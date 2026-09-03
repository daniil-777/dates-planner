/**
 * One place, as a card.
 *
 * The Google Maps *layout* — name, rating line, then the practical facts, then the way out —
 * because it is the arrangement everybody can already read, and none of it needs Google. The
 * pins, the stars and this card are ours; the base map underneath is OpenStreetMap and the
 * two buttons at the bottom are the only thing either map app is used for.
 *
 * ## The unpublished state is a first-class one
 *
 * Below three households a place has no stars, no chips and no cost. It is not an error, an
 * empty state or a skeleton: it is a place somebody has been to that nobody else has rated
 * yet, and the card says exactly that and how many more are needed. Getting this wrong in the
 * obvious way — zero stars, an empty chip row — would read as "everybody hated it", which is
 * the opposite of true.
 */
import '@ui5/webcomponents-icons/dist/navigation-right-arrow.js'

import type { PlaceCard as Card } from '@/api/commons'
import { StarRating } from './Stars'
import { TagChips } from './Chips'
import {
  ANONYMITY_THRESHOLD,
  KIND_LABEL,
  costShort,
  distanceLabel,
  householdsLabel,
} from './vocabulary'

export interface PlaceCardProps {
  place: Card
  onOpen?: (id: string) => void
  /** Rendered under the facts — the "why this one" line on a Tonight card. */
  footnote?: string
}

export function PlaceCardView({ place, onOpen, footnote }: PlaceCardProps): React.ReactElement {
  const distance = distanceLabel(place.distance)
  const facts = [KIND_LABEL[place.kind] ?? 'Somewhere', place.city, distance].filter(
    (one): one is string => typeof one === 'string' && one.length > 0,
  )

  const body = (
    <>
      <div className="place-card__head">
        <h3 className="place-card__name">{place.name}</h3>
        {place.published ? (
          <StarRating value={place.stars} households={place.households} />
        ) : (
          <p className="place-card__unpublished">
            {/* Never "0.0 ★". A place nobody has judged has not been judged badly. */}
            {householdsLabel(place.households)} so far — {ANONYMITY_THRESHOLD - place.households}{' '}
            more and it appears for everyone
          </p>
        )}
      </div>

      <p className="place-card__facts">
        {facts.join(' · ')}
        {place.costBand !== null && (
          <>
            {' · '}
            <span className="place-card__cost">{costShort(place.costBand)}</span>
          </>
        )}
      </p>

      <TagChips tags={place.tags} />
      {footnote !== undefined && <p className="place-card__because">{footnote}</p>}
    </>
  )

  return (
    <article className="place-card">
      {onOpen === undefined ? (
        body
      ) : (
        <button
          type="button"
          className="place-card__open"
          onClick={() => onOpen(place.ID)}
          aria-label={`Open ${place.name}`}
        >
          {body}
        </button>
      )}
      <MapLinks place={place} />
    </article>
  )
}

/**
 * The two ways out.
 *
 * Keyless universal links: no API key, no billing account, no contract, and both fall back to
 * a web map on a platform without the app. This is the whole of the app's relationship with
 * Google and Apple — **destinations, not stores.** Nothing is ever written back to either,
 * because neither permits it (ADR-003 §2).
 */
export function MapLinks({ place }: { place: Card }): React.ReactElement {
  return (
    <div className="place-card__links">
      <a
        className="place-card__link"
        href={place.googleUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        Google Maps
      </a>
      <a
        className="place-card__link"
        href={place.appleUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        Apple Maps
      </a>
    </div>
  )
}
