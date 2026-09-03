/**
 * Finding a place to rate — CONTRACTS.md §14.7.
 *
 * ## Why this moved to the server
 *
 * It used to live in `app/src/pages/memories/geocode.ts`, in the browser, and it was correct
 * there: a 1.1 s slot queue, a cache, a debounce, all honouring Nominatim's usage policy. It
 * is wrong there now, for one reason that has nothing to do with correctness — **a queue in a
 * browser tab is a queue per tab.** One household with a phone and a laptop open is two
 * queues; a hundred households is a hundred, and the policy Nominatim asks for is one request
 * a second from an *application*, not from a page.
 *
 * So the queue moves to the one place there is only one of. That also makes the eventual
 * cutover — Nominatim's public instance is explicitly not for heavy use, and a commons with
 * real traffic is heavy use — a change to this file and nothing else. Self-hosted Nominatim,
 * Photon and Pelias all speak close enough to the same shape.
 *
 * ## The policy, honoured rather than described
 *
 * - **At most one request per second**, process-wide, through {@link claimSlot}.
 * - **A real `User-Agent`** naming the application and a way to reach its author. Nominatim
 *   blocks anonymous traffic and is entitled to.
 * - **Cache what comes back.** Ten minutes in memory here, and the browser is told to cache
 *   too — a household typing a restaurant name generates one lookup, not one per keystroke.
 * - **No bulk querying.** There is no endpoint here that takes a list.
 *
 * Nothing about a household reaches Nominatim: a search carries a string somebody typed and a
 * viewport, and no cookie, no session and no id. The commons never tells anybody who is
 * looking.
 */

/** Nominatim asks for one request a second. This is that second, plus a little. */
const MIN_INTERVAL_MS = 1_100

/** How long a search is remembered. Places move very slowly. */
const CACHE_TTL_MS = 10 * 60 * 1000

/** Enough to serve a session; small enough to be forgettable. Oldest out first. */
const CACHE_MAX = 300

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/**
 * Nominatim requires a `User-Agent` that identifies the application, and blocks traffic that
 * does not have one. `COMMONS_CONTACT` should be an address somebody reads; without it this
 * still names the app, which is the part the policy is actually about.
 */
function userAgent(env: NodeJS.ProcessEnv = process.env): string {
  const contact = env.COMMONS_CONTACT?.trim()
  return `TwoWayMatch/1.0 (${contact !== undefined && contact.length > 0 ? contact : 'https://github.com/daniil-777/dates-planner'})`
}

export interface PlaceCandidate {
  name: string
  /** The full address line, for telling two identically named cafés apart. */
  label: string
  lat: number
  lon: number
  city: string | null
  country: string | null
  kind: string
  osmType: string | null
  osmId: string | null
}

/**
 * OpenStreetMap's classification, reduced to the eight kinds this app has.
 *
 * Deliberately coarse. OSM distinguishes a `bar` from a `pub` from a `biergarten`, and a
 * household deciding where to go this evening does not — every extra kind is another filter
 * chip nobody presses. Anything unrecognised becomes `other` rather than being dropped: a
 * place somebody wants to rate is a place, whatever OSM calls it.
 */
export function kindOf(category: string | undefined, type: string | undefined): string {
  const key = `${category ?? ''}/${type ?? ''}`
  if (/\/(restaurant|fast_food|food_court|ice_cream)$/.test(key)) return 'restaurant'
  if (/\/(cafe|coffee)$/.test(key)) return 'cafe'
  if (/\/(bar|pub|biergarten|nightclub|wine_bar)$/.test(key)) return 'bar'
  if (
    category === 'tourism' &&
    /museum|gallery|artwork|attraction|viewpoint|zoo|aquarium/.test(type ?? '')
  ) {
    return 'culture'
  }
  if (category === 'leisure' || /\/(park|garden|beach|nature_reserve|peak|water)$/.test(key)) {
    return 'outdoors'
  }
  if (category === 'amenity' && /theatre|cinema|arts_centre|library|casino/.test(type ?? '')) {
    return 'culture'
  }
  if (category === 'shop') return 'shop'
  if (category === 'amenity' || category === 'sport') return 'activity'
  return 'other'
}

interface NominatimRow {
  display_name?: unknown
  name?: unknown
  lat?: unknown
  lon?: unknown
  category?: unknown
  class?: unknown
  type?: unknown
  osm_type?: unknown
  osm_id?: unknown
  address?: Record<string, unknown>
}

export function toCandidate(row: NominatimRow): PlaceCandidate | null {
  const lat = Number(row.lat)
  const lon = Number(row.lon)
  const label = typeof row.display_name === 'string' ? row.display_name : ''
  if (label.length === 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

  // Nominatim's `name` is the place itself; `display_name` is the whole address. Both are
  // wanted — one for the card, one for telling two identically named cafés apart — and when
  // there is no name, the first line of the address is the best available stand-in.
  const named = typeof row.name === 'string' && row.name.length > 0 ? row.name : null
  const address = row.address ?? {}
  const city = ['city', 'town', 'village', 'municipality', 'suburb']
    .map(key => address[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const country =
    typeof address.country_code === 'string' ? address.country_code.toUpperCase() : null

  return {
    name: (named ?? label.split(',')[0] ?? label).slice(0, 200),
    label,
    lat,
    lon,
    city: city ?? null,
    country,
    kind: kindOf(
      typeof row.category === 'string'
        ? row.category
        : typeof row.class === 'string'
          ? row.class
          : undefined,
      typeof row.type === 'string' ? row.type : undefined,
    ),
    osmType: typeof row.osm_type === 'string' ? row.osm_type : null,
    osmId: row.osm_id === undefined || row.osm_id === null ? null : String(row.osm_id),
  }
}

/* ------------------------------------------------------------------- queue */

/** Serialises every outbound request onto slots, process-wide. */
let nextSlot = 0

function claimSlot(): Promise<void> {
  const now = Date.now()
  const startAt = Math.max(now, nextSlot)
  nextSlot = startAt + MIN_INTERVAL_MS
  const wait = startAt - now
  return wait <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, wait))
}

/* ------------------------------------------------------------------- cache */

interface CacheEntry {
  at: number
  results: PlaceCandidate[]
}

const cache = new Map<string, CacheEntry>()

export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function cacheKey(query: string, lat: number | null, lon: number | null): string {
  // Rounded to about a kilometre: two searches from the same neighbourhood are the same
  // search, and caching them separately would triple the traffic for no better answer.
  const near = lat === null || lon === null ? '' : `@${lat.toFixed(2)},${lon.toFixed(2)}`
  return `${normaliseQuery(query)}${near}`
}

function remember(key: string, results: PlaceCandidate[]): void {
  cache.set(key, { at: Date.now(), results })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/** Only the tests need this. */
export function clearPlaceCache(): void {
  cache.clear()
  nextSlot = 0
}

/* ------------------------------------------------------------------ search */

export interface SearchOptions {
  /** Bias results toward here, when the caller knows where "here" is. */
  lat?: number | null
  lon?: number | null
  limit?: number
  /** Injected by the tests. */
  fetchImpl?: typeof fetch
}

/**
 * Look up somewhere by name.
 *
 * Returns `[]` for a query too short to be meaningful and for any upstream failure. A place
 * search that throws would take down the sheet somebody is typing into, and the fallback —
 * type the name yourself, drop a pin — is a perfectly good way to add a place. Nominatim
 * being slow or cross is not a reason to stop somebody rating a restaurant.
 */
export async function searchPlaces(
  query: string,
  options: SearchOptions = {},
): Promise<PlaceCandidate[]> {
  const text = normaliseQuery(query)
  if (text.length < 3) return []

  const lat = options.lat ?? null
  const lon = options.lon ?? null
  const key = cacheKey(query, lat, lon)
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.results

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', text)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', String(Math.min(10, Math.max(1, options.limit ?? 8))))
  if (lat !== null && lon !== null) {
    // A 0.4° box, roughly 40 km, as a *bias* rather than a filter: somewhere just outside it
    // still appears, lower down, which is what somebody searching for a restaurant they
    // remember from a trip actually wants.
    url.searchParams.set('viewbox', `${lon - 0.2},${lat - 0.2},${lon + 0.2},${lat + 0.2}`)
  }

  const call = options.fetchImpl ?? fetch
  try {
    await claimSlot()
    const response = await call(url, {
      headers: { 'user-agent': userAgent(), accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (!Array.isArray(body)) return []
    const results = body
      .map(row => toCandidate(row as NominatimRow))
      .filter((row): row is PlaceCandidate => row !== null)
    remember(key, results)
    return results
  } catch {
    // Timeout, network, or malformed JSON. An empty list is a usable answer; an exception
    // here would be an error banner over a text field somebody is still typing into.
    return []
  }
}
