/*
 * The stamp plugin's resolution — the pure part, plus the one call into git.
 *
 * The Docker build has no `.git` and passes `GIT_SHA`; the laptop has git and no
 * `GIT_SHA`; a tarball has neither. All three must produce a stamp, and only the last one
 * may say `unknown`.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCommit, resolveBuildStamp } from '../../vite/buildStamp'

const NOW = new Date('2026-09-01T10:47:13.211Z')
const PACKAGE = JSON.stringify({ name: 'two-way-match', version: '1.4.0' })

describe('resolveBuildStamp', () => {
  it('prefers GIT_SHA from the environment, shortened and lower-cased', () => {
    const stamp = resolveBuildStamp({
      env: { GIT_SHA: '8CEA17B0DEADBEEF' },
      packageJson: PACKAGE,
      gitCommit: 'abcdef1',
      now: NOW,
    })
    expect(stamp).toEqual({ version: '1.4.0', commit: '8cea17b', builtAt: NOW.toISOString() })
  })

  it('falls back to git when GIT_SHA is absent or empty', () => {
    expect(
      resolveBuildStamp({ env: {}, packageJson: PACKAGE, gitCommit: 'abcdef1', now: NOW }).commit,
    ).toBe('abcdef1')
    expect(
      resolveBuildStamp({
        env: { GIT_SHA: '  ' },
        packageJson: PACKAGE,
        gitCommit: 'abcdef1',
        now: NOW,
      }).commit,
    ).toBe('abcdef1')
  })

  it('rejects anything that is not a SHA rather than stamping garbage', () => {
    for (const bad of ['main', 'HEAD', 'abc', '8cea17b; rm -rf /', '${GIT_SHA}']) {
      expect(
        resolveBuildStamp({
          env: { GIT_SHA: bad },
          packageJson: PACKAGE,
          gitCommit: null,
          now: NOW,
        }).commit,
        bad,
      ).toBe('unknown')
    }
  })

  it('keeps the -dirty mark scripts/deploy.sh puts on an uncommitted tree', () => {
    const stamp = resolveBuildStamp({
      env: { GIT_SHA: '8CEA17B0DEADBEEF-dirty' },
      packageJson: PACKAGE,
      gitCommit: null,
      now: NOW,
    })
    expect(stamp.commit).toBe('8cea17b-dirty')
  })

  it('says unknown when neither the environment nor git can answer', () => {
    const stamp = resolveBuildStamp({ env: {}, packageJson: PACKAGE, gitCommit: null, now: NOW })
    expect(stamp.commit).toBe('unknown')
    // Even then two builds are told apart by their time.
    expect(stamp.builtAt).toBe('2026-09-01T10:47:13.211Z')
  })

  it('reads the version from package.json and falls back to 0.0.0', () => {
    const inputs = { env: {}, gitCommit: null, now: NOW }
    expect(resolveBuildStamp({ ...inputs, packageJson: PACKAGE }).version).toBe('1.4.0')
    expect(resolveBuildStamp({ ...inputs, packageJson: undefined }).version).toBe('0.0.0')
    expect(resolveBuildStamp({ ...inputs, packageJson: '{not json' }).version).toBe('0.0.0')
    expect(resolveBuildStamp({ ...inputs, packageJson: '{"version": 3}' }).version).toBe('0.0.0')
    expect(resolveBuildStamp({ ...inputs, packageJson: '{"version": ""}' }).version).toBe('0.0.0')
  })
})

describe('gitCommit', () => {
  // Skipped where there is no HEAD to resolve — a source tarball, a runner image without
  // git, a bind mount git refuses as "dubious ownership". The build is still valid there;
  // the stamp says `unknown`, which is what the null path below covers.
  it.skipIf(gitCommit(process.cwd()) === null)(
    'answers with a short SHA inside a repository',
    () => {
      expect(gitCommit(process.cwd())).toMatch(/^[0-9a-f]{7}$/)
    },
  )

  it('answers null outside one, without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twm-nogit-'))
    try {
      expect(gitCommit(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
