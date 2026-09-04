/**
 * The map — our pins on somebody else's tiles.
 *
 * ## Why not Google's map
 *
 * Google's Maps JavaScript API would draw a nicer basemap and cost three things this app has
 * spent real effort keeping: `script-src 'self'` in the CSP (it loads scripts from two of its
 * own origins and makes its own XHRs), the map working offline (the service worker precaches
 * the shell; Google's map is useless without a network), and the promise that nothing about
 * where a household goes leaves this app. It also needs a billing account.
 *
 * None of that buys anything for *this* feature, because the interesting part of the picture
 * is ours either way: the pins, the ratings and the cards are drawn here, and a basemap is a
 * backdrop. So the backdrop is OpenStreetMap, as it already is on the memories map, and the
 * design work goes into the pins.
 *
 * If that trade ever stops being worth it, the swap is this file and nothing else — every
 * component around it takes `PlaceCard[]` and knows nothing about Leaflet.
 *
 * ## Two Leaflet-under-a-bundler problems, handled explicitly
 *
 * 1. **The broken default marker.** `L.Icon.Default` resolves its PNGs by rewriting the URL
 *    of the Leaflet stylesheet, which no bundler preserves. Every marker here is a `divIcon`
 *    with inline HTML, so there is no external asset to resolve.
 * 2. **Sizing.** The container is measured on mount and the map only mounts when this view is
 *    on screen, so an `invalidateSize()` on the next frame survives the toggle from the list.
 */
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo } from 'react'
import { divIcon, latLngBounds } from 'leaflet'
import type { LatLngTuple } from 'leaflet'
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet'

import type { PlaceCard } from '@/api/commons'
import type { Here } from '@/api/commonsHooks'

export interface PlacesMapProps {
  places: readonly PlaceCard[]
  here: Here | null
  selected: string | null
  onSelect: (id: string) => void
}

/**
 * A pin that says the rating on it.
 *
 * The one thing a map of rated places should show without a tap is the rating, so the marker
 * *is* the rating — a pill with the number in it, the way a price shows on a map of hotels.
 * A place below the threshold gets a plain dot instead of a number, for the same reason its
 * card gets no stars: there is nothing honest to write on it yet.
 */
function pinFor(place: PlaceCard, selected: boolean) {
  const label =
    place.published && place.stars !== null
      ? `<span class="pin__stars">${place.stars.toFixed(1)}</span>`
      : '<span class="pin__dot"></span>'
  return divIcon({
    className: '',
    html: `<span class="pin${selected ? ' pin--on' : ''}${place.published ? '' : ' pin--quiet'}">${label}</span>`,
    iconSize: [44, 26],
    iconAnchor: [22, 26],
  })
}

/** A soft ring where the person is. Not a pin: it is not a place, and it is not tappable. */
function herePin() {
  return divIcon({
    className: '',
    html: '<span class="pin-here"></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

function Fitter({ places, here }: { places: readonly PlaceCard[]; here: Here | null }): null {
  const map = useMap()

  useEffect(() => {
    // The map is mounted inside a container that has just appeared, so Leaflet's cached size
    // is stale for exactly one frame.
    const frame = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(frame)
  }, [map])

  useEffect(() => {
    const points: LatLngTuple[] = places.map(place => [place.lat, place.lon])
    if (here !== null) points.push([here.lat, here.lon])
    if (points.length === 0) return
    if (points.length === 1) {
      map.setView(points[0]!, 15)
      return
    }
    // `maxZoom` matters more than it looks: three places on one street produce a bounding box
    // a few metres across, and an uncapped fit zooms to building level, where the map shows a
    // roof and no context at all.
    map.fitBounds(latLngBounds(points).pad(0.15), { animate: false, maxZoom: 16 })
  }, [map, places, here])

  return null
}

export function PlacesMap({
  places,
  here,
  selected,
  onSelect,
}: PlacesMapProps): React.ReactElement {
  const centre: LatLngTuple = useMemo(() => {
    if (here !== null) return [here.lat, here.lon]
    const first = places[0]
    return first === undefined ? [47.3769, 8.5417] : [first.lat, first.lon]
  }, [here, places])

  return (
    <div className="places-map">
      <MapContainer
        center={centre}
        zoom={14}
        scrollWheelZoom
        className="places-map__canvas"
        // The zoom buttons are 26 px and unreachable with a thumb; pinch works and is what
        // anybody on a phone does anyway.
        zoomControl={false}
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <Fitter places={places} here={here} />
        {here !== null && <Marker position={[here.lat, here.lon]} icon={herePin()} />}
        {places.map(place => (
          <Marker
            key={place.ID}
            position={[place.lat, place.lon]}
            icon={pinFor(place, place.ID === selected)}
            eventHandlers={{ click: () => onSelect(place.ID) }}
          />
        ))}
      </MapContainer>
    </div>
  )
}
