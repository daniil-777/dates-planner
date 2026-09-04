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
import { MapPeek } from './places/MapPeek'
import { GoogleMap, googleMapsKey } from './places/GoogleMap'
import { PlacesMap, type DiscoveredPlace } from './places/PlacesMap'
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

/** Chosen once, at module load: swapping map engines mid-session would remount the world. */
const MapView = googleMapsKey() === null ? PlacesMap : GoogleMap

export function PlacesPage(): React.ReactElement {
  const { t } = useI18n()
  const { here, status, accuracy, approximate, locate, setHere } = useHere()
  const [kind, setKind] = useState<PlaceKind | null>(null)
  const [tag, setTag] = useState<PlaceTag | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [rating, setRating] = useState(false)
  // Somewhere tapped on the map that the commons has never heard of. Held apart from
  // `selected`, which is always a corpus id — conflating them is how a place with no rating
  // ends up asking the server for its detail and rendering an empty one.
  const [peeked, setPeeked] = useState<DiscoveredPlace | null>(null)

  const nearby = useNearby(here, { kind, tag, radiusM: 5_000, limit: 40 })
  const detail = usePlaceDetail(selected)
  const places = useMemo(() => nearby.data?.items ?? [], [nearby.data])

  return (
    <section className="places">
      <CommonsNav />
      <header className="places__head">
        <Title level="H2">{t('commons.places', 'Places')}</Title>
        <Button design="Transparent" icon="add" onClick={() => setRating(true)}>
          {t('commons.rate', 'Rate a place')}
        </Button>
      </header>

      {/*
        The map is drawn whether or not anybody has said where they are.
        
        It used to be replaced wholesale by the "where are you?" prompt, so the first thing a
        new household saw on a page about places was a form. A map centred on nowhere in
        particular is still a map: it shows what the app is, it is pleasant to look at, and
        the prompt sits on top of it as one card rather than standing in for the whole page.
      */}
      <div className="places__map-wrap">
        {/*
          Google's map when a key is configured, ours otherwise. The two take the same props
          and raise the same events, so nothing below this line knows which one it got — and
          an app whose map depends on somebody having set up a billing account is an app with
          a broken map, so the default is the one that always works.
        */}
        <MapView
          places={places}
          here={here}
          accuracy={accuracy}
          approximate={approximate}
          onLocate={locate}
          selected={selected}
          onSelect={id => {
            setPeeked(null)
            setSelected(id)
          }}
          onDiscover={found => {
            setSelected(null)
            setPeeked(found)
          }}
        />
        <MapPeek
          place={peeked}
          here={here}
          onRate={() => setRating(true)}
          onClose={() => setPeeked(null)}
        />
        {here === null && (
          <div className="places__here-over">
            <HerePrompt status={status} onLocate={locate} onPick={setHere} />
          </div>
        )}
      </div>

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
        candidate={
          peeked === null
            ? null
            : {
                name: peeked.name,
                label: peeked.name,
                lat: peeked.lat,
                lon: peeked.lon,
                city: null,
                country: null,
                kind: peeked.kind as PlaceKind,
                // The basemap's `poi` layer carries no OSM id — only a name, a class and a
                // position. `rate` de-duplicates on name and position when these are absent.
                osmType: null,
                osmId: null,
                placeID: null,
              }
        }
        yourStars={detail.data?.yourStars ?? null}
        onClose={() => {
          setRating(false)
          setPeeked(null)
        }}
      />
    </section>
  )
}
