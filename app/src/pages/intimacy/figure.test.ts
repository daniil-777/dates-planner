/**
 * The figure's regions — CONTRACTS.md §13.1.
 *
 * `buildFigure` polygonises a distance field and then decides a region for every vertex it
 * produced. That is flexible and it is also exactly the kind of code that goes quietly
 * wrong: move a landmark by two centimetres and a region can stop existing without
 * anything throwing. `intimate` is bounded above by the belly and below by the crotch;
 * `innerThighs` exists only on the half of each leg facing the other one; `lips` is two
 * centimetres tall on a mesh whose cells are twelve millimetres. Any of them can be
 * squeezed to nothing by an edit that looks harmless — and two of them were, during the
 * rebuild, which is what these assertions are for.
 *
 * So the assertions are about *coverage and shape*, not about geometry:
 *
 *  - every code the contract lists owns real surface on all three forms;
 *  - that surface is measured in square centimetres rather than in vertices, because a
 *    vertex count silently tracks the grid resolution and a person's fingertip does not;
 *  - each region is a *small number of connected patches*, which is what catches a region
 *    that technically exists but has been scattered into speckle along a boundary — the
 *    failure a raw count cannot see;
 *  - no vertex carries a code outside the vocabulary.
 *
 * These run without WebGL: geometry is arithmetic, and none of it needs a canvas.
 */
import { describe, expect, it } from 'vitest'

import { BufferAttribute, Color } from 'three'

import { buildFigure, clearFigureCache, paint } from './figure'
import { FORMS, LEVEL_SPECS, ZONE_CODES, type ZoneCode } from './zones'

/**
 * How much surface each region owns, in square centimetres.
 *
 * A triangle is credited to a region in thirds, one per vertex, so a triangle straddling a
 * boundary is shared rather than assigned by a tie-break nobody could predict.
 */
function areaByZone(form: (typeof FORMS)[number]): Map<ZoneCode, number> {
  const { geometry, zones } = buildFigure(form)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (index === null) throw new Error('the figure should be an indexed mesh')

  const areas = new Map<ZoneCode, number>()
  for (const code of ZONE_CODES) areas.set(code, 0)

  for (let t = 0; t < index.count; t += 3) {
    const ia = index.getX(t)
    const ib = index.getX(t + 1)
    const ic = index.getX(t + 2)

    const ux = position.getX(ib) - position.getX(ia)
    const uy = position.getY(ib) - position.getY(ia)
    const uz = position.getZ(ib) - position.getZ(ia)
    const vx = position.getX(ic) - position.getX(ia)
    const vy = position.getY(ic) - position.getY(ia)
    const vz = position.getZ(ic) - position.getZ(ia)
    // Half the cross product's length, then m² to cm².
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 10_000

    for (const vertex of [ia, ib, ic]) {
      const code = ZONE_CODES[zones[vertex]!]
      if (code === undefined) throw new Error(`vertex tagged with unknown zone ${zones[vertex]}`)
      areas.set(code, (areas.get(code) ?? 0) + area / 3)
    }
  }
  return areas
}

/** How many separate patches each region breaks into, walking the mesh's own edges. */
function patchesByZone(form: (typeof FORMS)[number]): Map<ZoneCode, number> {
  const { geometry, zones } = buildFigure(form)
  const index = geometry.getIndex()
  if (index === null) throw new Error('the figure should be an indexed mesh')

  const count = zones.length
  const neighbours: number[][] = Array.from({ length: count }, () => [])
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t)
    const b = index.getX(t + 1)
    const c = index.getX(t + 2)
    // Only edges *within* a region matter; an edge across a boundary joins nothing.
    if (zones[a] === zones[b]) {
      neighbours[a]!.push(b)
      neighbours[b]!.push(a)
    }
    if (zones[b] === zones[c]) {
      neighbours[b]!.push(c)
      neighbours[c]!.push(b)
    }
    if (zones[a] === zones[c]) {
      neighbours[a]!.push(c)
      neighbours[c]!.push(a)
    }
  }

  const seen = new Uint8Array(count)
  const patches = new Map<ZoneCode, number>()
  for (let v = 0; v < count; v += 1) {
    if (seen[v] === 1) continue
    const code = ZONE_CODES[zones[v]!]!
    // A patch of one or two vertices is a rounding artefact at a boundary, not a patch.
    let size = 0
    const stack = [v]
    seen[v] = 1
    while (stack.length > 0) {
      const current = stack.pop()!
      size += 1
      for (const next of neighbours[current]!) {
        if (seen[next] === 0) {
          seen[next] = 1
          stack.push(next)
        }
      }
    }
    if (size > 3) patches.set(code, (patches.get(code) ?? 0) + 1)
  }
  return patches
}

/**
 * Regions that are genuinely two patches because the body has two of them, plus the head's
 * regions, which the hairline and the ears cut into more pieces than you would guess.
 */
const EXPECTED_PATCHES: Partial<Record<ZoneCode, number>> = {
  shoulders: 2,
  arms: 2,
  hands: 2,
  thighs: 2,
  innerThighs: 2,
  calves: 2,
  feet: 2,
  glutes: 2,
  hips: 2,
  ears: 2,
  face: 3,
  hair: 3,
  lips: 2,
}

describe.each(FORMS)('the %s figure', form => {
  clearFigureCache()
  const areas = areaByZone(form)

  it('has every region the contract lists', () => {
    const missing = ZONE_CODES.filter(code => (areas.get(code) ?? 0) === 0)
    expect(missing, `regions with no surface: ${missing.join(', ')}`).toEqual([])
  })

  it('gives every region enough surface to be worth tapping', () => {
    // Twelve square centimetres is about a thumbprint and a half. Small enough that an
    // honest region like `lips` clears it, large enough to catch one that has collapsed to
    // a sliver along a boundary. Measured in area, not vertices, so raising or lowering
    // the mesh resolution cannot move the threshold under the test's feet.
    const thin = ZONE_CODES.filter(code => (areas.get(code) ?? 0) < 12)
    const detail = thin.map(code => `${code} ${(areas.get(code) ?? 0).toFixed(1)}cm²`)
    expect(thin, `regions that all but vanished: ${detail.join(', ')}`).toEqual([])
  })

  it('keeps each region in one or two pieces rather than scattered', () => {
    const patches = patchesByZone(form)
    const scattered = ZONE_CODES.filter(
      code => (patches.get(code) ?? 0) > (EXPECTED_PATCHES[code] ?? 1),
    )
    const detail = scattered.map(code => `${code} in ${patches.get(code)} pieces`)
    expect(scattered, `regions broken into speckle: ${detail.join(', ')}`).toEqual([])
  })

  it('tags no vertex with anything outside the vocabulary', () => {
    const { zones } = buildFigure(form)
    for (const index of zones) expect(ZONE_CODES[index]).toBeDefined()
  })

  it('builds one indexed mesh whose attributes agree', () => {
    const figure = buildFigure(form)
    expect(figure.zones.length).toBe(figure.geometry.getAttribute('position').count)
    // The colour attribute is what `paint` writes into; a mismatch shows up as regions
    // lighting up one vertex out of step with the one that was chosen.
    expect(figure.geometry.getAttribute('color').count).toBe(figure.zones.length)
    expect(figure.geometry.getAttribute('normal').count).toBe(figure.zones.length)
    expect(figure.geometry.getIndex()).not.toBeNull()
  })

  it('has no holes in it', () => {
    // An edge used by exactly one triangle is the rim of a hole. That is the failure that
    // matters, and it is the one that actually happened while this was being built: a
    // groove positioned inside the pelvis rather than on its surface opened a gap in the
    // lower back that no other assertion here noticed.
    //
    // An edge used by *more* than two is a different thing and is tolerated. Surface nets
    // puts one vertex in each cell, so wherever two surfaces pass within a single cell of
    // each other — the inner thighs, a hand beside a hip — the two sheets share that
    // vertex and pinch. It is a known property of the algorithm, it costs a handful of
    // edges out of ninety thousand, and it is invisible to both the renderer and the
    // raycaster. A hole is not.
    const { geometry } = buildFigure(form)
    const index = geometry.getIndex()!
    const uses = new Map<number, number>()
    const bump = (a: number, b: number): void => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a
      uses.set(key, (uses.get(key) ?? 0) + 1)
    }
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t)
      const b = index.getX(t + 1)
      const c = index.getX(t + 2)
      bump(a, b)
      bump(b, c)
      bump(c, a)
    }
    let open = 0
    let pinched = 0
    for (const n of uses.values()) {
      if (n === 1) open += 1
      else if (n > 2) pinched += 1
    }
    expect(open, `${open} edges border a hole`).toBe(0)
    // Loose, but not unbounded: a pinch count in the hundreds would mean two parts of the
    // body had genuinely fused, which is a modelling mistake and not an algorithm quirk.
    expect(pinched, `${pinched} edges are pinched between two surfaces`).toBeLessThan(40)
  })
})

describe('the forms differ', () => {
  it('draws a different silhouette for each', () => {
    // Shoulder span and hip span are where the three actually differ, and they differ in
    // *opposite* directions — that ratio is what the eye reads as a body shape, so a future
    // edit that collapsed the three onto one set of proportions would show up here first.
    const ratios = FORMS.map(form => {
      const { geometry } = buildFigure(form)
      const position = geometry.getAttribute('position')
      let shoulder = 0
      let hip = 0
      for (let i = 0; i < position.count; i += 1) {
        const y = position.getY(i)
        const x = Math.abs(position.getX(i))
        if (y > 1.36 && y < 1.46) shoulder = Math.max(shoulder, x)
        if (y > 0.9 && y < 1.0) hip = Math.max(hip, x)
      }
      return Math.round((shoulder / hip) * 100)
    })
    expect(new Set(ratios).size).toBe(FORMS.length)
    // The masculine figure must read wider at the shoulder relative to the hip than the
    // feminine one. This is the single strongest cue of the three, and it is the one an
    // innocent-looking tweak to a breadth is most likely to invert.
    const [feminine, masculine] = ratios
    expect(masculine).toBeGreaterThan(feminine!)
  })
})

describe('the surface faces outward', () => {
  it.each(FORMS)('winds every triangle of the %s figure away from the inside', form => {
    // Nothing else here would have caught this, and nothing on screen looks broken when it
    // is wrong: the material shades from the vertex normals, which are correct either way,
    // so an inside-out figure renders smoothly and simply appears to be facing away. The
    // check is that each triangle's geometric normal agrees with the vertex normals it was
    // built from — those come from the gradient of the distance field and always point out.
    const { geometry } = buildFigure(form)
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const index = geometry.getIndex()!

    let outward = 0
    let inward = 0
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t)
      const b = index.getX(t + 1)
      const c = index.getX(t + 2)
      const ux = position.getX(b) - position.getX(a)
      const uy = position.getY(b) - position.getY(a)
      const uz = position.getZ(b) - position.getZ(a)
      const vx = position.getX(c) - position.getX(a)
      const vy = position.getY(c) - position.getY(a)
      const vz = position.getZ(c) - position.getZ(a)
      const gx = uy * vz - uz * vy
      const gy = uz * vx - ux * vz
      const gz = ux * vy - uy * vx
      const agreement = gx * normal.getX(a) + gy * normal.getY(a) + gz * normal.getZ(a)
      if (agreement > 0) outward += 1
      else inward += 1
    }

    // Not every last triangle: a few sit on a pinch where two surfaces meet within one
    // cell, and their geometric normal is meaningless. The population is what matters.
    const share = outward / (outward + inward)
    expect(share, `only ${(share * 100).toFixed(1)}% of triangles face outward`).toBeGreaterThan(
      0.99,
    )
  })
})

/* ------------------------------------------------------------- highlight */

describe('the selection highlight', () => {
  /**
   * WCAG 2.1 relative luminance.
   *
   * No sRGB-to-linear step, because there is nothing to convert: three.js manages colour and
   * a `Color` holds **linear** components, which is already the space luminance is defined
   * in. Applying the usual transform here — the obvious thing to write — squares the
   * gamma and reported the highlight at 1.54:1 when it is 3.50:1.
   */
  function luminance(colour: Color): number {
    return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b
  }

  function contrast(a: Color, b: Color): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  /** Read the colour the mesh actually ended up with for one zone. */
  function colourOf(figure: ReturnType<typeof buildFigure>, zone: ZoneCode): Color {
    const attribute = figure.geometry.getAttribute('color') as BufferAttribute
    const array = attribute.array as Float32Array
    const index = figure.zones.findIndex(one => ZONE_CODES[one] === zone)
    expect(index, `no vertices for ${zone}`).toBeGreaterThanOrEqual(0)
    return new Color(array[index * 3], array[index * 3 + 1], array[index * 3 + 2])
  }

  it.each([
    ['light', '#d8c3b4'],
    ['dark', '#8d7566'],
  ])('is visible against the %s figure', (_name, base) => {
    // It used to lerp 28% towards white, which on the pale base measures 1.17:1 — WCAG
    // 1.4.11 asks 3:1 of a non-text indicator, and no amount of extra white reaches it,
    // because the base is already light. Tapping a region was the whole interaction and its
    // only feedback was a change nobody could see.
    const figure = buildFigure('neutral')
    paint(figure, new Map(), 'shoulders', base)

    const highlighted = colourOf(figure, 'shoulders')
    expect(contrast(highlighted, new Color(base))).toBeGreaterThanOrEqual(3)
  })

  it('cannot be mistaken for any of the four level colours', () => {
    // A selected-but-unmarked region must not read as an answer somebody has already given.
    const figure = buildFigure('neutral')
    paint(figure, new Map(), 'shoulders', '#d8c3b4')
    const highlighted = colourOf(figure, 'shoulders')

    for (const spec of LEVEL_SPECS) {
      expect(
        contrast(highlighted, new Color(spec.colour)),
        `highlight is too close to "${spec.label}"`,
      ).toBeGreaterThanOrEqual(3)
    }
  })
})
