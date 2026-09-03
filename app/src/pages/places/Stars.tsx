/**
 * Stars — the one idiom everybody already knows.
 *
 * Two components, because reading a rating and giving one are different jobs that only look
 * alike. `StarRating` is text with a picture in it; `StarInput` is a control.
 *
 * ## Why they are drawn rather than typed
 *
 * A star glyph renders at a different size, weight and vertical offset in every font on every
 * platform, and a row of them ends up looking like a row of five different stars. Inline SVG
 * is the same shape everywhere, scales to whatever the text does, and can be half-filled with
 * a clip — which is what a `4.4` actually needs.
 *
 * ## What is never rendered
 *
 * A place below the anonymity threshold has `stars: null`, and this refuses to draw anything
 * for it. Not zero stars, not five empty outlines — those both read as "rated badly", which
 * is a lie about somewhere nobody has judged. The card says how many more households are
 * needed instead.
 */
import { useId, useState } from 'react'

import { householdsLabel } from './vocabulary'

const STAR_PATH =
  'M12 2.6l2.9 5.88 6.5.94-4.7 4.58 1.11 6.47L12 17.42 6.19 20.47l1.11-6.47-4.7-4.58 6.5-.94z'

function Star({ fill, size }: { fill: number; size: number }): React.ReactElement {
  // A unique id per instance: two clip paths sharing an id is one of those bugs that only
  // appears once a second rating lands on the same screen.
  const clip = useId().replace(/:/g, '')
  const clamped = Math.max(0, Math.min(1, fill))
  return (
    <svg
      className="stars__star"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width={24 * clamped} height="24" />
        </clipPath>
      </defs>
      <path className="stars__outline" d={STAR_PATH} />
      {clamped > 0 && <path className="stars__fill" d={STAR_PATH} clipPath={`url(#${clip})`} />}
    </svg>
  )
}

export interface StarRatingProps {
  /** The mean, or null below the threshold — in which case nothing is drawn. */
  value: number | null
  households: number
  size?: number
  /** Hide the count, for a card where it is said elsewhere. */
  bare?: boolean
}

export function StarRating({
  value,
  households,
  size = 15,
  bare = false,
}: StarRatingProps): React.ReactElement | null {
  if (value === null) return null
  return (
    <span
      className="stars"
      aria-label={`${value.toFixed(1)} out of 5, ${householdsLabel(households)}`}
    >
      <span className="stars__value">{value.toFixed(1)}</span>
      <span className="stars__row" aria-hidden="true">
        {[0, 1, 2, 3, 4].map(index => (
          <Star key={index} fill={value - index} size={size} />
        ))}
      </span>
      {/* The denominator, always. A rating without one is a number pretending to be a fact. */}
      {!bare && <span className="stars__count">{householdsLabel(households)}</span>}
    </span>
  )
}

export interface StarInputProps {
  value: number | null
  onChange: (value: number) => void
  /** Labels the group for a screen reader, e.g. the place's name. */
  label: string
}

/**
 * Giving a rating: five buttons, one tap.
 *
 * A radio group rather than five buttons in a row, so a keyboard moves through it with the
 * arrow keys and a screen reader announces it as one question with five answers — which is
 * what it is. Hovering previews, because a five-star row that does not respond to the pointer
 * feels broken even to somebody who was going to tap anyway.
 */
export function StarInput({ value, onChange, label }: StarInputProps): React.ReactElement {
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? value ?? 0

  return (
    <div
      className="star-input"
      role="radiogroup"
      aria-label={`How was ${label}?`}
      onPointerLeave={() => setPreview(null)}
    >
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={`${star} star${star === 1 ? '' : 's'}`}
          className={`star-input__button${shown >= star ? ' star-input__button--on' : ''}`}
          onPointerEnter={() => setPreview(star)}
          onFocus={() => setPreview(star)}
          onBlur={() => setPreview(null)}
          onClick={() => onChange(star)}
        >
          <Star fill={shown >= star ? 1 : 0} size={34} />
        </button>
      ))}
    </div>
  )
}

/**
 * The five-bar histogram from a place page.
 *
 * Five stars at the top, one at the bottom, as everybody draws it. Bars are a proportion of
 * the largest bucket rather than of the total, because the shape is the information — whether
 * a place is loved by everyone or splits the room — and scaling to the total flattens that
 * into five short stubs.
 */
export function StarHistogram({
  buckets,
}: {
  buckets: readonly number[]
}): React.ReactElement | null {
  if (buckets.length !== 5) return null
  const largest = Math.max(...buckets, 1)
  return (
    <div className="histogram">
      {[5, 4, 3, 2, 1].map(star => {
        const count = buckets[star - 1] ?? 0
        return (
          <div className="histogram__row" key={star}>
            <span className="histogram__label">{star}</span>
            <span className="histogram__track">
              <span
                className="histogram__bar"
                style={{ width: `${Math.round((count / largest) * 100)}%` }}
              />
            </span>
            <span className="histogram__count">{count}</span>
          </div>
        )
      })}
    </div>
  )
}
