/**
 * What a mood looks like.
 *
 * One mapping from the five levels to colour, shared by the aurora behind the picker and the
 * ribbon of recent days. Sharing it is the whole point: if "rough" is a cold indigo in one
 * place and a grey in the other, the two stop being the same language and the colour stops
 * meaning anything.
 *
 * ## How the palette is built
 *
 * A single hue sweep from cold to warm — indigo, teal, sage, amber, gold — with saturation
 * and lightness rising alongside it. Two things fall out of that, both wanted:
 *
 *  - **It reads without a legend.** Nobody has to learn that gold is good. Warm and bright
 *    means good in every culture that has ever painted a sunrise.
 *  - **It is ordered.** Two adjacent days differ slightly; a bad week and a good one are
 *    visibly different fields of colour. A categorical palette — red, blue, green, yellow —
 *    would encode the same five values and show no shape at all.
 *
 * The low end is deliberately not red. Red is alarm, and a rough Tuesday is not an
 * emergency; making somebody's bad day flash a warning colour at them is the opposite of
 * what this feature is for. It goes cold and quiet instead.
 */

export interface MoodColour {
  /** The core of the bloom. */
  core: string
  /** The second, offset bloom — a neighbouring hue, so the field has depth rather than one wash. */
  echo: string
  /** The ground the blooms sit on. Never pure black: a black ground makes the colour look painted on. */
  ground: string
  /** Seconds for one drift cycle. A rough day moves slowly; a good one has energy. */
  drift: number
  /** A word for the level, used by the ribbon's tooltip and by screen readers. */
  word: string
}

/**
 * Indexed 1–5. `0` is the resting state — nothing chosen yet.
 *
 * The resting field is almost colourless and drifts slowest. The screen is asleep until
 * somebody says how they are, which makes the first tap feel like turning a light on.
 */
export const MOOD_COLOURS: Record<number, MoodColour> = {
  0: { core: '#3d4a63', echo: '#2b3348', ground: '#141821', drift: 46, word: 'Not said yet' },
  1: { core: '#3b4a8f', echo: '#5b3f86', ground: '#11131f', drift: 40, word: 'Rough' },
  2: { core: '#2f6a8f', echo: '#3f4f8c', ground: '#101820', drift: 34, word: 'Low' },
  3: { core: '#2f8a7a', echo: '#3c7f9a', ground: '#0f1a1c', drift: 28, word: 'Okay' },
  4: { core: '#8a9a35', echo: '#3f8f6a', ground: '#161a12', drift: 22, word: 'Good' },
  5: { core: '#e0a12a', echo: '#d8603f', ground: '#1b140c', drift: 17, word: 'Great' },
}

export function moodColour(level: number | null): MoodColour {
  if (level === null) return MOOD_COLOURS[0]!
  return MOOD_COLOURS[Math.min(5, Math.max(1, Math.round(level)))] ?? MOOD_COLOURS[0]!
}

/**
 * The colour a ribbon segment is drawn in.
 *
 * Brighter and more saturated than the aurora's, because the ribbon is small: a colour that
 * reads correctly as a metre-wide wash reads as mud in a six-pixel band.
 */
export const RIBBON_COLOURS: Record<number, string> = {
  1: '#5566c4',
  2: '#3d8fbf',
  3: '#37b39c',
  4: '#a8bd3c',
  5: '#f0b33c',
}

export function ribbonColour(level: number): string {
  return RIBBON_COLOURS[Math.min(5, Math.max(1, Math.round(level)))] ?? RIBBON_COLOURS[3]!
}
