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
import { CIRCULAR, type Skeleton } from './pose'

/** The signed short way from `a` to `b` around the circle, in (−π, π]. */
function shortWay(a: number, b: number): number {
  let delta = (b - a) % (2 * Math.PI)
  if (delta > Math.PI) delta -= 2 * Math.PI
  if (delta < -Math.PI) delta += 2 * Math.PI
  return delta
}

/** Back into (−π, π]. */
function wrap(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}

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

/**
 * A body at rest: arms hanging, knees straight, upright.
 *
 * ## The convention, which the first version got wrong
 *
 * Every number here is in the frame `pose.ts` extracts, and the values were **measured from
 * synthetic landmarks** rather than guessed — because the first version guessed and was
 * wrong in a way nothing caught.
 *
 * Shoulder elevation is measured from the spine pointing *up*, so:
 *
 * | pose | elevation |
 * |---|---|
 * | arm straight overhead | `0` |
 * | arm horizontal | `π/2` ≈ 1.57 |
 * | arm hanging by the side | `π` ≈ 3.0 |
 *
 * The old `REST` said `leftShoulder: 0.18`, which is a person standing with both arms
 * straight above their head. Every routine was therefore written against a reference pose no
 * camera would ever report, and the arm comparison in the one routine that moved its arms
 * was measuring the difference between a real body and a scarecrow.
 *
 * Knees and elbows are flexion, so `π` is straight. Hip elevation is measured from the spine
 * pointing *down*, so a standing leg is `0` and a lifted one grows from there.
 */
export const REST: Skeleton = {
  leftElbow: 3.0,
  rightElbow: 3.0,
  // Hanging, not overhead.
  leftShoulder: 2.95,
  rightShoulder: 2.95,
  // A hanging arm points nowhere in particular, so the direction is only meaningful once it
  // leaves the side. Zero is "out to its own side", which is where it drifts to first.
  leftArmAround: 0,
  rightArmAround: 0,
  leftKnee: 3.1,
  rightKnee: 3.1,
  leftHip: 0.05,
  rightHip: 0.05,
  leftLegAround: 0,
  rightLegAround: 0,
  roll: 0,
  pitch: 0,
  twist: 0,
}

/**
 * How big a movement has to be before a camera can tell it from noise.
 *
 * Pose estimation jitters by something like five to ten degrees on a good frame. The first
 * set of routines moved through 6–28°, which is at or under that floor, and the result was
 * that **standing perfectly still scored 99 or 100 on three of the four of them**. Anything
 * shipped has to clear this by a comfortable margin on at least one limb, and a test enforces
 * it.
 */
export const MIN_DEMAND = 0.6

export const ROUTINES: readonly Routine[] = [
  {
    id: 'sway',
    name: 'The sway',
    blurb: 'Weight from one foot to the other, in time. The whole of slow dancing.',
    bpm: 72,
    reps: 3,
    hint: 'It is in the hips. Let your shoulders follow rather than lead.',
    // Four beats each way. The signed roll is what makes this a dance rather than a wobble —
    // with the unsigned tilt this file used to be written against, leaning left and leaning
    // right were the same number and the whole routine was unscoreable.
    keys: [
      {
        beat: 0,
        pose: {
          roll: 0,
          leftKnee: 3.1,
          rightKnee: 3.1,
          twist: 0,
          leftShoulder: 2.95,
          rightShoulder: 2.95,
        },
      },
      {
        beat: 2,
        // Onto the left foot: that knee straightens, the right softens, the body tips left.
        pose: {
          roll: 0.42,
          leftKnee: 3.1,
          rightKnee: 2.6,
          twist: 0.16,
          leftShoulder: 2.72,
          rightShoulder: 2.95,
        },
      },
      {
        beat: 4,
        pose: {
          roll: 0,
          leftKnee: 3.1,
          rightKnee: 3.1,
          twist: 0,
          leftShoulder: 2.95,
          rightShoulder: 2.95,
        },
      },
      {
        beat: 6,
        pose: {
          roll: -0.42,
          leftKnee: 2.6,
          rightKnee: 3.1,
          twist: -0.16,
          leftShoulder: 2.95,
          rightShoulder: 2.72,
        },
      },
      {
        beat: 8,
        pose: {
          roll: 0,
          leftKnee: 3.1,
          rightKnee: 3.1,
          twist: 0,
          leftShoulder: 2.95,
          rightShoulder: 2.95,
        },
      },
    ],
  },
  {
    id: 'box',
    name: 'The box step',
    blurb: 'Forward, side, together — then back the same way. Waltz, and half of everything else.',
    bpm: 96,
    reps: 4,
    hint: 'Small steps, but commit to the direction. Forward means forward, not vaguely.',
    // `leftLegAround` is what makes this a box. Without a direction for the leg — which is
    // what this file used to have — a step forward, a step to the side and a step backwards
    // were an identical number, and the routine named after the difference between them could
    // not express any of it.
    keys: [
      {
        beat: 0,
        pose: { leftHip: 0.05, rightHip: 0.05, leftKnee: 3.1, rightKnee: 3.1, pitch: 0, twist: 0 },
      },
      {
        beat: 1,
        // Left foot FORWARD: azimuth +π/2.
        pose: { leftHip: 0.62, leftLegAround: 1.5, leftKnee: 2.85, pitch: 0.12, twist: 0.1 },
      },
      {
        beat: 2,
        // Right foot to the SIDE: azimuth 0, out from its own side.
        pose: {
          leftHip: 0.1,
          rightHip: 0.55,
          rightLegAround: 0,
          rightKnee: 2.95,
          pitch: 0,
          twist: -0.08,
        },
      },
      {
        beat: 3,
        // Feet together. The azimuths are restored explicitly: keyframes accumulate, so a
        // direction set on beat 1 is still set on beat 6 unless something clears it, and the
        // repetition would then start from a pose the first beat never described.
        pose: {
          leftHip: 0.05,
          rightHip: 0.05,
          leftLegAround: 0,
          rightLegAround: 0,
          leftKnee: 3.1,
          rightKnee: 3.1,
          pitch: 0,
          twist: 0,
        },
      },
      {
        beat: 4,
        // Right foot BACK: azimuth −π/2.
        pose: { rightHip: 0.6, rightLegAround: -1.5, rightKnee: 2.85, pitch: -0.12, twist: -0.1 },
      },
      {
        beat: 5,
        // Left foot to the SIDE, closing the box.
        pose: {
          rightHip: 0.1,
          leftHip: 0.55,
          leftLegAround: 0,
          leftKnee: 2.95,
          pitch: 0,
          twist: 0.08,
        },
      },
      {
        beat: 6,
        pose: {
          leftHip: 0.05,
          rightHip: 0.05,
          leftLegAround: 0,
          rightLegAround: 0,
          leftKnee: 3.1,
          rightKnee: 3.1,
          pitch: 0,
          twist: 0,
        },
      },
    ],
  },
  {
    id: 'turn',
    name: 'The underarm turn',
    blurb: 'One of you lifts a hand, the other goes under it. Four counts, and it always works.',
    bpm: 110,
    reps: 5,
    hint: 'The lifted arm stays still. It is a doorway, not a lever — the turn is in the feet.',
    // The one routine that worked before, now written in the right convention: the arm starts
    // hanging (≈π) and comes up overhead (≈0.5), rather than starting overhead as the old
    // REST implied and going nowhere a body could follow.
    keys: [
      { beat: 0, pose: { leftShoulder: 2.95, leftArmAround: 0, leftElbow: 3.0, twist: 0 } },
      // Up and forward into the frame: elevation drops as the arm rises, azimuth swings to
      // the front.
      { beat: 1, pose: { leftShoulder: 1.5, leftArmAround: 1.1, leftElbow: 2.0, twist: 0.15 } },
      { beat: 2, pose: { leftShoulder: 0.7, leftArmAround: 1.4, leftElbow: 1.6, twist: 0.6 } },
      { beat: 3, pose: { leftShoulder: 0.6, leftArmAround: 1.4, leftElbow: 1.6, twist: 1.05 } },
      { beat: 4, pose: { leftShoulder: 1.4, leftArmAround: 1.0, leftElbow: 2.2, twist: 0.45 } },
      { beat: 5, pose: { leftShoulder: 2.6, leftArmAround: 0.3, leftElbow: 2.9, twist: 0.1 } },
      { beat: 6, pose: { leftShoulder: 2.95, leftArmAround: 0, leftElbow: 3.0, twist: 0 } },
    ],
  },
  {
    id: 'shoulders',
    name: 'Shoulder bounce',
    blurb: 'Nothing but shoulders and a bit of knee. Impossible to do badly, hard to stop.',
    bpm: 118,
    reps: 16,
    hint: 'Let your arms be heavy. They should swing because your body moved, not on purpose.',
    // A two-beat loop, and the last keyframe is the first: anything else leaves a jump where
    // the repetition joins, which the reference then teaches as part of the step.
    //
    // Both knees are named in every keyframe on purpose. Keyframes accumulate — a joint not
    // mentioned keeps whatever the last keyframe that named it set — so bending only the left
    // knee here would leave it bent for the rest of the routine.
    keys: [
      {
        beat: 0,
        pose: {
          twist: 0.5,
          roll: 0.16,
          leftShoulder: 2.7,
          rightShoulder: 2.95,
          leftKnee: 2.8,
          rightKnee: 3.1,
        },
      },
      {
        beat: 1,
        pose: {
          twist: -0.5,
          roll: -0.16,
          leftShoulder: 2.95,
          rightShoulder: 2.7,
          leftKnee: 3.1,
          rightKnee: 2.8,
        },
      },
      {
        beat: 2,
        pose: {
          twist: 0.5,
          roll: 0.16,
          leftShoulder: 2.7,
          rightShoulder: 2.95,
          leftKnee: 2.8,
          rightKnee: 3.1,
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
    between[name] = CIRCULAR.has(name)
      ? // The short way round. Interpolating an azimuth from +170° to −170° the long way
        // sweeps the limb through the entire front of the body over one beat, which is a
        // movement nobody wrote and the learner cannot copy.
        wrap(before[name] + shortWay(before[name], after[name]) * eased)
      : before[name] + (after[name] - before[name]) * eased
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
