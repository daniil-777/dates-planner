/**
 * Geohashing, so "near me" is an index range scan — CONTRACTS.md §14.4.
 *
 * ## Why not PostGIS, and why not a bounding box on lat/lon
 *
 * The store today is SQLite on a volume and will be Postgres later (ADR-002), so anything
 * that needs an extension is out. A plain `WHERE lat BETWEEN … AND lon BETWEEN …` is the
 * obvious alternative and it is a trap: no single B-tree index serves two independent range
 * predicates, so one of them is a scan, and the plan degrades exactly as the corpus grows.
 *
 * A geohash turns two ranges into one **prefix**, and a prefix is an equality on a string
 * column, which every engine indexes well. Six characters is a cell of roughly 1.2 × 0.6 km,
 * so "near me" is `geohash6 IN (<the cell and its eight neighbours>)` — nine equalities, one
 * index, and the same query on SQLite today and on Postgres later with no rewrite.
 *
 * The nine cells cover 3.6 × 1.8 km, which over-selects at the corners; callers filter the
 * page they got back by true distance. That order is deliberate — cheap index work first,
 * exact arithmetic on the few rows that survive.
 */

/** Base-32 as geohash spells it: no `a`, `i`, `l` or `o`. */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/** Cell length used everywhere in the commons. Roughly 1.2 km across at the equator. */
export const GEOHASH_PRECISION = 6

/**
 * Encodes a point.
 *
 * The standard interleave: bisect longitude and latitude alternately, one bit at a time,
 * five bits to a character. Out-of-range input is clamped rather than rejected — a bad
 * coordinate should put a place in the wrong cell, not throw inside a write handler.
 */
export function geohash(lat: number, lon: number, precision: number = GEOHASH_PRECISION): string {
  let latMin = -90
  let latMax = 90
  let lonMin = -180
  let lonMax = 180
  const clampedLat = Math.min(90, Math.max(-90, Number.isFinite(lat) ? lat : 0))
  const clampedLon = Math.min(180, Math.max(-180, Number.isFinite(lon) ? lon : 0))

  let hash = ''
  let bits = 0
  let bit = 0
  let even = true

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2
      if (clampedLon >= mid) {
        bits = (bits << 1) + 1
        lonMin = mid
      } else {
        bits <<= 1
        lonMax = mid
      }
    } else {
      const mid = (latMin + latMax) / 2
      if (clampedLat >= mid) {
        bits = (bits << 1) + 1
        latMin = mid
      } else {
        bits <<= 1
        latMax = mid
      }
    }
    even = !even
    bit += 1
    if (bit === 5) {
      hash += BASE32[bits]
      bits = 0
      bit = 0
    }
  }
  return hash
}

export interface Bounds {
  readonly latMin: number
  readonly latMax: number
  readonly lonMin: number
  readonly lonMax: number
}

/** The box a hash covers. */
export function bounds(hash: string): Bounds {
  let latMin = -90
  let latMax = 90
  let lonMin = -180
  let lonMax = 180
  let even = true

  for (const character of hash) {
    const value = BASE32.indexOf(character)
    if (value < 0) break
    for (let mask = 16; mask >= 1; mask >>= 1) {
      if (even) {
        const mid = (lonMin + lonMax) / 2
        if ((value & mask) !== 0) lonMin = mid
        else lonMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if ((value & mask) !== 0) latMin = mid
        else latMax = mid
      }
      even = !even
    }
  }
  return { latMin, latMax, lonMin, lonMax }
}

/**
 * The cell containing a point and the eight around it.
 *
 * Derived by stepping a whole cell in each direction from the centre and re-encoding, rather
 * than by the usual border-and-neighbour lookup tables. It is the same answer with a tenth
 * of the code and no table to get wrong, it needs no special case at the poles — stepping
 * off the top of the map clamps back into the same cell, which then dedupes away — and
 * longitude wraps explicitly at the antimeridian.
 *
 * Always returns the centre cell first, and never a duplicate.
 */
export function neighbours(
  lat: number,
  lon: number,
  precision: number = GEOHASH_PRECISION,
): string[] {
  const centre = geohash(lat, lon, precision)
  const box = bounds(centre)
  const latStep = box.latMax - box.latMin
  const lonStep = box.lonMax - box.lonMin
  const latMid = (box.latMin + box.latMax) / 2
  const lonMid = (box.lonMin + box.lonMax) / 2

  const cells = new Set<string>([centre])
  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      if (dLat === 0 && dLon === 0) continue
      const nextLat = latMid + dLat * latStep
      let nextLon = lonMid + dLon * lonStep
      if (nextLon > 180) nextLon -= 360
      if (nextLon < -180) nextLon += 360
      cells.add(geohash(nextLat, nextLon, precision))
    }
  }
  return [centre, ...[...cells].filter(cell => cell !== centre)]
}

const EARTH_RADIUS_M = 6_371_008.8

/**
 * Great-circle distance in metres.
 *
 * Haversine, which is accurate to a few metres over the few kilometres this is ever asked
 * about, and cheap enough to run over a page of rows that the index already narrowed.
 */
export function distanceMetres(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRadians = Math.PI / 180
  const dLat = (bLat - aLat) * toRadians
  const dLon = (bLon - aLon) * toRadians
  const lat1 = aLat * toRadians
  const lat2 = bLat * toRadians
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Links out to the two map apps — ADR-003 §2.
 *
 * Neither needs an API key, a billing account or a contract, and both fall back to a web map
 * on a platform without the app installed. They are the whole of this app's integration with
 * Google and Apple: **destinations, not stores.** Nothing can be written back to either —
 * Google's Business Profile API forbids creating reviews outright, as an anti-spam measure,
 * and Apple has no third-party review API at all — so the ratings live here and the maps get
 * the directions.
 */
export function mapLinks(
  lat: number,
  lon: number,
  name: string,
): { google: string; apple: string } {
  const at = `${lat.toFixed(6)},${lon.toFixed(6)}`
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(at)}`,
    apple: `https://maps.apple.com/?ll=${encodeURIComponent(at)}&q=${encodeURIComponent(name)}`,
  }
}
