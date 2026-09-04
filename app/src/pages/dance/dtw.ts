/**
 * Lining up two performances in time — dynamic time warping.
 *
 * ## Why this is the whole problem
 *
 * Compare two dances frame by frame and you are not measuring dancing, you are measuring
 * *tempo*. Somebody performing the routine perfectly but a beat behind scores zero against
 * every frame; somebody standing still scores better, because at least they match the
 * moments the reference is also nearly still.
 *
 * That is not a rounding error, it is the wrong answer, and it is why every naive dance
 * scorer feels arbitrary to use. **Being slightly slow is not a mistake.** Getting there in
 * the wrong order is.
 *
 * Dynamic time warping is the standard answer and has been since speech recognition needed
 * it in the 1970s: find the alignment between two sequences that minimises total distance,
 * subject to the alignment only ever moving forwards in both. Time may be stretched and
 * squeezed; it may not be reordered. That is exactly the distinction wanted here.
 *
 * ## The band, which is not an optimisation
 *
 * Unconstrained DTW will happily align forty frames of the learner to one frame of the
 * reference — a "pathological alignment", and it is what lets somebody score well by
 * standing still in roughly the right shape. A **Sakoe–Chiba band** forbids the alignment
 * from drifting more than `w` frames from the diagonal, which says: you may be a little
 * early or a little late, you may not be in a different part of the song.
 *
 * It also takes the cost from O(n·m) to O(n·w), which matters on a phone, but the reason it
 * is here is correctness.
 *
 * ## What comes out
 *
 * Not just a number. The **path** comes out too, and that is what makes the feedback
 * specific: once the global alignment is known, each limb can be checked against it
 * separately, and a limb that fits better shifted a few frames is a limb that is early or
 * late. "Your left arm is a quarter-beat behind" is a thing somebody can act on; "you scored
 * 71" is not.
 */

import { CIRCULAR_MASK, circularDistance } from './pose'

/** One step of the alignment: reference frame `i` goes with learner frame `j`. */
export interface Step {
  i: number
  j: number
}

export interface Alignment {
  /** Mean distance along the path. Lower is closer. */
  cost: number
  path: Step[]
}

/**
 * How far the alignment may stray from the diagonal, as a fraction of the longer sequence.
 *
 * A tenth is about a beat at ordinary tempo over a short routine — generous enough that
 * nobody is punished for human timing, tight enough that standing still cannot be made to
 * fit. This is the one number in the file worth tuning against real dancers.
 */
export const BAND = 0.1

/** The smallest band that still works, so a very short routine is not over-constrained. */
const MIN_BAND = 4

/**
 * How much each angle matters in this particular routine.
 *
 * ## Why a plain average is the wrong comparison
 *
 * Twelve angles are compared, and in most routines most of them barely move. Average the
 * error across all twelve and a dance that is all arms has its arm error divided by ten
 * still joints — so somebody who **stands completely still** through an arm routine comes
 * out at 94 out of 100, because the four limbs they were meant to keep still were indeed
 * still. That is not a harsh scale or a tuning problem; it is measuring the wrong thing.
 *
 * **Error only means something where there was supposed to be movement.** So every angle is
 * weighted by how far it actually travels, and a joint that holds the same value from start
 * to finish contributes nothing to the score in either direction.
 *
 * ## Why the weight is the larger of the two ranges
 *
 * Taking the reference's range alone would catch "you did not move when you should have"
 * and miss its mirror image — flailing an arm the routine keeps still would be free, because
 * that angle would carry no weight. Taking the larger of the two catches both faults with
 * one number, which is the sort of symmetry worth having in a scoring function.
 */
export function salience(
  reference: readonly (readonly number[])[],
  learner: readonly (readonly number[])[],
  angles: number,
): number[] {
  const weights: number[] = []
  for (let index = 0; index < angles; index += 1) {
    weights.push(Math.max(rangeOf(reference, index), rangeOf(learner, index)))
  }
  return weights
}

/** The distance between two values of angle `index`, the short way round if it is circular. */
function gap(index: number, a: number, b: number): number {
  return CIRCULAR_MASK[index] === true ? circularDistance(a, b) : Math.abs(a - b)
}

/**
 * How far one angle travels over a sequence. `NaN` frames are skipped; all-NaN is zero.
 *
 * For a circular angle this is the largest gap between any two frames rather than
 * `max − min`: an arm swinging through the ±π seam has values at both ends of the range and
 * a naive span would report nearly a full turn for a small movement.
 */
export function rangeOf(frames: readonly (readonly number[])[], index: number): number {
  const seenValues: number[] = []
  for (const frame of frames) {
    const value = frame[index]
    if (value === undefined || Number.isNaN(value)) continue
    seenValues.push(value)
  }
  if (seenValues.length === 0) return 0

  if (CIRCULAR_MASK[index] !== true) {
    return Math.max(...seenValues) - Math.min(...seenValues)
  }

  // Circular: the widest short-way gap between any two samples. Sampled rather than
  // exhaustive when the sequence is long, because this is O(n²) and runs per angle.
  const step = Math.max(1, Math.floor(seenValues.length / 60))
  let widest = 0
  for (let i = 0; i < seenValues.length; i += step) {
    for (let j = i + step; j < seenValues.length; j += step) {
      const apart = circularDistance(seenValues[i]!, seenValues[j]!)
      if (apart > widest) widest = apart
    }
  }
  return widest
}

/**
 * Below this much travel (about 6°), an angle is treated as still and carries no weight.
 *
 * Pose estimation jitters, so a genuinely motionless joint still shows a small range, and
 * without a floor that jitter would be weighted as though it were choreography.
 */
export const STILL = 0.1

/**
 * Distance between two frames, weighted by salience and skipping anything that was not seen.
 *
 * Angles are in radians, so the raw difference is already comparable across joints — an
 * elbow and a knee out by the same amount contribute the same, which is what a viewer would
 * say too.
 *
 * `NaN` means the detector could not see that joint, and those are **skipped rather than
 * counted as zero or as maximal**. Counting them as zero rewards standing behind furniture;
 * counting them as maximal punishes somebody for the camera's angle. Skipping is the only
 * honest option, and if too few remain the frame has no opinion.
 */
export function frameDistance(
  a: readonly number[],
  b: readonly number[],
  weights?: readonly number[],
): number {
  let sum = 0
  let total = 0
  let counted = 0

  for (let index = 0; index < a.length && index < b.length; index += 1) {
    const one = a[index]
    const other = b[index]
    if (one === undefined || other === undefined) continue
    if (Number.isNaN(one) || Number.isNaN(other)) continue

    // Unweighted when no salience is supplied — the plain mean, which is what a caller
    // comparing two frames in isolation wants.
    const weight = weights === undefined ? 1 : (weights[index] ?? 0)
    if (weight < (weights === undefined ? 0 : STILL)) continue

    // Absolute rather than squared: squaring makes one badly-placed arm dominate the whole
    // frame, and a dancer with one thing wrong should not be told everything is wrong.
    //
    // The azimuths live on a circle, so they take the short way round: an arm at +179° and
    // one at −179° are two degrees apart, and plain subtraction would call them 358° apart —
    // which is the largest error the scale can express, for two poses that are the same.
    sum += gap(index, one, other) * weight
    total += weight
    counted += 1
  }

  // Fewer than a third of the angles visible is not a frame worth an opinion — unless
  // salience has already narrowed the comparison to the few joints that move, in which case
  // two is plenty and demanding four would throw the routine away.
  const enough = weights === undefined ? 4 : 1
  if (counted < enough || total === 0) return Number.NaN
  return sum / total
}

/**
 * Align `learner` to `reference`.
 *
 * Both are sequences of angle vectors. Returns the mean distance along the best path and the
 * path itself.
 */
export function align(
  reference: readonly (readonly number[])[],
  learner: readonly (readonly number[])[],
  bandFraction = BAND,
  weights?: readonly number[],
): Alignment {
  const n = reference.length
  const m = learner.length
  if (n === 0 || m === 0) return { cost: Number.NaN, path: [] }

  const w = Math.max(MIN_BAND, Math.ceil(bandFraction * Math.max(n, m)), Math.abs(n - m))

  // `cost[i][j]` is the best total distance to align the first i and j frames. Padded by one
  // so the boundary is Infinity and needs no special case inside the loop.
  const cost: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(Infinity),
  )
  cost[0]![0] = 0

  // How many real (non-skipped) frames each cell's path covers, so the final cost can be a
  // mean rather than a total — otherwise a longer routine always "scores worse".
  const steps: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))

  for (let i = 1; i <= n; i += 1) {
    // The band, expressed in learner frames for this reference frame.
    const from = Math.max(1, i - w)
    const to = Math.min(m, i + w)

    for (let j = from; j <= to; j += 1) {
      const d = frameDistance(reference[i - 1]!, learner[j - 1]!, weights)
      // An unseeable frame costs nothing and counts for nothing. It still has to be *passed
      // through*, or the path could not cross a moment when somebody stepped out of shot.
      const usable = Number.isNaN(d) ? 0 : d
      const counts = Number.isNaN(d) ? 0 : 1

      const diagonal = cost[i - 1]![j - 1]!
      const up = cost[i - 1]![j]!
      const left = cost[i]![j - 1]!

      let best = diagonal
      let bi = i - 1
      let bj = j - 1
      if (up < best) {
        best = up
        bi = i - 1
        bj = j
      }
      if (left < best) {
        best = left
        bi = i
        bj = j - 1
      }
      if (best === Infinity) continue

      cost[i]![j] = best + usable
      steps[i]![j] = steps[bi]![bj]! + counts
    }
  }

  const total = cost[n]![m]!
  if (total === Infinity) return { cost: Number.NaN, path: [] }
  const counted = steps[n]![m]!

  return { cost: counted === 0 ? Number.NaN : total / counted, path: trace(cost, n, m, w) }
}

/** Walk the cost matrix back from the end, choosing the cheapest predecessor each time. */
function trace(cost: number[][], n: number, m: number, w: number): Step[] {
  const path: Step[] = []
  let i = n
  let j = m

  while (i > 0 && j > 0) {
    path.push({ i: i - 1, j: j - 1 })
    const diagonal = cost[i - 1]?.[j - 1] ?? Infinity
    const up = cost[i - 1]?.[j] ?? Infinity
    const left = cost[i]?.[j - 1] ?? Infinity

    if (diagonal <= up && diagonal <= left) {
      i -= 1
      j -= 1
    } else if (up <= left) {
      i -= 1
    } else {
      j -= 1
    }
    // Cannot happen with a band wide enough to reach the corner, and would be an infinite
    // loop rather than a wrong answer if it did.
    if (path.length > (n + m) * (w + 2)) break
  }

  return path.reverse()
}

/**
 * The error a completely motionless learner would make.
 *
 * ## Why the score needs this
 *
 * Scoring measured raw radians against fixed thresholds, and that is only meaningful if every
 * routine asks for roughly the same amount of movement. They do not. The underarm turn swings
 * a shoulder through 138 degrees; the sway shifts a knee through 17. With an absolute
 * "under 0.1 rad is perfect" floor, **standing completely still through the sway scored 100
 * out of 100** — the whole movement was smaller than the threshold, so doing nothing landed
 * inside it. Three of the four shipped routines behaved that way and congratulated the
 * motionless.
 *
 * The fix is not a smaller constant, which would only move the problem to a smaller routine.
 * It is to measure error against *what this routine actually asks for*, and the natural unit
 * is the error somebody makes by not moving at all: the mean absolute deviation of the
 * reference from its own average pose. That is computed here rather than assumed from the
 * keyframe shape, so it is exact for any routine anybody writes later.
 *
 * A relative scale is self-calibrating. Ten degrees out is excellent on a routine that swings
 * through a hundred and forty, and total failure on one that moves through twelve.
 */
export function stillnessError(
  reference: readonly (readonly number[])[],
  indices: readonly number[],
  weights: readonly number[],
): number {
  let sum = 0
  let total = 0

  for (const index of indices) {
    const weight = weights[index] ?? 0
    if (weight < STILL) continue

    // The mean of this angle over the routine — the pose a motionless learner is effectively
    // holding, if they hold the most forgiving one available to them.
    let mean = 0
    let counted = 0
    for (const frame of reference) {
      const value = frame[index]
      if (value === undefined || Number.isNaN(value)) continue
      mean += value
      counted += 1
    }
    if (counted === 0) continue
    mean /= counted

    let deviation = 0
    for (const frame of reference) {
      const value = frame[index]
      if (value === undefined || Number.isNaN(value)) continue
      deviation += gap(index, value, mean)
    }
    sum += (deviation / counted) * weight
    total += weight
  }

  return total === 0 ? Number.NaN : sum / total
}

/**
 * How far out of time one limb is, in frames.
 *
 * ## The idea
 *
 * The global alignment says where the *performance* sits in time. A limb that fits the
 * reference better when shifted a few frames further is a limb that is out of time **with
 * the rest of the body** — which is a completely different fault from being in the wrong
 * shape, and the one a dancer most wants to hear about.
 *
 * So: take the aligned pairs, try sliding this limb's angles a few frames each way, and see
 * which shift fits best. Positive means the learner is **late**.
 *
 * ## Why this and not per-limb DTW
 *
 * Because a limb warped on its own can be aligned to almost anything, and the result stops
 * meaning "out of time" and starts meaning "contains similar shapes somewhere". A rigid
 * shift is the right model of the actual fault: a whole arm arriving consistently behind the
 * beat. Anything a rigid shift cannot explain is a shape error, and is reported as one.
 */
export function limbOffset(
  reference: readonly (readonly number[])[],
  learner: readonly (readonly number[])[],
  path: readonly Step[],
  indices: readonly number[],
  weights: readonly number[],
  maxShift = 8,
): { shift: number; cost: number; costAtZero: number; weight: number } {
  let best = { shift: 0, cost: Infinity }
  let atZero = Infinity

  // How much this limb is asked to do in this routine. A limb with nothing to do cannot be
  // graded, and pretending otherwise is what let a motionless dancer score well.
  const weight = indices.reduce((sum, index) => sum + Math.max(0, weights[index] ?? 0), 0)

  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    let sum = 0
    let total = 0

    for (const step of path) {
      const j = step.j + shift
      if (j < 0 || j >= learner.length) continue
      const a = reference[step.i]
      const b = learner[j]
      if (a === undefined || b === undefined) continue

      for (const index of indices) {
        const one = a[index]
        const other = b[index]
        if (one === undefined || other === undefined) continue
        if (Number.isNaN(one) || Number.isNaN(other)) continue

        const w = weights[index] ?? 0
        if (w < STILL) continue
        sum += gap(index, one, other) * w
        total += w
      }
    }

    if (total === 0) continue
    const mean = sum / total
    if (shift === 0) atZero = mean
    if (mean < best.cost) best = { shift, cost: mean }
  }

  return {
    shift: best.cost === Infinity ? 0 : best.shift,
    cost: best.cost === Infinity ? Number.NaN : best.cost,
    costAtZero: atZero === Infinity ? Number.NaN : atZero,
    weight,
  }
}
