/**
 * Places — what is good near us.
 *
 * Map and list are one view, not two tabs: the map answers "where", the list answers "which",
 * and a phone has room for both if the map takes the top third. Selecting in one selects in
 * the other, so a pin and a row are the same object seen twice.
 *
 * ## The empty state is the feature explaining itself
 *
 * A commons with nothing in it near you is the normal first experience, and the honest thing
 * is to say why — three households, and yours can be one of them — rather than show a spinner
 * that resolves to nothing or invent places to fill the space.
 *
 * ## What the filters are, and what they are not
 *
 * Kind and chip. There is deliberately **no filter describing the people who rated a place**,
 * and there never will be: ADR-002 §6 refuses to store a household's shape and ADR-003 §5
 * refuses to let it back in through the commons. A "for couples like us" filter is exactly
 * how that decision would get quietly reversed, and it is also how every app in this category
 * got worse — the thing that makes a tip useful is the place.
 */
import { useMemo, useState } from 'react'
import { Button, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/add.js'

import { useNearby, usePlaceDetail } from '@/api/commonsHooks'
import { useI18n } from '@/i18n'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { CommonsNav } from './places/CommonsNav'
import { HerePrompt } from './places/HerePrompt'
import { PlaceCardView } from './places/PlaceCard'
import { PlaceDetailPanel } from './places/PlaceDetailPanel'
import { PlacesMap } from './places/PlacesMap'
import { RateSheet } from './places/RateSheet'
import { useHere } from './places/useHere'
import {
  FILTER_KINDS,
  KIND_LABEL,
  PLACE_TAGS,
  TAG_LABEL,
  type PlaceKind,
  type PlaceTag,
} from './places/vocabulary'
import './places/places.css'

export function PlacesPage(): React.ReactElement {
  const { t } = useI18n()
  const { here, status, locate, setHere } = useHere()
  const [kind, setKind] = useState<PlaceKind | null>(null)
  const [tag, setTag] = useState<PlaceTag | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [rating, setRating] = useState(false)

  const nearby = useNearby(here, { kind, tag, radiusM: 5_000, limit: 40 })
  const detail = usePlaceDetail(selected)
  const places = useMemo(() => nearby.data?.items ?? [], [nearby.data])

  if (here === null) {
    return (
      <section className="places">
        <CommonsNav />
        <header className="places__head">
          <Title level="H2">{t('commons.places', 'Places')}</Title>
        </header>
        <HerePrompt status={status} onLocate={locate} onPick={setHere} />
      </section>
    )
  }

  return (
    <section className="places">
      <CommonsNav />
      <header className="places__head">
        <Title level="H2">{t('commons.places', 'Places')}</Title>
        <Button design="Transparent" icon="add" onClick={() => setRating(true)}>
          {t('commons.rate', 'Rate a place')}
        </Button>
      </header>

      <PlacesMap places={places} here={here} selected={selected} onSelect={setSelected} />

      <div className="places__filters">
        <div className="places__filter-row" role="group" aria-label="Kind of place">
          <button
            type="button"
            aria-pressed={kind === null}
            className={`places__chip${kind === null ? ' places__chip--on' : ''}`}
            onClick={() => setKind(null)}
          >
            {t('places.everything', 'Everything')}
          </button>
          {FILTER_KINDS.map(one => (
            <button
              type="button"
              key={one}
              aria-pressed={kind === one}
              className={`places__chip${kind === one ? ' places__chip--on' : ''}`}
              onClick={() => setKind(kind === one ? null : one)}
            >
              {KIND_LABEL[one]}
            </button>
          ))}
        </div>
        <div className="places__filter-row" role="group" aria-label="What it is like">
          {PLACE_TAGS.map(one => (
            <button
              type="button"
              key={one}
              aria-pressed={tag === one}
              className={`places__chip places__chip--tag${tag === one ? ' places__chip--on' : ''}`}
              onClick={() => setTag(tag === one ? null : one)}
            >
              {TAG_LABEL[one]}
            </button>
          ))}
        </div>
      </div>

      {nearby.isPending && <LoadingSkeleton />}
      {nearby.isError && <ErrorState error={nearby.error} onRetry={() => nearby.refetch()} />}

      {!nearby.isPending && !nearby.isError && places.length === 0 && (
        <div className="places__empty">
          <p className="places__empty-line">
            {kind !== null || tag !== null
              ? t('places.emptyFiltered', 'Nothing near you matches that.')
              : t('places.empty', 'Nothing near you yet.')}
          </p>
          <p className="places__empty-hint">
            A place appears once three households have rated it — enough that no single household
            can be picked out of it. Rate somewhere you already like and it starts filling up.
          </p>
          <Button design="Emphasized" icon="add" onClick={() => setRating(true)}>
            {t('commons.rate', 'Rate a place')}
          </Button>
        </div>
      )}

      {places.length > 0 && (
        <ol className="places__list">
          {places.map(place => (
            <li key={place.ID} className={place.ID === selected ? 'places__row--on' : undefined}>
              <PlaceCardView place={place} onOpen={setSelected} />
            </li>
          ))}
        </ol>
      )}

      <PlaceDetailPanel
        detail={detail.data ?? null}
        loading={detail.isPending && selected !== null}
        onClose={() => setSelected(null)}
        onRate={() => setRating(true)}
      />

      <RateSheet
        open={rating}
        place={rating && selected !== null ? (detail.data?.place ?? null) : null}
        yourStars={detail.data?.yourStars ?? null}
        onClose={() => setRating(false)}
      />
    </section>
  )
}
