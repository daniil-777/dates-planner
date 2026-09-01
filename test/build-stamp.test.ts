/*
 * The build stamp `/health` reports — read from `app/dist/build.json`, or null.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBuildStamp, readBuildStamp, resetBuildStampCache } from '../srv/lib/build-stamp'

const STAMP = { version: '1.0.0', commit: '8cea17b', builtAt: '2026-09-01T10:47:13.211Z' }

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twm-stamp-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  resetBuildStampCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseBuildStamp', () => {
  it('accepts exactly three strings', () => {
    expect(parseBuildStamp(JSON.stringify(STAMP))).toEqual(STAMP)
    expect(parseBuildStamp(JSON.stringify({ ...STAMP, extra: 1 }))).toEqual(STAMP)
  })

  it('rejects everything else', () => {
    expect(parseBuildStamp('')).toBeNull()
    expect(parseBuildStamp('{not json')).toBeNull()
    expect(parseBuildStamp('null')).toBeNull()
    expect(parseBuildStamp('"a string"')).toBeNull()
    expect(parseBuildStamp(JSON.stringify({ version: '1.0.0', commit: '8cea17b' }))).toBeNull()
    expect(parseBuildStamp(JSON.stringify({ ...STAMP, commit: 7 }))).toBeNull()
    expect(parseBuildStamp(JSON.stringify({ ...STAMP, commit: '' }))).toBeNull()
  })
})

describe('readBuildStamp', () => {
  it('reads a stamp the frontend build wrote', () => {
    const path = join(scratch(), 'build.json')
    writeFileSync(path, `${JSON.stringify(STAMP, null, 2)}\n`)
    expect(readBuildStamp(path)).toEqual(STAMP)
  })

  it('is null for a missing or malformed file, and never throws', () => {
    const dir = scratch()
    expect(readBuildStamp(join(dir, 'build.json'))).toBeNull()
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{')
    expect(readBuildStamp(path)).toBeNull()
  })

  it('notices a new build without a restart', () => {
    const path = join(scratch(), 'build.json')
    writeFileSync(path, JSON.stringify(STAMP))
    utimesSync(path, new Date('2026-09-01T10:00:00Z'), new Date('2026-09-01T10:00:00Z'))
    expect(readBuildStamp(path)?.commit).toBe('8cea17b')

    writeFileSync(path, JSON.stringify({ ...STAMP, commit: 'deadbee' }))
    utimesSync(path, new Date('2026-09-01T11:00:00Z'), new Date('2026-09-01T11:00:00Z'))
    expect(readBuildStamp(path)?.commit).toBe('deadbee')
  })

  it('serves the cache while the file is unchanged', () => {
    const path = join(scratch(), 'build.json')
    writeFileSync(path, JSON.stringify(STAMP))
    const when = new Date('2026-09-01T10:00:00Z')
    utimesSync(path, when, when)
    expect(readBuildStamp(path)?.commit).toBe('8cea17b')

    // Same mtime, different content: the cache answers, which is the point of keying on mtime.
    writeFileSync(path, JSON.stringify({ ...STAMP, commit: 'deadbee' }))
    utimesSync(path, when, when)
    expect(readBuildStamp(path)?.commit).toBe('8cea17b')
  })
})
