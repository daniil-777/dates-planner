/**
 * The figure, drawn.
 *
 * One component for two jobs, which is why it takes a pose rather than a routine: the
 * thumbnail on a routine card holds a single characteristic frame, and the demonstration
 * above the camera plays the whole thing. Both want the same body drawn the same way, and two
 * implementations of one figure would drift apart within a week.
 *
 * ## Limb capsules, not a stick figure
 *
 * Each bone is one `<line>` with a round cap, which *is* a capsule — a rounded rectangle for
 * the price of a stroke. Torso, thigh and upper arm are drawn heavier than forearm and shin,
 * which is the whole difference between something that reads as a body and something that
 * reads as a diagram. Nearer limbs are drawn over farther ones using the depth the projection
 * already computed, so an arm crossing the chest goes in front of it rather than through it.
 *
 * ## Why not point-lights alone
 *
 * The literature on biological motion is real — people read a walker from a dozen moving dots
 * — but it is about *motion*. A still frame of point-lights is famously unreadable, and half
 * of this component's job is a still frame on a card. So: capsules, with a dot at each joint,
 * which reads at both.
 */
import { BONES, VIEW_TURN, boundsOf, toFigure, type Dot } from './kinematics'
import { CIRCULAR, circularDistance, type Skeleton } from './pose'
import { REST } from './routines'

/**
 * How thick each bone is drawn, in figure units where the torso is 1. A body tapers; a
 * diagram does not.
 *
 * These started at roughly twice these values and the figure came out as a slab: a spine
 * drawn at 30% of its own length is not a torso, it is a domino, and at that weight the two
 * thighs merged into one shape. Limb *thickness* is a fraction of limb *length*, and for a
 * real body that fraction is small — an upper arm is about a seventh as thick as it is long.
 */
const WEIGHT: Record<string, number> = {
  'neck-hips': 0.17,
  'leftShoulder-rightShoulder': 0.075,
  'leftHip-rightHip': 0.09,
  'leftShoulder-leftElbow': 0.075,
  'rightShoulder-rightElbow': 0.075,
  'leftElbow-leftWrist': 0.06,
  'rightElbow-rightWrist': 0.06,
  'leftHip-leftKnee': 0.105,
  'rightHip-rightKnee': 0.105,
  'leftKnee-leftAnkle': 0.08,
  'rightKnee-rightAnkle': 0.08,
}

export interface DancerProps {
  pose: Skeleton
  /**
   * Every pose the figure will take, so the viewport can be sized once for all of them.
   *
   * Without it a moving figure appears to zoom, because the box is recomputed each frame and
   * the drawing rescales to fit — which reads as the camera moving rather than the dancer.
   */
  extent?: readonly Skeleton[]
  turn?: number
  /** Drawn faint, for a figure behind something else. */
  ghost?: boolean
  className?: string
  /** Announced to a screen reader. The figure itself is decorative. */
  label?: string
}

export function Dancer({
  pose,
  extent,
  turn = VIEW_TURN,
  ghost = false,
  className,
  label,
}: DancerProps): React.ReactElement {
  const figure = toFigure(pose, turn)
  const box = boundsOf((extent ?? [pose]).map(one => toFigure(one, turn)))

  // A little air, so a limb at full stretch does not touch the edge.
  const pad = 0.25
  const width = box.maxX - box.minX + pad * 2
  const height = box.maxY - box.minY + pad * 2
  const viewBox = `${box.minX - pad} ${box.minY - pad} ${width} ${height}`

  // Farthest first, so nearer limbs paint over them. `z` comes out of the same projection
  // that placed the joints, so this costs nothing.
  const bones = BONES.map(([from, to]) => {
    const a = figure[from]
    const b = figure[to]
    return {
      key: `${String(from)}-${String(to)}`,
      a,
      b,
      depth: (a.z + b.z) / 2,
      weight: WEIGHT[`${String(from)}-${String(to)}`] ?? 0.12,
    }
  }).sort((one, other) => one.depth - other.depth)

  const joints: Dot[] = [
    figure.leftShoulder,
    figure.rightShoulder,
    figure.leftElbow,
    figure.rightElbow,
    figure.leftHip,
    figure.rightHip,
    figure.leftKnee,
    figure.rightKnee,
  ]

  return (
    <svg
      className={`dancer${ghost ? ' dancer--ghost' : ''}${className ? ` ${className}` : ''}`}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role={label === undefined ? 'presentation' : 'img'}
      {...(label === undefined ? { 'aria-hidden': true } : { 'aria-label': label })}
    >
      {bones.map(bone => (
        <line
          key={bone.key}
          className="dancer__bone"
          x1={bone.a.x}
          y1={bone.a.y}
          x2={bone.b.x}
          y2={bone.b.y}
          strokeWidth={bone.weight}
        />
      ))}

      {joints.map((dot, index) => (
        <circle key={index} className="dancer__joint" cx={dot.x} cy={dot.y} r={0.038} />
      ))}

      {/* No face. A blank head is a body anybody can be, and a face is a person somebody
          is being compared to — which is the wrong feeling for a thing you copy in a
          kitchen. */}
      <circle className="dancer__head" cx={figure.head.x} cy={figure.head.y} r={0.145} />

      {/* The hands, a shade larger than the other joints. In a dance the hands are where the
          eye goes, and losing them in the line weight makes the figure hard to follow. */}
      <circle className="dancer__hand" cx={figure.leftWrist.x} cy={figure.leftWrist.y} r={0.052} />
      <circle
        className="dancer__hand"
        cx={figure.rightWrist.x}
        cy={figure.rightWrist.y}
        r={0.052}
      />
    </svg>
  )
}

/**
 * The frame that says most about a routine — the one furthest from simply standing there.
 *
 * Used for the thumbnail on a routine card. Four identical tiles tell the eye that four
 * things are interchangeable, which is the opposite of what a menu is for; a characteristic
 * pose tells somebody what they are choosing before they choose it.
 *
 * ## Why "furthest from standing" and not "furthest from the routine's own average"
 *
 * The average is the tempting measure and it picks the wrong frame. The underarm turn spends
 * most of its cycle with the arm *raised*, so its mean sits high and the outlier — the frame
 * furthest from that mean — is the one moment the arm is down. Measured: the resting frame
 * scored 3.36 against the peak's 2.84, so the card for the routine whose whole content is
 * lifting an arm would have shown a figure standing perfectly still.
 *
 * Against a fixed neutral there is no such inversion: the frame furthest from standing is the
 * one that looks least like standing, which is the picture wanted.
 */
export function signaturePose(sequence: readonly Skeleton[], neutral: Skeleton = REST): Skeleton {
  if (sequence.length === 0) throw new Error('a routine with no frames has no signature')

  const names = Object.keys(sequence[0]!) as (keyof Skeleton)[]

  let best = sequence[0]!
  let furthest = -1
  for (const frame of sequence) {
    let distance = 0
    for (const name of names) {
      const value = frame[name]
      const rest = neutral[name]
      if (!Number.isFinite(value) || !Number.isFinite(rest)) continue
      distance += CIRCULAR.has(name) ? circularDistance(value, rest) : Math.abs(value - rest)
    }
    if (distance > furthest) {
      furthest = distance
      best = frame
    }
  }
  return best
}
