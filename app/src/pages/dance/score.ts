/**
 * Turning an alignment into something a person can act on.
 *
 * ## The failure this file exists to avoid
 *
 * Almost every dance-scoring app shows a number and a colour. "78. Good!" It is useless, and
 * worse than useless, because it implies a precision nobody has and gives nothing to do next.
 * Somebody who scored 71 twice in a row has learned nothing except that they are stuck.
 *
 * What a real teacher says is short, singular and concrete: *"your left arm is late"*, or
 * *"you're doing it, but smaller than the music"*. One thing, named, with a direction. That
 * is what this file produces, and the number is demoted to a supporting role.
 *
 * ## The three faults, which are genuinely different
 *
 * The insight that makes specific feedback possible is that a limb can be wrong in three
 * ways that call for three different corrections, and they can be told apart arithmetically:
 *
 *  1. **Timing.** The shape is right and it arrives at the wrong moment. Detected by the
 *     limb fitting better at a non-zero shift (`limbOffset`). Fix: listen to the music.
 *  2. **Amplitude.** The shape is right and the size is wrong — the commonest fault in every
 *     beginner class, and the one people cannot see in themselves. Detected by comparing the
 *     *range* each angle travels through. Fix: bigger.
 *  3. **Shape.** Neither of the above explains it; the limb is somewhere else. Fix: watch
 *     the move again.
 *
 * They are checked in that order, because that is the order they are worth fixing in: timing
 * first (it is the cheapest to correct and the most audible), then size, then shape.
 *
 * ## Mirroring
 *
 * Somebody facing a screen copies it mirrored, and is not wrong. Both readings are scored
 * and the better one is kept. Doing anything else produces a coach that tells half its users
 * their arms are on the wrong side, which is the fastest way to be uninstalled.
 */
import { STILL, align, limbOffset, rangeOf, salience, type Alignment } from './dtw'
import {
  ANGLES,
  LIMBS,
  LIMB_LABEL,
  LIMB_OF,
  mirror,
  toVector,
  type AngleName,
  type Limb,
  type Skeleton,
} from './pose'

/** Where each angle sits in a vector, grouped by limb. Computed once. */
const INDICES_OF: Record<Limb, number[]> = LIMBS.reduce(
  (all, limb) => {
    all[limb] = ANGLES.map((name, index) => ({ name, index }))
      .filter(one => LIMB_OF[one.name as AngleName] === limb)
      .map(one => one.index)
    return all
  },
  {} as Record<Limb, number[]>,
)

/**
 * Radians of mean error that count as "perfect" and "hopeless".
 *
 * About 6° and 50°. The low end is not zero on purpose: pose estimation is noisy, two people
 * of different builds never match exactly, and a scale where nobody can reach the top is a
 * scale nobody believes. The high end is where a limb is unrecognisably elsewhere.
 */
const PERFECT = 0.1
const HOPELESS = 0.87

/** A shift of fewer than this many frames is human timing, not a fault. */
const TIMING_SLACK = 2

/** Below this ratio of the reference's range, a move is being done too small. */
const SMALL = 0.62
/** Above this, too big — rarer, and worth saying because it usually means muscling it. */
const LARGE = 1.55

export type Fault = 'timing' | 'amplitude' | 'shape' | 'none'

export interface LimbReport {
  limb: Limb
  /** 0–100. */
  score: number
  fault: Fault
  /** Frames the learner is behind. Negative is early. Only meaningful for `timing`. */
  shift: number
  /** Learner's range over the reference's. Only meaningful for `amplitude`. */
  size: number
  /**
   * How much this routine asks of this limb, in radians of travel.
   *
   * Near zero means the limb barely moves in the choreography, so its score says nothing and
   * it is left out of the body's. Reported rather than hidden, because "we did not grade
   * your legs, this dance has none" is a fair thing for a coach to be able to say.
   */
  asked: number
}

export interface Verdict {
  /** 0–100, over the whole body. */
  score: number
  /** True when the learner was read as a mirror image, which is the normal case. */
  mirrored: boolean
  limbs: LimbReport[]
  /**
   * The one thing to say. Written as a teacher would say it — singular, concrete, and with
   * a direction. Never a list: somebody who is told four things fixes none of them.
   */
  note: string
  /** Frames actually compared. Few means the camera saw very little, and the score is soft. */
  frames: number
}

/** Mean error in radians to a score out of 100. */
function toScore(error: number): number {
  if (Number.isNaN(error)) return 0
  const through = (error - PERFECT) / (HOPELESS - PERFECT)
  return Math.round(100 * Math.min(1, Math.max(0, 1 - through)))
}

/**
 * Score one reading (mirrored or not).
 *
 * Split out so both readings go through identical arithmetic — a mirrored path that scored
 * by a slightly different route would make the choice between them meaningless.
 */
function judge(
  reference: readonly (readonly number[])[],
  learner: readonly (readonly number[])[],
): { alignment: Alignment; limbs: LimbReport[]; score: number } {
  // Worked out once from both sequences and threaded through everything, so the alignment,
  // the limb scores and the body score all agree about what this routine is made of.
  const weights = salience(reference, learner, ANGLES.length)
  const alignment = align(reference, learner, undefined, weights)

  const limbs = LIMBS.map((limb): LimbReport => {
    const indices = INDICES_OF[limb]
    const offset = limbOffset(reference, learner, alignment.path, indices, weights)

    // A limb the routine never moves, and which the learner also kept still, matched — so
    // it scores full marks and carries no weight. Scoring it zero because there was nothing
    // to measure would be the mirror of the dilution bug: instead of a still dancer looking
    // good, a correct one would look terrible.
    //
    // Note this cannot hide a flail: salience takes the *larger* of the two ranges, so a
    // learner waving through a still passage gives the limb weight and gets graded on it.
    const nothingAsked = offset.weight < STILL

    // The score uses the *unshifted* error, because being out of time is a real fault and
    // scoring the shifted version would give full marks for a beautiful arm on the wrong
    // beat. The shift is used to *explain* the loss, not to forgive it.
    const score = nothingAsked ? 100 : toScore(offset.costAtZero)

    let size = 1
    let sized = 0
    for (const index of indices) {
      const wanted = rangeOf(reference, index)
      const got = rangeOf(learner, index)
      // Only angles that actually move in the reference say anything about amplitude: a
      // joint that is still throughout has no range to be a fraction of.
      if (Number.isNaN(wanted) || Number.isNaN(got) || wanted < 0.15) continue
      size += got / wanted
      sized += 1
    }
    size = sized === 0 ? 1 : (size - 1) / sized

    let fault: Fault = 'none'
    if (!nothingAsked && score < 88) {
      const improves = !Number.isNaN(offset.cost) && !Number.isNaN(offset.costAtZero)
      // Timing first: the shift has to be real *and* have to explain a decent part of the
      // error, or every limb gets blamed on timing because some shift always fits slightly
      // better than none.
      if (
        improves &&
        Math.abs(offset.shift) >= TIMING_SLACK &&
        offset.cost < offset.costAtZero * 0.75
      ) {
        fault = 'timing'
      } else if (sized > 0 && (size < SMALL || size > LARGE)) {
        fault = 'amplitude'
      } else {
        fault = 'shape'
      }
    }

    return { limb, score, fault, shift: offset.shift, size, asked: offset.weight }
  })

  // Weighted by how much each limb is *asked* to do, and limbs the routine never moves are
  // left out of the mean entirely.
  //
  // This is the line that stops a motionless dancer scoring well. A plain mean over five
  // limbs gives somebody who stood still through an arm routine four perfect scores for the
  // four limbs that were supposed to be still, and 94 overall. Weighting by demand says the
  // obvious thing instead: in a routine that is all arms, the arms are the score.
  const graded = limbs.filter(one => one.asked >= STILL)
  const pool = graded.length === 0 ? limbs : graded
  const demand = pool.reduce((sum, one) => sum + Math.max(one.asked, STILL), 0)
  const score = Math.round(
    pool.reduce((sum, one) => sum + one.score * Math.max(one.asked, STILL), 0) / demand,
  )
  return { alignment, limbs, score }
}

/**
 * Compare a performance to a routine.
 *
 * Both are sequences of skeletons, in order. They need not be the same length or the same
 * tempo — that is the point of the alignment.
 */
export function scoreRoutine(
  reference: readonly Skeleton[],
  learner: readonly Skeleton[],
): Verdict {
  const wanted = reference.map(toVector)
  const asIs = learner.map(toVector)
  const asMirror = learner.map(one => toVector(mirror(one)))

  const straight = judge(wanted, asIs)
  const mirrored = judge(wanted, asMirror)
  const better = mirrored.score > straight.score ? mirrored : straight

  return {
    score: better.score,
    mirrored: better === mirrored,
    limbs: better.limbs,
    note: noteFor(better.limbs, better.score),
    frames: better.alignment.path.length,
  }
}

/**
 * The one sentence.
 *
 * Picks the worst limb and says the single most useful thing about it. Deliberately never a
 * list — somebody told four things fixes none of them, and the worst fault is almost always
 * causing some of the others anyway.
 *
 * Only limbs the routine actually asks something of are eligible, in either direction. There
 * is no point praising somebody's legs for a dance that has none, and less point still in
 * blaming them.
 */
export function noteFor(limbs: readonly LimbReport[], score: number): string {
  const graded = limbs.filter(one => one.asked >= STILL)
  if (graded.length === 0) return 'Not enough of you was in shot to say anything useful.'

  // Praise is specific too, or it is noise. Naming the best limb is what makes it land.
  if (score >= 90) {
    const best = [...graded].sort((a, b) => b.score - a.score)[0]!
    return `That was really close. ${cap(LIMB_LABEL[best.limb])} in particular.`
  }

  const worst = [...graded].sort((a, b) => a.score - b.score)[0]!
  const name = LIMB_LABEL[worst.limb]

  switch (worst.fault) {
    case 'timing':
      return worst.shift > 0
        ? `The shape is there — ${name} is just arriving a little late.`
        : `The shape is there — ${name} is running slightly ahead of the music.`
    case 'amplitude':
      return worst.size < 1
        ? `You have the move. Try it bigger — ${name} is staying quite small.`
        : `Slightly less effort in ${name}; it is bigger than the music asks for.`
    case 'shape':
      return `Worth watching ${name} again — it is going somewhere different.`
    case 'none':
      return 'Solid all the way through. Try it at full speed.'
  }
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
