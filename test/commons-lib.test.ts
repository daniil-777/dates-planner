/**
 * The pure half of the commons — ranking, geohashing, author keys and the vocabulary.
 *
 * These four modules hold every decision in ADR-003 that can be checked without a database,
 * which is most of the ones that matter: the ranking is what makes the corpus useful, the
 * geohash is what makes it fast, the author key is what keeps it anonymous, and the
 * vocabulary is the contract three layers share.
 */
import { describe, expect, it } from 'vitest'

import { authorKey, requireAuthorSecret, sameAuthor } from '../srv/lib/commons/author'
import { bounds, distanceMetres, geohash, mapLinks, neighbours } from '../srv/lib/commons/geo'
import {
  DEFAULT_GLOBAL_MEAN,
  EMPTY_HISTOGRAM,
  PRIOR_WEIGHT,
  applyStar,
  bayesianScore,
  isPublishable,
  mean,
  ratingsUntilPublishable,
  totals,
} from '../srv/lib/commons/ranking'
import {
  ANONYMITY_THRESHOLD,
  COST_BANDS,
  COST_RANGE,
  PLACE_TAGS,
  costBandOf,
  isCostBand,
  isPlaceKind,
  isPlaceTag,
} from '../srv/lib/commons/vocabulary'

describe('the ranking', () => {
  it('shows the plain mean but never orders by it', () => {
    // The case the whole design exists for: one enthusiast against a settled favourite.
    const newcomer = { sum: 5, count: 1 }
    const favourite = { sum: 184, count: 40 } // mean 4.6

    expect(mean(newcomer.sum, newcomer.count)).toBe(5)
    expect(mean(favourite.sum, favourite.count)).toBe(4.6)

    // …and the ordering is the other way round, which is the point.
    expect(bayesianScore(newcomer.sum, newcomer.count)).toBeLessThan(
      bayesianScore(favourite.sum, favourite.count),
    )
  })

  it('needs real evidence to move a place off the global mean', () => {
    // At the anonymity threshold the prior still does most of the work…
    const atThreshold = bayesianScore(15, 3) // three fives
    expect(atThreshold).toBeLessThan(4.5)
    expect(atThreshold).toBeGreaterThan(DEFAULT_GLOBAL_MEAN)

    // …and by forty ratings it barely does any.
    expect(bayesianScore(200, 40)).toBeGreaterThan(4.8)
  })

  it('is exactly the weighted formula, not something that merely behaves like it', () => {
    const sum = 47
    const count = 11
    const globalMean = 4.1
    const expected = (sum + PRIOR_WEIGHT * globalMean) / (count + PRIOR_WEIGHT)
    expect(bayesianScore(sum, count, globalMean)).toBeCloseTo(expected, 4)
  })

  it('answers for a place nobody has rated rather than returning NaN', () => {
    expect(mean(0, 0)).toBe(0)
    expect(bayesianScore(0, 0)).toBeCloseTo(DEFAULT_GLOBAL_MEAN, 4)
    expect(totals(EMPTY_HISTOGRAM)).toEqual({ count: 0, sum: 0 })
  })

  it('rounds to four places so two tied rows tie identically on every engine', () => {
    const score = bayesianScore(37, 9, 3.9137)
    expect(score).toBe(Math.round(score * 10000) / 10000)
  })

  it('keeps the histogram and the totals in step through a rating and its withdrawal', () => {
    let histogram = EMPTY_HISTOGRAM
    for (const stars of [5, 4, 4, 2]) histogram = applyStar(histogram, stars, 1)
    expect(totals(histogram)).toEqual({ count: 4, sum: 15 })
    expect(histogram.s4).toBe(2)

    histogram = applyStar(histogram, 2, -1)
    expect(totals(histogram)).toEqual({ count: 3, sum: 13 })
    expect(histogram.s2).toBe(0)
  })

  it('never lets a withdrawal drive a bucket negative', () => {
    const histogram = applyStar(EMPTY_HISTOGRAM, 3, -1)
    expect(histogram.s3).toBe(0)
    expect(totals(histogram).count).toBe(0)
  })
})

describe('the anonymity threshold', () => {
  it('hides a place until three households have rated it', () => {
    expect(isPublishable(0)).toBe(false)
    expect(isPublishable(ANONYMITY_THRESHOLD - 1)).toBe(false)
    expect(isPublishable(ANONYMITY_THRESHOLD)).toBe(true)
  })

  it('says how many more are needed, and stops counting once it is enough', () => {
    expect(ratingsUntilPublishable(0)).toBe(ANONYMITY_THRESHOLD)
    expect(ratingsUntilPublishable(ANONYMITY_THRESHOLD)).toBe(0)
    expect(ratingsUntilPublishable(99)).toBe(0)
  })
})

describe('the vocabulary', () => {
  it('says nothing about who was there', () => {
    // ADR-002 §6 and ADR-003 §5: the commons must not reintroduce group composition. This
    // fails loudly if anybody ever adds a tag describing the household rather than the place.
    const forbidden = /couple|gay|straight|lesbian|man|woman|male|female|gender|orientation/i
    for (const tag of PLACE_TAGS) expect(tag, `tag "${tag}" describes people`).not.toMatch(forbidden)
  })

  it('narrows unknown codes rather than trusting the wire', () => {
    expect(isPlaceTag('quiet')).toBe(true)
    expect(isPlaceTag('Quiet')).toBe(false)
    expect(isPlaceTag('romantic_for_couples')).toBe(false)
    expect(isCostBand('c15_30')).toBe(true)
    expect(isCostBand('cheap')).toBe(false)
    expect(isPlaceKind('restaurant')).toBe(true)
    expect(isPlaceKind('nightclub')).toBe(false)
  })

  it('has cost bands that tile the whole range with no gap and no overlap', () => {
    let previous = 0
    for (const band of COST_BANDS) {
      const { from, to } = COST_RANGE[band]
      expect(from, `${band} starts where the last band ended`).toBe(previous)
      previous = to ?? Infinity
    }
    expect(previous).toBe(Infinity)
  })

  it('puts a real amount in the band a person would put it in', () => {
    expect(costBandOf(0)).toBe('free')
    expect(costBandOf(12)).toBe('under_15')
    expect(costBandOf(15)).toBe('c15_30')
    expect(costBandOf(29.99)).toBe('c15_30')
    expect(costBandOf(30)).toBe('c30_60')
    expect(costBandOf(450)).toBe('over_120')
    expect(costBandOf(Number.NaN)).toBe('free')
  })
})

describe('geohashing', () => {
  it('encodes the reference point every geohash implementation agrees on', () => {
    // (57.64911, 10.40744) -> u4pruydqqvj, the worked example from the original spec.
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
  })

  it('puts a point inside the box its own hash describes', () => {
    const lat = 47.3769
    const lon = 8.5417 // Zürich
    const box = bounds(geohash(lat, lon))
    expect(lat).toBeGreaterThanOrEqual(box.latMin)
    expect(lat).toBeLessThanOrEqual(box.latMax)
    expect(lon).toBeGreaterThanOrEqual(box.lonMin)
    expect(lon).toBeLessThanOrEqual(box.lonMax)
  })

  it('cells are about a kilometre across, which is what "near me" assumes', () => {
    const box = bounds(geohash(47.3769, 8.5417))
    const width = distanceMetres(box.latMin, box.lonMin, box.latMin, box.lonMax)
    const height = distanceMetres(box.latMin, box.lonMin, box.latMax, box.lonMin)
    expect(width).toBeGreaterThan(600)
    expect(width).toBeLessThan(1600)
    expect(height).toBeGreaterThan(400)
    expect(height).toBeLessThan(900)
  })

  it('returns nine distinct cells with the middle one first', () => {
    const cells = neighbours(47.3769, 8.5417)
    expect(cells).toHaveLength(9)
    expect(new Set(cells).size).toBe(9)
    expect(cells[0]).toBe(geohash(47.3769, 8.5417))
  })

  it('covers a point just over the edge of the middle cell', () => {
    // The reason the nine-cell query exists at all: a place 200 m away can be in a different
    // cell, and a single-cell lookup would silently never find it.
    const lat = 47.3769
    const lon = 8.5417
    const box = bounds(geohash(lat, lon))
    const justOutside = geohash(box.latMax + 1e-6, lon)
    expect(justOutside).not.toBe(geohash(lat, lon))
    expect(neighbours(lat, lon)).toContain(justOutside)
  })

  it('wraps at the antimeridian instead of producing garbage', () => {
    const cells = neighbours(0, 179.999)
    expect(cells).toHaveLength(9)
    for (const cell of cells) expect(cell).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/)
  })

  it('does not fall over at the pole', () => {
    const cells = neighbours(90, 0)
    expect(cells.length).toBeGreaterThan(0)
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('measures a distance a map would agree with', () => {
    // Zürich HB to Bern HB, about 95 km.
    const metres = distanceMetres(47.3779, 8.5403, 46.9489, 7.4396)
    expect(metres).toBeGreaterThan(93_000)
    expect(metres).toBeLessThan(97_000)
  })
})

describe('the map links', () => {
  it('builds keyless universal links for both map apps', () => {
    const links = mapLinks(47.3769, 8.5417, "Kafi Dihei & Co")
    expect(links.google).toBe(
      'https://www.google.com/maps/search/?api=1&query=47.376900%2C8.541700',
    )
    expect(links.apple).toContain('https://maps.apple.com/?ll=47.376900%2C8.541700')
    // The name is a place's name, not a URL fragment, and has to survive being one.
    expect(links.apple).toContain('Kafi%20Dihei%20%26%20Co')
    for (const url of Object.values(links)) expect(url).not.toMatch(/key=|apikey|token/i)
  })
})

describe('the author key', () => {
  const env = { COMMONS_AUTHOR_SECRET: 'a'.repeat(64) } as NodeJS.ProcessEnv
  const group = 'g0000000-0000-4000-8000-000000000001'

  it('is stable for a group, so uniqueness and withdrawal survive a restart', () => {
    expect(authorKey(group, env)).toBe(authorKey(group, env))
  })

  it('differs between groups', () => {
    expect(authorKey(group, env)).not.toBe(authorKey('g0000000-0000-4000-8000-000000000002', env))
  })

  it('differs between deployments, so two installations cannot compare notes', () => {
    const other = { COMMONS_AUTHOR_SECRET: 'b'.repeat(64) } as NodeJS.ProcessEnv
    expect(authorKey(group, env)).not.toBe(authorKey(group, other))
  })

  it('does not contain the group id it was made from', () => {
    const key = authorKey(group, env)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain(group)
    expect(key).not.toContain(group.slice(0, 8))
  })

  it('compares without leaking a timing signal, and still says no to a mismatch', () => {
    const key = authorKey(group, env)
    expect(sameAuthor(key, key)).toBe(true)
    expect(sameAuthor(key, authorKey('other', env))).toBe(false)
    expect(sameAuthor(key, key.slice(0, 10))).toBe(false)
  })

  it('refuses to run in production without a secret of its own', () => {
    expect(() =>
      requireAuthorSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/COMMONS_AUTHOR_SECRET/)
    expect(() =>
      requireAuthorSecret({ NODE_ENV: 'production', COMMONS_AUTHOR_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/32 characters/)
    expect(() => requireAuthorSecret({ NODE_ENV: 'production', ...env })).not.toThrow()
  })

  it('still works with an empty .env, because the app has to', () => {
    expect(() => requireAuthorSecret({} as NodeJS.ProcessEnv)).not.toThrow()
    expect(authorKey(group, {} as NodeJS.ProcessEnv)).toMatch(/^[0-9a-f]{64}$/)
  })
})
