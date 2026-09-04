/**
 * The mood palette and the ribbon.
 *
 * Two claims worth holding, both of which are about meaning rather than rendering:
 *
 *  - **The palette is ordered and monotonic.** It is a scale, not a set of categories, and
 *    the moment two adjacent levels stop being distinguishable — or the order inverts — the
 *    aurora and the ribbon start lying about the data they are drawn from.
 *  - **The low end is never alarm-coloured.** A rough Tuesday is not an emergency, and
 *    flashing red at somebody having a bad week is the opposite of what this is for.
 */
import { describe, expect, it } from 'vitest'

import { MOOD_COLOURS, RIBBON_COLOURS, moodColour, ribbonColour } from './palette'

/** Perceived warmth: how far the hue sits towards red/yellow rather than blue. */
function warmth(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r + g) / 2 - b
}

function brightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

describe('the mood palette', () => {
  it('gets warmer with every step up the scale', () => {
    const warmths = [1, 2, 3, 4, 5].map(level => warmth(MOOD_COLOURS[level]!.core))
    for (let i = 1; i < warmths.length; i += 1) {
      // Monotonic, so the scale reads without a legend: nobody has to be told gold is good.
      expect(warmths[i], `level ${i + 1} is not warmer than ${i}`).toBeGreaterThan(warmths[i - 1]!)
    }
  })

  it('gets brighter with every step up the scale', () => {
    const values = [1, 2, 3, 4, 5].map(level => brightness(MOOD_COLOURS[level]!.core))
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]!)
    }
  })

  it('drifts faster the better the day', () => {
    const speeds = [1, 2, 3, 4, 5].map(level => MOOD_COLOURS[level]!.drift)
    for (let i = 1; i < speeds.length; i += 1) {
      // Lower duration is faster. Energy is part of what the field is saying.
      expect(speeds[i]).toBeLessThan(speeds[i - 1]!)
    }
  })

  it('never uses an alarm colour at the low end', () => {
    // Red means emergency. A bad week is not one, and colouring it that way would be a small
    // cruelty performed automatically.
    for (const level of [1, 2]) {
      const hex = MOOD_COLOURS[level]!.core
      const r = parseInt(hex.slice(1, 3), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      expect(b, `level ${level} is warm, which reads as alarm`).toBeGreaterThan(r)
    }
  })

  it('answers for a missing or out-of-range level rather than throwing', () => {
    expect(moodColour(null).word).toBe('Not said yet')
    expect(moodColour(0)).toBe(MOOD_COLOURS[1])
    expect(moodColour(99)).toBe(MOOD_COLOURS[5])
    expect(ribbonColour(-3)).toBe(RIBBON_COLOURS[1])
  })

  it('uses brighter colours in the ribbon than in the aurora', () => {
    // A colour that reads correctly as a metre-wide wash reads as mud in a fourteen-pixel band.
    for (const level of [1, 2, 3, 4, 5]) {
      expect(brightness(RIBBON_COLOURS[level]!)).toBeGreaterThan(
        brightness(MOOD_COLOURS[level]!.core),
      )
    }
  })
})
