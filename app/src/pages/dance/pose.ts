/**
 * A body, reduced to the few numbers a dance can be compared in.
 *
 * ## The problem this file solves
 *
 * A pose detector gives 33 points in space. Comparing two people's points directly does not
 * work, and the reasons are worth listing because each one dictates a step below:
 *
 *  - **They are different sizes.** A tall person's wrist is further from their hip than a
 *    short person's, doing exactly the same move.
 *  - **They stand in different places.** One is a metre from the camera, one is three.
 *  - **They face different ways.** A quarter-turn changes every coordinate and no joint.
 *  - **One of them is mirrored.** Somebody copying a video facing you lifts the opposite arm,
 *    and is not wrong.
 *
 * So positions are thrown away and **angles** are kept. An angle at the elbow is the same
 * number whoever you are, wherever you stand, and whichever way you face — which is precisely
 * the invariance wanted, and it is why every serious motion-comparison system works in joint
 * space rather than in world space.
 *
 * ## What is kept, and why these twelve
 *
 * Twelve angles, chosen because they are what a person watching would describe. Nobody says
 * "your left acromioclavicular joint is out"; they say "your arm is too low". The list maps
 * onto the four limbs plus the torso, which is also how the feedback is phrased.
 *
 * Fingers, toes and face are discarded outright. A pose detector's estimates for them are
 * noisy, and no social dance is judged on them.
 *
 * ## Coordinates
 *
 * MediaPipe's *world* landmarks: metres, origin at the hip midpoint, roughly gravity-aligned.
 * Not the image-space ones, which are in pixels and change when somebody steps forward.
 * The normalisation below is belt and braces — world landmarks are already hip-centred, but
 * the scale still varies with the detector's estimate of body size, and a routine recorded
 * once must compare against everybody.
 */

/**
 * The subset of MediaPipe's 33 landmarks this app uses, by its index in that list.
 *
 * The indices are fixed by the model and are a contract with it: renumbering them silently
 * compares an elbow to a knee.
 */
export const JOINT = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const

export interface Point {
  x: number
  y: number
  z: number
  /** The detector's confidence, 0–1. Low-confidence points are not trusted. */
  visibility: number
}

/** One frame: the model's 33 world landmarks, in order. */
export type Landmarks = readonly Point[]

/**
 * Below this, a joint is treated as unseen rather than as being where the model guessed.
 *
 * An occluded limb produces a confident-looking but invented position, and scoring somebody
 * down for a hand they had behind their back is the fastest way to make a coach untrusted.
 */
export const VISIBLE = 0.55

/**
 * The fifteen angles a pose is reduced to.
 *
 * ## Why fifteen, and why not the twelve this started with
 *
 * The first version kept an *unsigned* magnitude for every limb: how far the arm is from the
 * torso, how far the thigh is lifted, how far the body is tilted. That is half a coordinate,
 * and the missing half turned out to be the half dances are made of. Measured on the routines
 * that shipped:
 *
 *  - A leg **forward**, **out to the side** and **behind** all produced the same number
 *    (0.537 rad). The box step is called "forward, side, together" and all three of its steps
 *    were identical to the scorer.
 *  - Leaning **left** and leaning **right** both produced 0.3805. The sway is nothing but
 *    alternating those two.
 *  - `armSwing` was exactly `±shoulder` — two of the twelve angles carrying one number and a
 *    sign bit — so an arm out to the side and an arm behind the back were the same pose.
 *
 * So the representation is now a proper one: for each limb, **how far off the body axis**
 * (elevation) and **where around the body** (azimuth); for the torso, roll and pitch as
 * signed angles rather than one unsigned tilt.
 *
 * ## The azimuth convention
 *
 * Measured *outward from that limb's own side*, so it is symmetric: azimuth `0` means
 * straight out to the left for a left limb and straight out to the right for a right limb,
 * `+π/2` is forward for both, `−π/2` is behind for both. Arms out to the sides is `0, 0`
 * rather than `π, 0`, and mirroring becomes a plain swap.
 *
 * Azimuth is **undefined when the limb lies along the body axis** — a hanging arm points
 * nowhere in particular — so it is `NaN` there rather than a number made of noise. See
 * {@link AZIMUTH_FLOOR}.
 */
export interface Skeleton {
  /** Elbow flexion: shoulder–elbow–wrist. π is straight. */
  leftElbow: number
  rightElbow: number
  /** How far the upper arm is off the spine. 0 straight up, π/2 out, π hanging down. */
  leftShoulder: number
  rightShoulder: number
  /** Where the arm points around the body. 0 out to its own side, +π/2 forward, −π/2 back. */
  leftArmAround: number
  rightArmAround: number
  /** Knee flexion: hip–knee–ankle. */
  leftKnee: number
  rightKnee: number
  /** How far the thigh is lifted off the body's down-axis. */
  leftHip: number
  rightHip: number
  /** Where the leg points around the body, same convention as the arms. */
  leftLegAround: number
  rightLegAround: number
  /** Side-to-side tilt, signed: positive leans towards the person's own left. */
  roll: number
  /** Front-to-back tilt, signed: positive leans forward. */
  pitch: number
  /** Shoulders against hips, signed. */
  twist: number
}

/** The angle names, in a fixed order, so a vector is always the same shape. */
export const ANGLES = [
  'leftElbow',
  'rightElbow',
  'leftShoulder',
  'rightShoulder',
  'leftArmAround',
  'rightArmAround',
  'leftKnee',
  'rightKnee',
  'leftHip',
  'rightHip',
  'leftLegAround',
  'rightLegAround',
  'roll',
  'pitch',
  'twist',
] as const

export type AngleName = (typeof ANGLES)[number]

/**
 * Which angles wrap around.
 *
 * The azimuths live on a circle: an arm at +179° and one at −179° are two degrees apart, and
 * subtracting them naively says they are 358° apart — which would make a limb pointing
 * straight forward look maximally wrong against one a hair to its other side. Every
 * comparison has to take the short way round for these, and only for these.
 *
 * Roll, pitch and twist are signed but bounded by anatomy well short of ±π, so they are
 * ordinary numbers.
 */
export const CIRCULAR: ReadonlySet<AngleName> = new Set([
  'leftArmAround',
  'rightArmAround',
  'leftLegAround',
  'rightLegAround',
])

/** `CIRCULAR` as a mask over {@link ANGLES}, for the distance functions. */
export const CIRCULAR_MASK: readonly boolean[] = ANGLES.map(name => CIRCULAR.has(name))

/**
 * The shortest angular distance between two directions on a circle.
 *
 * Never more than π, which is the whole point.
 */
export function circularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % (2 * Math.PI)
  return raw > Math.PI ? 2 * Math.PI - raw : raw
}

/**
 * Below this much sine of elevation, a limb is treated as lying along the body and its
 * azimuth is reported as unknown.
 *
 * About 14°. An arm hanging by somebody's side points nowhere in particular; the azimuth it
 * computes is the direction of the noise, and comparing two people's noise is worse than
 * comparing nothing.
 */
export const AZIMUTH_FLOOR = 0.25

/**
 * Which limb an angle belongs to.
 *
 * This is what turns a number into a sentence: the feedback says "your left arm", not
 * "leftElbow and leftShoulder and leftArmAround".
 */
export const LIMB_OF: Record<AngleName, Limb> = {
  leftElbow: 'leftArm',
  leftShoulder: 'leftArm',
  leftArmAround: 'leftArm',
  rightElbow: 'rightArm',
  rightShoulder: 'rightArm',
  rightArmAround: 'rightArm',
  leftKnee: 'leftLeg',
  leftHip: 'leftLeg',
  leftLegAround: 'leftLeg',
  rightKnee: 'rightLeg',
  rightHip: 'rightLeg',
  rightLegAround: 'rightLeg',
  roll: 'torso',
  pitch: 'torso',
  twist: 'torso',
}

export type Limb = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'torso'

export const LIMBS: readonly Limb[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'torso']

export const LIMB_LABEL: Record<Limb, string> = {
  leftArm: 'your left arm',
  rightArm: 'your right arm',
  leftLeg: 'your left leg',
  rightLeg: 'your right leg',
  torso: 'your upper body',
}

/* ------------------------------------------------------------------ maths */

type Vec = readonly [number, number, number]

function sub(a: Point, b: Point): Vec {
  return [a.x - b.x, a.y - b.y, a.z - b.z]
}

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function length(a: Vec): number {
  return Math.sqrt(dot(a, a))
}

/** Normalised, or a zero vector when there is nothing to normalise. */
function unit(a: Vec): Vec {
  const size = length(a)
  return size < 1e-9 ? [0, 0, 0] : [a[0] / size, a[1] / size, a[2] / size]
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility, b.visibility),
  }
}

/**
 * The angle at `vertex` between two other points, in radians, 0 to π.
 *
 * `acos` of the normalised dot product. Guarded at both ends because floating point can put
 * the quotient a hair outside [-1, 1] for a perfectly straight limb, and `acos(1.0000001)`
 * is `NaN` — which then poisons every downstream average silently. That is a genuinely
 * nasty bug and it happens on the most ordinary input there is: a straight arm.
 */
export function angleAt(vertex: Point, a: Point, b: Point): number {
  const u = sub(a, vertex)
  const v = sub(b, vertex)
  const scale = length(u) * length(v)
  if (scale < 1e-9) return Number.NaN
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v) / scale)))
}

/** The angle between two directions. Same guard, same reason. */
function angleBetween(u: Vec, v: Vec): number {
  const scale = length(u) * length(v)
  if (scale < 1e-9) return Number.NaN
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v) / scale)))
}

/**
 * A signed angle around `axis`, so "in front" and "behind" are different numbers.
 *
 * An unsigned angle cannot tell an arm swung forward from one swung back — they are the same
 * number of degrees from the torso — and a dance where that does not matter is not a dance.
 */
function signedAngle(u: Vec, v: Vec, axis: Vec): number {
  const plain = angleBetween(u, v)
  if (Number.isNaN(plain)) return Number.NaN
  return dot(cross(u, v), axis) < 0 ? -plain : plain
}

/* ------------------------------------------------------- reading a skeleton */

/**
 * `NaN` for any angle whose joints were not clearly seen.
 *
 * Deliberately not zero and not a guess. `NaN` propagates into the comparison, where it is
 * *skipped* — which is the correct treatment of "we could not see this" and the reason it is
 * not a number in range. A zero here would read as a perfectly straight limb and would be
 * scored against somebody for standing behind a chair.
 */
function seen(...points: Point[]): boolean {
  return points.every(one => one !== undefined && one.visibility >= VISIBLE)
}

export function toSkeleton(landmarks: Landmarks): Skeleton | null {
  const at = (index: number): Point | undefined => landmarks[index]

  const ls = at(JOINT.leftShoulder)
  const rs = at(JOINT.rightShoulder)
  const lh = at(JOINT.leftHip)
  const rh = at(JOINT.rightHip)

  // Without both shoulders and both hips there is no torso, and without a torso there is no
  // frame of reference for anything else. A frame like that is dropped rather than salvaged.
  if (ls === undefined || rs === undefined || lh === undefined || rh === undefined) return null
  if (!seen(ls, rs, lh, rh)) return null

  const shoulders = midpoint(ls, rs)
  const hips = midpoint(lh, rh)

  /** Up the spine. The body's own vertical, which is not the world's when somebody leans. */
  const up = unit(sub(shoulders, hips))
  /** Across the shoulders, towards the person's own right. */
  const across = unit(sub(rs, ls))
  /** Out of the chest. Completes a right-handed frame with `across` and `up`. */
  const forward = unit(cross(across, up))

  /**
   * Where a limb points, in the body's own frame.
   *
   * Returns elevation off the reference axis and azimuth around it, measured outward from
   * the limb's own side so that left and right are symmetric. Azimuth is `NaN` when the limb
   * lies close to the axis, because then it is the direction of the noise.
   */
  const direction = (
    from: Point,
    to: Point | undefined,
    axis: Vec,
    side: 'left' | 'right',
  ): { elevation: number; azimuth: number } => {
    if (to === undefined || !seen(to)) return { elevation: Number.NaN, azimuth: Number.NaN }

    const limb = unit(sub(to, from))
    const elevation = angleBetween(limb, axis)
    if (Number.isNaN(elevation)) return { elevation: Number.NaN, azimuth: Number.NaN }

    // Outward is the person's own left for a left limb, their own right for a right one, so
    // "arms out to the sides" is the same azimuth on both.
    const outward: Vec = side === 'right' ? across : [-across[0], -across[1], -across[2]]
    const along = dot(limb, axis)
    // The part of the limb perpendicular to the axis — the only part that has a direction.
    const flat: Vec = [
      limb[0] - axis[0] * along,
      limb[1] - axis[1] * along,
      limb[2] - axis[2] * along,
    ]
    if (length(flat) < AZIMUTH_FLOOR) return { elevation, azimuth: Number.NaN }

    return { elevation, azimuth: Math.atan2(dot(flat, forward), dot(flat, outward)) }
  }

  const le = at(JOINT.leftElbow)
  const lw = at(JOINT.leftWrist)
  const re = at(JOINT.rightElbow)
  const rw = at(JOINT.rightWrist)
  const lk = at(JOINT.leftKnee)
  const la = at(JOINT.leftAnkle)
  const rk = at(JOINT.rightKnee)
  const ra = at(JOINT.rightAnkle)

  const down: Vec = [-up[0], -up[1], -up[2]]
  const leftArm = direction(ls, le, up, 'left')
  const rightArm = direction(rs, re, up, 'right')
  const leftLeg = direction(lh, lk, down, 'left')
  const rightLeg = direction(rh, rk, down, 'right')

  // The world's vertical. Roll and pitch are the two things that are genuinely about the
  // body's relation to gravity rather than to itself, so they are the one place the world
  // frame is used. MediaPipe's world frame has −y up.
  const worldUp: Vec = [0, -1, 0]

  return {
    leftElbow:
      le !== undefined && lw !== undefined && seen(le, lw) ? angleAt(le, ls, lw) : Number.NaN,
    rightElbow:
      re !== undefined && rw !== undefined && seen(re, rw) ? angleAt(re, rs, rw) : Number.NaN,

    leftShoulder: leftArm.elevation,
    rightShoulder: rightArm.elevation,
    leftArmAround: leftArm.azimuth,
    rightArmAround: rightArm.azimuth,

    leftKnee:
      lk !== undefined && la !== undefined && seen(lk, la) ? angleAt(lk, lh, la) : Number.NaN,
    rightKnee:
      rk !== undefined && ra !== undefined && seen(rk, ra) ? angleAt(rk, rh, ra) : Number.NaN,

    leftHip: leftLeg.elevation,
    rightHip: rightLeg.elevation,
    leftLegAround: leftLeg.azimuth,
    rightLegAround: rightLeg.azimuth,

    // Signed, both of them. The unsigned tilt this replaces gave leaning left and leaning
    // right the same number, which made the sway — a dance that is nothing but alternating
    // those two — literally unscoreable.
    roll: Math.atan2(dot(up, [-across[0], -across[1], -across[2]]), dot(up, worldUp)),
    pitch: Math.atan2(dot(up, forward), dot(up, worldUp)),
    // Shoulders against hips. The one angle that needs both, and the one that catches a
    // whole class of "your feet are right but your body is not" errors.
    twist: signedAngle(across, unit(sub(rh, lh)), up),
  }
}

/**
 * The same pose as seen in a mirror.
 *
 * Somebody copying a video facing the camera lifts the opposite arm. They are not wrong, and
 * a coach that told them so would be useless. Every routine is therefore scored both ways and
 * the better reading is kept — see `score.ts`.
 *
 * Because azimuth is measured *outward from each limb's own side*, mirroring is now a plain
 * swap for the limbs: a person raising their left arm forward and their mirror image raising
 * the right arm forward have the same azimuth. Only the torso's two lateral angles flip,
 * because roll and twist are measured against the body rather than per side.
 */
export function mirror(skeleton: Skeleton): Skeleton {
  return {
    leftElbow: skeleton.rightElbow,
    rightElbow: skeleton.leftElbow,
    leftShoulder: skeleton.rightShoulder,
    rightShoulder: skeleton.leftShoulder,
    leftArmAround: skeleton.rightArmAround,
    rightArmAround: skeleton.leftArmAround,
    leftKnee: skeleton.rightKnee,
    rightKnee: skeleton.leftKnee,
    leftHip: skeleton.rightHip,
    rightHip: skeleton.leftHip,
    leftLegAround: skeleton.rightLegAround,
    rightLegAround: skeleton.leftLegAround,
    roll: -skeleton.roll,
    pitch: skeleton.pitch,
    twist: -skeleton.twist,
  }
}

/** A skeleton as a fixed-order vector, for the distance function. */
export function toVector(skeleton: Skeleton): number[] {
  return ANGLES.map(name => skeleton[name])
}
