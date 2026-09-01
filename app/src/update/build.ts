/*
 * The build this bundle is.
 *
 * `__TWM_BUILD__` is a compile-time constant that `app/vite/buildStamp.ts` defines — in
 * production, in `npm run dev`, and under vitest, because the plugin's `config()` hook runs
 * for all three. The `typeof` guard is for the one place none of them apply: a component
 * rendered by something that is not Vite at all. There it degrades to a stamp that says
 * so, rather than to a ReferenceError at import time.
 */
import type { BuildStamp } from '@/api/types'

declare global {
  var __TWM_BUILD__: BuildStamp | undefined
}

const UNKNOWN: BuildStamp = { version: '0.0.0', commit: 'unknown', builtAt: '' }

export const BUILD: BuildStamp =
  typeof __TWM_BUILD__ === 'object' && __TWM_BUILD__ !== null ? __TWM_BUILD__ : UNKNOWN

/**
 * Same build, or not. Both fields, deliberately: `builtAt` changes on every build, and a
 * rebuild of the same commit *is* a new bundle (the stamp is inlined into it, so its hash
 * moves), so a phone holding the older one really is behind.
 */
export function sameBuild(a: BuildStamp, b: BuildStamp): boolean {
  return a.commit === b.commit && a.builtAt === b.builtAt
}

/**
 * Whether the server has moved on from the build this device is running.
 *
 * `production` is `import.meta.env.PROD` at the call site. In development Vite serves the
 * bundle and `app/dist` — where `/health` reads its stamp — is whatever the last
 * `vite build` left behind, so the two never agree and the comparison would say "behind"
 * forever. It is not a comparison worth making there, and this says so by returning false.
 */
export function serverIsAhead(
  device: BuildStamp,
  server: BuildStamp | null | undefined,
  production: boolean,
): boolean {
  if (!production || server === null || server === undefined) return false
  return !sameBuild(device, server)
}
