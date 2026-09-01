/*
 * The build stamp — which build is this, said the same way in three places.
 *
 * Every deploy is a different bundle, but nothing in the bundle used to say so: an installed
 * PWA that was quietly holding last week's build looked exactly like one on today's, and
 * "check if you deployed" was a question with no honest answer from the phone. This plugin
 * gives the bundle an identity and puts the same identity where the server can read it:
 *
 *   1. `__TWM_BUILD__` — a compile-time constant (`define`) the SPA reads through
 *      `src/update/build.ts`. Inlined into whichever chunk reads it, so it changes that
 *      chunk's content hash, so the precache manifest changes, so a rebuild — even of the
 *      same commit — is a new build to the service worker.
 *   2. `dist/build.json` — the same object as a file, which `srv/server.ts` reports under
 *      `/health.build`. The SPA compares the two: a phone whose stamp differs from the
 *      server's is a phone that has not taken the update yet (`src/pages/settings/
 *      VersionCard.tsx`).
 *
 * The commit is read from `GIT_SHA` first, because the Docker build context has no `.git`
 * (see .dockerignore) and `npm run deploy` passes it as a build arg; `git rev-parse` is the
 * laptop's answer; `unknown` is the honest last resort — and even then `builtAt` still
 * tells two builds apart.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

export interface BuildStamp {
  /** `version` from the root package.json — the number `/health` already reports. */
  version: string
  /**
   * Short git SHA (7 hex chars) — with `-dirty` after it when `scripts/deploy.sh` was told
   * to ship uncommitted changes — or `unknown` when neither the env nor git can say.
   */
  commit: string
  /** ISO 8601, UTC. */
  builtAt: string
}

export interface StampInputs {
  env: Record<string, string | undefined>
  /** The root package.json, as text; `undefined` when it is not in the build context. */
  packageJson: string | undefined
  /** The commit git reports for the working tree, or `null` when there is no git. */
  gitCommit: string | null
  now: Date
}

const SHORT_SHA = /^([0-9a-f]{7,40})(-dirty)?$/i

/** Pure: everything environmental is passed in, so the resolution order is testable. */
export function resolveBuildStamp({ env, packageJson, gitCommit, now }: StampInputs): BuildStamp {
  const commit = shortCommit(env.GIT_SHA) ?? shortCommit(gitCommit) ?? 'unknown'
  return { version: readVersion(packageJson), commit, builtAt: now.toISOString() }
}

/** `8cea17b` or `8cea17b-dirty` from anything that looks like a SHA; null from anything else. */
function shortCommit(value: string | null | undefined): string | null {
  const match = SHORT_SHA.exec((value ?? '').trim())
  if (match === null) return null
  const [, sha, dirty] = match
  return `${sha.slice(0, 7).toLowerCase()}${dirty === undefined ? '' : '-dirty'}`
}

function readVersion(packageJson: string | undefined): string {
  if (packageJson === undefined) return '0.0.0'
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined
    return typeof version === 'string' && version !== '' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** `git rev-parse --short=7 HEAD`, or null where there is no git or no repository. */
export function gitCommit(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export interface BuildStampOptions {
  /** Where the root package.json lives — one directory up from `app/` in this repository. */
  packageJsonPath: string
  /** The directory `git rev-parse` runs in. */
  cwd: string
}

/**
 * The plugin: `define` for the bundle, `build.json` beside it.
 *
 * The stamp is resolved once, when the config is evaluated, so the constant and the file
 * cannot disagree. `config()` runs in dev and under vitest too, which is what makes
 * `__TWM_BUILD__` defined everywhere the SPA's code can run; `generateBundle` is build-only.
 */
export function buildStamp(options: BuildStampOptions): Plugin {
  const stamp = resolveBuildStamp({
    env: process.env,
    packageJson: readOptional(options.packageJsonPath),
    gitCommit: gitCommit(options.cwd),
    now: new Date(),
  })
  let emitted = false

  return {
    name: 'twm-build-stamp',
    config() {
      return { define: { __TWM_BUILD__: JSON.stringify(stamp) } }
    },
    generateBundle() {
      // One file per build, whichever output this hook is called for.
      if (emitted) return
      emitted = true
      this.emitFile({
        type: 'asset',
        fileName: 'build.json',
        source: `${JSON.stringify(stamp, null, 2)}\n`,
      })
    },
  }
}
