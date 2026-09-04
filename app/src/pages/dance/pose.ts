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
 * The twelve angles a pose is reduced to.
 *
 * Radians throughout — degrees only at the point of display, so no conversion can creep into
 * the arithmetic.
 */
export interface Skeleton {
  /** Elbow flexion: shoulder–elbow–wrist. */
  leftElbow: number
  rightElbow: number
  /** Shoulder elevation: how far the upper arm is raised from the torso. */
  leftShoulder: number
  rightShoulder: number
  /** Shoulder rotation: where the arm is around the body, front to back. */
  leftArmSwing: number
  rightArmSwing: number
  /** Knee flexion: hip–knee–ankle. */
  leftKnee: number
  rightKnee: number
  /** Hip flexion: how far the thigh is lifted. */
  leftHip: number
  rightHip: number
  /** Torso lean from vertical, and rotation of the shoulders against the hips. */
  lean: number
  twist: number
}

/** The angle names, in a fixed order, so a vector is always the same shape. */
export const ANGLES = [
  'leftElbow',
  'rightElbow',
  'leftShoulder',
  'rightShoulder',
  'leftArmSwing',
  'rightArmSwing',
  'leftKnee',
  'rightKnee',
  'leftHip',
  'rightHip',
  'lean',
  'twist',
] as const

export type AngleName = (typeof ANGLES)[number]

/**
 * Which limb an angle belongs to.
 *
 * This is what turns a number into a sentence: the feedback says "your left arm", not
 * "leftElbow and leftShoulder and leftArmSwing".
 */
export const LIMB_OF: Record<AngleName, Limb> = {
  leftElbow: 'leftArm',
  leftShoulder: 'leftArm',
  leftArmSwing: 'leftArm',
  rightElbow: 'rightArm',
  rightShoulder: 'rightArm',
  rightArmSwing: 'rightArm',
  leftKnee: 'leftLeg',
  leftHip: 'leftLeg',
  rightKnee: 'rightLeg',
  rightHip: 'rightLeg',
  lean: 'torso',
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
  const spine: Vec = sub(shoulders, hips)
  /**
   * Across the shoulders, left to right.
   *
   * Also the axis arm swing is signed around: swinging an arm forward or back rotates it in
   * the sagittal plane, and that plane's normal is the body's left-right axis. Signing
   * around the spine instead would give the same number for an arm in front and behind.
   */
  const across: Vec = sub(rs, ls)

  const le = at(JOINT.leftElbow)
  const lw = at(JOINT.leftWrist)
  const re = at(JOINT.rightElbow)
  const rw = at(JOINT.rightWrist)
  const lk = at(JOINT.leftKnee)
  const la = at(JOINT.leftAnkle)
  const rk = at(JOINT.rightKnee)
  const ra = at(JOINT.rightAnkle)

  const armSwing = (shoulder: Point, elbow: Point | undefined): number =>
    elbow === undefined || !seen(elbow)
      ? Number.NaN
      : signedAngle(sub(elbow, shoulder), spine, across)

  const legLift = (hip: Point, knee: Point | undefined): number =>
    knee === undefined || !seen(knee)
      ? Number.NaN
      : angleBetween(sub(knee, hip), [-spine[0], -spine[1], -spine[2]])

  return {
    leftElbow:
      le !== undefined && lw !== undefined && seen(le, lw) ? angleAt(le, ls, lw) : Number.NaN,
    rightElbow:
      re !== undefined && rw !== undefined && seen(re, rw) ? angleAt(re, rs, rw) : Number.NaN,

    leftShoulder: le !== undefined && seen(le) ? angleBetween(sub(le, ls), spine) : Number.NaN,
    rightShoulder: re !== undefined && seen(re) ? angleBetween(sub(re, rs), spine) : Number.NaN,

    leftArmSwing: armSwing(ls, le),
    rightArmSwing: armSwing(rs, re),

    leftKnee:
      lk !== undefined && la !== undefined && seen(lk, la) ? angleAt(lk, lh, la) : Number.NaN,
    rightKnee:
      rk !== undefined && ra !== undefined && seen(rk, ra) ? angleAt(rk, rh, ra) : Number.NaN,

    leftHip: legLift(lh, lk),
    rightHip: legLift(rh, rk),

    // Lean is measured against the *world's* vertical, which is the one thing here that is
    // not body-relative — because leaning is precisely a change in the body's relation to
    // gravity. MediaPipe's world frame has −y up.
    lean: angleBetween(spine, [0, -1, 0]),
    // Shoulders against hips. The one angle that needs both, and the one that catches a
    // whole class of "your feet are right but your body is not" errors.
    twist: signedAngle(across, sub(rh, lh), spine),
  }
}

/**
 * The same pose as seen in a mirror.
 *
 * Somebody copying a video facing the camera lifts the opposite arm. They are not wrong, and
 * a coach that told them so would be useless. Every routine is therefore scored both ways
 * and the better reading is kept — see `score.ts`.
 *
 * Mirroring is a swap of left and right plus a sign flip on everything that is signed. The
 * sign flips are the part that is easy to forget and the part that makes a mirrored score
 * silently slightly wrong rather than obviously broken.
 */
export function mirror(skeleton: Skeleton): Skeleton {
  return {
    leftElbow: skeleton.rightElbow,
    rightElbow: skeleton.leftElbow,
    leftShoulder: skeleton.rightShoulder,
    rightShoulder: skeleton.leftShoulder,
    leftArmSwing: -skeleton.rightArmSwing,
    rightArmSwing: -skeleton.leftArmSwing,
    leftKnee: skeleton.rightKnee,
    rightKnee: skeleton.leftKnee,
    leftHip: skeleton.rightHip,
    rightHip: skeleton.leftHip,
    lean: skeleton.lean,
    twist: -skeleton.twist,
  }
}

/** A skeleton as a fixed-order vector, for the distance function. */
export function toVector(skeleton: Skeleton): number[] {
  return ANGLES.map(name => skeleton[name])
}
