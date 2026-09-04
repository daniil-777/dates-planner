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
  /**
   * A third hue the field slowly wanders into and back out of.
   *
   * The blooms always moved, but the *colour* never did — a fixed triple, drifting in
   * position. Over the few seconds anybody actually looks at a screen that reads as static,
   * and on the journal, where the level is pinned, it was one unchanging teal for as long as
   * the page was open.
   *
   * This is a near neighbour rather than a contrast: the field should feel like weather, not
   * like a slideshow. It is cross-faded by opacity rather than interpolated, so the wander
   * costs the compositor nothing — see mood.css.
   */
  wander: string
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
 * The resting field is the quietest and drifts slowest: the screen is asleep until somebody
 * says how they are, which makes the first tap feel like turning a light on.
 *
 * **Quiet, though, not absent.** The first version of level 0 was `#3d4a63` on `#141821`, and
 * the honest description of it on a phone is a dark grey smudge. That matters more than it
 * sounds: this panel is 21 rem tall on purpose, so that the field has room to be a sky rather
 * than a stripe, and a sky with no visible colour in it does not read as restraint — it reads
 * as a component that failed to load. Lifted until the gradient is legible as a deliberate
 * blue-violet, while staying the least saturated of the six.
 */
export const MOOD_COLOURS: Record<number, MoodColour> = {
  // `wander` is one step around the wheel from `core`, never across it. Far enough that the
  // field is visibly a different colour a minute later, near enough that it never looks like
  // it changed its mind.
  0: {
    core: '#5a6c94',
    echo: '#414f77',
    ground: '#1b2030',
    wander: '#6a5f95',
    drift: 46,
    word: 'Not said yet',
  },
  1: {
    core: '#3b4a8f',
    echo: '#5b3f86',
    ground: '#11131f',
    wander: '#6a3f8c',
    drift: 40,
    word: 'Rough',
  },
  2: {
    core: '#2f6a8f',
    echo: '#3f4f8c',
    ground: '#101820',
    wander: '#2f8a8f',
    drift: 34,
    word: 'Low',
  },
  3: {
    core: '#2f8a7a',
    echo: '#3c7f9a',
    ground: '#0f1a1c',
    wander: '#4f9a52',
    drift: 28,
    word: 'Okay',
  },
  4: {
    core: '#8a9a35',
    echo: '#3f8f6a',
    ground: '#161a12',
    wander: '#b89a2c',
    drift: 22,
    word: 'Good',
  },
  5: {
    core: '#e0a12a',
    echo: '#d8603f',
    ground: '#1b140c',
    wander: '#d8843a',
    drift: 17,
    word: 'Great',
  },
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
