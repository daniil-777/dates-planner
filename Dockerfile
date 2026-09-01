# syntax=docker/dockerfile:1.7
#
# Two-Way Match — production image.
#
# One container serves both halves of the app: the built Vite SPA at `/` and the CAP
# service at `/ledger`, out of the same Express instance that `srv/server.ts` configures.
# That is not a shortcut — `srv/server.ts` deliberately mounts `app/dist` itself so the
# SPA and the API share an origin, which is what lets its CSP stay `script-src 'self'`
# and its CORS shim stay same-origin-only.
#
# ---------------------------------------------------------------------------
# The libc rule, and why every stage below is alpine
# ---------------------------------------------------------------------------
# `sharp` (receipt image normalisation, srv/lib/images.ts) is a native module. It ships as
# prebuilt platform packages — `@img/sharp-linux-x64` for glibc, `@img/sharp-linuxmusl-x64`
# for musl — and npm picks one at install time from the `os`/`cpu`/`libc` fields of the
# *installing* machine. Install on `node:22-bookworm-slim` and run on `node:22-alpine` and
# sharp throws at first require:
#
#     Could not load the "sharp" module using the linuxmusl-x64 runtime
#
# So: the stage that runs `npm ci` and the stage that runs the app must be the same libc.
# Both are alpine here. If you ever move the runtime to a Debian base, move the `deps`
# stage with it. (`package-lock.json` does carry every platform variant, including
# `@img/sharp-linuxmusl-x64` and `-arm64`, so `npm ci` finds the right one on either arch.)
#
# ---------------------------------------------------------------------------
# Why the runtime keeps devDependencies
# ---------------------------------------------------------------------------
# The CAP handlers in `srv/` are TypeScript, and `@sap/cds` alone will not load `.ts`
# service implementations — booted with plain `cds-serve`, the services come up with no
# `impl:` at all, `/health` falls back to CAP's `{status:"UP"}` stub, and every custom
# handler in `srv/ledger-service.ts` silently does not exist. The loader that fixes that is
# `cds-tsx`, which lives in `@sap/cds-dk`, which `package.json` declares as a
# devDependency. `package.json` is not this file's to change, and there is no
# `tsc`-to-`gen/` step wired up in it, so the honest thing is to ship the whole dependency
# tree and say why. It costs about 170 MB of layer; `@sap/cds-dk` is 27 MB of that and
# `tsx` under 1 MB.
#
# If a smaller image ever matters more than this simplicity, the change is in
# `package.json`, not here: add a `tsc` emit step, add an `"imports"` entry so the
# `#cds-models/*` specifier in `srv/ledger-service.ts` resolves without tsconfig paths,
# and then `npm ci --omit=dev` + `cds-serve` becomes correct.
#
# ---------------------------------------------------------------------------
# NOT BUILT HERE
# ---------------------------------------------------------------------------
# Docker is not installed on the machine this file was written on, so this image has never
# been built or run.
#
# Every runtime decision in it *was* verified, by assembling the layout below in a scratch
# directory — package.json, tsconfig.json, db/, srv/, scripts/, a generated @cds-models/,
# ml/model/weights.json, an app/dist/, and node_modules — and starting it under `env -i`
# with only the variables this file and fly.toml set. `cds-deploy` created and seeded the
# database at the volume path; `cds-tsx serve` loaded both TypeScript service
# implementations; `/` served the SPA and `/health` reported `status: ok` with the model
# loaded, both behind basic auth and both 401 without it. `npx cds-typer "*"` was also run
# with no `app/` folder present, which is what the `deps` stage looks like.
#
# What remains unverified is the packaging itself: layer order, `npm ci` on alpine, the
# `vite build` inside the web stage, the heredoc entrypoint, and `su-exec`. See
# docs/DEPLOY.md §0.


# =============================================================================
# Stage 1 — web: build the SPA
# =============================================================================
FROM node:22-alpine AS web

WORKDIR /src/app

# Lockfile first: the dependency layer is rebuilt only when the lockfile moves, not on
# every source edit.
COPY app/package.json app/package-lock.json ./
RUN npm ci

# The root package.json is where the version number lives; the stamp plugin reads it.
COPY package.json /src/package.json
COPY app/tsconfig.json app/vite.config.ts app/index.html ./
COPY app/vite/ ./vite/
COPY app/public/ ./public/
COPY app/src/ ./src/

# `npx vite build`, not the project's `npm run build`. That script is
# `tsc -b --noEmit false && vite build`, and with no `outDir` the `tsc` half writes a `.js`
# beside every `.ts`/`.tsx` in `src/` — and a `vite.config.js` beside `vite.config.ts`.
# Vite resolves `.js` first, so the bundle would then be built from tsc's output and from a
# compiled copy of its own config rather than from the sources. It happens to work, but
# "happens to work" is not what should be deciding what ships.
#
# Typechecking is CI's job (`npm run typecheck` in .github/workflows/ci.yml), which is the
# right place for it: a deploy should not be blocked by a type error CI already caught, and
# an image should not be built by a step with a side effect on its own inputs. GO-LIVE.md
# §1.3 has the one-flag fix for the npm script; once that lands this line can go back to
# `npm run build`.
#
# The commit this image is built from, stamped into the bundle and into `dist/build.json`
# by `app/vite/buildStamp.ts`. The build context has no `.git` (see .dockerignore), so the
# plugin cannot ask git itself; `npm run deploy` passes it in. A plain `fly deploy` without
# the arg still works — the stamp then says `unknown` where the SHA would be. It is a short
# SHA, not a secret, so a build arg is the right place for it (contrast §4 of DEPLOY.md).
# Declared here, after `npm ci`, and not at the top of the stage: an ARG invalidates every
# layer after it, and the SHA changes on every deploy.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA

# Output lands in /src/app/dist and is copied into the runtime stage below.
RUN npx vite build


# =============================================================================
# Stage 2 — deps: backend dependency tree + generated CDS types
# =============================================================================
FROM node:22-alpine AS deps

WORKDIR /src

# If `npm ci` ever fails here on a native module that has no musl prebuild, the fix is
# `RUN apk add --no-cache python3 make g++` above this line. Nothing in the current tree
# needs it: sharp and esbuild both ship musl binaries.
COPY package.json package-lock.json ./
RUN npm ci

# `@cds-models/` is generated, git-ignored, and imported for *values* — `srv/server.ts`
# does `import { People } from '../@cds-models/twowaymatch'`. A fresh clone has no such
# folder, so the image has to make one. cds-typer needs the model to do that, which is why
# the CDS sources are copied before it runs.
COPY db/ ./db/
COPY srv/ ./srv/
RUN npx cds-typer "*" --outputDirectory @cds-models


# =============================================================================
# Stage 3 — runtime
# =============================================================================
FROM node:22-alpine AS runtime

# `su-exec` is used by the entrypoint to drop from root to uid 1000 after it has taken
# ownership of the mounted volume. `tini` reaps the children that `npm run backup` and the
# nightly retrain job spawn, so nothing accumulates as a zombie under PID 1.
RUN apk add --no-cache su-exec tini

ENV NODE_ENV=production \
    PORT=8080 \
    TWM_DATA_DIR=/data \
    NODE_OPTIONS=--enable-source-maps \
    PATH=/app/node_modules/.bin:$PATH

WORKDIR /app

# node_modules is the biggest and least volatile layer, so it goes first.
COPY --from=deps /src/node_modules ./node_modules
COPY --from=deps /src/@cds-models ./@cds-models

# `tsconfig.json` is a *runtime* file here: tsx reads its `paths` to resolve the
# `#cds-models/twowaymatch` specifier that srv/ledger-service.ts and srv/lib/statement.ts
# import. Without it the service fails to load.
COPY package.json package-lock.json tsconfig.json ./
COPY db/ ./db/
COPY srv/ ./srv/
COPY scripts/ ./scripts/

# The classifier's weights. srv/server.ts and srv/admin-service.ts both read
# `<cds.root>/ml/model/weights.json`; without it every prediction falls back to "no model
# deployed" and /health reports `model: null`. ~5 MB, and the only thing from ml/ that the
# running app needs — the trainer, its data and model.pkl stay out (see .dockerignore).
COPY ml/model/weights.json ./ml/model/weights.json

# `srv/server.ts` serves this directory at `/` with a history fallback.
COPY --from=web /src/app/dist ./app/dist

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
# Written here rather than shipped as a repo file so the image is self-contained.
#
# It does three things and then gets out of the way:
#
#  1. Points CAP's SQLite database at the mounted volume. `package.json` pins
#     `cds.requires.db.credentials.url` to the relative path `db.sqlite`, which inside a
#     container would be a file on the ephemeral layer — gone on every deploy. CAP honours
#     `CDS_REQUIRES_DB_CREDENTIALS_URL` as an override (verified against @sap/cds 10.0.6).
#  2. Takes ownership of the volume and drops to the unprivileged `node` user. Fly.io
#     mounts volumes owned by root; a process already running as uid 1000 cannot chown
#     them. So the container starts as root for exactly one mkdir and one chown, then
#     re-executes itself through su-exec and spends the rest of its life as uid 1000.
#     If the volume is pre-owned, or you run the image with `--user node`, the root branch
#     is simply skipped.
#  3. Creates and seeds the database on first boot only. `cds-deploy` is a *destructive*
#     redeploy — it drops and recreates every table and re-imports db/data/*.csv — so it
#     runs only when the file does not exist. A restart with an existing database must
#     never touch it.
COPY <<'SH' /usr/local/bin/twm-entrypoint
#!/bin/sh
set -eu

DATA_DIR="${TWM_DATA_DIR:-/data}"
DB_FILE="${CDS_REQUIRES_DB_CREDENTIALS_URL:-$DATA_DIR/twm.sqlite}"
export CDS_REQUIRES_DB_CREDENTIALS_URL="$DB_FILE"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$(dirname "$DB_FILE")"
  chown -R node:node "$DATA_DIR"
  # Re-exec this same script as uid 1000. The branch above is not taken the second time.
  exec su-exec node "$0" "$@"
fi

if [ ! -f "$DB_FILE" ]; then
  echo "twm: no database at $DB_FILE — creating it and importing db/data/*.csv"
  cds-deploy
  echo "twm: database ready"
fi

exec "$@"
SH

RUN chmod 0755 /usr/local/bin/twm-entrypoint

# 200 when the app is open (development), 401 when production basic auth is on — both mean
# the HTTP server is listening and srv/server.ts is mounted, which is the whole question a
# liveness probe asks. Anything else, including a refused connection, is a failure.
#
# The probe cannot authenticate: the container is given bcrypt *hashes* (AUTH_HASH_A/B),
# never the passwords, and that is the right way round. Verified: with NODE_ENV=production
# and credentials configured, GET /health answers 401 to an anonymous caller and 200 with
# the correct Authorization header.
#
# Note that Fly Machines ignore an image's HEALTHCHECK — see the checks block in fly.toml.
# This one is for `docker run`, Compose, and anything else that reads image metadata.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.status===200||r.status===401?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/twm-entrypoint"]
CMD ["cds-tsx", "serve"]
