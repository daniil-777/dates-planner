/*
 * The weather and the face are the only things on this screen that cannot be checked by
 * looking at it — a gradient that is subtly wrong at 63 looks fine in a screenshot taken
 * at 0, 50 and 100. So the properties are asserted across the whole range rather than at
 * a few sampled points.
 */
import { describe, expect, it } from 'vitest'

import {
  BAND,
  VALUE_MAX,
  VALUE_MIN,
  clamp01,
  faceFor,
  hexToRgb,
  levelForValue,
  mix,
  smoothstep,
  valueForLevel,
  weatherFor,
  wordForValue,
} from './sky'

/** Every whole step the slider can be on. */
const EVERY = Array.from({ length: VALUE_MAX - VALUE_MIN + 1 }, (_, index) => VALUE_MIN + index)

describe('the scale', () => {
  it('maps the range onto the five levels the table stores', () => {
    for (const value of EVERY) {
      const level = levelForValue(value)
      expect(Number.isInteger(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(1)
      expect(level).toBeLessThanOrEqual(5)
    }
  })

  it('never skips a level and never goes backwards', () => {
    let previous = levelForValue(VALUE_MIN)
    expect(previous).toBe(1)
    for (const value of EVERY) {
      const level = levelForValue(value)
      expect(level - previous).toBeGreaterThanOrEqual(0)
      expect(level - previous).toBeLessThanOrEqual(1)
      previous = level
    }
    expect(previous).toBe(5)
  })

  it('puts the boundaries half a band from each stop', () => {
    // The whole point of centring the bands: a value is never more than 12.5 from the
    // level it will be saved as.
    expect(levelForValue(12)).toBe(1)
    expect(levelForValue(13)).toBe(2)
    expect(levelForValue(37)).toBe(2)
    expect(levelForValue(38)).toBe(3)
    expect(levelForValue(87)).toBe(4)
    expect(levelForValue(88)).toBe(5)
  })

  it('round-trips a level through the slider position that means it', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      expect(levelForValue(valueForLevel(level))).toBe(level)
    }
    expect(valueForLevel(1)).toBe(VALUE_MIN)
    expect(valueForLevel(5)).toBe(VALUE_MAX)
    expect(BAND).toBe(25)
  })

  it('clamps a level the camera should never have sent', () => {
    expect(valueForLevel(0)).toBe(VALUE_MIN)
    expect(valueForLevel(9)).toBe(VALUE_MAX)
  })

  it('agrees with the words the rest of the app uses', () => {
    expect(wordForValue(0)).toBe('Rough')
    expect(wordForValue(50)).toBe('Okay')
    expect(wordForValue(100)).toBe('Great')
  })
})

describe('arithmetic', () => {
  it('clamps and ramps', () => {
    expect(clamp01(-3)).toBe(0)
    expect(clamp01(4)).toBe(1)
    expect(smoothstep(0, 1, 0)).toBe(0)
    expect(smoothstep(0, 1, 1)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5)
    // Flat at both ends is the property that matters — it is why nothing on this screen
    // starts or stops with a visible corner.
    expect(smoothstep(0, 1, 0.02)).toBeLessThan(0.02)
    expect(smoothstep(0, 1, 0.98)).toBeGreaterThan(0.98)
  })

  it('does not divide by zero on a degenerate ramp', () => {
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0)
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1)
  })

  it('mixes colours and survives short hex', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(mix('#000000', '#ffffff', 0)).toBe('rgb(0 0 0)')
    expect(mix('#000000', '#ffffff', 1)).toBe('rgb(255 255 255)')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('rgb(128 128 128)')
  })
})

describe('the weather', () => {
  it('produces a complete, finite scene at every step', () => {
    for (const value of EVERY) {
      const w = weatherFor(value)
      for (const number of [w.t, w.sun, w.sunY, w.rain, w.storm, w.cover, w.wisp, w.warmth]) {
        expect(Number.isFinite(number)).toBe(true)
      }
      for (const fraction of [w.t, w.sun, w.rain, w.storm, w.cover, w.wisp, w.warmth]) {
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
      }
      for (const colour of [w.sky.top, w.sky.upper, w.sky.mid, w.sky.horizon]) {
        expect(colour).toMatch(/^rgb\(\d+ \d+ \d+\)$/)
      }
    }
  })

  it('is a thunderstorm at the bottom and a clear noon at the top', () => {
    const storm = weatherFor(0)
    expect(storm.storm).toBe(1)
    expect(storm.rain).toBe(1)
    expect(storm.sun).toBe(0)
    expect(storm.cover).toBe(1)

    const noon = weatherFor(100)
    expect(noon.storm).toBe(0)
    expect(noon.rain).toBe(0)
    expect(noon.sun).toBe(1)
    expect(noon.cover).toBe(0)
    expect(noon.warmth).toBe(1)
  })

  it('never brings the sun out while it is still thundering', () => {
    for (const value of EVERY) {
      const w = weatherFor(value)
      if (w.storm > 0) expect(w.sun).toBeLessThan(0.5)
    }
  })

  it('moves one way only — no weather goes backwards as the slider goes up', () => {
    let previous = weatherFor(VALUE_MIN)
    for (const value of EVERY) {
      const w = weatherFor(value)
      expect(w.sun).toBeGreaterThanOrEqual(previous.sun)
      expect(w.warmth).toBeGreaterThanOrEqual(previous.warmth)
      expect(w.rain).toBeLessThanOrEqual(previous.rain)
      expect(w.storm).toBeLessThanOrEqual(previous.storm)
      expect(w.cover).toBeLessThanOrEqual(previous.cover)
      // The sun only ever rises, and `sunY` counts down from the top of the scene.
      expect(w.sunY).toBeLessThanOrEqual(previous.sunY)
      previous = w
    }
  })

  it('stops raining before the cloud has finished clearing', () => {
    // The order real weather happens in, and the reason the middle of the scale reads as
    // "grey but no longer wet" rather than as a straight cross-fade.
    const dry = EVERY.find(value => weatherFor(value).rain === 0)
    const clear = EVERY.find(value => weatherFor(value).cover === 0)
    expect(dry).toBeDefined()
    expect(clear).toBeDefined()
    expect(dry!).toBeLessThan(clear!)
  })
})

/** Pulls every number out of an SVG path so it can be checked for NaN. */
function numbersIn(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
}

describe('the face', () => {
  it('emits drawable paths at every step', () => {
    for (const value of EVERY) {
      const face = faceFor(value)
      for (const path of [face.eye, face.lidPath, face.brow, face.mouth, face.teeth, face.tongue]) {
        expect(path.length).toBeGreaterThan(0)
        expect(path).not.toMatch(/NaN|Infinity|undefined/)
        for (const number of numbersIn(path)) expect(Number.isFinite(number)).toBe(true)
      }
      for (const fraction of [face.lidOpacity, face.pupil, face.tongueOpacity, face.blush]) {
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
      }
    }
  })

  it('frowns at the bottom and grins at the top', () => {
    // The mouth's control point is the second Q argument; negative means the middle of the
    // mouth sits above its corners, which is a frown.
    const sad = faceFor(0)
    const happy = faceFor(100)
    const sadControl = numbersIn(sad.mouth)[3]!
    const happyControl = numbersIn(happy.mouth)[3]!
    expect(sadControl).toBeLessThan(0)
    expect(happyControl).toBeGreaterThan(0)
  })

  it('opens the mouth only near the top, and shows the tongue only when it is open', () => {
    expect(faceFor(0).tongueOpacity).toBe(0)
    expect(faceFor(50).tongueOpacity).toBe(0)
    expect(faceFor(100).tongueOpacity).toBe(1)
    for (const value of EVERY) {
      const face = faceFor(value)
      // A tongue may never be visible in a mouth that is not open. The mouth's own
      // thickness grows with the opening, so a closed mouth is a lip line with no room.
      if (face.tongueOpacity > 0) expect(faceFor(value).t).toBeGreaterThan(0.6)
    }
  })

  it('closes the eyes upward into a crescent at the top of the scale', () => {
    // The signature: at full delight both edges of the eye bow up, so the shape is an arc
    // rather than an opening — and the pupil has gone, because there is nowhere for it.
    const happy = faceFor(100)
    // "M -x 0 Q 0 top x 0 Q 0 bottom -x 0 Z" — the two control offsets are the fourth and
    // the eighth number, the zeroes between them being the control points' x coordinates.
    const numbers = numbersIn(happy.eye)
    const topControl = numbers[3]!
    const bottomControl = numbers[7]!
    expect(topControl).toBeLessThan(0)
    expect(bottomControl).toBeLessThan(0)
    expect(happy.pupil).toBe(0)

    // And in the middle it is an ordinary open eye with a pupil in it.
    const neutral = faceFor(50)
    expect(numbersIn(neutral.eye)[7]!).toBeGreaterThan(0)
    expect(neutral.pupil).toBe(1)
  })

  it('drops the heavy lid only at the bottom', () => {
    expect(faceFor(0).lidOpacity).toBeGreaterThan(0.9)
    expect(faceFor(100).lidOpacity).toBe(0)
  })

  it('lights the face from the same sky it sits in', () => {
    expect(faceFor(0).skinLit).not.toBe(faceFor(100).skinLit)
    expect(faceFor(100).skinLit).toMatch(/^rgb\(\d+ \d+ \d+\)$/)
  })
})
