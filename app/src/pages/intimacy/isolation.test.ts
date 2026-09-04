/**
 * The touch map stays where it is put — CONTRACTS.md §13.4.
 *
 * ## Why this is a test and not a comment
 *
 * §13.4 makes three promises about the most private rows in the app: they are **never sent to
 * a language model**, and they **never appear on a shared surface** — no home-tile figure, no
 * statement line, no memory, no notification body. Those promises are currently kept by
 * everybody having read the rule, which is the weakest form of enforcement there is. The
 * commons has the same class of rule and enforces it *structurally*, by having no association
 * that could be joined; there is no equivalent trick available here, because the data is
 * ordinary rows in the household's own database and any page could read them.
 *
 * So the enforcement is a test that walks the source. It is deliberately about **imports**
 * rather than about behaviour: the way this rule gets broken is not somebody deciding to leak
 * a touch map, it is somebody building a nice summary widget and reaching for the nearest
 * module that has the data in it.
 *
 * It will fire on a legitimate refactor — moving `zones.ts` somewhere shared, say. That is
 * the point: such a move is exactly the change that deserves a second look, and the failure
 * message says so rather than just going red.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../')
const INTIMACY = resolve(HERE)

/**
 * `IntimacyPage.tsx` is part of the feature and sits one directory up, because that is where
 * the router looks for a page. It is the one legitimate importer of everything in here.
 */
const THE_PAGE = resolve(SRC, 'pages/IntimacyPage.tsx')

/** Every source file under `src`, excluding the intimacy page's own directory. */
function sourcesOutsideIntimacy(): string[] {
  const found: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (resolve(path) === INTIMACY) continue
        walk(path)
        continue
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(path)
    }
  }

  walk(SRC)
  return found
}

describe('the touch map does not leave its own page', () => {
  it('is imported by nothing outside app/src/pages/intimacy', () => {
    // The rule this guards is not "do not leak on purpose". It is that somebody building a
    // household summary reaches for the nearest module holding the data, and this data must
    // never be the nearest anything.
    const offenders: string[] = []

    for (const file of sourcesOutsideIntimacy()) {
      if (resolve(file) === THE_PAGE) continue

      const source = readFileSync(file, 'utf8')
      // Any import that resolves into the intimacy directory, however it is spelled.
      for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const isIntimacy =
          specifier.includes('pages/intimacy/') || /(^|\/)intimacy\/[A-Za-z]/.test(specifier)
        if (isIntimacy) offenders.push(`${relative(SRC, file)} imports ${specifier}`)
      }
    }

    expect(
      offenders,
      'CONTRACTS §13.4: touch-map modules must not be reachable from anywhere else.\n' +
        'If this is a deliberate refactor, move the shared part OUT of pages/intimacy rather\n' +
        'than importing into it — and check the new home is not a shared surface.',
    ).toEqual([])
  })

  it('is not named in any statement, memory, notification or home-tile module', () => {
    // The four surfaces §13.4 names by name. Checked by symbol rather than by import,
    // because a fetch to `/api/ledger/BodyMaps` needs no import at all.
    const forbidden = /BodyMaps|BodyZones|touchMap|TouchMap/
    const surfaces = sourcesOutsideIntimacy().filter(file =>
      /statement|memor|notification|home\/|Home|chat/i.test(relative(SRC, file)),
    )

    const offenders = surfaces
      .filter(file => forbidden.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file))

    expect(
      offenders,
      'CONTRACTS §13.4: no statement, memory, notification or launcher surface may name the ' +
        'touch map.',
    ).toEqual([])
  })

  it('has surfaces to check, so a rename cannot make this test vacuously pass', () => {
    // Without this, moving or renaming the statement and memory pages would empty the filter
    // above and the previous test would go green by having nothing to look at.
    const surfaces = sourcesOutsideIntimacy().filter(file =>
      /statement|memor|notification|home\/|Home|chat/i.test(relative(SRC, file)),
    )
    expect(surfaces.length).toBeGreaterThan(4)
  })
})
