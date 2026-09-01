/**
 * Place lookup through Nominatim.
 *
 * Nominatim is a free service run on donated hardware, and its usage policy is
 * strict: at most one request per second, no bulk querying, cache what you get
 * back. This module is the only place the app talks to it, and it enforces all
 * three — a process-wide 1.1 s slot queue, a localStorage cache with a TTL, and
 * a hard debounce in the hook below. Nothing here is ever allowed to block a
 * save: geocoding is a convenience on top of a free-text place name, and a
 * memory with a place but no pin is still a memory.
 */

import { useEffect, useState } from 'react'

export interface GeocodeResult {
  label: string
  lat: number
  lon: number
}

export type GeocodeStatus =
  'idle' | 'typing' | 'searching' | 'ready' | 'empty' | 'error' | 'unavailable'

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const MIN_INTERVAL_MS = 1_100
const CACHE_KEY = 'twm.geocode.v1'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 80
const DEBOUNCE_MS = 900
const MIN_QUERY_LENGTH = 3

interface CacheEntry {
  at: number
  results: GeocodeResult[]
}

type CacheShape = Record<string, CacheEntry>

export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function readCache(): CacheShape {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CacheShape
  } catch {
    // Private mode, quota, or a corrupted value. A cache miss is harmless.
    return {}
  }
}

function writeCache(cache: CacheShape): void {
  try {
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at)
    const trimmed = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES))
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed))
  } catch {
    // Nothing to do — the cache is an optimisation, not state we own.
  }
}

export function cachedGeocode(query: string): GeocodeResult[] | null {
  const key = normaliseQuery(query)
  if (!key) return null
  const entry = readCache()[key]
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) return null
  return entry.results
}

function cacheGeocode(query: string, results: GeocodeResult[]): void {
  const key = normaliseQuery(query)
  if (!key) return
  const cache = readCache()
  cache[key] = { at: Date.now(), results }
  writeCache(cache)
}

/** Serialises every outbound request onto 1.1 s slots, process-wide. */
let nextSlot = 0

function claimSlot(): Promise<void> {
  const now = Date.now()
  const startAt = Math.max(now, nextSlot)
  nextSlot = startAt + MIN_INTERVAL_MS
  const wait = startAt - now
  return wait <= 0 ? Promise.resolve() : new Promise(resolve => window.setTimeout(resolve, wait))
}

interface NominatimRow {
  display_name?: unknown
  lat?: unknown
  lon?: unknown
}

function toResult(row: NominatimRow): GeocodeResult | null {
  const lat = Number(row.lat)
  const lon = Number(row.lon)
  const label = typeof row.display_name === 'string' ? row.display_name : ''
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { label, lat, lon }
}

/**
 * One lookup. Returns cached results immediately when there are any, otherwise
 * queues a request. Throws only on a genuine transport/parse failure so the
 * caller can offer manual coordinates instead.
 */
export async function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const key = normaliseQuery(query)
  if (key.length < MIN_QUERY_LENGTH) return []

  const cached = cachedGeocode(key)
  if (cached) return cached

  await claimSlot()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const url = `${ENDPOINT}?format=json&limit=5&addressdetails=0&q=${encodeURIComponent(key)}`
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`)

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new Error('Nominatim returned an unexpected payload')

  const results = payload
    .map(row => toResult(row as NominatimRow))
    .filter((row): row is GeocodeResult => row !== null)

  cacheGeocode(key, results)
  return results
}

export interface GeocodeSuggestions {
  results: GeocodeResult[]
  status: GeocodeStatus
}

/**
 * Debounced suggestions for the place field. `enabled` is what keeps the app
 * from querying a shared public service on every keystroke of a form the user
 * has not even focused into the place field yet.
 */
export function useGeocodeSuggestions(query: string, enabled: boolean): GeocodeSuggestions {
  const [state, setState] = useState<GeocodeSuggestions>({ results: [], status: 'idle' })

  useEffect(() => {
    const key = normaliseQuery(query)
    if (!enabled || key.length < MIN_QUERY_LENGTH) {
      setState({ results: [], status: 'idle' })
      return
    }

    const cached = cachedGeocode(key)
    if (cached) {
      setState({ results: cached, status: cached.length > 0 ? 'ready' : 'empty' })
      return
    }

    if (typeof fetch !== 'function') {
      setState({ results: [], status: 'unavailable' })
      return
    }

    setState(previous => ({ results: previous.results, status: 'typing' }))

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setState(previous => ({ results: previous.results, status: 'searching' }))
      geocode(key, controller.signal)
        .then(results => {
          if (controller.signal.aborted) return
          setState({ results, status: results.length > 0 ? 'ready' : 'empty' })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          if (error instanceof DOMException && error.name === 'AbortError') return
          setState({ results: [], status: 'error' })
        })
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, enabled])

  return state
}
