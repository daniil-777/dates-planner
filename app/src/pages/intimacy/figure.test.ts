/**
 * The figure's regions — CONTRACTS.md §13.1.
 *
 * `buildFigure` decides a zone for every vertex by running positional rules over the built
 * geometry. That is flexible and it is also exactly the kind of code that goes quietly
 * wrong: change a landmark height by two centimetres and a region can stop existing
 * without anything throwing. `intimate` is bounded above by the waist and below by the
 * crotch, and behind by a z-test; `innerThighs` exists only on the half of each leg facing
 * the other one. Either can be squeezed to nothing by an edit that looks harmless.
 *
 * So the assertion is coverage, not geometry: every code the contract lists must own real
 * vertices on all three forms, and no vertex may carry a code that is not on the list.
 * These run without WebGL — geometry is arithmetic, and none of it needs a canvas.
 */
import { describe, expect, it } from 'vitest'

import { buildFigure } from './figure'
import { FORMS, ZONE_CODES, type ZoneCode } from './zones'

/** How many vertices each region owns, for one form. */
function census(form: (typeof FORMS)[number]): Map<ZoneCode, number> {
  const { zones } = buildFigure(form)
  const counts = new Map<ZoneCode, number>()
  for (const index of zones) {
    const code = ZONE_CODES[index]
    if (code === undefined) throw new Error(`vertex tagged with unknown zone index ${index}`)
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return counts
}

describe.each(FORMS)('the %s figure', form => {
  const counts = census(form)

  it('has every region the contract lists', () => {
    const missing = ZONE_CODES.filter(code => (counts.get(code) ?? 0) === 0)
    expect(missing, `regions with no vertices: ${missing.join(', ')}`).toEqual([])
  })

  it('gives every region enough surface to be worth tapping', () => {
    // Not a pixel measurement — a floor low enough that any honest region clears it and
    // high enough to catch one that has collapsed to a sliver at a boundary.
    const thin = ZONE_CODES.filter(code => (counts.get(code) ?? 0) < 12)
    expect(thin, `regions that all but vanished: ${thin.join(', ')}`).toEqual([])
  })

  it('tags no vertex with anything outside the vocabulary', () => {
    for (const code of counts.keys()) expect(ZONE_CODES).toContain(code)
  })

  it('builds a mesh with matching position and zone counts', () => {
    const figure = buildFigure(form)
    expect(figure.zones.length).toBe(figure.geometry.getAttribute('position').count)
    // The colour attribute is what `paint` writes into; a mismatch here shows up as
    // regions lighting up one vertex out of step with the one that was chosen.
    expect(figure.geometry.getAttribute('color').count).toBe(figure.zones.length)
  })
})

describe('the forms differ', () => {
  it('draws a different silhouette for each', () => {
    // Shoulders and hips are where the three actually differ; if a future edit collapses
    // them onto one set of proportions this is what notices.
    const widths = FORMS.map(form => {
      const { geometry } = buildFigure(form)
      const position = geometry.getAttribute('position')
      let widest = 0
      for (let i = 0; i < position.count; i += 1) {
        if (position.getY(i) > 1.3) widest = Math.max(widest, Math.abs(position.getX(i)))
      }
      return Math.round(widest * 1000)
    })
    expect(new Set(widths).size).toBe(FORMS.length)
  })
})
