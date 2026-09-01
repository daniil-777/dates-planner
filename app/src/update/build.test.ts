/*
 * The device/server comparison.
 */
import { describe, expect, it } from 'vitest'
import { gitCommit } from '../../vite/buildStamp'
import { BUILD, sameBuild, serverIsAhead } from './build'

const A = { version: '1.0.0', commit: '8cea17b', builtAt: '2026-09-01T10:00:00.000Z' }

/**
 * Null in a source tarball or a container without git — the stamp then says `unknown`. A
 * `GIT_SHA` in the environment wins over git (that is how the Docker build gets its commit),
 * so the comparison is only meaningful without one.
 */
const sha = process.env.GIT_SHA === undefined ? gitCommit(process.cwd()) : null

describe('build', () => {
  it('is stamped by the Vite plugin, even under vitest', () => {
    // The plugin's `config()` hook runs for the test runner too, so the constant is a real
    // stamp here — not the `unknown` fallback.
    expect(BUILD.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(BUILD.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(BUILD.commit).toMatch(/^([0-9a-f]{7}|unknown)$/)
  })

  it.skipIf(sha === null)('carries the commit of the checkout it was built from', () => {
    expect(BUILD.commit).toBe(sha)
  })

  it('treats a rebuild of the same commit as a different build', () => {
    expect(sameBuild(A, { ...A })).toBe(true)
    expect(sameBuild(A, { ...A, commit: 'deadbee' })).toBe(false)
    expect(sameBuild(A, { ...A, builtAt: '2026-09-01T11:00:00.000Z' })).toBe(false)
    // The version alone does not count: `/health.version` is the release, not the bundle.
    expect(sameBuild(A, { ...A, version: '9.9.9' })).toBe(true)
  })

  it('says the server is ahead only in production, and only with a stamp to compare', () => {
    const newer = { ...A, commit: 'deadbee' }
    expect(serverIsAhead(A, newer, true)).toBe(true)
    expect(serverIsAhead(A, { ...A }, true)).toBe(false)
    expect(serverIsAhead(A, null, true)).toBe(false)
    expect(serverIsAhead(A, undefined, true)).toBe(false)
    // In development the served bundle and `app/dist` are different things; no comparison.
    expect(serverIsAhead(A, newer, false)).toBe(false)
  })
})
