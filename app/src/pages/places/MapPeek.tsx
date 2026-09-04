/**
 * The card that appears when you tap somewhere on the map.
 *
 * ## What it is for
 *
 * The commons publishes a place once three households have rated it, which means the map of
 * a new household is empty and the only way in was to type a restaurant's name into a search
 * field. Somebody standing outside a café is looking at the thing they mean. This is the card
 * that says "yes, that one" and gets out of the way.
 *
 * ## The one thing it must not do
 *
 * It must not look like it knows anything. This card is shown for a place the commons has
 * never heard of: nobody has rated it, there is no mean, no cost band, no chips. So it shows
 * a name, a kind, and how far away it is — every one of which came off the basemap — and then
 * one action. No empty star outlines, no "0.0", no greyed-out rating: an empty rating control
 * reads as *rated badly* rather than *not rated*, which is the single easiest way to libel a
 * restaurant, and `commons.test.tsx` already guards the same mistake on the list card.
 *
 * ## Why a sheet over the map rather than the existing detail panel
 *
 * The map is the top third of the page and the thing tapped is inside it. A panel that opens
 * elsewhere makes somebody look away from the pin to find out what they tapped, and on a
 * phone it pushes the map off screen entirely. This sits over the bottom of the map, which is
 * where both Google and Apple put it, is within thumb reach, and leaves the pin visible.
 */
import { useI18n } from '@/i18n'
import { KIND_LABEL, distanceLabel, type PlaceKind } from './vocabulary'
import type { DiscoveredPlace } from './PlacesMap'
import type { Here } from '@/api/commonsHooks'

export interface MapPeekProps {
  place: DiscoveredPlace | null
  here: Here | null
  onRate: () => void
  onClose: () => void
}

/** Metres between two points. Good enough for "220 m away" and cheap. */
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const lat = ((aLat + bLat) / 2) * (Math.PI / 180)
  const x = dLon * Math.cos(lat)
  return Math.round(Math.sqrt(dLat * dLat + x * x) * R)
}

export function MapPeek({ place, here, onRate, onClose }: MapPeekProps): React.ReactElement | null {
  const { t } = useI18n()
  if (place === null) return null

  const away =
    here === null ? null : distanceLabel(metresBetween(here.lat, here.lon, place.lat, place.lon))
  const kind = KIND_LABEL[place.kind as PlaceKind] ?? place.kind

  return (
    // `role="dialog"` would demand focus management and a trap for something that is a peek
    // rather than a mode — the map stays live behind it and panning it should dismiss it.
    // `status` announces the name when it appears, which is what a screen reader needs here.
    <div className="map-peek" role="status" aria-live="polite" data-testid="map-peek">
      <div className="map-peek__body">
        <p className="map-peek__name">{place.name}</p>
        <p className="map-peek__meta">
          {kind}
          {away !== null ? ` · ${away}` : ''}
        </p>
        {/*
          Said plainly, at the moment it becomes true, rather than in a policy nobody opens.
          Rating this puts it into a shared corpus, and somebody deserves to know that before
          they press the button rather than after.
        */}
        <p className="map-peek__note">
          {t(
            'places.peek.new',
            'Nobody has rated this yet. Yours would be the first — it stays private until three households have.',
          )}
        </p>
      </div>
      <div className="map-peek__actions">
        <button type="button" className="map-peek__go" onClick={onRate}>
          {t('places.peek.rate', 'Rate it')}
        </button>
        <button
          type="button"
          className="map-peek__close"
          onClick={onClose}
          aria-label={t('places.peek.dismiss', 'Dismiss')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default MapPeek
