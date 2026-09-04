/**
 * The steps you can learn, written as keyframes.
 *
 * ## Why keyframes and not recorded video
 *
 * A reference routine has to come from somewhere. The obvious source is a recording of
 * somebody dancing, and it is the wrong one for this app: it means shipping video of a real
 * person, it means their body becomes the standard everybody is measured against, and it
 * means the reference carries a build and a proportion that the comparison then has to
 * undo. (It also means somebody has to be filmed.)
 *
 * Keyframes avoid all of that. A step is a handful of named poses and the beats between
 * them, and the reference sequence is interpolated at whatever rate the camera happens to
 * run at. It is bodiless by construction — pure joint angles, no build, no proportions, no
 * person — which is exactly what the comparison wants, since `pose.ts` throws away
 * everything else anyway.
 *
 * It also makes a step *editable*. Adding a dance is a dozen numbers, not a film shoot.
 *
 * ## What these are
 *
 * Deliberately simple, deliberately social. These are the movements two people do in a
 * kitchen, not choreography: a basic step, a turn, a sway. The point of this chapter is a
 * pair of people trying something together and laughing at the score, and a routine nobody
 * can do on the first evening fails at that.
 *
 * Angles are radians, and the values are what the body actually does — a relaxed arm hangs
 * at about 0.2 rad from the torso, not 0.
 */
import type { Skeleton } from './pose'

/** A pose held at a moment in the bar, `beat` counted from zero. */
export interface Keyframe {
  beat: number
  pose: Partial<Skeleton>
}

export interface Routine {
  id: string
  name: string
  /** One line, said the way somebody would describe it to you. */
  blurb: string
  /** Beats per minute the step is written for. */
  bpm: number
  /**
   * How many times through.
   *
   * One repetition of any of these is four to eight seconds, which is not a dance and is not
   * enough to score: the alignment needs a few cycles before "you are consistently late" can
   * be told apart from "you fluffed the start". Three to five repetitions puts every routine
   * at about twenty seconds, which is long enough to measure and short enough that nobody
   * dreads pressing the button.
   *
   * The length of one repetition is not stored — it is the last keyframe's beat, so the two
   * can never disagree. An earlier version carried a `bars` field that said twelve while the
   * keyframes ended at six, and the reference simply froze for half of every capture.
   */
  reps: number
  /** What to think about while doing it. Shown before the count-in, not during. */
  hint: string
  keys: Keyframe[]
}

/** A body at rest: arms down, knees straight, upright. Every keyframe is a change from this. */
export const REST: Skeleton = {
  leftElbow: 2.9,
  rightElbow: 2.9,
  leftShoulder: 0.18,
  rightShoulder: 0.18,
  leftArmSwing: 0,
  rightArmSwing: 0,
  leftKnee: 3.0,
  rightKnee: 3.0,
  leftHip: 0.12,
  rightHip: 0.12,
  lean: 0,
  twist: 0,
}

export const ROUTINES: readonly Routine[] = [
  {
    id: 'sway',
    name: 'The sway',
    blurb: 'Weight from one foot to the other, in time. The whole of slow dancing.',
    bpm: 72,
    reps: 3,
    hint: 'It is in the hips, not the shoulders. Let your head stay still.',
    keys: [
      { beat: 0, pose: { twist: 0, lean: 0, leftKnee: 3.0, rightKnee: 3.0 } },
      // Weight onto the left: that knee softens, the body leans a little that way.
      { beat: 2, pose: { lean: 0.14, leftKnee: 2.75, rightKnee: 3.05, twist: 0.05 } },
      { beat: 4, pose: { twist: 0, lean: 0, leftKnee: 3.0, rightKnee: 3.0 } },
      { beat: 6, pose: { lean: -0.14, leftKnee: 3.05, rightKnee: 2.75, twist: -0.05 } },
      { beat: 8, pose: { twist: 0, lean: 0, leftKnee: 3.0, rightKnee: 3.0 } },
    ],
  },
  {
    id: 'box',
    name: 'The box step',
    blurb: 'Forward, side, together — then back the same way. Waltz, and half of everything else.',
    bpm: 96,
    reps: 5,
    hint: 'Small steps. The box is about the size of a bath mat, not a room.',
    keys: [
      { beat: 0, pose: { leftHip: 0.12, rightHip: 0.12, leftKnee: 3.0, rightKnee: 3.0, twist: 0 } },
      // Left foot forward.
      { beat: 1, pose: { leftHip: 0.42, leftKnee: 2.7, rightHip: 0.05, twist: 0.06 } },
      // Right foot to the side.
      { beat: 2, pose: { leftHip: 0.15, rightHip: 0.3, rightKnee: 2.85, twist: -0.04 } },
      { beat: 3, pose: { leftHip: 0.12, rightHip: 0.12, leftKnee: 3.0, rightKnee: 3.0, twist: 0 } },
      // Right foot back.
      { beat: 4, pose: { rightHip: -0.18, rightKnee: 2.8, leftHip: 0.14, twist: -0.06 } },
      { beat: 5, pose: { leftHip: 0.28, leftKnee: 2.85, rightHip: 0.08, twist: 0.04 } },
      { beat: 6, pose: { leftHip: 0.12, rightHip: 0.12, leftKnee: 3.0, rightKnee: 3.0, twist: 0 } },
    ],
  },
  {
    id: 'turn',
    name: 'The underarm turn',
    blurb: 'One of you lifts a hand, the other goes under it. Four counts, and it always works.',
    bpm: 110,
    reps: 6,
    hint: 'The lifted arm stays still. It is a doorway, not a lever — the turn is in the feet.',
    keys: [
      { beat: 0, pose: { leftShoulder: 0.2, leftElbow: 2.9, twist: 0 } },
      // The hand goes up and the elbow bends: the frame that makes the doorway.
      { beat: 1, pose: { leftShoulder: 2.4, leftElbow: 1.7, twist: 0.1 } },
      { beat: 2, pose: { leftShoulder: 2.6, leftElbow: 1.5, twist: 0.5 } },
      // Through, and the body has turned under it.
      { beat: 3, pose: { leftShoulder: 2.6, leftElbow: 1.6, twist: 0.9 } },
      { beat: 4, pose: { leftShoulder: 2.3, leftElbow: 1.9, twist: 0.4 } },
      { beat: 5, pose: { leftShoulder: 0.4, leftElbow: 2.7, twist: 0 } },
      { beat: 6, pose: { leftShoulder: 0.2, leftElbow: 2.9, twist: 0 } },
    ],
  },
  {
    id: 'shoulders',
    name: 'Shoulder bounce',
    blurb: 'Nothing but shoulders and a bit of knee. Impossible to do badly, hard to stop.',
    bpm: 118,
    reps: 18,
    hint: 'Let your arms be heavy. They should swing because your body moved, not on purpose.',
    // A two-beat loop, and the last keyframe is the first: anything else leaves a jump
    // where the repetition joins, which the reference then teaches as part of the step.
    //
    // Both knees are named in every keyframe on purpose. Keyframes accumulate — a joint not
    // mentioned keeps whatever the last keyframe that named it set — so bending only the
    // left knee here would leave it bent for the rest of the routine and end up with a
    // reference doing the whole dance in a permanent half-squat.
    keys: [
      {
        beat: 0,
        pose: {
          twist: 0.18,
          leftShoulder: 0.3,
          rightShoulder: 0.14,
          leftKnee: 2.85,
          rightKnee: 3.0,
        },
      },
      {
        beat: 1,
        pose: {
          twist: -0.18,
          leftShoulder: 0.14,
          rightShoulder: 0.3,
          leftKnee: 3.0,
          rightKnee: 2.85,
        },
      },
      {
        beat: 2,
        pose: {
          twist: 0.18,
          leftShoulder: 0.3,
          rightShoulder: 0.14,
          leftKnee: 2.85,
          rightKnee: 3.0,
        },
      },
    ],
  },
]

/**
 * Turn a routine into the sequence the scorer compares against.
 *
 * Interpolated at `fps` with a raised cosine between keyframes rather than a straight line.
 * Linear interpolation gives a body that changes direction instantly at every keyframe,
 * which no body does — and since the scorer measures *amplitude* and *timing*, a reference
 * with unnatural corners in it would mark real dancers down for being smooth.
 *
 * Angles not mentioned in a keyframe hold their value from the last keyframe that set them,
 * falling back to {@link REST}. That is what lets a routine about legs say nothing about
 * arms without accidentally asserting the arms are pinned.
 */
export function toSequence(routine: Routine, fps = 20): Skeleton[] {
  const perBeat = (60 / routine.bpm) * fps
  const sorted = [...routine.keys].sort((a, b) => a.beat - b.beat)
  const span = beatsIn(routine)
  const total = Math.max(2, Math.round(span * perBeat * routine.reps))

  const frames: Skeleton[] = []
  for (let frame = 0; frame < total; frame += 1) {
    // Modulo, so the step repeats rather than the last pose being held. Every routine here
    // ends where it began, so the seam is invisible.
    const beat = (frame / perBeat) % span
    frames.push(poseAt(sorted, beat))
  }
  return frames
}

/** Beats in one repetition: the last keyframe's, so it cannot disagree with the keyframes. */
export function beatsIn(routine: Routine): number {
  const last = routine.keys.reduce((most, one) => Math.max(most, one.beat), 0)
  return last > 0 ? last : 1
}

/** How long one attempt takes, in seconds. */
export function secondsFor(routine: Routine): number {
  return (beatsIn(routine) / routine.bpm) * 60 * routine.reps
}

/** The pose at a moment, interpolated between the keyframes on either side. */
export function poseAt(keys: readonly Keyframe[], beat: number): Skeleton {
  if (keys.length === 0) return { ...REST }

  // Before the first or after the last: hold. A routine loops, and the caller decides where
  // the loop is; extrapolating here would invent movement nobody wrote.
  const first = keys[0]!
  const last = keys[keys.length - 1]!
  if (beat <= first.beat) return settle(keys, 0, { ...REST })
  if (beat >= last.beat) return settle(keys, keys.length - 1, { ...REST })

  let index = 0
  while (index < keys.length - 1 && keys[index + 1]!.beat <= beat) index += 1

  const from = keys[index]!
  const to = keys[index + 1]!
  const span = to.beat - from.beat
  const through = span <= 0 ? 0 : (beat - from.beat) / span
  // Raised cosine: zero velocity at each keyframe, so the body eases in and out rather than
  // snapping direction. A real body cannot do a corner, and a reference that does one
  // penalises everybody who cannot either.
  const eased = (1 - Math.cos(Math.PI * through)) / 2

  const before = settle(keys, index, { ...REST })
  const after = settle(keys, index + 1, { ...REST })

  const between = { ...REST }
  for (const name of Object.keys(REST) as (keyof Skeleton)[]) {
    between[name] = before[name] + (after[name] - before[name]) * eased
  }
  return between
}

/**
 * The full pose at keyframe `index`, filling anything it does not mention from the most
 * recent keyframe that did.
 */
function settle(keys: readonly Keyframe[], index: number, base: Skeleton): Skeleton {
  const pose = { ...base }
  for (let at = 0; at <= index; at += 1) {
    Object.assign(pose, keys[at]!.pose)
  }
  return pose
}
