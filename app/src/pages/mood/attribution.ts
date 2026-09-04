/**
 * Whose answer was it — the person's, or the camera's?
 *
 * ## Why this is a module and not a ternary
 *
 * It was a ternary, and it was wrong. `save(level, suggestion === null ? 'manual' : 'face')`
 * decided the source from whether a scan had *happened*, never from whether the person
 * agreed with it. So somebody who scanned, disagreed, tapped a different face and saved had
 * their correction stored as `source: 'face'`, with the model's word in `detected` and its
 * confidence beside it — and the history list then stamped it with an AI badge.
 *
 * A human overrule filed as a machine reading, afterwards indistinguishable from one the
 * person accepted. The mood page's own header says the human is the authority on their own
 * mood; the row said the opposite, and the row is what survives.
 *
 * Pulled out here because it is the one piece of that screen carrying a claim about who said
 * what, and a claim like that should be checkable without mounting a page.
 */

export interface Reading {
  level: number
  label: string
  confidence: number
}

export interface Attribution {
  source: 'manual' | 'face'
  /** The model's word for it, kept only when the person accepted the reading. */
  detected: string | null
  /** The model's own confidence, kept on the same condition. */
  confidence: number | null
}

/**
 * What to record for a save.
 *
 * `face` only when a reading exists **and** the level being saved is the one it suggested.
 * Anything else is the person's own answer.
 *
 * A rejected guess is discarded rather than filed alongside the correction. Keeping it would
 * mean storing an inference about somebody's emotional state that they have just told us is
 * wrong, which is a strange thing for this app of all apps to keep — and it would leave a row
 * that reads, to anything looking at it later, as though a machine and a person disagreed and
 * the machine's view was worth writing down.
 */
export function attribute(reading: Reading | null, chosen: number): Attribution {
  const agreed = reading !== null && reading.level === chosen
  return {
    source: agreed ? 'face' : 'manual',
    detected: agreed ? reading.label : null,
    confidence: agreed ? reading.confidence : null,
  }
}
