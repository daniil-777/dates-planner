/**
 * The on-device face reader.
 *
 * The properties worth guarding here are all about restraint. This reader runs with no
 * network, no key and no confidence score of its own, on a signal the literature calls weak —
 * so what matters is not that it is right, it is that it knows when to keep quiet, and that
 * it never says more than "here is what your face is doing".
 */
import { describe, expect, it } from 'vitest'

import { ENOUGH, FLOOR, read, type Blendshapes, type HeadPose } from './expression'

const SQUARE: HeadPose = { roll: 0, yaw: 0 }

const BLANK: Blendshapes = {
  mouthSmileLeft: 0,
  mouthSmileRight: 0,
  eyeSquintLeft: 0,
  eyeSquintRight: 0,
  mouthFrownLeft: 0,
  mouthFrownRight: 0,
  browInnerUp: 0,
  browDownLeft: 0,
  browDownRight: 0,
  mouthPressLeft: 0,
  mouthPressRight: 0,
}

const face = (over: Partial<Blendshapes>): Blendshapes => ({ ...BLANK, ...over })

/**
 * A real measurement, not an invention: these are the values MediaPipe returns for a broadly,
 * unambiguously smiling portrait. Note `browDown` at 0.83 — a genuine smile squeezes the
 * corrugator, which is the finding that forced the negative axis to be built from something
 * other than brow-furrow.
 */
const SMILING = face({
  mouthSmileLeft: 0.947,
  mouthSmileRight: 0.95,
  eyeSquintLeft: 0.7,
  eyeSquintRight: 0.699,
  browDownLeft: 0.839,
  browDownRight: 0.818,
  mouthFrownLeft: 0.001,
  mouthFrownRight: 0.001,
  browInnerUp: 0.001,
})

describe('the smiling portrait', () => {
  it('is read as positive, despite its brows being furrowed', () => {
    // The whole reason the obvious arithmetic was thrown away. A smile-minus-brow-furrow
    // design scores this real, happy face at roughly zero.
    const reading = read(SMILING, SQUARE)
    expect(reading.readable).toBe(true)
    expect(reading.valence).toBeGreaterThan(0.5)
    expect(reading.level).toBeGreaterThanOrEqual(4)
  })

  it('notices the smile reached the eyes', () => {
    expect(read(SMILING, SQUARE).says).toMatch(/reaches your eyes/i)
  })
})

describe('knowing when to keep quiet', () => {
  it('declines a face with nothing much on it', () => {
    // The detector fails silently: a heavily blurred photograph still yields a face, 478
    // landmarks and a full blendshape vector with the smile channel at about 0.1. Without
    // this gate the reader tells somebody photographing a grin in bad light that their face
    // was still.
    const reading = read(face({ mouthSmileLeft: 0.107, mouthSmileRight: 0.107 }), SQUARE)
    expect(reading.readable).toBe(false)
    expect(reading.level).toBeNull()
    expect(reading.evidence).toBeLessThan(ENOUGH)
  })

  it('says what to do about it rather than reporting a blank face', () => {
    const reading = read(BLANK, SQUARE)
    expect(reading.says).toMatch(/could not read/i)
    // The distinction that matters: the picture was unreadable, not the person expressionless.
    expect(reading.says).not.toMatch(/level|neutral|blank/i)
  })

  it('declines a head turned too far to measure', () => {
    for (const head of [
      { roll: 40, yaw: 0 },
      { roll: 0, yaw: 40 },
      { roll: -35, yaw: 0 },
    ]) {
      expect(read(SMILING, head).readable, JSON.stringify(head)).toBe(false)
    }
  })

  it('declines a lopsided smile, which is usually the light', () => {
    const crooked = face({ ...SMILING, mouthSmileLeft: 0.9, mouthSmileRight: 0.3 })
    expect(read(crooked, SQUARE).readable).toBe(false)
  })
})

describe('what it will not say', () => {
  it('never suggests the bottom of the scale', () => {
    // A person may tell this app their day was rough. A photograph may not tell them so. The
    // asymmetry is deliberate — the negative half of this signal is the weakest part of a
    // weak signal, and being wrongly told you look miserable is not the same as being
    // wrongly cheered up.
    const miserable = face({
      mouthFrownLeft: 1,
      mouthFrownRight: 1,
      browInnerUp: 1,
      mouthPressLeft: 1,
      mouthPressRight: 1,
      browDownLeft: 1,
      browDownRight: 1,
    })
    const reading = read(miserable, SQUARE)
    expect(reading.readable).toBe(true)
    expect(reading.level).toBeGreaterThanOrEqual(FLOOR)
  })

  it('does not call a neutral face a low one', () => {
    // Most faces most of the time are neutral, and the absence of a smile is not sadness.
    // This needs enough evidence to be readable but no unambiguous negative marker.
    const tense = face({ browDownLeft: 0.9, browDownRight: 0.9 })
    const reading = read(tense, SQUARE)
    if (reading.readable) expect(reading.level).toBeGreaterThanOrEqual(3)
  })

  it('names no feeling, ever — it only describes the face', () => {
    // The line the science and the AI Act both draw: detecting a readily apparent expression
    // is not inferring an emotion. "You look like you are smiling" is one; "you seem happy"
    // is the other, and this reader may never produce the second.
    const feelings = /happy|sad|angry|anxious|depress|upset|miserable|cheerful|content|stressed/i
    const faces = [
      SMILING,
      BLANK,
      face({ mouthSmileLeft: 0.6, mouthSmileRight: 0.6 }),
      face({ mouthSmileLeft: 0.3, mouthSmileRight: 0.3 }),
      face({ mouthFrownLeft: 0.8, mouthFrownRight: 0.8 }),
      face({ browInnerUp: 0.9 }),
      face({ mouthPressLeft: 0.7, mouthPressRight: 0.7 }),
    ]
    for (const one of faces) {
      expect(read(one, SQUARE).says, JSON.stringify(one).slice(0, 60)).not.toMatch(feelings)
    }
  })

  it('stays inside the app’s scale whatever it is given', () => {
    const extremes = [
      face({ mouthSmileLeft: 1, mouthSmileRight: 1, eyeSquintLeft: 1, eyeSquintRight: 1 }),
      face({ mouthFrownLeft: 1, mouthFrownRight: 1, browInnerUp: 1 }),
    ]
    for (const one of extremes) {
      const { level } = read(one, SQUARE)
      if (level !== null) {
        expect(level).toBeGreaterThanOrEqual(1)
        expect(level).toBeLessThanOrEqual(5)
        expect(Number.isInteger(level)).toBe(true)
      }
    }
  })
})

describe('the Duchenne split', () => {
  it('rates a smile that reaches the eyes above one that does not', () => {
    const polite = face({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8 })
    const genuine = face({ ...polite, eyeSquintLeft: 0.8, eyeSquintRight: 0.8 })
    expect(read(genuine, SQUARE).valence).toBeGreaterThan(read(polite, SQUARE).valence)
  })
})
