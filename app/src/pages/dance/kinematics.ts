/**
 * Drawing the step, so somebody can see it before they try it.
 *
 * ## Why this exists
 *
 * The chapter shipped without it, and that was the single biggest thing wrong with it as
 * teaching. The app holds the exact intended pose at every beat and showed the learner none
 * of it — they were asked to perform "the box step" having read one line of prose about it.
 * Watching a movement before attempting it is the oldest thing in motor learning, and the
 * data to do it was already sitting in `routines.ts`.
 *
 * This turns a {@link Skeleton} into 2D points a component can draw.
 *
 * ## The three-quarter view, which is not a stylistic choice
 *
 * The figure is drawn from about twenty degrees off the front, the angle a dance teacher
 * stands at when showing you something. Dead-on, an orthographic projection collapses every
 * forward and backward movement to nothing: a step towards the camera and a step nowhere look
 * identical, and the box step — half of which is forward and back — would be unreadable. Off
 * to one side, depth becomes visible as horizontal movement.
 *
 * ## What the angles cannot say, and what is done instead
 *
 * The joint set carries limb *directions*, not a full skeleton, so two things are genuinely
 * unknown and are chosen rather than derived. Both are documented here because a figure that
 * silently invents motion would teach it.
 *
 *  - **The plane a limb bends in.** Elbow and knee flexion are single angles; they say how
 *    bent, not which way. The bend is placed in the plane containing the limb and the body's
 *    own vertical, which is where an arm and a leg almost always bend, and is the only choice
 *    that looks like a person rather than a deckchair.
 *  - **Where the feet are.** Nothing in the representation locates the ground. The figure is
 *    hung from the hips and the feet fall where the leg angles put them, so it reads as a
 *    body moving rather than as a body walking. A routine that depended on foot placement
 *    could not be taught this way, and none of them do.
 */
import { type Skeleton } from './pose'

/** A point in the drawing, in figure units where the torso is 1 and +y is down. */
export interface Dot {
  x: number
  y: number
  /** Depth after rotation. Positive is nearer the viewer; used only to order what overlaps. */
  z: number
}

export interface Figure {
  head: Dot
  neck: Dot
  hips: Dot
  leftShoulder: Dot
  rightShoulder: Dot
  leftElbow: Dot
  rightElbow: Dot
  leftWrist: Dot
  rightWrist: Dot
  leftHip: Dot
  rightHip: Dot
  leftKnee: Dot
  rightKnee: Dot
  leftAnkle: Dot
  rightAnkle: Dot
}

/**
 * Proportions, with the torso as the unit.
 *
 * Roughly a real adult's, which matters less than it looks: the whole point of comparing
 * angles is that build does not signify. They are here so the drawing reads as a person.
 */
const L = {
  torso: 1,
  shoulderHalf: 0.26,
  hipHalf: 0.17,
  // A little longer than it looks right on paper: at 0.16 the head sat straight on the
  // shoulder line with no neck visible at all.
  neck: 0.21,
  headRadius: 0.145,
  upperArm: 0.52,
  foreArm: 0.48,
  thigh: 0.72,
  shin: 0.7,
}

/** How far round the figure is turned. Twenty degrees: enough for depth, short of a profile. */
export const VIEW_TURN = 0.35

type Vec = [number, number, number]

function add(a: Vec, b: Vec, scale = 1): Vec {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale]
}

function unit(a: Vec): Vec {
  const size = Math.hypot(a[0], a[1], a[2])
  return size < 1e-9 ? [0, 0, 0] : [a[0] / size, a[1] / size, a[2] / size]
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Rotate `v` about `axis` (unit) by `angle`. Rodrigues, written out. */
function rotate(v: Vec, axis: Vec, angle: number): Vec {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = cross(axis, v)
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2]
  return [
    v[0] * c + k[0] * s + axis[0] * d * (1 - c),
    v[1] * c + k[1] * s + axis[1] * d * (1 - c),
    v[2] * c + k[2] * s + axis[2] * d * (1 - c),
  ]
}

/** A number that may be `NaN`, with a fallback — unseen joints must not blank the figure. */
function or(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * A limb direction from elevation and azimuth, in the frame `(axis, outward, forward)`.
 *
 * The inverse of what `pose.ts` measures, and it has to stay the inverse — if one of them
 * changes convention the demonstration silently stops matching what is scored.
 */
function limbDirection(
  axis: Vec,
  outward: Vec,
  forward: Vec,
  elevation: number,
  azimuth: number,
): Vec {
  const along = Math.cos(elevation)
  const out = Math.sin(elevation)
  return unit([
    axis[0] * along + (outward[0] * Math.cos(azimuth) + forward[0] * Math.sin(azimuth)) * out,
    axis[1] * along + (outward[1] * Math.cos(azimuth) + forward[1] * Math.sin(azimuth)) * out,
    axis[2] * along + (outward[2] * Math.cos(azimuth) + forward[2] * Math.sin(azimuth)) * out,
  ])
}

/**
 * Where the second segment of a limb goes.
 *
 * `flex` is π when straight. The bend is placed in the plane containing the limb and the
 * body's vertical — see the header: which way a joint bends is not in the data, and this is
 * the choice that looks like a body.
 */
function bend(direction: Vec, bodyUp: Vec, flex: number): Vec {
  // The axis to rotate about: perpendicular to both the limb and the body's vertical. When
  // the limb is parallel to it (an arm hanging straight down) there is no such plane, so any
  // perpendicular will do and the bend is placed forwards, which is how elbows and knees go.
  let axis = cross(direction, bodyUp)
  if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) axis = [0, 0, 1]
  return rotate(direction, unit(axis), Math.PI - flex)
}

/**
 * Build the drawable figure for one pose.
 *
 * `turn` is the viewing angle; pass 0 for dead-on. Everything is in figure units with the hip
 * midpoint at the origin, so a component only has to scale and centre.
 */
export function toFigure(pose: Skeleton, turn = VIEW_TURN): Figure {
  // The body's own frame, tilted by roll and pitch. Screen axes: +x right, +y DOWN, +z
  // towards the viewer — so "up" starts as (0, -1, 0).
  const worldUp: Vec = [0, -1, 0]
  const worldRight: Vec = [1, 0, 0]
  const worldForward: Vec = [0, 0, 1]

  const roll = or(pose.roll, 0)
  const pitch = or(pose.pitch, 0)

  // Roll tips the body towards its own left, which is screen-left before the view turn, so
  // it rotates about the viewer's depth axis. Pitch tips it forwards, about the across axis.
  let up = rotate(worldUp, worldForward, roll)
  up = rotate(up, worldRight, -pitch)
  up = unit(up)

  // The across axis, kept perpendicular to the tilted spine, and pointing to the person's
  // own RIGHT.
  //
  // Note the order: `cross(up, worldForward)` rather than the other way round. It puts the
  // person's right at screen −x, which means **the figure faces the viewer**, like a teacher
  // standing opposite you rather than one you are following from behind. The scorer accepts
  // either mirroring (see `score.ts`), so this changes nothing about marks — it changes which
  // way round a person naturally copies, and facing is what people expect from a screen.
  const across = unit(cross(up, worldForward))
  const forward = unit(cross(across, up))

  const hips: Vec = [0, 0, 0]
  const neck: Vec = add(hips, up, L.torso)

  // Twist turns the shoulders against the hips, about the spine.
  const twist = or(pose.twist, 0)
  const shoulderAcross = unit(rotate(across, up, twist))
  const shoulderForward = unit(cross(shoulderAcross, up))

  // `across` points to the person's own right; outward for a left limb is the other way.
  const rightOut = shoulderAcross
  const leftOut: Vec = [-shoulderAcross[0], -shoulderAcross[1], -shoulderAcross[2]]
  const hipRightOut = across
  const hipLeftOut: Vec = [-across[0], -across[1], -across[2]]

  const leftShoulder = add(neck, leftOut, L.shoulderHalf)
  const rightShoulder = add(neck, rightOut, L.shoulderHalf)
  const leftHip = add(hips, hipLeftOut, L.hipHalf)
  const rightHip = add(hips, hipRightOut, L.hipHalf)

  const down: Vec = [-up[0], -up[1], -up[2]]

  // Arms. Elevation is from the spine pointing up, so a hanging arm is π.
  const leftArm = limbDirection(
    up,
    leftOut,
    shoulderForward,
    or(pose.leftShoulder, Math.PI),
    or(pose.leftArmAround, 0),
  )
  const rightArm = limbDirection(
    up,
    rightOut,
    shoulderForward,
    or(pose.rightShoulder, Math.PI),
    or(pose.rightArmAround, 0),
  )
  const leftElbow = add(leftShoulder, leftArm, L.upperArm)
  const rightElbow = add(rightShoulder, rightArm, L.upperArm)
  const leftWrist = add(leftElbow, bend(leftArm, up, or(pose.leftElbow, Math.PI)), L.foreArm)
  const rightWrist = add(rightElbow, bend(rightArm, up, or(pose.rightElbow, Math.PI)), L.foreArm)

  // Legs. Elevation is from the spine pointing down, so a standing leg is 0.
  const leftLeg = limbDirection(
    down,
    hipLeftOut,
    forward,
    or(pose.leftHip, 0),
    or(pose.leftLegAround, 0),
  )
  const rightLeg = limbDirection(
    down,
    hipRightOut,
    forward,
    or(pose.rightHip, 0),
    or(pose.rightLegAround, 0),
  )
  const leftKnee = add(leftHip, leftLeg, L.thigh)
  const rightKnee = add(rightHip, rightLeg, L.thigh)
  // A knee bends backwards, which is the opposite way to an elbow — so the body's vertical is
  // passed inverted and the same helper produces the right shape.
  const leftAnkle = add(leftKnee, bend(leftLeg, down, or(pose.leftKnee, Math.PI)), L.shin)
  const rightAnkle = add(rightKnee, bend(rightLeg, down, or(pose.rightKnee, Math.PI)), L.shin)

  const head = add(neck, up, L.neck + L.headRadius)

  // Turn the whole figure about the vertical and project. Orthographic: no perspective, so a
  // limb towards the viewer shortens but nothing swells, which keeps proportions readable.
  const project = (p: Vec): Dot => {
    const spun = rotate(p, worldUp, turn)
    return { x: spun[0], y: spun[1], z: spun[2] }
  }

  return {
    head: project(head),
    neck: project(neck),
    hips: project(hips),
    leftShoulder: project(leftShoulder),
    rightShoulder: project(rightShoulder),
    leftElbow: project(leftElbow),
    rightElbow: project(rightElbow),
    leftWrist: project(leftWrist),
    rightWrist: project(rightWrist),
    leftHip: project(leftHip),
    rightHip: project(rightHip),
    leftKnee: project(leftKnee),
    rightKnee: project(rightKnee),
    leftAnkle: project(leftAnkle),
    rightAnkle: project(rightAnkle),
  }
}

/** The bones, as pairs of joint names — what a renderer draws lines between. */
export const BONES: ReadonlyArray<readonly [keyof Figure, keyof Figure]> = [
  ['neck', 'hips'],
  ['leftShoulder', 'rightShoulder'],
  ['leftHip', 'rightHip'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
]

/**
 * The box the figure occupies across a whole routine, so a viewport can be sized once.
 *
 * Computed over the sequence rather than per frame: a viewport that resized every frame would
 * make the figure appear to zoom as it moved, which reads as the camera moving rather than
 * the dancer.
 */
export function boundsOf(figures: readonly Figure[]): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const figure of figures) {
    for (const dot of Object.values(figure)) {
      if (dot.x < minX) minX = dot.x
      if (dot.x > maxX) maxX = dot.x
      if (dot.y < minY) minY = dot.y
      if (dot.y > maxY) maxY = dot.y
    }
  }
  // A degenerate sequence would divide by zero downstream.
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1 }
  return { minX, maxX, minY, maxY }
}
