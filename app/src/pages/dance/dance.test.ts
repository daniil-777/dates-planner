/**
 * The dance coach's arithmetic.
 *
 * Every claim this feature makes is checkable without a camera, which is why it was built in
 * this order. The properties below are the ones that decide whether the coach is useful or
 * merely confident:
 *
 *  - **Being slow is not being wrong.** The single most important one. A frame-by-frame
 *    comparison fails it, and failing it is why most dance scorers feel arbitrary.
 *  - **Standing still does not score well.** The pathological alignment DTW allows if you
 *    let it, and the reason for the band.
 *  - **A mirrored dancer is a correct dancer.** Half of all users, facing the screen.
 *  - **The three faults are told apart.** Timing, size and shape need three different
 *    corrections, and a coach that cannot distinguish them can only say "try again".
 */
import { describe, expect, it } from 'vitest'

import { align, frameDistance, salience } from './dtw'
import {
  ANGLES,
  angleAt,
  mirror,
  toSkeleton,
  toVector,
  type Landmarks,
  type Skeleton,
} from './pose'
import { noteFor, scoreRoutine } from './score'
import { ROUTINES, beatsIn, poseAt, secondsFor, toSequence } from './routines'

/* ------------------------------------------------------------- fixtures */

/** A neutral skeleton: everything straight and still. */
function still(): Skeleton {
  return {
    leftElbow: Math.PI,
    rightElbow: Math.PI,
    leftShoulder: 0.2,
    rightShoulder: 0.2,
    leftArmSwing: 0,
    rightArmSwing: 0,
    leftKnee: Math.PI,
    rightKnee: Math.PI,
    leftHip: 0.1,
    rightHip: 0.1,
    lean: 0,
    twist: 0,
  }
}

/**
 * A routine: the left arm raises and lowers over `frames`, everything else still.
 *
 * `phase` shifts it in time, `size` scales how far it travels. Those two knobs are exactly
 * the two faults the coach claims to distinguish, so the fixtures are built to produce them
 * on demand rather than by hand.
 */
function wave(frames: number, { phase = 0, size = 1, mirrored = false } = {}): Skeleton[] {
  return Array.from({ length: frames }, (_unused, index) => {
    const t = ((index + phase) / frames) * Math.PI * 2
    const lift = 0.2 + size * 0.9 * (1 - Math.cos(t)) * 0.5
    const one = {
      ...still(),
      leftShoulder: lift,
      leftElbow: Math.PI - size * 0.5 * (1 - Math.cos(t)),
    }
    return mirrored ? mirror(one) : one
  })
}

/* ------------------------------------------------------------------ pose */

describe('reading a body', () => {
  it('measures a right angle as a right angle', () => {
    const at = (x: number, y: number): { x: number; y: number; z: number; visibility: number } => ({
      x,
      y,
      z: 0,
      visibility: 1,
    })
    expect(angleAt(at(0, 0), at(1, 0), at(0, 1))).toBeCloseTo(Math.PI / 2, 6)
  })

  it('does not return NaN for a perfectly straight limb', () => {
    // The nasty one. Floating point can put the cosine a hair outside [-1, 1], and
    // `acos(1.0000001)` is NaN — which then poisons every average downstream, silently, on
    // the most ordinary input there is.
    const at = (x: number): { x: number; y: number; z: number; visibility: number } => ({
      x,
      y: 0,
      z: 0,
      visibility: 1,
    })
    expect(angleAt(at(0), at(-1), at(1))).toBeCloseTo(Math.PI, 6)
    expect(Number.isNaN(angleAt(at(0), at(1), at(2)))).toBe(false)
  })

  it('refuses a frame where the torso was not clearly seen', () => {
    // Without a torso there is no frame of reference for anything else, so the frame is
    // dropped rather than salvaged into a confident guess.
    const hidden: Landmarks = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0.1,
    }))
    expect(toSkeleton(hidden)).toBeNull()
  })

  it('mirrors by swapping sides and flipping every signed angle', () => {
    // The sign flips are what make a mirrored score subtly wrong rather than obviously
    // broken when they are forgotten.
    const one: Skeleton = { ...still(), leftArmSwing: 0.4, twist: 0.3, leftElbow: 1 }
    const other = mirror(one)
    expect(other.rightElbow).toBe(1)
    expect(other.rightArmSwing).toBe(-0.4)
    expect(other.twist).toBe(-0.3)
    expect(mirror(other)).toEqual(one)
  })
})

/* ------------------------------------------------------------------- dtw */

describe('distance between two frames', () => {
  it('skips joints the camera could not see rather than scoring them', () => {
    // Counting an unseen joint as zero rewards standing behind furniture; counting it as
    // maximal punishes somebody for the camera angle. Skipping is the only honest option.
    const seen = [0.1, 0.2, 0.3, 0.4, 0.5]
    const partly = [0.1, 0.2, 0.3, 0.4, Number.NaN]
    expect(frameDistance(seen, partly)).toBeCloseTo(0, 6)
  })

  it('has no opinion when almost nothing was visible', () => {
    const mostly = [1, Number.NaN, Number.NaN, Number.NaN, Number.NaN]
    expect(Number.isNaN(frameDistance(mostly, mostly))).toBe(true)
  })
})

describe('aligning two performances', () => {
  it('costs nothing to align a sequence with itself', () => {
    const routine = wave(40).map(toVector)
    expect(align(routine, routine).cost).toBeCloseTo(0, 6)
  })

  it('barely notices somebody dancing the same thing slower', () => {
    // THE property. A learner performing correctly at 75% speed is correct, and a
    // frame-by-frame comparison would call them badly wrong.
    const routine = wave(40)
    const slower: Skeleton[] = []
    for (const frame of routine) {
      slower.push(frame, frame)
    }

    const cost = align(routine.map(toVector), slower.map(toVector)).cost
    expect(cost).toBeLessThan(0.05)
  })

  it('will not let somebody stand still and be aligned to everything', () => {
    // The pathological alignment, and the reason the band exists. Without it, DTW happily
    // matches forty frames of stillness to the one moment the reference is also still.
    //
    // Weighted, because that is how `align` is called in earnest: unweighted, the error of
    // the two joints that move is divided by the ten that do not, and standing still comes
    // out at 0.08 — which is the dilution that made a motionless dancer score 94.
    const routine = wave(40).map(toVector)
    const frozen = Array.from({ length: 40 }, () => toVector(still()))
    const weights = salience(routine, frozen, ANGLES.length)

    const moving = align(routine, routine, undefined, weights).cost
    const stuck = align(routine, frozen, undefined, weights).cost
    expect(stuck).toBeGreaterThan(moving + 0.3)
  })
})

/* ----------------------------------------------------------------- score */

describe('scoring a routine', () => {
  it('gives a perfect performance close to full marks', () => {
    const routine = wave(40)
    const verdict = scoreRoutine(routine, routine)
    expect(verdict.score).toBeGreaterThanOrEqual(95)
  })

  it('does not punish somebody for facing the camera', () => {
    // Half of all users. A coach that tells them their arms are on the wrong side is a coach
    // nobody keeps.
    const routine = wave(40)
    const facing = routine.map(mirror)

    const verdict = scoreRoutine(routine, facing)
    expect(verdict.mirrored).toBe(true)
    expect(verdict.score).toBeGreaterThanOrEqual(95)
  })

  it('scores standing still much lower than dancing', () => {
    // Before salience weighting this was 94 out of 100 — four perfect scores for the four
    // limbs the routine keeps still, and the arms diluted away. It is the single most
    // important number in this file.
    const routine = wave(40)
    const frozen = Array.from({ length: 40 }, still)

    const stood = scoreRoutine(routine, frozen).score
    expect(stood).toBeLessThan(60)
    expect(stood).toBeLessThan(scoreRoutine(routine, routine).score - 40)
  })

  it('does not grade a limb the routine never asks to move', () => {
    // "We did not grade your legs, this dance has none" is a fair thing for a coach to say,
    // and much better than inventing a score for a limb that had nothing to do.
    const verdict = scoreRoutine(wave(40), wave(40, { size: 0.3 }))
    const leg = verdict.limbs.find(one => one.limb === 'leftLeg')
    expect(leg?.asked).toBeLessThan(0.1)
  })

  it('says a small version is small rather than wrong', () => {
    // The commonest fault in every beginner class, and the one people cannot see in
    // themselves. Telling them "watch it again" would send them to fix the wrong thing.
    const routine = wave(40)
    const timid = wave(40, { size: 0.3 })

    const verdict = scoreRoutine(routine, timid)
    const arm = verdict.limbs.find(one => one.limb === 'leftArm')
    expect(arm?.fault).toBe('amplitude')
    expect(arm?.size).toBeLessThan(1)
    expect(verdict.note).toMatch(/bigger/i)
  })

  it('leaves the limbs that were right alone', () => {
    // A coach that marks everything down because one arm is off teaches nothing.
    const verdict = scoreRoutine(wave(40), wave(40, { size: 0.3 }))
    for (const limb of verdict.limbs.filter(one => one.limb !== 'leftArm')) {
      expect(limb.score, limb.limb).toBeGreaterThanOrEqual(95)
      expect(limb.fault, limb.limb).toBe('none')
    }
  })

  it('still grades a limb the learner waves that the routine keeps still', () => {
    // The mirror of the last one, and the reason salience takes the LARGER of the two
    // ranges. Weighting by the reference alone would make flailing through a still passage
    // free, because that joint would carry no weight.
    const routine = wave(40)
    const extra = routine.map((frame, index) => ({
      ...frame,
      rightShoulder: 0.2 + 0.9 * (1 - Math.cos((index / 40) * Math.PI * 2)) * 0.5,
    }))

    const verdict = scoreRoutine(routine, extra)
    const arm = verdict.limbs.find(one => one.limb === 'rightArm')
    expect(arm?.asked).toBeGreaterThan(0.1)
    expect(arm?.score).toBeLessThan(90)
  })

  it('names one thing, not four', () => {
    // Somebody told four things fixes none of them.
    const verdict = scoreRoutine(wave(40), wave(40, { size: 0.3 }))
    expect(verdict.note.split(/[.!?]/).filter(one => one.trim() !== '').length).toBeLessThanOrEqual(
      2,
    )
  })
})

describe('what it says', () => {
  it('praises specifically or not at all', () => {
    const note = noteFor(
      [
        { limb: 'leftArm', score: 96, fault: 'none', shift: 0, size: 1, asked: 1.9 },
        { limb: 'torso', score: 92, fault: 'none', shift: 0, size: 1, asked: 0.8 },
      ],
      94,
    )
    // "Good job!" is noise. Naming the limb is what makes it land.
    expect(note).toMatch(/left arm/i)
  })

  it('gives a direction, never just a verdict', () => {
    const timing = noteFor(
      [{ limb: 'rightLeg', score: 60, fault: 'timing', shift: 4, size: 1, asked: 1.2 }],
      60,
    )
    expect(timing).toMatch(/late/i)

    const early = noteFor(
      [{ limb: 'rightLeg', score: 60, fault: 'timing', shift: -4, size: 1, asked: 1.2 }],
      60,
    )
    expect(early).toMatch(/ahead/i)
  })

  it('admits when it could not see enough to judge', () => {
    expect(noteFor([], 0)).toMatch(/not enough/i)
  })
})

/* -------------------------------------------------------------- routines */

describe('the routines that ship', () => {
  it('are all long enough to score and short enough to attempt', () => {
    // One repetition of any of these is four to eight seconds, which is not a dance: the
    // alignment needs a few cycles before "consistently late" can be told from "fluffed the
    // start". Twenty seconds is the compromise.
    for (const routine of ROUTINES) {
      const seconds = secondsFor(routine)
      expect(seconds, routine.id).toBeGreaterThan(14)
      expect(seconds, routine.id).toBeLessThan(26)
    }
  })

  it('end where they begin, so a repetition has no seam', () => {
    for (const routine of ROUTINES) {
      const span = beatsIn(routine)
      const start = poseAt(routine.keys, 0)
      const end = poseAt(routine.keys, span)
      for (const [name, value] of Object.entries(start)) {
        expect(end[name as keyof typeof end], `${routine.id}.${name}`).toBeCloseTo(value, 2)
      }
    }
  })

  it('actually keep moving, rather than holding a pose for half the capture', () => {
    // The bug this guards: an earlier version carried a `bars` field saying twelve while the
    // keyframes ended at six, so the reference froze for half of every attempt and scored
    // everybody on standing still.
    for (const routine of ROUTINES) {
      const frames = toSequence(routine, 20)
      const moved = frames.filter((frame, index) => {
        const before = frames[index - 1]
        if (before === undefined) return false
        return Object.keys(frame).some(
          name =>
            Math.abs(frame[name as keyof typeof frame] - before[name as keyof typeof before]) >
            0.001,
        )
      })
      // Almost every frame should differ from the one before it.
      expect(moved.length / frames.length, routine.id).toBeGreaterThan(0.9)
    }
  })

  it('asks something of at least one limb', () => {
    // A routine that moves nothing cannot be scored, and would silently give everybody 100.
    for (const routine of ROUTINES) {
      const reference = toSequence(routine, 20)
      const verdict = scoreRoutine(reference, reference)
      expect(
        verdict.limbs.some(one => one.asked >= 0.1),
        routine.id,
      ).toBe(true)
      expect(verdict.score, routine.id).toBeGreaterThanOrEqual(95)
    }
  })
})
