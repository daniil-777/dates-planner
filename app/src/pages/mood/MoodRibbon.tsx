/**
 * A run of days, as a band of colour.
 *
 * ## Why this replaces reading the list
 *
 * A list of moods answers "what did I put on Tuesday". Almost nobody wants that. What people
 * actually want from a mood record is the *shape* — has this been a bad fortnight, is it
 * lifting, was last week worse than it felt at the time — and a list is the worst possible
 * way to see a shape. You have to hold fourteen values in your head and compare them.
 *
 * A ribbon shows it in one glance and needs no reading at all. It uses the same palette as
 * the aurora, so the colours already mean something by the time anybody looks at this.
 *
 * The list stays underneath. This is the summary, not the replacement — the note somebody
 * wrote on a hard day is the most valuable thing on the page and a band of colour cannot
 * carry it.
 *
 * ## Drawn as one gradient, not as blocks
 *
 * Days blend into their neighbours rather than sitting in hard segments. Mood is continuous
 * and a hard edge between Tuesday and Wednesday claims a precision the data does not have —
 * somebody tapping a face is not measuring anything to within a day.
 */
import { moodColour, ribbonColour } from './palette'

export interface RibbonEntry {
  /** ISO timestamp. */
  at: string
  level: number
}

export interface MoodRibbonProps {
  /** Newest first, as the service returns them. */
  entries: readonly RibbonEntry[]
  /** How many days to show. */
  days?: number
}

export function MoodRibbon({ entries, days = 14 }: MoodRibbonProps): React.ReactElement | null {
  // Oldest on the left, because time reads left to right and a chart that runs backwards is a
  // chart everybody misreads once.
  const recent = [...entries].slice(0, days).reverse()
  if (recent.length < 2) return null

  const stops = recent
    .map((entry, index) => {
      const at = recent.length === 1 ? 50 : (index / (recent.length - 1)) * 100
      return `${ribbonColour(entry.level)} ${at.toFixed(1)}%`
    })
    .join(', ')

  const average = recent.reduce((sum, entry) => sum + entry.level, 0) / recent.length
  const first = recent[0]!
  const last = recent[recent.length - 1]!

  return (
    <figure className="mood-ribbon">
      <div
        className="mood-ribbon__band"
        style={{ backgroundImage: `linear-gradient(90deg, ${stops})` }}
        role="img"
        aria-label={`The last ${recent.length} entries, from ${moodColour(first.level).word} to ${moodColour(last.level).word}, averaging ${moodColour(Math.round(average)).word.toLowerCase()}`}
      />
      <figcaption className="mood-ribbon__caption">
        <span>{recent.length} entries</span>
        {/* Said in the same words the faces use, not as a number. "3.4 out of 5" is a grade,
            and nobody wants their fortnight graded. */}
        <span className="mood-ribbon__verdict">
          mostly {moodColour(Math.round(average)).word.toLowerCase()}
        </span>
      </figcaption>
    </figure>
  )
}
