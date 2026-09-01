import { Icon } from '@ui5/webcomponents-react'
import { Link } from 'react-router-dom'
import type { Event } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney } from '@/theme'
import './icons'
import { formatDateRange, spanLabel } from './dates'
import { SurpriseBadge } from './SurpriseBadge'
import { participantLabel, postingsLabel, type EventRollup } from './summary'

/** More faces than this and the row wraps into the figures; the rest become a count. */
const AVATARS_SHOWN = 4

export interface EventCardProps {
  event: Event
  /** Postings and total derived from the ledger the list already loaded. */
  rollup: EventRollup
  currency?: string
  /**
   * CONTRACTS §11.3: this is a surprise the person looking at the list created and has not
   * revealed yet. Decided by `isOwnSecret` in `./surprise`, never guessed at here — and never
   * true for somebody else's surprise, which the service never sent in the first place.
   */
  onlyYou?: boolean
}

/**
 * One event, as a card in the list.
 *
 * The whole card is a single link rather than a card with a button in it: on a phone the
 * target is the tile, and one link per card also means one tab stop per card. There is a
 * single figure on it — what the event cost — because that is the only fact an event has.
 */
export function EventCard({ event, rollup, currency, onlyYou = false }: EventCardProps) {
  const when = formatDateRange(event.startsOn, event.endsOn)
  const participants = event.participants ?? []
  const shown = participants.slice(0, AVATARS_SHOWN)
  const hidden = participants.length - shown.length
  const roster = participantLabel(participants)

  return (
    <li className="ev-card">
      <Link
        className="ev-card__link"
        to={`/events/${event.ID}`}
        data-testid="event-card"
        data-event-id={event.ID}
        aria-label={`${event.name}, ${when}, ${roster}, ${postingsLabel(rollup.count)}, ${formatMoney(
          rollup.total,
          currency,
        )}${onlyYou ? ', only you can see this' : ''}`}
      >
        <span className="ev-card__head">
          <span className="ev-card__name">{event.name}</span>
          {onlyYou ? <SurpriseBadge compact /> : null}
        </span>

        <span className="ev-card__when">
          <Icon name="calendar" aria-hidden="true" />
          <span>{when}</span>
          <span aria-hidden="true">·</span>
          <span>{spanLabel(event.startsOn, event.endsOn)}</span>
          {event.place ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{event.place}</span>
            </>
          ) : null}
        </span>

        <span className="ev-card__foot">
          <span className="ev-avatars" role="img" aria-label={roster}>
            {shown.map(person => (
              <PersonAvatar key={person.ID} person={person} size="S" />
            ))}
            {hidden > 0 ? <span className="ev-avatars__more">+{hidden}</span> : null}
            {participants.length === 0 ? (
              <span className="ev-card__postings">No participants yet</span>
            ) : null}
          </span>

          <span className="ev-card__figures">
            <MoneyText amount={rollup.total} currency={currency} bold />
            <span className="ev-card__postings">{postingsLabel(rollup.count)}</span>
          </span>
        </span>
      </Link>
    </li>
  )
}

export default EventCard
