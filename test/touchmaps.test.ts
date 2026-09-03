/**
 * The touch-map vocabulary — CONTRACTS.md §13.1.
 *
 * `ZONE_CODES` exists three times: in `srv/lib/constants.ts`, where the service validates
 * writes against it; in `app/src/pages/intimacy/zones.ts`, where the client labels and
 * draws it; and in the table in `docs/CONTRACTS.md`, which is what a person reads. The
 * three are not generated from one another, so nothing but this test stops them drifting.
 *
 * Drift here is quiet in a way that matters. A code the client knows and the server does
 * not becomes a 400 on a region that looks perfectly ordinary. A code the server knows and
 * the client does not becomes a stored row that is never drawn — the mark saves, the
 * figure does not change, and there is nothing to see in either log. The client reads the
 * app's list as text rather than importing it, because the two live in separate
 * TypeScript projects with separate module resolution; a regex over a frozen array is
 * uglier than an import and does not need a build step to be correct.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ZONE_CODES } from '../srv/lib/constants'

const ROOT = process.cwd()

/** The string literals of an `export const NAME = [...] as const` array. */
function frozenArray(source: string, name: string): string[] {
  const block = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source)
  if (block === null) throw new Error(`${name} is not an "as const" array any more`)
  return [...block[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

describe('touch-map zone codes', () => {
  it('is the list the contract documents', () => {
    expect(ZONE_CODES).toHaveLength(19)
    expect(new Set(ZONE_CODES).size).toBe(ZONE_CODES.length)
  })

  it('matches the client, code for code and in the same order', () => {
    const client = frozenArray(
      readFileSync(join(ROOT, 'app/src/pages/intimacy/zones.ts'), 'utf8'),
      'ZONE_CODES',
    )
    expect(client).toEqual([...ZONE_CODES])
  })

  it('gives every code a label the list can show', () => {
    const source = readFileSync(join(ROOT, 'app/src/pages/intimacy/zones.ts'), 'utf8')
    const labels = /export const ZONE_LABEL: Record<ZoneCode, string> = \{([\s\S]*?)\n\}/.exec(
      source,
    )
    expect(labels).not.toBeNull()
    const labelled = [...labels![1]!.matchAll(/^\s{2}(\w+):/gm)].map(match => match[1]!)
    expect(labelled.sort()).toEqual([...ZONE_CODES].sort())
  })

  it('orders every code exactly once for the region list', () => {
    const source = readFileSync(join(ROOT, 'app/src/pages/intimacy/zones.ts'), 'utf8')
    const ordered = frozenArray(
      source.replace(
        'export const ZONE_ORDER: readonly ZoneCode[] = [',
        'export const ZONE_ORDER = [',
      ) + ' as const',
      'ZONE_ORDER',
    )
    // A code missing from the order is a region that can only be reached by finding it on
    // the model, which is exactly the path somebody using a keyboard does not have.
    expect(ordered.sort()).toEqual([...ZONE_CODES].sort())
  })

  it('is documented in CONTRACTS.md', () => {
    const contract = readFileSync(join(ROOT, 'docs/CONTRACTS.md'), 'utf8')
    const section = contract.slice(contract.indexOf('### 13.1 Zone codes'))
    for (const code of ZONE_CODES) {
      expect(section, `${code} is not in the §13.1 table`).toContain(`\`${code}\``)
    }
  })
})
