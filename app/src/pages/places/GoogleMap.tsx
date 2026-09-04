/**
 * The map, drawn by Google.
 *
 * ## What this is, and when it is used
 *
 * The same map as `PlacesMap`, rendered with the Google Maps JavaScript API instead of
 * MapLibre. It takes the identical props and reports the identical events, so `PlacesPage`
 * cannot tell which one it is holding — that is the whole point of the split, and it is what
 * lets the app run either without a rewrite.
 *
 * It is used when `VITE_GOOGLE_MAPS_API_KEY` is set at build time, and not otherwise. Without
 * a key the Google API does not degrade: it renders a grey rectangle stamped "for development
 * purposes only" and logs a billing error. So the choice is made once, in
 * {@link googleMapsKey}, and the MapLibre map remains the default — an app whose map depends
 * on somebody having remembered to configure a billing account is an app with a broken map.
 *
 * ## The three things it costs, written down because they are not obvious
 *
 * **The CSP gets weaker.** `script-src` is `'self'` with no exceptions, which is the single
 * directive that actually stops XSS, and Google's API loads code from `maps.googleapis.com`
 * and `maps.gstatic.com` at runtime. `srv/server.ts` widens those two directives *only* when
 * a key is configured, so a deployment that does not use Google keeps the strong policy.
 *
 * **It does not work offline.** The MapLibre map's tiles are same-origin and cached by the
 * service worker; Google's are not and cannot be — their terms forbid caching tiles, and the
 * CSP would block the service worker from doing it anyway. On a train, this map is grey.
 *
 * **Google sees where the household is looking.** Every pan sends the viewport and the
 * browser's IP to Google, tied to the API key. That is a real change to what this app
 * promises about the commons, and it is the reason the default is the other one.
 *
 * ## What it buys, which is not nothing
 *
 * The POI database. Tapping a restaurant on a Google map gives a `placeId`, and Places
 * Details turns that into a name, a category, an address and opening hours — richer and far
 * better maintained than OpenStreetMap in most of the world. For "tap any café and rate it",
 * that is the best data there is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { importLibrary, setOptions } from '@googlemaps/js-api-loader'

import type { PlaceCard } from '@/api/commons'
import type { DiscoveredPlace, PlacesMapProps } from './PlacesMap'

/**
 * The key, or null.
 *
 * Read through a function rather than inlined so the tests can reason about both branches,
 * and trimmed because a `.env` line with a trailing space is otherwise a key that looks
 * present and is not.
 */
export function googleMapsKey(): string | null {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Google's own categories, folded into this app's kinds.
 *
 * Mirrors `kindOfSubclass` in `PlacesMap` and `kindOf` on the server: the same café rated
 * through Google, through OpenStreetMap or through search must reach `rate` as the same
 * `kind`, or the corpus files one place three ways.
 */
export function kindOfTypes(types: readonly string[]): string {
  if (types.includes('cafe') || types.includes('bakery')) return 'cafe'
  if (types.includes('bar') || types.includes('night_club')) return 'bar'
  return 'restaurant'
}

/**
 * A muted style, so the markers stay the loudest thing on the map.
 *
 * The same argument as the MapLibre palette: Google's default basemap paints roads in a warm
 * yellow that competes directly with pins laid over it. This is applied through the legacy
 * `styles` array rather than a cloud-hosted Map ID, deliberately — a Map ID moves the app's
 * appearance into a Google console that is not in this repository and cannot be reviewed in a
 * pull request.
 */
const MUTED: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#f5f3ef' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#40566b' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c3d9ea' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#e2ecda' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#fdf7e8' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#fbeed6' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
]

/** A pill with the rating on it, or a quiet dot — the same two shapes the other map uses. */
function pinContent(place: PlaceCard, selected: boolean): HTMLElement {
  const span = document.createElement('span')
  const rated = place.published && place.stars !== null
  span.className = `pin${selected ? ' pin--on' : ''}${rated ? '' : ' pin--quiet'}`
  if (rated) {
    span.textContent = place.stars!.toFixed(1)
  } else {
    const dot = document.createElement('span')
    dot.className = 'pin__dot'
    span.append(dot)
  }
  return span
}

export function GoogleMap({
  places,
  here,
  selected,
  onSelect,
  onDiscover,
  accuracy = null,
  onLocate,
  approximate = false,
}: PlacesMapProps): React.ReactElement {
  const holder = useRef<HTMLDivElement | null>(null)
  const map = useRef<google.maps.Map | null>(null)
  const markers = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map())
  const hereMarker = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const halo = useRef<google.maps.Circle | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const discover = useRef(onDiscover)
  discover.current = onDiscover
  const select = useRef(onSelect)
  select.current = onSelect

  const centre = useMemo<google.maps.LatLngLiteral>(() => {
    if (here !== null) return { lat: here.lat, lng: here.lon }
    const first = places[0]
    return first === undefined ? { lat: 47.3769, lng: 8.5417 } : { lat: first.lat, lng: first.lon }
  }, [here, places])

  /* ------------------------------------------------------------- the map */

  useEffect(() => {
    const key = googleMapsKey()
    if (key === null || holder.current === null || map.current !== null) return
    const container = holder.current
    let live = true

    // The functional API, not `new Loader(...)`: the class is deprecated in v2 and the
    // options must be set before the first import, because that first import is what actually
    // fetches the API.
    setOptions({ key, v: 'weekly' })

    void importLibrary('maps')
      .then(async ({ Map }) => {
        // Advanced markers live in their own library and are what allow a DOM element as the
        // pin — which is how the same `.pin` CSS serves both maps.
        await importLibrary('marker')
        if (!live) return

        const instance = new Map(container, {
          center: centre,
          zoom: 15,
          styles: MUTED,
          // The furniture Google adds by default is designed for a full-screen map. This one
          // is a third of a phone, and every control is a target competing with the pins.
          disableDefaultUI: true,
          gestureHandling: 'greedy',
          clickableIcons: true,
          keyboardShortcuts: false,
        })

        /*
         * Tapping one of Google's own restaurants.
         *
         * A click on a POI icon arrives as an `IconMouseEvent` carrying a `placeId`, and
         * `stop()` suppresses Google's own info window so ours is the only card that opens.
         * The name is fetched from Places rather than guessed, because the click event does
         * not carry one.
         */
        instance.addListener('click', (event: google.maps.MapMouseEvent) => {
          const icon = event as google.maps.IconMouseEvent
          if (typeof icon.placeId !== 'string' || icon.placeId.length === 0) return
          icon.stop()
          void resolvePlace(instance, icon.placeId).then(found => {
            if (found !== null) discover.current?.(found)
          })
        })

        map.current = instance
        setReady(true)
      })
      .catch((error: unknown) => {
        // A bad key, a referrer restriction, or no billing account. Said plainly, because the
        // alternative is a grey rectangle nobody can diagnose.
        setFailed(error instanceof Error ? error.message : 'Google Maps could not load.')
      })

    return () => {
      live = false
      map.current = null
      setReady(false)
    }
    // Once. The map owns its centre after mount; re-creating it would discard a pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------------------------------------------------- the corpus */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return
    const AdvancedMarkerElement = google.maps.marker.AdvancedMarkerElement

    const wanted = new Set(places.map(place => place.ID))
    for (const [id, marker] of markers.current) {
      if (!wanted.has(id)) {
        marker.map = null
        markers.current.delete(id)
      }
    }

    for (const place of places) {
      markers.current.get(place.ID)?.setAttribute?.('hidden', '')
      const existing = markers.current.get(place.ID)
      if (existing !== undefined) existing.map = null

      const marker = new AdvancedMarkerElement({
        map: instance,
        position: { lat: place.lat, lng: place.lon },
        content: pinContent(place, place.ID === selected),
        title: place.name,
      })
      marker.addListener('click', () => select.current(place.ID))
      markers.current.set(place.ID, marker)
    }
  }, [places, selected, ready])

  /* -------------------------------------------------------------- "here" */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return

    hereMarker.current && (hereMarker.current.map = null)
    hereMarker.current = null
    halo.current?.setMap(null)
    halo.current = null
    if (here === null) return

    const dot = document.createElement('span')
    dot.className = 'pin-here'
    hereMarker.current = new google.maps.marker.AdvancedMarkerElement({
      map: instance,
      position: { lat: here.lat, lng: here.lon },
      content: dot,
    })

    // The accuracy circle is a real Circle here rather than a projected DOM element: Google
    // draws it in metres natively, which is the one thing MapLibre needed arithmetic for.
    if (accuracy !== null && accuracy > 20) {
      halo.current = new google.maps.Circle({
        map: instance,
        center: { lat: here.lat, lng: here.lon },
        radius: accuracy,
        strokeColor: '#1a73e8',
        strokeOpacity: 0.22,
        strokeWeight: 1,
        fillColor: '#1a73e8',
        fillOpacity: 0.1,
        clickable: false,
      })
    }
  }, [here, accuracy, ready])

  /* ---------------------------------------------------------------- fit */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return
    const points = places.map(place => ({ lat: place.lat, lng: place.lon }))
    if (here !== null) points.push({ lat: here.lat, lng: here.lon })
    if (points.length === 0) return
    if (points.length === 1) {
      instance.setCenter(points[0]!)
      instance.setZoom(15)
      return
    }
    const bounds = new google.maps.LatLngBounds()
    for (const point of points) bounds.extend(point)
    instance.fitBounds(bounds, 48)
  }, [places, here, ready])

  const recentre = useCallback(() => {
    if (here === null || approximate) {
      onLocate?.()
      return
    }
    map.current?.panTo({ lat: here.lat, lng: here.lon })
    map.current?.setZoom(16)
  }, [here, approximate, onLocate])

  if (failed !== null) {
    return (
      <div className="places-map places-map--none" role="note">
        <p>The Google map could not load, so here is the list instead. ({failed})</p>
      </div>
    )
  }

  return (
    <div className="places-map">
      <div className="places-map__canvas" ref={holder} data-testid="places-map" />
      {(here !== null || onLocate !== undefined) && (
        <button
          type="button"
          className={`places-map__recentre${here === null || approximate ? ' places-map__recentre--ask' : ''}`}
          onClick={recentre}
          aria-label={
            here === null || approximate ? 'Find where I am' : 'Centre the map on where I am'
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3.4" />
            <circle cx="12" cy="12" r="7.6" />
            <path d="M12 1.6v3M12 19.4v3M22.4 12h-3M4.6 12h-3" />
          </svg>
        </button>
      )}
    </div>
  )
}

/**
 * A `placeId` to something rateable.
 *
 * Only four fields are requested. Places Details is billed per field group, and this needs a
 * name, a position and a category — asking for opening hours and photographs because they are
 * available would multiply the cost of every tap for data the card does not show.
 */
async function resolvePlace(
  map: google.maps.Map,
  placeId: string,
): Promise<DiscoveredPlace | null> {
  try {
    const { PlacesService } = await importLibrary('places')
    const service = new PlacesService(map)
    return await new Promise<DiscoveredPlace | null>(resolve => {
      service.getDetails(
        { placeId, fields: ['name', 'geometry.location', 'types'] },
        (result, status) => {
          if (status !== google.maps.places.PlacesServiceStatus.OK || result === null) {
            resolve(null)
            return
          }
          const point = result.geometry?.location
          const name = result.name
          if (point === undefined || typeof name !== 'string' || name.length === 0) {
            resolve(null)
            return
          }
          resolve({
            name: name.slice(0, 200),
            kind: kindOfTypes(result.types ?? []),
            lat: point.lat(),
            lon: point.lng(),
          })
        },
      )
    })
  } catch {
    // A blocked Places library, or a quota. The card simply does not open, which is the same
    // as tapping a road.
    return null
  }
}

export default GoogleMap
