# DEPLOY — path A: Fly.io

The daily driver. One machine in Frankfurt, one 3 GB volume, one SQLite file, one URL that
the household has bookmarked on their phones.

Path B, `docs/DEPLOY_BTP.md`, puts the same app on SAP BTP Cloud Foundry with HANA and
XSUAA. That one is the demo — it is the version you show someone who says "but is it
_really_ SAP" — and its free-tier database stops every night. This one is the one that
holds the receipts.

---

## 0. What is verified, and what is not

This document was written against the running code. Everything in the list below was
executed and its output read:

| Claim                                                                                   | How it was checked                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cds-tsx serve` loads the TypeScript handlers; plain `cds-serve` does not               | booted both; the second serves `AdminService`/`LedgerService` with no `impl:` and answers `/health` with CAP's `{"status":"UP"}` stub                                                                                                                                                                                                          |
| `CDS_REQUIRES_DB_CREDENTIALS_URL` relocates the database                                | booted with it set to a path outside the project; CAP logged `connect to db > sqlite { url: … }` and created the file there                                                                                                                                                                                                                    |
| `cds-deploy` creates and seeds a fresh database at that path                            | ran it; 19 expenses, 5 people, 2 events, 10 categories, 1 memory                                                                                                                                                                                                                                                                               |
| `npx cds-typer "*" --outputDirectory @cds-models` reproduces the generated types        | ran it into a scratch directory; identical layout and `index.d.ts`                                                                                                                                                                                                                                                                             |
| In production `/health` answers **401** to an anonymous caller and 200 with credentials | booted with `NODE_ENV=production` and `AUTH_*` set; `curl` both ways                                                                                                                                                                                                                                                                           |
| `package-lock.json` carries the musl builds of `sharp`                                  | `@img/sharp-linuxmusl-x64` and `-arm64` are both in the lockfile                                                                                                                                                                                                                                                                               |
| `npx tsx scripts/backup.ts --out <dir>` produces a readable archive                     | ran it; `tar tzf` lists `manifest.json`, `db.sqlite`, `images/`                                                                                                                                                                                                                                                                                |
| `npm run backup -- --out <dir>` does **not** work                                       | `cds run` eats the flag: `Invalid option: --out`                                                                                                                                                                                                                                                                                               |
| The end-to-end suite passes against a real server                                       | `npx playwright test` — 27 passed, 5 skipped                                                                                                                                                                                                                                                                                                   |
| The whole container layout works                                                        | assembled it in a scratch directory — package.json, tsconfig.json, db/, srv/, scripts/, generated `@cds-models/`, `ml/model/weights.json`, an `app/dist/`, node_modules — and started it under `env -i` with only the variables the Dockerfile and fly.toml set. Deploy, seed, both services loaded, SPA at `/`, `/health` ok, 401 anonymously |
| `cds-typer` works with no `app/` folder, which is what the `deps` stage looks like      | ran it against a directory holding only `db/` and `srv/`                                                                                                                                                                                                                                                                                       |

**Not verified, because this machine has no Docker:** the image has never been built or
run. The Dockerfile's _runtime decisions_ are all from the table above, reproduced outside
a container. What is untested is the packaging — layer order, `npm ci` on alpine, the
`vite build` inside the web stage, and the heredoc entrypoint. Expect to iterate once on
the first `fly deploy`, and read §9 before you do.

**Also not verified:** everything that needs a Fly account. `fly.toml`, the
`fly secrets set` list below and `.github/workflows/backup.yml` have never been run
against a real app.

---

## 1. What gets deployed

```
                        ┌──────────────────────── fly machine (512 MB, fra) ───────────┐
   phone ──── https ────┤  Fly proxy → :8080                                           │
                        │      │                                                       │
                        │      ├─ srv/server.ts  (helmet, basic auth, rate limits)      │
                        │      │        ├─ GET /            → app/dist  (the SPA)       │
                        │      │        ├─ /ledger, /admin  → CAP OData services        │
                        │      │        └─ GET /health      → status, behind auth       │
                        │      │                                                        │
                        │      └─ ml/model/weights.json  (classifier, in-process)        │
                        │                                                                │
                        │  /data  ──── volume ──── twm.sqlite  (everything, images too)  │
                        └────────────────────────────────────────────────────────────────┘
```

One process. The SPA and the API share an origin on purpose — it is what lets the CSP stay
`script-src 'self'` and the CORS shim stay same-origin-only.

Everything durable is in `/data/twm.sqlite`, receipt and memory images included:
`db/schema.cds` stores them as `LargeBinary` columns rather than as files. Lose the volume
and you lose the photographs too. §8 is not optional.

---

## 2. Before you start

```bash
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login
```

You also need the two passwords the app will use. Generate their hashes now, on your own
machine, because the container is only ever given hashes:

```bash
npm run hash -- 'the password she will use'
npm run hash -- 'the password you will use'
```

Each prints a bcrypt hash starting `$2b$12$`. Keep them next to you for §4.

---

## 3. Create the app and the volume

```bash
# Reserve the name. --no-deploy because fly.toml is already written and correct.
fly launch --no-deploy --name two-way-match-<something-unique> --region fra

# fly launch rewrites `app = …` in fly.toml. Check that it changed only that line:
git diff fly.toml
```

Then the volume. It must exist before the first deploy, and it must be in the same region
as the machine:

```bash
fly volumes create twm_data --region fra --size 3
```

Three gigabytes is years of scanning — `srv/lib/images.ts` normalises every receipt down to
tens of kilobytes — and `fly.toml` sets it to extend itself to 10 GB rather than fail a
write at three in the morning. One volume, one machine: do not scale this app to two.

---

## 4. Secrets

`fly secrets set` stores values encrypted, injects them as environment variables at boot,
and never writes them into the image or into `fly.toml`. **Nothing sensitive goes in
`fly.toml`.** `.dockerignore` excludes `.env` and every `.env.*`, and the Dockerfile does
not copy one, so a credential can only reach the container this way.

`fly secrets set` restarts the machine, so set them all in one command.

### Required — the app refuses to start in production without these

`srv/server.ts` throws at boot if any of the four is missing or is not a bcrypt hash. That
is deliberate: CAP's configured `auth.kind` is `mocked`, whose default user table ends in
`'*': true`, so a missing variable must never be able to fall back to "any username, any
password".

| Name          | What it is                                              |
| ------------- | ------------------------------------------------------- |
| `AUTH_USER_A` | her login. Must match a `People.email` in the seed data |
| `AUTH_HASH_A` | the bcrypt hash from §2                                 |
| `AUTH_USER_B` | your login                                              |
| `AUTH_HASH_B` | the other hash                                          |

```bash
fly secrets set \
  AUTH_USER_A='her@example.com' \
  AUTH_HASH_A='$2b$12$…' \
  AUTH_USER_B='you@example.com' \
  AUTH_HASH_B='$2b$12$…'
```

**Single quotes around the hashes.** A bcrypt hash is full of `$`, and an unquoted one gets
eaten by your shell before flyctl ever sees it. The app validates the shape and will tell
you if this happened, but it will tell you by refusing to boot.

### Strongly wanted — set it on the first deploy

| Name             | What it is                                                |
| ---------------- | --------------------------------------------------------- |
| `SESSION_SECRET` | the key that signs the session cookie (`srv/lib/auth.ts`) |

Not required: with it unset, `sessionSecret()` falls back to 32 random bytes chosen once per
boot. That is a _stronger_ key than any passphrase, so it is never a weakening — it simply
does not survive a restart, which means **everybody is signed out on every deploy**, and the
`immediate` strategy in `fly.toml` means every deploy is a restart. On a phone that is a
login screen instead of the app, in a restaurant, holding a receipt.

```bash
fly secrets set SESSION_SECRET="$(openssl rand -base64 36)"
```

### Optional — each one buys one more real service

Set none of these and the app is complete: Document AI runs on bundled fixtures, the
statement is rendered by the deterministic template, and the classifier runs in-process
from `ml/model/weights.json`. Nothing degrades into a stub.

**Statement generator** (`docs/CONTRACTS.md` §7 — first configured provider wins):

| Name                                                            | Notes                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                             | **secret.** Its presence alone selects the Anthropic provider                                                                                                                                                                                                                                                     |
| `ANTHROPIC_WORKSPACE_ID`                                        | only for an _identity-linked_ key (one tied to your user, not created inside a workspace): the API refuses those with `anthropic-workspace-id is required` until this names the workspace (`wrkspc_…`, console → Settings → Workspaces). Shared by the statement writer, the receipt reader and the mood estimate |
| `ANTHROPIC_MODEL`                                               | optional; defaults to `claude-opus-5`                                                                                                                                                                                                                                                                             |
| `ANTHROPIC_BASE_URL`                                            | optional; only for a gateway                                                                                                                                                                                                                                                                                      |
| `LLM_BASE_URL` + `LLM_API_KEY`                                  | any OpenAI-compatible `/chat/completions`. **Both** required                                                                                                                                                                                                                                                      |
| `LLM_MODEL`                                                     | required for the OpenAI-compatible provider, which has no default                                                                                                                                                                                                                                                 |
| `AICORE_SERVICE_KEY`                                            | **secret.** The whole AI Core service key as one line of JSON                                                                                                                                                                                                                                                     |
| `AICORE_MODEL`, `AICORE_RESOURCE_GROUP`, `AICORE_DEPLOYMENT_ID` | optional                                                                                                                                                                                                                                                                                                          |

**Receipt extraction** (`docs/CONTRACTS.md` §6). All four, or none — the client falls back
to mock mode if any one is missing, which is the behaviour you want rather than a 401 at
the supermarket checkout:

| Name                                       | Where it comes from                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `DOCAI_URL`                                | service key `url` — the API host, no path                                                                   |
| `DOCAI_UAA_URL`                            | service key `uaa.url` — the **token** host. Swapping these two is the classic mistake and shows up as a 401 |
| `DOCAI_CLIENT_ID`                          | service key `uaa.clientid`                                                                                  |
| `DOCAI_CLIENT_SECRET`                      | **secret.** service key `uaa.clientsecret`                                                                  |
| `DOCAI_SCHEMA_NAME`, `DOCAI_DOCUMENT_TYPE` | optional; neither affects the mock/live decision                                                            |
| `MOCK_DOCAI`                               | set to `1` to force fixtures even with credentials present                                                  |

**Remote classifier** (optional; local inference is the default and stays the default):
`CLASSIFIER_URL`, `CLASSIFIER_TOKEN`, `CLASSIFIER_RESOURCE_GROUP`.

**HANA forecasting** (optional, and needs `@sap/hana-client`, which this project
deliberately does not depend on — see `docs/HANA_PAL.md`): `HANA_HOST`, `HANA_USER`,
`HANA_PASSWORD`.

```bash
fly secrets set ANTHROPIC_API_KEY='sk-ant-…'
fly secrets list        # names, digests and timestamps. Never values.
```

`ANTHROPIC_API_KEY` and every `DOCAI_*` value must be Fly secrets. Not `fly.toml`, not the
Dockerfile, not a build arg — a build arg is visible in `docker history` forever.

---

## 5. First deploy

```bash
npm run deploy
```

That is `scripts/deploy.sh`: `fly deploy --build-arg GIT_SHA=<short HEAD>`, with a guard in
front. The build context has no `.git`, so the commit has to be handed in; the frontend
build stamps it, together with the version and the build time, into the bundle and into
`app/dist/build.json`. The guard refuses an uncommitted tree — `fly deploy` ships whatever
is on disk, and a stamp that names a commit the code is not would send you reading the
wrong diff. `DEPLOY_DIRTY=1 npm run deploy` ships anyway and stamps it `8cea17b-dirty`, so
the phone still tells you. Extra arguments go through: `npm run deploy -- --strategy
immediate`. A bare `fly deploy` works too — the stamp then reads `unknown` where the SHA
would be.

What happens, in order:

1. The build context is uploaded, minus everything in `.dockerignore` — no `node_modules`,
   no `.git`, no `.env`, no `*.sqlite`.
2. Stage `web` runs `npm ci` in `app/` and builds the SPA with `npx vite build` — not with
   `npm run build`, whose `tsc -b --noEmit false` half writes a `.js` beside every source
   file and a `vite.config.js` beside `vite.config.ts`, which Vite then prefers. The
   Dockerfile says so at more length, and `GO-LIVE.md` §1.3 has the one-flag fix.
3. Stage `deps` runs `npm ci` at the root and `npx cds-typer "*"`. Both stages are alpine,
   which is what gives `sharp` the musl binary the runtime needs — see the long comment at
   the top of the Dockerfile before you change a base image.
4. The runtime image is assembled and pushed.
5. The machine boots. The entrypoint runs as root just long enough to `mkdir` and `chown`
   `/data` — Fly mounts volumes root-owned and a process already running as uid 1000 cannot
   fix that — then re-executes itself as the `node` user through `su-exec`.
6. Seeing no database at `/data/twm.sqlite`, it runs `cds-deploy` once: tables created,
   `db/data/*.csv` imported. **On every later boot it finds the file and does nothing** —
   `cds deploy` is a destructive redeploy and must not run twice.
7. `cds-tsx serve` starts. The log ends with `server listening on { url: … }`.

Watch it:

```bash
fly logs
```

`app/dist not built` in the log means step 2 did not land in the image, and you will get a
404 at `/` with a working API. `no database at /data/twm.sqlite — creating it` should
appear exactly once in the life of the app.

---

## 6. Custom domain and HTTPS

`fly.toml` sets `force_https = true`, so `http://` is redirected before it reaches the app.

```bash
fly ips list                                  # note the v4 and v6 addresses
fly certs add twm.example.com
fly certs show twm.example.com                # tells you exactly which records to create
```

At your DNS provider:

| Type   | Name  | Value                                            |
| ------ | ----- | ------------------------------------------------ |
| `A`    | `twm` | the shared or dedicated IPv4 from `fly ips list` |
| `AAAA` | `twm` | the IPv6                                         |

An apex domain needs both records at the root; a subdomain can use `CNAME` →
`<app>.fly.dev` instead, which is easier and survives an IP change. Fly issues the
certificate over Let's Encrypt as soon as the records resolve, usually inside a minute:

```bash
fly certs check twm.example.com     # → "The certificate for … has been issued"
```

Then fix the URL before anyone installs it. **A PWA is installed against an origin.** If
she adds `https://two-way-match-xyz.fly.dev` to her home screen and you later move to
`https://twm.example.com`, the icon on her phone points at the old origin, with its own
service worker and its own cache. Decide the address first, install second.

---

## 7. Check it is actually up

```bash
curl -u 'you@example.com:your-password' https://twm.example.com/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 41,
  "model": "2026-09-01T12:20:32",
  "docai": "mock",
  "llm": "Deterministic template · …",
  "build": { "version": "1.0.0", "commit": "8cea17b", "builtAt": "2026-09-01T10:47:13.211Z" }
}
```

Read all five of the interesting fields:

- `model` — `null` means `ml/model/weights.json` did not make it into the image and every
  prediction is a fallback.
- `docai` — `mock` or `live`. If you set the four `DOCAI_*` secrets and this still says
  `mock`, one of them is empty.
- `llm` — names the _variable_ a key came from, never the key.
- `version` — comes from `package.json`, so it is how you tell which release is running.
- `build` — which _frontend build_ is being served: the commit and the time the bundle was
  built, read from `app/dist/build.json`. `null` means `app/dist` has no stamp, which on a
  deployed machine means the `web` stage did not run the current `app/vite/buildStamp.ts`.
  `"commit": "unknown"` means the image was built without `GIT_SHA` — use `npm run deploy`.
  A `-dirty` suffix means it was shipped with uncommitted changes (`DEPLOY_DIRTY=1`).

The same stamp is compiled into the bundle, and **Settings → Version** on a phone shows
both: the one the phone is running and the one the server has. When they differ the card
says so, asks the service worker to look, and the moment the new build is installed a
banner at the bottom of every screen offers **Reload**. Nothing reloads on its own — the
service worker runs in `prompt` mode, so a half-typed expense is never lost to a deploy.

Without credentials that endpoint returns **401**, by design: `srv/server.ts` mounts basic
auth in front of every route, `/health` included. That is why `fly.toml` uses a TCP check
rather than an HTTP one — an anonymous HTTP probe would fail forever and Fly would restart a
perfectly healthy machine every few minutes. The `HEALTHCHECK` in the Dockerfile is the
richer probe (it treats 200 _and_ 401 as healthy, so it also proves the auth middleware is
mounted), but Fly Machines ignore an image's healthcheck. The whole argument, in full, is in
the comments of `fly.toml`.

```bash
fly status                 # machine state, and the TCP check
fly checks list
```

---

## 8. Backups

Read this before you decide 3 GB was plenty. The volume is the only copy of everything.

**Once, by hand, to prove the loop works:**

```bash
fly ssh console -C "/bin/sh -c 'cd /app && tsx scripts/backup.ts --out /data/backups'"
fly ssh sftp get /data/backups/twoway-match-<stamp>.tar.gz ./twm-backup.tar.gz
tar tzf twm-backup.tar.gz | head
```

`tsx scripts/backup.ts`, not `npm run backup` — the npm script is
`cds-tsx run scripts/backup.ts`, and `cds run` rejects the `--out` flag before the script
ever sees it (`Invalid option: --out`). The image puts `/app/node_modules/.bin` on `PATH`,
so `tsx` resolves.

The archive is a plain gzipped USTAR tarball holding `manifest.json`, a consistent
`db.sqlite` snapshot taken through SQLite's online backup API, and every receipt and photo
as an ordinary JPEG. That last part is redundant with the database on purpose: in ten years
a folder of JPEGs will still open, whatever has happened to CDS.

Restore it with `npx tsx scripts/restore.ts <archive>`. **Rehearse this once.** A backup you
have never restored is a hope.

**Nightly, automatically:** `.github/workflows/backup.yml` does exactly the sequence above
on a schedule, encrypts the result with AES-256 and keeps it as a workflow artifact. It
needs two repository secrets — `FLY_API_TOKEN` (`fly tokens create deploy -x 8760h`) and
`BACKUP_PASSPHRASE` (`openssl rand -base64 48`) — and it has never been run. Trigger it by
hand from the Actions tab once, read the job summary, and only then trust the schedule.

Write the passphrase down somewhere that is neither this repository nor this laptop.

---

## 9. Install it on the phones

Do this against the final URL, over HTTPS, after §6. Both phones, the same evening.

### iPhone (Safari — and it must be Safari)

1. Open the URL in **Safari**. Chrome and Firefox on iOS cannot install a web app; the
   option is not in their menus. Say this out loud to whoever is holding the phone.
2. Sign in when the basic-auth sheet appears. Tick "remember".
3. Share button (the square with the arrow) → scroll → **Add to Home Screen** → **Add**.
4. The name should already say **2WM** — that is `apple-mobile-web-app-title` in
   `app/index.html`. The icon should be the app's, not a screenshot of the page.
5. Close Safari. Open the new icon.

Then check, in the installed app:

- [ ] No Safari address bar and no toolbar. If either is there,
      `apple-mobile-web-app-capable` did not take effect and you are looking at a bookmark.
- [ ] Content clears the notch at the top and the home indicator at the bottom — the
      bottom navigation should sit above it, not under it. That is
      `viewport-fit=cover` plus the `env(safe-area-inset-*)` padding, and it is what the
      "bottom bar clears the home indicator" e2e test guards.
- [ ] The status bar is legible in both light and dark mode.
- [ ] Tap **Scan** → **Scan receipt**. iOS asks for camera permission once. Allow it.
      _If the prompt never appears, the page is not on HTTPS._
- [ ] Photograph a real receipt. A draft posting appears with a merchant and an amount.
- [ ] **Post** it. Open **Ledger**. It is there, with the amount as `CHF 47.85` —
      apostrophes for thousands, never commas.
- [ ] Swipe the app away and reopen it. You should not have to sign in again.

Two iOS truths worth knowing before they surprise you:

- A standalone web app keeps its own credential store, separate from Safari's. She may have
  to enter the password once more inside the installed app. Once.
- iOS evicts service-worker caches from apps that go unused for weeks. The app still works —
  it just fetches instead of serving from cache. Nothing is lost; the data lives on the
  server.

### Android (Chrome)

1. Open the URL in Chrome and sign in.
2. Chrome usually offers an **Install app** banner within a few seconds. If it does not:
   ⋮ menu → **Install app** (older versions say **Add to Home screen**).
3. Choosing **Install** — not "Add shortcut" — is what produces a real standalone app with
   its own task-switcher entry.

Then check:

- [ ] The icon is round and correctly cropped, not the square icon pasted into a white
      circle. That is `icon-maskable-512.png` with `purpose: "maskable"` in the manifest;
      the e2e manifest test asserts it exists.
- [ ] Launching from the icon shows no browser UI (`display: "standalone"`).
- [ ] The splash background and the status bar are `#0070F2` — SAP blue, from
      `theme_color`.
- [ ] Camera works from **Scan**.
- [ ] Turn on airplane mode and reopen the app. The shell should still paint, from the
      service-worker cache, and say plainly that it cannot reach the server rather than
      showing a white screen.

### Both

- [ ] Post one real expense from each phone and confirm both people see both postings.
- [ ] Run one payment run and read the clearing document out loud. If the sentence is
      wrong, stop and fix the split before this becomes a habit.

---

## 10. Living with it

```bash
fly logs                    # follow
fly logs -n                 # no follow
fly ssh console             # a root shell on the machine
fly status                  # machine, region, volume, checks
fly volumes list
npm run deploy              # ship a change with the commit stamped in; a few seconds of 502
fly apps restart <app>      # when you have changed a secret and want to be sure
```

**Updating the classifier.** The nightly job in `srv/admin-service.ts` spawns
`npm run ml:retrain`, which needs `ml/.venv` and scikit-learn — neither of which is in the
image, and neither of which belongs in a 512 MB machine. So the cron fires (after 20 new
confirmed rows), fails, logs a note, and changes nothing. That is the whole consequence.

Retraining is a laptop operation:

```bash
npm run ml:export-data      # pull the confirmed rows out of the live database
npm run ml:retrain          # train, export, and run the parity test
git commit ml/model/weights.json
npm run deploy
```

CI will not let a broken `weights.json` through: `.github/workflows/ci.yml` checks that the
coefficient blob decodes to exactly `rows × cols` float32 values and that the labels are
sorted, and `npm test` replays `ml/model/parity_fixture.json` through the TypeScript port to
1e-4.

**Cost.** One `shared-cpu-1x` machine at 512 MB with `auto_stop_machines = 'off'`, a 3 GB
volume, and a few hundred megabytes of egress. Small, and not zero — the machine never
stops, on purpose. `srv/admin-service.ts` wants a 03:00 timer, and more to the point this
app is used the way a camera is used: a cold start you have to stand there and wait through
is the difference between a tool and a chore.

---

## 11. When it does not work

| What you see                                                                                                            | What it is                                                                                                                                                                                               | What to do                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refusing to start in production without working credentials`                                                           | one of the four `AUTH_*` is missing, or a hash lost its `$` to the shell                                                                                                                                 | re-set it in **single quotes**; §4                                                                                                                                                                          |
| `Could not load the "sharp" module using the linuxmusl-x64 runtime`                                                     | the build stage and the runtime stage are on different libc                                                                                                                                              | both must be alpine; read the header of the Dockerfile                                                                                                                                                      |
| 404 at `/`, but `/ledger` returns JSON                                                                                  | `app/dist` is not in the image                                                                                                                                                                           | check the `web` stage in the build log                                                                                                                                                                      |
| `/health` says `"model": null`                                                                                          | `ml/model/weights.json` is missing or unparseable                                                                                                                                                        | it is committed; check the `COPY` line and that it is not caught by `.dockerignore`                                                                                                                         |
| Every prediction is `Groceries` at low confidence                                                                       | same as above, from the other end                                                                                                                                                                        | `/health`                                                                                                                                                                                                   |
| The data was there yesterday and is gone today                                                                          | the database is on the container layer, not the volume                                                                                                                                                   | `fly ssh console -C "ls -la /data"`; check `CDS_REQUIRES_DB_CREDENTIALS_URL` in `fly.toml`                                                                                                                  |
| Machine restarts every few minutes                                                                                      | someone replaced the TCP check with an HTTP check on `/health`, which is 401 for an anonymous prober                                                                                                     | put the TCP check back; the reasoning is in `fly.toml`                                                                                                                                                      |
| The app renders in Times New Roman                                                                                      | the `72` faces are not being served — either `app/public/fonts` did not reach the image, or someone removed the `twm-bundle-ui5-fonts` plugin from `app/vite.config.ts` and the baked CDN URLs came back | `curl -I https://…/fonts/72-Regular.woff2` should be 200 `font/woff2`; `GO-LIVE.md` §1.1                                                                                                                    |
| Everybody is signed out after every deploy                                                                              | `SESSION_SECRET` is unset, so the cookie key is regenerated on each boot                                                                                                                                 | set it; §4                                                                                                                                                                                                  |
| `npm ci` fails on alpine building a native module                                                                       | no musl prebuild for something                                                                                                                                                                           | add `RUN apk add --no-cache python3 make g++` to the failing stage                                                                                                                                          |
| `fly ssh console` hangs                                                                                                 | the machine is stopped                                                                                                                                                                                   | `fly status`; `auto_stop_machines` should be `'off'`                                                                                                                                                        |
| A phone keeps showing last week's screen after a deploy                                                                 | the service worker has the new build but is waiting for a tap — or has not looked yet                                                                                                                    | **Settings → Version**: the card names both builds and has **Check for updates**; the **Reload** banner appears once the new build is installed. Killing and reopening the app also makes the browser check |
| No banner, and the Version card is missing altogether                                                                   | the phone is still on a build from before the card existed: that worker updated on its own and never waits, so it has nothing to tap and nothing that tells the new worker to take over                  | close the installed app fully (swipe it away) and open it again — once. From then on the banner does the job                                                                                                |
| `/health` says `"build": null` or `"commit": "unknown"`                                                                 | the `web` stage did not write `dist/build.json`, or was built without `GIT_SHA`                                                                                                                          | `npm run deploy`, not `fly deploy`; check the `COPY app/vite/` line in the Dockerfile                                                                                                                       |
| a scan or face-scan fails with `anthropic-workspace-id is required when authenticating with an identity-linked API key` | the key is tied to your user, not to a workspace                                                                                                                                                         | `fly secrets set ANTHROPIC_WORKSPACE_ID='wrkspc_…'` — or create the key _inside_ a workspace instead, which needs no id                                                                                     |

`docs/RUNBOOK.md` covers the application-level failures — a scan that will not extract, a
settlement that looks wrong, a restore. This file stops at the edge of the machine.

---

## Postgres

SQLite on the volume is still the default and is still right for one household. Postgres is
for the commons (ADR-003): one corpus read and written by every household, which is not a
shape one file on one machine serves while that machine is also serving the app.

**Be clear about the cost before starting.** Fly's Managed Postgres begins at about **$38 a
month** (Basic, shared-2x, 1 GB) plus storage. Unmanaged Fly Postgres is a few dollars a month
and is explicitly unsupported by Fly — you are the DBA, including the night it fails over.
The SQLite volume costs cents. Nothing in the app needs Postgres until the commons has real
traffic, and `DATABASE_URL` is the whole of the switch, so this can wait until it is worth
paying for.

### 1. Create it

```bash
fly mpg create --name twm-db --region fra          # managed; see `fly mpg --help`
fly mpg attach twm-db --app twm-dates-planner      # sets DATABASE_URL as a secret
```

`DATABASE_URL` is the only setting. `srv/lib/database.ts` reads it, parses it and points CAP
at Postgres; unset, everything behaves exactly as it does today.

### 2. Let the app build the schema

Deploy with `DATABASE_URL` set and start once. `migrate()` finds an empty database, generates
the DDL from the model for the Postgres dialect, creates every table and index, and records
the steps. **Do not run `cds deploy`** — it drops every table first, which is right for a test
and catastrophic here.

Check `/health` and the log line `database: postgres` before going further.

### 3. Copy the rows

Offline. A live database copied twice is a household with two of every receipt.

```bash
fly scale count 0 --app twm-dates-planner                 # stop writing
fly ssh sftp get /data/db.sqlite ./db.sqlite              # pull the real thing

DATABASE_URL='postgres://…' npx tsx scripts/migrate-to-postgres.ts --from db.sqlite --dry-run
DATABASE_URL='postgres://…' npx tsx scripts/migrate-to-postgres.ts --from db.sqlite

fly scale count 1 --app twm-dates-planner
```

The script verifies every table row-for-row and fails on any mismatch. **Rehearse it on the
pulled copy first** — that is what the `--dry-run` is for, and pulling a copy costs nothing.

### 4. Afterwards

- **Turn off `.github/workflows/backup.yml`.** It snapshots the SQLite file; against Postgres
  it produces an empty tarball every night. `scripts/backup.ts` now refuses to run rather than
  pretend, but the workflow will still go green on the failure unless it is disabled.
- **Keep the volume and the file for a while.** It is the only rollback: unset `DATABASE_URL`
  and the app is back on SQLite exactly as before, minus anything written since the cutover.
- **`COMMONS_AUTHOR_SECRET` must be set** before the commons is used in production; the server
  refuses to start without it. Rotating it later orphans every published rating — see
  CONTRACTS §14.5.
