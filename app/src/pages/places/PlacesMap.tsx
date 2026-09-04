/**
 * The map — a real basemap, and everything on it tappable.
 *
 * ## Why this stopped being Leaflet and raster tiles
 *
 * The old map drew `tile.openstreetmap.org` PNGs. Three things were wrong with that and only
 * one of them was cosmetic.
 *
 * **It was blurry.** OSM's standard tiles have no `@2x` variant — `…@2x.png` is an HTTP 400 —
 * so on a phone every tile was a 256 px image stretched over 512 device pixels. That is the
 * whole reason the map looked a decade old next to any other app on the same screen.
 *
 * **It could not be cached.** `connect-src` is `'self'` in production, and that directive
 * governs `fetch()` *inside the service worker* as much as in the page. Workbox therefore
 * could not cache a cross-origin tile at all, so the Places map offline was a grey rectangle.
 *
 * **It quietly broke the promise this feature is built on.** The file used to say "nothing
 * about where a household goes leaves this app" while the browser asked a third party for the
 * tiles around somebody's street, on every pan, with their IP attached.
 *
 * Vector tiles fix all three: resolution-independent so it is sharp at any zoom, served
 * same-origin through `srv/lib/commons/basemap.ts` so the service worker may cache them and
 * the tile host sees this server rather than a household, and — the part that turned out to
 * matter most — **the tiles already contain the restaurants**.
 *
 * ## The thing that made the second half of this feature simple
 *
 * A vector tile is data, not a picture. The OpenMapTiles `poi` layer inside the tiles this
 * map is already downloading carries every named restaurant, café and bar with its class and
 * position — 1,161 of them in one city viewport, measured. So "tap any place and rate it"
 * needs no POI service, no Overpass proxy, no rate limit to honour and no round trip: the
 * answer is already on the device, and it works on a train.
 *
 * That is why there is no `pois` query anywhere in this app. It was written, and then deleted
 * when the data turned out to be in hand already.
 *
 * ## Three tiers, and the rule that keeps them honest
 *
 * The map carries three different kinds of claim and they must never be confusable:
 *
 *  1. a **published** commons place — three or more households, a real mean;
 *  2. a place **in the corpus but below the threshold** — somebody has rated it, the number
 *     is nobody's business yet;
 *  3. a **place that merely exists** — from the basemap, carrying no judgement at all.
 *
 * The rule: **a numeral on the map means a published mean and nothing else.** Tier 2 is a
 * dot, tier 3 is a hollow ring. Neither borrows the shape that means "this is rated", so
 * nobody can read a rating off a café nobody has been to. Shape carries this, not colour
 * (WCAG 1.4.1), and the list below the map says the same thing in words.
 */
import 'maplibre-gl/dist/maplibre-gl.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LngLatBounds, Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { FilterSpecification, MapGeoJSONFeature, StyleSpecification } from 'maplibre-gl'

import type { PlaceCard } from '@/api/commons'
import type { Here } from '@/api/commonsHooks'

/** Vendored and URL-rewritten by `app/scripts/basemap-style.mjs`. */
const STYLE_URL = '/basemap/style.json'

/**
 * Fetches the vendored style and makes it usable.
 *
 * Two things have to happen between the file and MapLibre.
 *
 * **The sprite URL must be absolute.** MapLibre refuses a relative one outright — `Invalid
 * sprite URL "…", must be absolute` — while accepting relative URLs everywhere else, so this
 * is the one field that cannot be stored the way the others are. Resolving it here rather
 * than baking an origin into the file keeps the vendored style portable between localhost,
 * a preview deploy and production.
 *
 * **The palette is ours.** OpenFreeMap's Liberty is a general-purpose basemap; this app has
 * a palette, and a map that ignores it looks like an iframe somebody embedded. The overrides
 * are deliberately few — ground, water, parks and buildings, the four things that carry the
 * impression — and they are applied by layer id, so an upstream restyle that renames a layer
 * loses a colour rather than breaking the map.
 */
export async function loadStyle(fetchImpl: typeof fetch = fetch): Promise<StyleSpecification> {
  const response = await fetchImpl(STYLE_URL)
  if (!response.ok) throw new Error(`basemap style: HTTP ${response.status}`)
  const style = (await response.json()) as StyleSpecification

  if (typeof style.sprite === 'string' && style.sprite.startsWith('/')) {
    style.sprite = `${window.location.origin}${style.sprite}`
  }

  for (const layer of style.layers) {
    const paint = PALETTE[layer.id]
    if (paint === undefined || !('paint' in layer)) continue
    layer.paint = { ...layer.paint, ...paint } as typeof layer.paint
  }
  return style
}

/**
 * The colours that decide whether a map reads as ours.
 *
 * Quieter than Liberty's defaults throughout, and the roads most of all. Liberty paints
 * motorways `#ffdaa6` over `#e9ac77` casings and primaries `#fff4c6` — a warm orange-yellow
 * road network that, on the first build of this map, competed directly with the markers laid
 * on top of it and turned a city centre into orange noise. A basemap that outshouts its own
 * markers has forgotten what it is for.
 *
 * Applied by layer id, so an upstream restyle that renames a layer costs a colour rather than
 * breaking the map — which is why the ids here were read out of the vendored style rather
 * than guessed. The first attempt guessed, half of them silently missed, and the map came
 * back in stock colours looking almost right.
 */
const PALETTE: Record<string, Record<string, unknown>> = {
  background: { 'background-color': '#f5f3ef' },
  water: { 'fill-color': '#c3d9ea' },
  waterway_river: { 'line-color': '#c3d9ea' },
  waterway_other: { 'line-color': '#c3d9ea' },
  landcover_wood: { 'fill-color': '#dde7d4' },
  landcover_grass: { 'fill-color': '#e2ecda' },
  park: { 'fill-color': '#e2ecda' },
  building: { 'fill-color': '#e8e4dd', 'fill-outline-color': '#dcd7ce' },
  // The roads. Warm grey casings and near-white surfaces, with motorways kept a shade
  // warmer so the hierarchy of the network survives being desaturated.
  road_motorway_casing: { 'line-color': '#dfd7c9' },
  road_trunk_primary_casing: { 'line-color': '#e2dbcd' },
  road_secondary_tertiary_casing: { 'line-color': '#e4ded2' },
  road_minor_casing: { 'line-color': '#e6e2db' },
  road_link_casing: { 'line-color': '#e2dbcd' },
  road_motorway: { 'line-color': '#fbeed6' },
  road_trunk_primary: { 'line-color': '#fdf7e8' },
  road_secondary_tertiary: { 'line-color': '#fefbf2' },
  road_minor: { 'line-color': '#ffffff' },
  road_link: { 'line-color': '#fdf7e8' },
}

/** The kinds this app is about. Everything else in the `poi` layer stays a basemap label. */
const FOOD = ['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'ice_cream', 'food_court'] as const

const SOURCE = 'openmaptiles'
const POI_LAYER = 'twm-poi'

export interface DiscoveredPlace {
  name: string
  /** One of the app's kinds, already folded down from the OSM subclass. */
  kind: string
  lat: number
  lon: number
}

export interface PlacesMapProps {
  places: readonly PlaceCard[]
  here: Here | null
  selected: string | null
  onSelect: (id: string) => void
  /** A basemap place somebody tapped that the commons has never heard of. */
  onDiscover?: (place: DiscoveredPlace) => void
  /** Metres of uncertainty around `here`, drawn as a halo. See {@link hereElement}. */
  accuracy?: number | null
  /** Ask the browser for a fresh fix. The crosshair calls this when the point is stale. */
  onLocate?: () => void
  /** True when `here` came from storage or a search rather than a live fix. */
  approximate?: boolean
}

/**
 * OpenMapTiles' `subclass` reduced to the app's kinds.
 *
 * Mirrors `kindOf` in `srv/lib/commons/places.ts` deliberately — a place tapped here and the
 * same place found through search must arrive at `rate` with the same `kind`, or the corpus
 * ends up with one café filed two ways.
 */
export function kindOfSubclass(subclass: string): string {
  if (subclass === 'cafe' || subclass === 'ice_cream') return 'cafe'
  if (subclass === 'bar' || subclass === 'pub' || subclass === 'biergarten') return 'bar'
  return 'restaurant'
}

/** A pill with the rating on it, a dot, or a ring — see the header. */
function pinElement(place: PlaceCard, selected: boolean): HTMLElement {
  const span = document.createElement('span')
  const rated = place.published && place.stars !== null
  span.className = `pin${selected ? ' pin--on' : ''}${rated ? '' : ' pin--quiet'}`
  if (rated) {
    span.textContent = place.stars!.toFixed(1)
    span.setAttribute('aria-label', `${place.name}, ${place.stars!.toFixed(1)} stars`)
  } else {
    const dot = document.createElement('span')
    dot.className = 'pin__dot'
    span.append(dot)
    span.setAttribute('aria-label', `${place.name}, not rated yet`)
  }
  return span
}

/**
 * Where the person is, and how sure the browser is about it.
 *
 * The halo is not decoration. A bare dot claims a precision the browser never offered: on a
 * laptop a fix is routinely derived from wifi or an IP address and is out by hundreds of
 * metres, and a household looking at a confident dot in the wrong street reasonably concludes
 * the app is broken. Drawing the circle the browser actually reported explains the gap
 * without a word of copy — and it is why every map application does the same thing.
 */
function hereElement(): HTMLElement {
  const span = document.createElement('span')
  span.className = 'pin-here'
  const halo = document.createElement('span')
  halo.className = 'pin-here__halo'
  span.append(halo)
  return span
}

/**
 * The halo's radius in CSS pixels, by projection rather than by arithmetic.
 *
 * The closed form needs the metres-per-pixel constant, the latitude cosine and MapLibre's
 * 512-pixel tile convention, and getting any of the three wrong yields a circle that looks
 * plausible and is off by a factor of two. Projecting the centre and a point `metres` due
 * north and measuring the gap asks the map the question directly, and stays right through
 * zoom, pitch and whatever projection MapLibre is using this year.
 */
function haloPixels(instance: MapLibreMap, here: Here, metres: number): number {
  const north = { lat: here.lat + metres / 111_320, lng: here.lon }
  const a = instance.project([here.lon, here.lat])
  const b = instance.project([north.lng, north.lat])
  return Math.abs(a.y - b.y)
}

/**
 * Is WebGL actually available?
 *
 * jsdom has no WebGL and neither do some locked-down or very old browsers, and MapLibre
 * throws rather than degrading. The map is a decoration over a list that works without it, so
 * this returns false and the caller renders the list alone — a missing map is a worse page,
 * a thrown error is no page.
 */
export function canRenderMap(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null
  } catch {
    return false
  }
}

export function PlacesMap({
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
  const map = useRef<MapLibreMap | null>(null)
  const markers = useRef<Map<string, Marker>>(new Map())
  const hereMarker = useRef<Marker | null>(null)
  const [ready, setReady] = useState(false)
  const [usable] = useState(canRenderMap)

  // Read inside map callbacks that outlive the render they were created in. A ref rather
  // than a dependency, so re-registering listeners on every keystroke is not required.
  const discover = useRef(onDiscover)
  discover.current = onDiscover
  const select = useRef(onSelect)
  select.current = onSelect

  const centre = useMemo<[number, number]>(() => {
    if (here !== null) return [here.lon, here.lat]
    const first = places[0]
    return first === undefined ? [8.5417, 47.3769] : [first.lon, first.lat]
  }, [here, places])

  /* ------------------------------------------------------------- the map */

  useEffect(() => {
    if (!usable || holder.current === null || map.current !== null) return
    const container = holder.current
    let live = true

    const start = (style: StyleSpecification): void => {
      const instance = new MapLibreMap({
        container,
        style,
        center: centre,
        zoom: 14,
        // Neither is what this map is for, and both make a small map on a phone feel broken
        // when a two-finger scroll tilts it by accident.
        pitchWithRotate: false,
        dragRotate: false,
        // Attribution is rendered below the map instead — see the credit line in the JSX.
        // MapLibre's own control draws a floating white box over the bottom of the map, which
        // is where the card for a tapped place goes, and its compact mode opens itself on
        // load anyway. Turning it off does not make the attribution optional: it is required
        // by OpenStreetMap's licence and asked for by OpenFreeMap, and it is owed regardless
        // — this map is other people's work, given away. It is simply shown somewhere it can
        // be read.
        attributionControl: false,
      })

      instance.on('load', () => {
        addFoodLayers(instance)
        setReady(true)
      })

      // Tapping the basemap's own restaurants. The query is limited to our own layer, so a
      // tap on a road or a park falls through and does nothing, rather than opening a card
      // about a bus stop.
      instance.on('click', event => {
        const hit = instance.queryRenderedFeatures(event.point, { layers: [POI_LAYER] })[0]
        if (hit === undefined) return
        const found = toDiscovered(hit)
        if (found !== null) discover.current?.(found)
      })

      // A pointer that does not change over a tappable thing is a tappable thing nobody
      // knows is tappable.
      instance.on('mouseenter', POI_LAYER, () => {
        instance.getCanvas().style.cursor = 'pointer'
      })
      instance.on('mouseleave', POI_LAYER, () => {
        instance.getCanvas().style.cursor = ''
      })

      // MapLibre measures its container once, at construction, and the container here is
      // still being laid out at that moment — the first render came out 265 px tall inside a
      // 390 px box, with the rest of the frame left as bare background. An observer is the
      // only reliable fix: `vh` units, the filter chips wrapping to a second row and an
      // on-screen keyboard opening all change this box after the map exists.
      const resize = new ResizeObserver(() => instance.resize())
      resize.observe(container)
      instance.once('remove', () => resize.disconnect())

      map.current = instance
    }

    // The style is fetched rather than handed to MapLibre as a URL, because the sprite field
    // has to be absolute before it will accept it — see `loadStyle`. That makes construction
    // async, and an async constructor needs a guard: the effect can be torn down while the
    // fetch is in flight, by a fast route change or by React's double-invoked development
    // effects. Building into an unmounted container leaks a WebGL context, and a browser
    // grants only a handful before it starts dropping the oldest.
    void loadStyle()
      .then(style => {
        if (live) start(style)
      })
      .catch(() => {
        // The style is a static same-origin asset; failing means offline on a cold cache.
        // The list below the map is unaffected, so this leaves an empty frame rather than
        // taking the page down.
      })

    return () => {
      live = false
      map.current?.remove()
      map.current = null
      setReady(false)
    }
    // Deliberately once: the map owns its own centre after mount, and re-creating it when
    // `centre` changes would throw away the view somebody had panned to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable])

  /* ---------------------------------------------------------- the corpus */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return

    const wanted = new Set(places.map(place => place.ID))
    for (const [id, marker] of markers.current) {
      if (!wanted.has(id)) {
        marker.remove()
        markers.current.delete(id)
      }
    }

    for (const place of places) {
      const element = pinElement(place, place.ID === selected)
      element.setAttribute('role', 'button')
      element.tabIndex = 0
      const open = (): void => select.current(place.ID)
      element.addEventListener('click', open)
      // A marker reachable by tab has to be operable by keyboard, or the tab stop is a trap
      // that leads nowhere.
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })

      const already = markers.current.get(place.ID)
      if (already !== undefined) already.remove()
      markers.current.set(
        place.ID,
        new Marker({ element, anchor: 'bottom' }).setLngLat([place.lon, place.lat]).addTo(instance),
      )
    }
  }, [places, selected, ready])

  /* -------------------------------------------------------------- "here" */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return
    hereMarker.current?.remove()
    hereMarker.current = null
    if (here === null) return

    const element = hereElement()
    hereMarker.current = new Marker({ element }).setLngLat([here.lon, here.lat]).addTo(instance)

    const halo = element.querySelector('.pin-here__halo')
    if (!(halo instanceof HTMLElement)) return

    const size = (): void => {
      // Below this the halo is smaller than the dot and says nothing; hide it rather than
      // draw a ring inside a ring.
      const radius = accuracy === null ? 0 : haloPixels(instance, here, accuracy)
      halo.style.setProperty('--halo', `${Math.round(radius * 2)}px`)
      halo.hidden = radius < 14
    }
    size()
    // The halo is a fixed number of metres, so it has to be re-measured whenever the scale
    // changes — otherwise it is right at the zoom it was drawn at and a lie at every other.
    instance.on('zoom', size)
    instance.on('move', size)
    return () => {
      instance.off('zoom', size)
      instance.off('move', size)
    }
  }, [here, accuracy, ready])

  /* ---------------------------------------------------------------- fit */

  useEffect(() => {
    const instance = map.current
    if (instance === null || !ready) return

    const points: Array<[number, number]> = places.map(place => [place.lon, place.lat])
    if (here !== null) points.push([here.lon, here.lat])
    if (points.length === 0) return
    if (points.length === 1) {
      instance.jumpTo({ center: points[0]!, zoom: 15 })
      return
    }
    const box = points.reduce(
      (bounds, point) => bounds.extend(point),
      new LngLatBounds(points[0]!, points[0]!),
    )
    // `maxZoom` matters more than it looks: three places on one street make a box a few
    // metres across, and an uncapped fit lands on a roof with no context around it.
    instance.fitBounds(box, { padding: 48, maxZoom: 16, animate: false })
  }, [places, here, ready])

  /*
   * The crosshair does two jobs, and which one depends on what we know.
   *
   * With a live fix it re-centres, because that is what somebody who has panned away wants.
   * With a stale or approximate one — a point restored from storage, rounded to a kilometre,
   * possibly from last week — re-centring on it would be centring confidently on the wrong
   * place. So it asks for a real fix instead, which is the only thing that can actually
   * answer "where am I".
   */
  const recentre = useCallback(() => {
    if (here === null || approximate) {
      onLocate?.()
      return
    }
    map.current?.easeTo({ center: [here.lon, here.lat], zoom: 15.5, duration: 600 })
  }, [here, approximate, onLocate])

  if (!usable) {
    // Not an error. The list under this is the whole feature; the map is how it is browsed.
    return (
      <div className="places-map places-map--none" role="note">
        <p>This browser cannot draw the map, so here is the list instead.</p>
      </div>
    )
  }

  return (
    <div className="places-map">
      <div className="places-map__canvas" ref={holder} data-testid="places-map" />
      <p className="places-map__credit">
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>
        {' · '}
        <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">
          OpenMapTiles
        </a>
        {' · data '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>
      </p>
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
 * One rendered basemap feature to something rateable.
 *
 * The `poi` layer carries no OSM id — only a name, a class and a position — so a place tapped
 * here reaches `rate` without one, and the corpus de-duplicates it by name and position
 * instead. That is a real limitation and it is written down rather than hidden: two households
 * tapping the same café agree because they are tapping the same point in the same tile.
 */
export function toDiscovered(feature: MapGeoJSONFeature): DiscoveredPlace | null {
  const properties = feature.properties ?? {}
  const name = typeof properties.name === 'string' ? properties.name.trim() : ''
  if (name.length === 0) return null
  if (feature.geometry.type !== 'Point') return null
  const [lon, lat] = feature.geometry.coordinates
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  const subclass = typeof properties.subclass === 'string' ? properties.subclass : ''
  return { name: name.slice(0, 200), kind: kindOfSubclass(subclass), lat, lon }
}

/**
 * The ring drawn for a place that merely exists.
 *
 * Generated rather than taken from the sprite: the basemap sprite has no icon meaning
 * "somewhere, unrated", and drawing it here means it is this app's shape rather than
 * OpenMapTiles'.
 *
 * **A ring and not a disc.** A filled dot at this size reads as a pin — the shape that means
 * "a rated place is here" — and the whole point of the third tier is that it claims nothing.
 *
 * **One colour, and a quiet one.** The first version coloured the ring by kind: orange for a
 * restaurant, brown for a café, pink for a bar. It looked deliberate and it was wrong. Those
 * are the loudest things on the map, and they mark the places nobody has rated — so the
 * screen shouted about the tier that carries no information and whispered about the tier that
 * does, which is the exact inversion of the hierarchy documented at the top of this file.
 *
 * Kind is on the card, one tap away, and in the filter chips. It does not need to be on a
 * 12-pixel ring.
 */
function ringImage(colour: string, dpr: number): ImageData | null {
  const size = Math.round(18 * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  const mid = size / 2
  const radius = size / 2 - 2.5 * dpr

  ctx.beginPath()
  ctx.arc(mid, mid, radius, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.lineWidth = 2 * dpr
  ctx.strokeStyle = colour
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

/** One ring, in the app's muted label colour. See {@link ringImage}. */
const RING_IMAGE = 'twm-ring'
const RING_COLOUR = '#6B8299'

/**
 * Our own layer for the food places, rather than tapping the basemap's.
 *
 * The style's own `poi_r*` layers start at zoom 15, are ranked so quiet streets show nothing,
 * and are drawn in the basemap's idiom rather than this app's. Owning the layer means they
 * are drawn as a ring that cannot be mistaken for a rating, and hit-testing is against one
 * layer we control instead of whatever the upstream style happens to call its layers.
 *
 * ## Why symbols and not circles
 *
 * The first version drew circles, and a city centre at zoom 14 came out as roughly two
 * hundred overlapping orange rings — a texture rather than a set of things you could tap.
 * Circle layers have no collision detection: every feature in the tile is drawn, however
 * many land on the same twenty pixels.
 *
 * Symbol layers do. With `icon-allow-overlap: false` MapLibre drops any symbol that would
 * collide with one already placed, so the map thins itself out as you zoom out and fills in
 * as you zoom in — which is what every map you have ever used does, and why they stay
 * legible. `symbol-sort-key` on `rank` makes that thinning deliberate rather than arbitrary:
 * when two restaurants compete for the same spot, the one OpenStreetMap considers more
 * prominent wins.
 */
function addFoodLayers(instance: MapLibreMap): void {
  if (instance.getLayer(POI_LAYER) !== undefined) return

  // The basemap's own POI labels go, and this is the rule they broke: **everything named on
  // this map must be tappable.** Liberty labels shops, clinics and hairdressers alongside
  // restaurants, and its labels compete with our rings for the same collision slots — so the
  // map came out with a dozen restaurant names, four rings, and no way to tell which of the
  // named things would respond to a tap. A name with nothing behind it is worse than no name.
  //
  // `poi_transit` stays. Stations and bus stops are how somebody decides whether a place is
  // reachable, they are not places to eat, and nobody expects to tap one.
  for (const id of ['poi_r1', 'poi_r7', 'poi_r20']) {
    if (instance.getLayer(id) !== undefined) instance.removeLayer(id)
  }

  const dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)))
  if (!instance.hasImage(RING_IMAGE)) {
    const image = ringImage(RING_COLOUR, dpr)
    if (image !== null) instance.addImage(RING_IMAGE, image, { pixelRatio: dpr })
  }

  // Annotated, because a bare array widens to `string[]` and the layer definitions below
  // then fail to typecheck against `FilterSpecification`.
  const isFood: FilterSpecification = [
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['match', ['get', 'subclass'], [...FOOD], true, false],
  ]

  instance.addLayer({
    id: POI_LAYER,
    type: 'symbol',
    source: SOURCE,
    'source-layer': 'poi',
    // Below this the map is about which neighbourhood, not which café, and two hundred rings
    // answer a question nobody asked.
    minzoom: 14,
    filter: isFood,
    layout: {
      'icon-image': RING_IMAGE,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.62, 17, 1],
      // The two settings that make this thin itself out instead of piling up.
      'icon-allow-overlap': false,
      'icon-ignore-placement': false,
      // Lower sorts first, and OSM's `rank` is smaller for more prominent places, so the
      // café everybody has heard of survives the collision.
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 50],
      // The tap target. A 12 px ring is a target only a mouse can hit, and this is a phone.
      'icon-padding': 6,
      // The name rides on the same symbol as the ring rather than in a layer of its own, so
      // the two can never be placed apart — a label surviving a collision its own ring lost
      // is exactly the "named but not tappable" state this layer exists to prevent.
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 12],
      'text-offset': [0, 1.05],
      'text-anchor': 'top',
      'text-max-width': 9,
      // The label may be dropped when it does not fit; the ring stays, so the place is still
      // tappable even where there is no room to name it.
      'text-optional': true,
    },
    paint: {
      'text-color': '#40566b',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.3,
    },
  })
}

export default PlacesMap
