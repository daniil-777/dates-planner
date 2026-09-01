import '@ui5/webcomponents-icons/dist/calendar.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import { Icon } from '@ui5/webcomponents-react'
import type { Event } from '../api/types'
import { formatDate } from '../theme'
import './components.css'

export interface EventChipProps {
  event: Event
  /** When given, the chip carries an × that detaches the posting from the event. */
  onClear?: () => void
  className?: string
}

/** `10 Jun 2026 – 13 Jun 2026`, or a single date when the event lasts one day. */
function eventDates(event: Event): string {
  const from = formatDate(event.startsOn)
  if (!event.endsOn || event.endsOn === event.startsOn) return from
  return `${from} – ${formatDate(event.endsOn)}`
}

/**
 * The event a posting belongs to, as one small readable thing.
 *
 * An expense with no event is ordinary spending (CONTRACTS.md §10); this chip is what
 * "not ordinary" looks like — the trip, the dinner, the party the amount was part of.
 * It never implies a share of anything: belonging to an event is bookkeeping, not a bill.
 */
export function EventChip({ event, onClear, className }: EventChipProps) {
  const parts = [eventDates(event)]
  if (event.place) parts.push(event.place)

  return (
    <span
      className={className ? `twm-event-chip ${className}` : 'twm-event-chip'}
      data-testid="event-chip"
      data-event={event.ID}
    >
      <Icon className="twm-event-chip__icon" name="calendar" />
      <span className="twm-event-chip__text">
        <span className="twm-event-chip__name">{event.name}</span>
        <span className="twm-event-chip__meta">{parts.join(' · ')}</span>
      </span>
      {onClear ? (
        <button
          type="button"
          className="twm-event-chip__clear"
          aria-label={`Remove ${event.name}`}
          onClick={onClear}
        >
          <Icon name="decline" />
        </button>
      ) : null}
    </span>
  )
}

export default EventChip
