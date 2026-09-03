/**
 * The mannequin — one merged mesh, with a zone written onto every vertex.
 *
 * ## Why one mesh and not nineteen
 *
 * The obvious build is a mesh per region, which makes picking trivial (`intersect.object`)
 * and everything else hard: nineteen draw calls, nineteen materials to keep in step, and
 * visible seams wherever two regions meet on a curve. Worse, the regions that matter most
 * here are front-and-back halves of the same limb, and there is no seam to cut them along.
 *
 * So the figure is built as a handful of primitives, every vertex is tagged with the
 * region it falls in, and the primitives are merged into a single geometry. Picking reads
 * the tag off the face the ray hit; highlighting writes vertex colours for the tag. Both
 * read the same attribute, which is what guarantees the region that lights up is the
 * region you actually selected — with separate meshes those are two representations that
 * can drift.
 *
 * ## The figure is a mannequin on purpose
 *
 * Smooth artist's-figure forms, no modelled anatomy. It is what can honestly be built from
 * primitives without a licensed scan, it is tasteful enough to leave open on a kitchen
 * table, and it is *clearer* for the job: this drawing exists to let somebody point at a
 * place, and detail it does not need would only compete with the marks that carry meaning.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  SphereGeometry,
  Vector2,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import { ZONE_CODES, type BodyForm, type ZoneCode } from './zones'

/** Overall height in world units; the camera framing below is written against it. */
export const FIGURE_HEIGHT = 1.8

const ZONE_INDEX = new Map<ZoneCode, number>(ZONE_CODES.map((code, index) => [code, index]))

/** Landmark heights, shared by every form so the three figures stay comparable. */
const Y = {
  ankle: 0.09,
  knee: 0.5,
  crotch: 0.86,
  pelvisTop: 0.98,
  waist: 1.18,
  chestTop: 1.46,
  shoulder: 1.4,
  elbow: 1.1,
  wrist: 0.82,
  neckBase: 1.5,
  headCentre: 1.66,
} as const

interface Proportions {
  /** Half the shoulder span. */
  shoulder: number
  chest: number
  waist: number
  hip: number
  /** Extra depth at the chest, forward only. */
  bust: number
  limb: number
}

/**
 * The three silhouettes differ in four numbers and nothing else.
 *
 * Shoulder-to-hip ratio is what the eye actually reads as a body shape, so that is where
 * the difference lives; `neutral` sits between the other two rather than being a fourth
 * shape, which keeps it a real choice instead of a placeholder.
 */
const PROPORTIONS: Record<BodyForm, Proportions> = {
  feminine: { shoulder: 0.175, chest: 0.127, waist: 0.101, hip: 0.158, bust: 0.03, limb: 0.052 },
  masculine: { shoulder: 0.216, chest: 0.152, waist: 0.126, hip: 0.134, bust: 0, limb: 0.061 },
  neutral: { shoulder: 0.196, chest: 0.139, waist: 0.113, hip: 0.146, bust: 0.012, limb: 0.056 },
}

/** A vertex's region, decided from where it ended up in world space. */
type ZoneRule = ZoneCode | ((x: number, y: number, z: number) => ZoneCode)

interface Part {
  geometry: BufferGeometry
  zone: ZoneRule
}

/** Places a primitive without mutating the caller's matrix bookkeeping. */
function at(geometry: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  return geometry.applyMatrix4(new Matrix4().makeTranslation(x, y, z))
}

/** Rotation about Z, for limbs that hang at an angle. */
function tilt(geometry: BufferGeometry, radians: number): BufferGeometry {
  return geometry.applyMatrix4(new Matrix4().makeRotationZ(radians))
}

/** A capsule spanning two heights on the Y axis, centred at `x`. */
function limb(radius: number, from: number, to: number, x: number, lean = 0): BufferGeometry {
  const length = Math.abs(to - from)
  const geometry = new CapsuleGeometry(radius, length, 6, 18)
  if (lean !== 0) tilt(geometry, lean)
  return at(geometry, x, (from + to) / 2, 0)
}

function scaled(geometry: BufferGeometry, sx: number, sy: number, sz: number): BufferGeometry {
  return geometry.applyMatrix4(new Matrix4().makeScale(sx, sy, sz))
}

/**
 * The trunk: one lathed profile from hip to collarbone, flattened front-to-back.
 *
 * A real torso is an ellipse in cross-section, not a circle, so the whole surface is
 * squashed on Z after lathing. The chest is then pushed *forward only*, with a cosine
 * falloff over the band so the change of curvature has no crease in it — a body's
 * silhouette differs from the side as much as from the front, and a figure that only
 * differs from the front reads as the same mannequin wearing a label.
 */
function torso(p: Proportions): BufferGeometry {
  const profile: Vector2[] = [
    new Vector2(p.hip * 0.82, Y.crotch - 0.02),
    new Vector2(p.hip * 0.99, 0.93),
    new Vector2(p.hip * 0.97, Y.pelvisTop),
    new Vector2(p.waist * 1.08, 1.09),
    new Vector2(p.waist, Y.waist),
    new Vector2(p.chest * 0.92, 1.3),
    new Vector2(p.chest, 1.39),
    new Vector2(p.chest * 0.84, Y.chestTop),
    new Vector2(p.chest * 0.52, 1.49),
  ]
  const geometry = new LatheGeometry(profile, 44)

  const position = geometry.getAttribute('position')
  const bandLow = 1.24
  const bandHigh = 1.45
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i)
    const z = position.getZ(i)
    // Front-to-back flattening, everywhere.
    let depth = z * 0.78
    // Forward-only bust, fading in and out across the band.
    if (p.bust > 0 && z > 0 && y > bandLow && y < bandHigh) {
      const t = (y - bandLow) / (bandHigh - bandLow)
      depth += p.bust * Math.sin(Math.PI * t) * (z / Math.max(p.chest, 1e-6))
    }
    position.setZ(i, depth)
  }
  position.needsUpdate = true
  // The only part that earns a normal recompute: its vertices moved after they were
  // generated, so the normals the lathe produced no longer describe this surface.
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Builds the parts list for one form.
 *
 * Every entry is either a constant zone or a rule reading the vertex position — the rules
 * are what give front-and-back regions on a limb that has no seam.
 */
function partsFor(form: BodyForm): Part[] {
  const p = PROPORTIONS[form]
  const legX = p.hip * 0.52
  const armX = p.shoulder + p.limb * 0.55

  /** Inner face of a leg: the side turned toward the body's centre line. */
  const innerLeg = (x: number, centre: number): boolean => (x - centre) * Math.sign(centre) < 0

  const parts: Part[] = [
    /* ------------------------------------------------------------- head */
    {
      // Slightly taller than wide, which is what stops a sphere reading as a ball.
      geometry: at(scaled(new SphereGeometry(0.113, 32, 24), 0.94, 1.12, 1), 0, Y.headCentre, 0),
      zone: (_x, _y, z) => (z >= 0 ? 'face' : 'hair'),
    },
    {
      geometry: at(scaled(new SphereGeometry(0.026, 14, 10), 1.5, 0.7, 0.5), 0, 1.62, 0.104),
      zone: 'lips',
    },
    {
      geometry: at(scaled(new SphereGeometry(0.022, 12, 10), 0.5, 1.2, 0.9), -0.104, 1.67, 0),
      zone: 'ears',
    },
    {
      geometry: at(scaled(new SphereGeometry(0.022, 12, 10), 0.5, 1.2, 0.9), 0.104, 1.67, 0),
      zone: 'ears',
    },
    {
      geometry: at(new CylinderGeometry(0.045, 0.055, 0.12, 20), 0, Y.neckBase, 0),
      zone: 'neck',
    },

    /* ------------------------------------------------------------ torso */
    {
      // One lathed surface from hip to collarbone. Three stacked cylinders were the first
      // attempt and read as stacked cylinders: every change of radius became a visible
      // step, and a body has no steps in it. A lathe spends the same triangles on a
      // continuous profile, and the front/back split the zones need is positional anyway,
      // so nothing is lost by the parts no longer being separate meshes.
      geometry: torso(p),
      zone: (x, y, z) => {
        if (y >= Y.waist) return z >= 0 ? 'chest' : 'upperBack'
        if (y >= Y.pelvisTop) return z >= 0 ? 'stomach' : 'lowerBack'
        // Three regions on one short band: everything behind is glutes, the flanks are
        // hips, and only the narrow front that is left is `intimate`. Ordering matters —
        // the widest test has to run last or it swallows the other two.
        if (z < -0.012) return 'glutes'
        if (Math.abs(x) > p.hip * 0.58) return 'hips'
        return 'intimate'
      },
    },
    {
      geometry: at(new SphereGeometry(p.limb * 1.15, 18, 14), -p.shoulder, Y.shoulder, 0),
      zone: 'shoulders',
    },
    {
      geometry: at(new SphereGeometry(p.limb * 1.15, 18, 14), p.shoulder, Y.shoulder, 0),
      zone: 'shoulders',
    },

    /* ------------------------------------------------------------- arms */
    // Upper and lower segments overlap at the joint rather than meeting at it. Two
    // capsules of different radii that share an exact end plane leave a visible step
    // there — the taper is wanted, the shelf is not, and a few centimetres of overlap
    // buys a continuous limb for nothing.
    { geometry: limb(p.limb * 0.82, Y.elbow - 0.03, Y.shoulder, -armX), zone: 'arms' },
    { geometry: limb(p.limb * 0.82, Y.elbow - 0.03, Y.shoulder, armX), zone: 'arms' },
    { geometry: limb(p.limb * 0.68, Y.wrist, Y.elbow + 0.02, -armX), zone: 'arms' },
    { geometry: limb(p.limb * 0.68, Y.wrist, Y.elbow + 0.02, armX), zone: 'arms' },
    {
      geometry: at(
        scaled(new SphereGeometry(p.limb * 0.72, 14, 12), 0.72, 1.6, 0.5),
        -armX,
        Y.wrist - 0.05,
        0,
      ),
      zone: 'hands',
    },
    {
      geometry: at(
        scaled(new SphereGeometry(p.limb * 0.72, 14, 12), 0.72, 1.6, 0.5),
        armX,
        Y.wrist - 0.05,
        0,
      ),
      zone: 'hands',
    },

    /* ------------------------------------------------------------- legs */
    {
      geometry: limb(p.limb * 1.28, Y.knee, Y.crotch, -legX),
      zone: x => (innerLeg(x, -legX) ? 'innerThighs' : 'thighs'),
    },
    {
      geometry: limb(p.limb * 1.28, Y.knee, Y.crotch, legX),
      zone: x => (innerLeg(x, legX) ? 'innerThighs' : 'thighs'),
    },
    { geometry: limb(p.limb * 0.95, Y.ankle, Y.knee + 0.04, -legX), zone: 'calves' },
    { geometry: limb(p.limb * 0.95, Y.ankle, Y.knee + 0.04, legX), zone: 'calves' },
    {
      geometry: at(
        scaled(new SphereGeometry(p.limb * 0.9, 14, 12), 0.8, 0.45, 1.7),
        -legX,
        0.04,
        0.04,
      ),
      zone: 'feet',
    },
    {
      geometry: at(
        scaled(new SphereGeometry(p.limb * 0.9, 14, 12), 0.8, 0.45, 1.7),
        legX,
        0.04,
        0.04,
      ),
      zone: 'feet',
    },
  ]

  return parts
}

export interface Figure {
  geometry: BufferGeometry
  /** Zone of every vertex, parallel to the position attribute. */
  zones: Uint8Array
}

/**
 * Builds one form's geometry, ready to render and to pick against.
 *
 * The zone attribute is merged along with position and normal, which is the only reason
 * this works: `mergeGeometries` refuses a set of geometries whose attributes differ, so
 * every part has to carry the tag before merging rather than after.
 */
export function buildFigure(form: BodyForm): Figure {
  const parts = partsFor(form)

  for (const part of parts) {
    const position = part.geometry.getAttribute('position')
    const tags = new Float32Array(position.count)
    for (let i = 0; i < position.count; i += 1) {
      const zone =
        typeof part.zone === 'function'
          ? part.zone(position.getX(i), position.getY(i), position.getZ(i))
          : part.zone
      tags[i] = ZONE_INDEX.get(zone) ?? 0
    }
    part.geometry.setAttribute('zone', new BufferAttribute(tags, 1))
    // uv is not read by the material and is the one attribute the primitives disagree
    // about often enough to break the merge; dropping it is cheaper than reconciling it.
    part.geometry.deleteAttribute('uv')
  }

  const merged = mergeGeometries(
    parts.map(part => part.geometry),
    false,
  )
  if (merged === null) {
    throw new Error('the figure could not be assembled')
  }

  const zoneAttribute = merged.getAttribute('zone')
  const zones = new Uint8Array(zoneAttribute.count)
  for (let i = 0; i < zoneAttribute.count; i += 1) zones[i] = zoneAttribute.getX(i)

  // Vertex colours start neutral; `paint` writes the real ones on every change.
  merged.setAttribute('color', new BufferAttribute(new Float32Array(zoneAttribute.count * 3), 3))
  // Deliberately *not* computeVertexNormals(): every primitive already carries smooth
  // normals, and `applyMatrix4` transforms them correctly through the non-uniform scales
  // above. Recomputing here would average across the seams where separate parts meet and
  // facet the spheres in the process.
  merged.computeBoundingSphere()

  return { geometry: merged, zones }
}

/**
 * Writes vertex colours for the current marks.
 *
 * Called on every selection and every hover, so it allocates nothing and walks the vertex
 * list once. `needsUpdate` is what actually gets the new colours to the GPU — without it
 * the array changes and the picture does not, which looks exactly like a broken click
 * handler and is the first thing to check if this ever appears not to work.
 */
export function paint(
  figure: Figure,
  marks: ReadonlyMap<ZoneCode, string>,
  hovered: ZoneCode | null,
  base: string,
): void {
  const attribute = figure.geometry.getAttribute('color') as BufferAttribute
  const colour = new Color()
  const baseColour = new Color(base)

  // One Color per zone rather than one per vertex: nineteen parses instead of ~12 000.
  const perZone = ZONE_CODES.map(code => {
    const mark = marks.get(code)
    const resolved = mark === undefined ? baseColour.clone() : new Color(mark)
    if (code === hovered) resolved.lerp(new Color('#ffffff'), 0.28)
    return resolved
  })

  for (let i = 0; i < figure.zones.length; i += 1) {
    colour.copy(perZone[figure.zones[i]!] ?? baseColour)
    attribute.setXYZ(i, colour.r, colour.g, colour.b)
  }
  attribute.needsUpdate = true
}

/** The zone a raycast hit, read off the first vertex of the face it landed on. */
export function zoneOfFace(figure: Figure, vertexIndex: number): ZoneCode | null {
  const index = figure.zones[vertexIndex]
  return index === undefined ? null : (ZONE_CODES[index] ?? null)
}
