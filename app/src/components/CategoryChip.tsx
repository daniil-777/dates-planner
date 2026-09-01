// The ten seeded `Categories.icon` values, plus the aliases `resolveIcon` maps the four
// missing ones onto. Registered here so a chip renders even on a page that loads nothing else.
import '@ui5/webcomponents-icons/dist/cart.js'
import '@ui5/webcomponents-icons/dist/meal.js'
import '@ui5/webcomponents-icons/dist/nutrition-activity.js'
import '@ui5/webcomponents-icons/dist/bus-public-transport.js'
import '@ui5/webcomponents-icons/dist/flight.js'
import '@ui5/webcomponents-icons/dist/present.js'
import '@ui5/webcomponents-icons/dist/home.js'
import '@ui5/webcomponents-icons/dist/electrocardiogram.js'
import '@ui5/webcomponents-icons/dist/video.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/receipt.js'
import type { CSSProperties } from 'react'
import { Icon } from '@ui5/webcomponents-react'
import type { Category } from '../api/types'
import { NEEDS_REVIEW_THRESHOLD, formatConfidence, resolveIcon } from '../theme'

export interface CategoryChipProps {
  category: Category
  /** The model's probability for this category, 0..1. Shown quietly when present. */
  confidence?: number
  selected?: boolean
  onSelect?: () => void
  className?: string
}

/**
 * One category, in its own colour, optionally with what the classifier thinks of it.
 *
 * The colour is `Category.colour` from the code list (FRONTEND-CONTRACT §7) — the chip
 * tints its border, icon and, when selected, its fill from that one value, so re-theming a
 * category in the CSV re-themes it everywhere.
 *
 * A confidence below `NEEDS_REVIEW_THRESHOLD` is drawn in the critical colour: that is the
 * same 0.6 the backend uses to flag `needsReview`, and the two must not disagree on screen.
 */
export function CategoryChip({
  category,
  confidence,
  selected = false,
  onSelect,
  className,
}: CategoryChipProps) {
  const colour = category.colour || 'var(--sapBrandColor, #0070F2)'
  const hasConfidence = typeof confidence === 'number' && Number.isFinite(confidence)
  const lowConfidence = hasConfidence && confidence < NEEDS_REVIEW_THRESHOLD

  const style = { '--twm-chip-color': colour } as CSSProperties

  const classes = ['twm-chip']
  if (selected) classes.push('twm-chip--selected')
  if (onSelect) classes.push('twm-chip--interactive')
  if (className) classes.push(className)

  const body = (
    <>
      <Icon className="twm-chip__icon" name={resolveIcon(category.icon)} />
      <span className="twm-chip__label">{category.name}</span>
      {hasConfidence ? (
        <span
          className={lowConfidence ? 'twm-chip__score twm-chip__score--low' : 'twm-chip__score'}
        >
          {formatConfidence(confidence)}
        </span>
      ) : null}
    </>
  )

  if (!onSelect) {
    return (
      <span
        className={classes.join(' ')}
        style={style}
        data-testid="category-chip"
        data-code={category.code}
      >
        {body}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={style}
      onClick={onSelect}
      aria-pressed={selected}
      title={
        hasConfidence
          ? `${category.name} — model confidence ${formatConfidence(confidence)}`
          : category.name
      }
      data-testid="category-chip"
      data-code={category.code}
    >
      {body}
    </button>
  )
}

export default CategoryChip
