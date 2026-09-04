/**
 * The figure — one continuous surface, with a region written onto every vertex.
 *
 * ## Where it comes from
 *
 * It is a sculpt, not a construction: MakeHuman's `hm08` base mesh, released as CC0 in 2020,
 * morphed by MakeHuman's own macro targets and baked by `app/scripts/bake-figure.ts` into
 * `figureData.ts`. That script is where the interesting decisions are and where to go to
 * change how the body looks or where a region begins. This module only unpacks what it
 * wrote, which is deliberately dull work: 13 380 vertices of quads, a region byte each, and
 * two sets of 16-bit coordinates.
 *
 * The figure used to be generated here on the phone, from a signed distance field of forty
 * blended masses. It was replaced because that approach has a ceiling: soft masses can make
 * a deltoid and they cannot make an ear, a heel or five fingers, and every extra mass cost
 * another second of a phone's time. A sculpt has the anatomy already and costs a decode.
 *
 * ## Why one mesh and not nineteen
 *
 * Unchanged, and still right: a mesh per region means nineteen draw calls and a seam
 * wherever two regions meet on a curve — and the regions that matter most are the front and
 * back halves of the same limb, which have no seam to be cut along. So every vertex carries
 * its region as an attribute, picking reads the attribute off the face the ray hit, and
 * highlighting writes vertex colours for it. One representation, so the region that lights
 * up is necessarily the region that was tapped.
 *
 * ## Neutral is the midpoint, and that is exact
 *
 * The asset stores `feminine` and `masculine` only. Each is the base mesh plus the mean of
 * three of MakeHuman's macro targets, so the mean of all six — which is what `neutral` is —
 * is their midpoint, arrived at by construction rather than by taste. It costs an add per
 * coordinate and saves a third of the file.
 */
import { BufferAttribute, BufferGeometry, Color, Sphere, Vector3 } from 'three'

import { FIGURE_ASSET_BASE64 } from './figureData'
import { ZONE_CODES, type BodyForm, type ZoneCode } from './zones'

/** Height of the figure in metres. The bake scales the mesh to it; the camera trusts it. */
export const FIGURE_HEIGHT = 1.8

/** `'TWMF'`, and the layout version the reader below understands. */
const MAGIC = 0x464d5754
const VERSION = 1

export interface Figure {
  geometry: BufferGeometry
  /** Zone of every vertex, parallel to the position attribute. */
  zones: Uint8Array
}

interface Asset {
  readonly vertexCount: number
  /** Quads, four vertex indices each — the topology, shared by every form. */
  readonly quads: Uint16Array
  /** Zone of every vertex, shared by every form: a vertex is the same anatomy in all of them. */
  readonly zones: Uint8Array
  /** Quantised coordinates, `feminine` then `masculine`, over `min`…`max`. */
  readonly coordinates: Uint16Array
  readonly min: Float32Array
  readonly max: Float32Array
}

let decoded: Asset | null = null

/**
 * Unpacks the asset once.
 *
 * `atob` rather than a `Buffer` or a `TextEncoder` dance, because this runs in a browser,
 * in vitest and under `tsx`, and `atob` is the one spelling all three agree on.
 */
function asset(): Asset {
  if (decoded !== null) return decoded

  const binary = atob(FIGURE_ASSET_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)

  const magic = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  if (magic !== MAGIC || version !== VERSION) {
    throw new Error(
      `figureData is not a v${VERSION} figure asset — re-run app/scripts/bake-figure.ts`,
    )
  }
  const vertexCount = view.getUint32(8, true)
  const quadCount = view.getUint32(12, true)
  const formCount = view.getUint32(16, true)
  const zoneCount = view.getUint32(20, true)
  if (zoneCount !== ZONE_CODES.length) {
    throw new Error(
      `the asset was baked with ${zoneCount} regions and the app has ${ZONE_CODES.length} ` +
        '— re-run app/scripts/bake-figure.ts',
    )
  }

  const min = new Float32Array(3)
  const max = new Float32Array(3)
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = view.getFloat32(24 + axis * 4, true)
    max[axis] = view.getFloat32(36 + axis * 4, true)
  }

  // The blocks are laid out back to back after the header, and each is read as a typed view
  // over the same bytes rather than copied out of them.
  let at = 48
  const quads = new Uint16Array(bytes.buffer, at, quadCount * 4)
  at += quadCount * 4 * 2
  const zones = new Uint8Array(bytes.buffer, at, vertexCount)
  at += vertexCount
  const coordinates = new Uint16Array(bytes.buffer, at, formCount * vertexCount * 3)

  decoded = { vertexCount, quads, zones, coordinates, min, max }
  return decoded
}

/** Dequantised coordinates for one form. `neutral` is the midpoint of the two stored ones. */
function positionsOf(form: BodyForm): Float32Array {
  const { vertexCount, coordinates, min, max } = asset()
  const stride = vertexCount * 3
  const out = new Float32Array(stride)
  for (let i = 0; i < stride; i += 1) {
    const axis = i % 3
    const span = (max[axis]! - min[axis]!) / 65535
    const quantised =
      form === 'feminine'
        ? coordinates[i]!
        : form === 'masculine'
          ? coordinates[stride + i]!
          : (coordinates[i]! + coordinates[stride + i]!) / 2
    out[i] = min[axis]! + quantised * span
  }
  return out
}

/**
 * Builds one form's geometry, ready to render and to pick against.
 *
 * Deterministic: the same form always produces the same mesh, vertex for vertex — which is
 * what lets the tests assert on it and what makes the memo safe. Somebody switching between
 * the three forms to compare them pays the build once per form and nothing after.
 */
const cache = new Map<BodyForm, Figure>()

export function buildFigure(form: BodyForm): Figure {
  const cached = cache.get(form)
  if (cached !== undefined) return cached
  const built = build(form)
  cache.set(form, built)
  return built
}

/** Drops the memoised figures. Only the tests need this. */
export function clearFigureCache(): void {
  cache.clear()
}

function build(form: BodyForm): Figure {
  const { vertexCount, quads, zones } = asset()
  const positions = positionsOf(form)

  // Quads to triangles, split along the same diagonal the bake used to measure area and to
  // check the winding, so what is drawn is what was measured.
  const quadCount = quads.length / 4
  const indices = new Uint32Array(quadCount * 6)
  for (let q = 0; q < quadCount; q += 1) {
    const a = quads[q * 4]!
    const b = quads[q * 4 + 1]!
    const c = quads[q * 4 + 2]!
    const d = quads[q * 4 + 3]!
    indices[q * 6] = a
    indices[q * 6 + 1] = b
    indices[q * 6 + 2] = c
    indices[q * 6 + 3] = a
    indices[q * 6 + 4] = c
    indices[q * 6 + 5] = d
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(vertexCount * 3), 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  // The surface is watertight and every vertex is shared by the quads around it, so the
  // averaged face normals are the smooth normals — there is no crease to protect and nothing
  // for a split-vertex pass to fix.
  geometry.computeVertexNormals()
  geometry.boundingSphere = new Sphere(new Vector3(0, FIGURE_HEIGHT / 2, 0), FIGURE_HEIGHT * 0.62)
  geometry.computeBoundingBox()

  // The zone array is shared across forms and must not be handed out mutable-by-accident to
  // three of them, so each figure gets its own copy of a very small array.
  return { geometry, zones: Uint8Array.from(zones) }
}

/**
 * Writes vertex colours for the current marks.
 *
 * Called on every selection and every hover, so it allocates nothing per vertex and walks
 * the list once. `needsUpdate` is what actually gets the new colours to the GPU — without it
 * the array changes and the picture does not, which looks exactly like a broken click
 * handler and is the first thing to check if this ever appears not to work.
 */
/**
 * The colour a selected region is painted.
 *
 * It used to lerp 28% towards **white**, and that direction cannot work at all: the light
 * figure's base is `#d8c3b4`, already pale, so lightening it gives **1.17:1** against its
 * surroundings. WCAG 1.4.11 asks 3:1 of a non-text indicator and the ceiling going lighter is
 * 1.50:1 even at 75% white. The dark figure managed 1.63:1 — no better in practice.
 *
 * It is a replacement rather than a tint, which is the part worth noting. A partial mix has
 * to clear 3:1 against *both* base figures while staying clearly apart from four level
 * colours, and there is no mix amount that does: 80% towards near-black reaches 3.71:1 on the
 * light base but only 2.66:1 on the dark one, and lands 1.02:1 from "Favourite". Painting the
 * region outright measures 11.55:1 and 4.54:1 against the two bases and 3.18:1 from the
 * nearest level colour, which is the only arrangement that clears everything.
 *
 * What is given up is seeing a region's existing mark while it is selected. The level buttons
 * show that, and they are on screen precisely then.
 *
 * This mattered more than a contrast number usually does: tapping a region was the entire
 * interaction, and its only feedback was a change nobody could see.
 *
 * (Contrast figures are computed in **linear** space, which is what three.js `Color` holds.
 * Converting from sRGB first — the obvious thing to write — squares the gamma and reports
 * 1.54:1 where the truth is 3.50:1.)
 */
const HIGHLIGHT = new Color('#0d0b10')

export function paint(
  figure: Figure,
  marks: ReadonlyMap<ZoneCode, string>,
  hovered: ZoneCode | null,
  base: string,
): void {
  const attribute = figure.geometry.getAttribute('color') as BufferAttribute
  const baseColour = new Color(base)

  // One Color per zone rather than one per vertex: nineteen parses instead of thirteen
  // thousand.
  const perZone = ZONE_CODES.map(code => {
    const mark = marks.get(code)
    const resolved = mark === undefined ? baseColour.clone() : new Color(mark)
    if (code === hovered) resolved.copy(HIGHLIGHT)
    return resolved
  })

  const array = attribute.array as Float32Array
  for (let i = 0; i < figure.zones.length; i += 1) {
    const colour = perZone[figure.zones[i]!] ?? baseColour
    array[i * 3] = colour.r
    array[i * 3 + 1] = colour.g
    array[i * 3 + 2] = colour.b
  }
  attribute.needsUpdate = true
}

/** The zone a raycast hit, read off the first vertex of the face it landed on. */
export function zoneOfFace(figure: Figure, vertexIndex: number): ZoneCode | null {
  const index = figure.zones[vertexIndex]
  return index === undefined ? null : (ZONE_CODES[index] ?? null)
}
