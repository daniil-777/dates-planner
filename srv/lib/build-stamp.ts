/*
 * The build stamp — which frontend build the server is serving.
 *
 * `app/vite/buildStamp.ts` writes `app/dist/build.json` next to the bundle it stamps, with
 * the same three fields it compiled into that bundle. `/health` reports it, and the Version
 * card in Settings compares it with the stamp inside the bundle the phone actually loaded.
 * When they differ, the phone is behind — the one question this file exists to answer.
 *
 * A reader, not a parser of anything clever: three strings, or null. Cached against the
 * file's mtime, the same way `/health` caches `weights.json`, so a deploy that swaps `dist/`
 * under a running server is visible on the next probe without a restart.
 */
import { readFileSync, statSync } from 'node:fs'

export interface BuildStamp {
  /** `package.json` version at build time. */
  version: string
  /** Short git SHA (`-dirty` when shipped uncommitted), or `unknown` without git or `GIT_SHA`. */
  commit: string
  /** ISO timestamp of the build. */
  builtAt: string
}

interface CacheEntry {
  path: string
  mtimeMs: number
  stamp: BuildStamp | null
}

let cache: CacheEntry | null = null

/**
 * The stamp at `path`, or null when there is none — no `dist/` yet in a fresh checkout, or a
 * file something else wrote. Never throws: a missing stamp is a fact for `/health` to
 * report, not a reason to fail the probe.
 */
export function readBuildStamp(path: string): BuildStamp | null {
  try {
    const { mtimeMs } = statSync(path)
    if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs) return cache.stamp
    const stamp = parseBuildStamp(readFileSync(path, 'utf8'))
    cache = { path, mtimeMs, stamp }
    return stamp
  } catch {
    cache = null
    return null
  }
}

/** Strictly the three fields, all strings; anything else is not a stamp. */
export function parseBuildStamp(text: string): BuildStamp | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { version, commit, builtAt } = raw as Record<string, unknown>
  if (typeof version !== 'string' || typeof commit !== 'string' || typeof builtAt !== 'string') {
    return null
  }
  if (version === '' || commit === '') return null
  return { version, commit, builtAt }
}

/** For tests, which share the module-level cache. */
export function resetBuildStampCache(): void {
  cache = null
}
