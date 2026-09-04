/**
 * Reading a face, on the device, without claiming to know how anybody feels.
 *
 * ## The line this file is built on
 *
 * A face can be read for **valence** — pleasant against unpleasant — weakly and with real
 * error. It cannot be read for a named emotion. The best available meta-analysis puts the
 * agreement between facial configurations and emotion categories at r ≈ .32, which the
 * field's own published thresholds call *weak*, and the specificity is worse: the studies
 * mostly do not report how often a scowl appears on somebody who is not angry, so the base
 * rate needed to invert "what does anger look like" into "what does this face mean" has never
 * been measured.
 *
 * Machines do not rescue it. Validated against fourteen databases, expression recognisers
 * score around 70% on *posed* faces and around 45% on *spontaneous* ones — and spontaneous is
 * the only kind this app will ever see. One commercial system managed 97% on standardised
 * images and 31% in the wild.
 *
 * So this module **describes what a face is doing and never says what a person feels.** That
 * is not only the honest reading of the science; it is also the line the EU AI Act draws.
 * Emotion recognition is high-risk under Annex III 1(c) with no sector limit and no consent
 * exemption, but Recital 18 excludes "the mere detection of readily apparent expressions,
 * gestures or movements", naming smiles and frowns exactly. *You look like you are smiling*
 * is detection. *You seem happy* is not.
 *
 * Nothing here is stored, and no frame leaves the device — the blendshapes are computed by
 * WebAssembly in this browser and this module only ever sees the numbers.
 *
 * ## Why the obvious arithmetic is wrong
 *
 * The natural design is a smile axis minus a brow-furrow axis. Measured, that is backwards:
 * on a broadly, unambiguously smiling portrait, `browDownLeft` reads **0.839**. A real smile
 * squeezes the corrugator, and AU4 fires for anger, concentration, squinting into the sun and
 * happiness alike. Subtracting it cancels the one signal that works.
 *
 * The honest negative markers on that same smiling face read near zero — `mouthFrown` 0.001,
 * `browInnerUp` 0.001 — so those carry the negative axis, and brow-furrow is admitted only as
 * whatever is left once any smile beneath it is accounted for.
 */

/**
 * The blendshapes this reader uses.
 *
 * MediaPipe emits 52 and these are the eleven that carry any of the signal — six action units,
 * most of them measured on both sides of the face. The other 41 are jaw, tongue, cheek puff,
 * individual eyelids and the like: useful for driving an avatar, silent about valence.
 */
export interface Blendshapes {
  mouthSmileLeft: number
  mouthSmileRight: number
  eyeSquintLeft: number
  eyeSquintRight: number
  mouthFrownLeft: number
  mouthFrownRight: number
  browInnerUp: number
  browDownLeft: number
  browDownRight: number
  mouthPressLeft: number
  mouthPressRight: number
}

/** How the head is held, in degrees, from the detector's transformation matrix. */
export interface HeadPose {
  roll: number
  yaw: number
}

export interface Reading {
  /** True when there was enough to say anything at all. Everything below is meaningless if false. */
  readable: boolean
  /**
   * A suggested position on the app's 1–5 scale, or null when nothing legible was found.
   *
   * Never 1. A camera may not tell somebody their day is rough — see {@link FLOOR}.
   */
  level: number | null
  /**
   * What the face appears to be doing, in the app's voice. Describes the face, never the
   * feeling, and is chosen from the evidence rather than from the level.
   */
  says: string
  /** −1 … +1. Exposed for tests and for anybody who wants to see the working. */
  valence: number
  /** How much there was to go on at all. Below {@link ENOUGH} the reader declines. */
  evidence: number
}

/**
 * Below this, the face is not saying anything legible and the reader declines.
 *
 * This gate is the single most important thing in the file, because the detector **fails
 * silently**: given a heavily blurred photograph it still returns a face, 478 landmarks and a
 * full 52-value blendshape vector, with the smile channel reading 0.107. There is no
 * `faceFound: false` and no confidence — unlike the server path, whose schema forces both. A
 * reader without this gate would confidently tell somebody photographing a grin in bad light
 * that their face was still.
 */
export const ENOUGH = 0.15

/** A crooked smile is a lighting artefact as often as an expression. */
export const MAX_ASYMMETRY = 0.15

/** Past this much head turn the blendshapes are measuring foreshortening. */
export const MAX_TILT = 25

/**
 * The lowest level a camera may suggest.
 *
 * A person may tell this app their day was rough. A photograph may not tell them so. The
 * asymmetry is deliberate: the cost of wrongly cheering somebody up is a shrug, and the cost
 * of a machine informing somebody that they look miserable is entirely different — and the
 * evidence for the negative half of this scale is the weakest part of a weak signal.
 */
export const FLOOR = 2

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function mean(a: number, b: number): number {
  return (a + b) / 2
}

/**
 * Read a face.
 *
 * The weights below are **judgement calls, not fitted parameters**, and saying so is part of
 * being honest about them: there is no labelled data here to fit against, and presenting them
 * as measured would be the dishonest part. They encode two defensible claims — that a smile
 * reaching the eyes is worth more than one that does not, and that the negative evidence in
 * this signal is weak enough to need a higher bar than the positive.
 */
export function read(shapes: Blendshapes, head: HeadPose): Reading {
  const smile = mean(shapes.mouthSmileLeft, shapes.mouthSmileRight)
  // AU6, the orbicularis. The classic marker separating a smile that reaches the eyes.
  const duchenne = mean(shapes.eyeSquintLeft, shapes.eyeSquintRight)
  const frown = mean(shapes.mouthFrownLeft, shapes.mouthFrownRight)
  const worry = shapes.browInnerUp
  const furrow = mean(shapes.browDownLeft, shapes.browDownRight)
  const press = mean(shapes.mouthPressLeft, shapes.mouthPressRight)

  const positive = smile * (0.6 + 0.4 * duchenne)
  // Brow-furrow counts only as whatever is left once any smile under it is accounted for.
  // See the header: on a genuinely smiling face this channel reads 0.84.
  const tension = clamp(furrow - smile, 0, 1)
  const negative = 0.5 * frown + 0.3 * worry + 0.2 * press + 0.3 * tension

  const valence = positive - negative
  const evidence = Math.max(positive, negative)
  const asymmetry = Math.abs(shapes.mouthSmileLeft - shapes.mouthSmileRight)

  const readable =
    evidence >= ENOUGH &&
    asymmetry <= MAX_ASYMMETRY &&
    Math.abs(head.roll) <= MAX_TILT &&
    Math.abs(head.yaw) <= MAX_TILT

  if (!readable) {
    return {
      readable: false,
      level: null,
      // Says what to do about it, and does not pretend the face was blank when the truth is
      // that the picture was.
      says: 'I could not read that one — try facing the camera a little more squarely.',
      valence,
      evidence,
    }
  }

  let level = Math.round(clamp(3 + 2 * valence, 1, 5))
  if (level < FLOOR) level = FLOOR
  // "Low" needs an unambiguous marker rather than the absence of a smile. A neutral face is
  // not a sad one, and most faces most of the time are neutral.
  if (level === 2 && frown < 0.4 && worry < 0.5) level = 3

  return {
    readable: true,
    level,
    says: describe(smile, duchenne, frown, worry, press),
    valence,
    evidence,
  }
}

/**
 * One sentence about the face, chosen from the evidence rather than from the level.
 *
 * Every line describes an expression and none names a feeling. This is the Recital 18 line
 * and it is also just true: the app can see a mouth shape, and it cannot see a mood.
 *
 * It is a lookup table, and that is this path's real weakness rather than a detail — a
 * household checking in daily will have memorised these inside a fortnight, where the server
 * reader writes something new every time. It is why the on-device reader supplements the
 * model rather than replacing it.
 */
function describe(
  smile: number,
  duchenne: number,
  frown: number,
  worry: number,
  press: number,
): string {
  if (smile >= 0.5 && duchenne >= 0.35)
    return 'That looks like a real smile — it reaches your eyes.'
  if (smile >= 0.5) return 'There is a smile there.'
  if (smile >= 0.25) return 'Something around a half-smile.'
  if (frown >= 0.4) return 'Your mouth is turned down a little.'
  if (worry >= 0.5) return 'Your brows are up in the middle — the worried shape.'
  if (press >= 0.4) return 'Your lips are pressed together.'
  return 'A fairly level face, as most faces are most of the time.'
}
