/** Colour helpers. Every colour on this page comes from the data or the theme. */

/** Neutral used for postings that have no category yet. */
export const UNCATEGORISED_COLOUR = '#8396A8'

/**
 * Neutral used for a payer who is no longer on the roster.
 * A person who *is* on the roster always brings their own `Person.colour`.
 */
export const PERSON_FALLBACK_COLOUR = '#8396A8'

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** `#0070F2` + 0.14 → `rgba(0, 112, 242, 0.14)`. Returns the input if it is not hex. */
export function withAlpha(colour: string, alpha: number): string {
  const match = HEX.exec(colour.trim())
  if (!match) return colour
  let hex = match[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  const value = Number.parseInt(hex, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
