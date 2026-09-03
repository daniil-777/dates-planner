/// <reference types="@cap-js/cds-types" />
/**
 * CommonsService handlers — TWM-ADR-003, CONTRACTS.md §14.
 *
 * The same rule as `ledger-service.ts`: arithmetic lives in `srv/lib`, not here. Ranking is
 * `lib/commons/ranking`, geography is `lib/commons/geo`, the deal is `lib/commons/evening`,
 * the words are `lib/commons/vocabulary` and identity is `lib/commons/author`. What is left
 * in this file is transactions, validation, and turning a library answer into a response.
 *
 * Four things in here are load-bearing and are easy to undo by accident.
 *
 * 1. **`authorKey` never crosses the wire.** It is derived from the caller's session inside
 *    a handler and used only to find their own row. No response contains it and no request
 *    is trusted to supply it. If a future handler needs "whose rating is this", it derives
 *    the key again — it never accepts one.
 *
 * 2. **`PlaceRatings` is never read for display.** Every read below goes to `PlaceStats`,
 *    which has no author in it, except `placeDetail`'s tips — which are read with a
 *    `tipHidden = false` filter, above the anonymity threshold, projected to text and tags
 *    and nothing else.
 *
 * 3. **The threshold is checked on the way out, not on the way in.** A place with two
 *    ratings has real rows and a real score; what it does not have is permission to be
 *    *shown*. Filtering at write time would mean a place could never accumulate the third
 *    rating that publishes it.
 *
 * 4. **Stats are updated incrementally, in the request's transaction.** The histogram in
 *    `PlaceStats` is the source of truth for the score; `PlaceRatings` is the source of
 *    truth for who has rated. `recomputeStats` reconciles the two and exists because an
 *    incremental counter that nothing can rebuild is a counter that will one day be wrong
 *    with no way back.
 */
import cds from '@sap/cds'
import type { Request } from '@sap/cds'

import { authorKey, requireAuthorSecret } from './lib/commons/author'
import { dealEvenings, type DealtIdea, type DealtPlace } from './lib/commons/evening'
import { distanceMetres, geohash, mapLinks, neighbours } from './lib/commons/geo'
import {
  applyStar,
  bayesianScore,
  isPublishable,
  mean,
  ratingsUntilPublishable,
  totals,
  type Histogram,
} from './lib/commons/ranking'
import {
  EATING_KINDS,
  MAX_TAGS_PER_RATING,
  MAX_TIP_LENGTH,
  isCostBand,
  isPlaceKind,
  isPlaceTag,
  type CostBand,
  type PlaceKind,
} from './lib/commons/vocabulary'
import { readSessionToken, verifySessionToken } from './lib/auth'

const { DELETE, SELECT, INSERT, UPDATE } = cds.ql

const PLACES = 'twowaymatch.Places'
const RATINGS = 'twowaymatch.PlaceRatings'
const RATING_TAGS = 'twowaymatch.PlaceRatingTags'
const STATS = 'twowaymatch.PlaceStats'
const TAG_COUNTS = 'twowaymatch.PlaceTagCounts'
const IDEAS = 'twowaymatch.Ideas'
const GROUPS = 'twowaymatch.Groups'
const MEMBERSHIPS = 'twowaymatch.Memberships'

/** Default and largest page a caller may ask for. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 60

/** Default and largest radius. Beyond ten kilometres it is not "near me", it is a search. */
const DEFAULT_RADIUS_M = 3_000
const MAX_RADIUS_M = 30_000

/** How deep the deal reaches into the ranking before sampling from it. */
const DEAL_POOL = 40

/** Kinds a card treats as "something to do". */
const DOING_KINDS: readonly PlaceKind[] = ['activity', 'outdoors', 'culture']

/* ------------------------------------------------------------------- rows */

interface PlaceRow {
  ID: string
  name: string
  kind?: string | null
  lat: number
  lon: number
  city?: string | null
  geohash6?: string | null
}

interface StatsRow {
  ID: string
  place_ID: string
  ratings: number
  starSum: number
  s1: number
  s2: number
  s3: number
  s4: number
  s5: number
  mean: number
  score: number
  tips: number
  costBand?: string | null
  geohash6?: string | null
  kind?: string | null
}

interface Card {
  ID: string
  name: string
  kind: string
  lat: number
  lon: number
  city: string | null
  distance: number | null
  stars: number | null
  households: number
  published: boolean
  needs: number
  costBand: string | null
  tags: string[]
  googleUrl: string
  appleUrl: string
}

export default class CommonsService extends cds.ApplicationService {
  /**
   * Handlers are named `onX`, never `x`.
   *
   * CAP puts a convenience caller for every operation on the service *instance* — `srv.rate
   * (data)` sends a `rate` request — and an own property shadows a prototype method. A
   * private method called `rate` is therefore invisible from inside the class, and
   * `this.rate(req)` quietly re-dispatches the request with the request object as its
   * payload instead of running the handler. It fails as `req.data` being undefined two
   * frames away from the cause, so: the prefix is not decoration.
   */
  override async init(): Promise<void> {
    requireAuthorSecret()

    this.on('nearby', req => this.onNearby(req))
    this.on('placeDetail', req => this.onPlaceDetail(req))
    this.on('tonight', req => this.onTonight(req))
    this.on('deck', req => this.onDeck(req))
    this.on('rate', req => this.onRate(req))
    this.on('withdrawRating', req => this.onWithdrawRating(req))
    this.on('reportTip', req => this.onReportTip(req))

    await super.init()
  }

  /* --------------------------------------------------------------- identity */

  /**
   * The opaque author key of the household making this request.
   *
   * Resolution order mirrors `LedgerService.scope`, minus its last step: the session's own
   * claim, then a sole membership, then the group flagged as the default.
   *
   * The default-group fallback is safe *here* in a way it would not be in the ledger, and
   * the difference is worth stating. In the ledger, guessing wrong would show one household
   * another's money. Here the key decides only which rating a caller may amend or withdraw,
   * and the fallback is reached only in open-door development mode, which is one household
   * by definition. Getting it wrong in production is impossible because a production session
   * always carries a claim.
   */
  private async author(req: Request): Promise<string> {
    const cookie = req.headers?.cookie
    const claimed = verifySessionToken(
      readSessionToken(typeof cookie === 'string' ? cookie : undefined),
    )
    if (claimed?.groupId) return authorKey(claimed.groupId)

    if (claimed?.userId) {
      const mine = (await SELECT.from(MEMBERSHIPS)
        .columns('group_ID')
        .where({ user_ID: claimed.userId })) as Array<{ group_ID?: string | null }>
      if (mine.length === 1 && mine[0]?.group_ID) return authorKey(String(mine[0].group_ID))
    }

    const fallback = one<{ ID?: string }>(
      await SELECT.one.from(GROUPS).columns('ID').where({ isDefault: true }),
    )
    if (fallback?.ID) return authorKey(String(fallback.ID))

    return req.reject(403, 'This request is not attached to a household, so it cannot rate.')
  }

  /* ------------------------------------------------------------------ read */

  private async onNearby(req: Request): Promise<{ items: Card[]; next: string | null }> {
    const { lat, lon } = coordinates(req)
    const radius = clamp(numberOf(req.data.radiusM) ?? DEFAULT_RADIUS_M, 100, MAX_RADIUS_M)
    const limit = clamp(numberOf(req.data.limit) ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
    const kind = isPlaceKind(req.data.kind) ? req.data.kind : null
    const tag = isPlaceTag(req.data.tag) ? req.data.tag : null

    const rows = await this.pageOf({
      cells: neighbours(lat, lon),
      kind: kind === null ? null : [kind],
      cursor: typeof req.data.cursor === 'string' ? req.data.cursor : null,
      // One over the page, so "is there a next page" is an answer rather than a guess.
      limit: limit + 1,
      tag,
    })

    const page = rows.slice(0, limit)
    const cards = await this.cards(page, lat, lon)
    // The nine cells cover more ground than the radius asks for, at the corners especially.
    // Cheap index work first, exact arithmetic on the few rows that survived it.
    const within = cards.filter(card => card.distance === null || card.distance <= radius)

    const last = page[page.length - 1]
    const next =
      rows.length > limit && last !== undefined ? encodeCursor(last.score, last.place_ID) : null
    return { items: within, next }
  }

  private async onPlaceDetail(req: Request): Promise<{
    place: Card | null
    histogram: number[]
    tips: Array<{ text: string; tags: string[] }>
    ratedByYou: boolean
    yourStars: number | null
  }> {
    const id = String(req.data.ID ?? '')
    const stats = one<StatsRow>(await SELECT.one.from(STATS).where({ place_ID: id }))
    const place = one<PlaceRow>(await SELECT.one.from(PLACES).where({ ID: id }))
    if (place === null) return req.reject(404, 'No such place.')

    const [card] = await this.cards(stats === null ? [] : [stats], null, null, place)
    const published = stats !== null && isPublishable(stats.ratings)

    const mine = one<{
      ID?: string
      stars?: number
    }>(
      await SELECT.one
        .from(RATINGS)
        .columns('ID', 'stars')
        .where({ place_ID: id, authorKey: await this.author(req) }),
    )

    // Tips are the part that leaks, so they are gated by the same threshold as everything
    // else and projected to their text and their chips — never their row id, never a date.
    const tips: Array<{ text: string; tags: string[] }> = []
    if (published) {
      const rows = (await SELECT.from(RATINGS)
        .columns('ID', 'tip')
        .where({ place_ID: id, tipHidden: false })
        .limit(30)) as Array<{ ID: string; tip?: string | null }>
      const withText = rows.filter(row => (row.tip ?? '').trim().length > 0)
      const tagRows = (await SELECT.from(RATING_TAGS)
        .columns('rating_ID', 'tag')
        .where({ rating_ID: { in: withText.map(row => row.ID) } })) as Array<{
        rating_ID: string
        tag: string
      }>
      for (const row of withText) {
        tips.push({
          text: String(row.tip).trim(),
          tags: tagRows.filter(entry => entry.rating_ID === row.ID).map(entry => entry.tag),
        })
      }
    }

    return {
      place: card ?? null,
      histogram:
        published && stats !== null ? [stats.s1, stats.s2, stats.s3, stats.s4, stats.s5] : [],
      tips,
      ratedByYou: mine !== null,
      yourStars: mine?.stars ?? null,
    }
  }

  private async onTonight(req: Request): Promise<unknown[]> {
    const { lat, lon } = coordinates(req)
    const maxCost = isCostBand(req.data.maxCost) ? req.data.maxCost : null
    const cells = neighbours(lat, lon)
    const author = await this.author(req)

    const [eatRows, doRows] = await Promise.all([
      this.pageOf({ cells, kind: EATING_KINDS, cursor: null, limit: DEAL_POOL, tag: null }),
      this.pageOf({ cells, kind: DOING_KINDS, cursor: null, limit: DEAL_POOL, tag: null }),
    ])
    const [eat, activities] = await Promise.all([
      this.cards(eatRows, lat, lon),
      this.cards(doRows, lat, lon),
    ])

    const ideaRows = (await SELECT.from(IDEAS).where({ deck: 'activity' }).limit(40)) as Array<{
      ID: string
      title: string
      summary?: string | null
      costBand?: string | null
      minutes?: number | null
    }>

    const visited = new Set(
      (
        (await SELECT.from(RATINGS).columns('place_ID').where({ authorKey: author })) as Array<{
          place_ID: string
        }>
      ).map(row => row.place_ID),
    )

    const evenings = dealEvenings({
      eat: eat.map(toDealtPlace),
      activities: activities.map(toDealtPlace),
      ideas: ideaRows.map((row): DealtIdea => ({
        ID: row.ID,
        title: row.title,
        summary: row.summary ?? '',
        costBand: isCostBand(row.costBand) ? row.costBand : null,
        minutes: row.minutes ?? null,
      })),
      visited,
      maxCost,
      // The day and the household, so the same question gets the same three cards until
      // tomorrow — and two households in the same street get different ones.
      seed: `${new Date().toISOString().slice(0, 10)}:${author.slice(0, 16)}`,
    })

    const byId = new Map(eat.concat(activities).map(card => [card.ID, card]))
    return evenings.map(evening => ({
      ID: evening.ID,
      eat: byId.get(evening.eat.ID) ?? null,
      doPlace: evening.doPlace === null ? null : (byId.get(evening.doPlace.ID) ?? null),
      doIdea: evening.doIdea,
      costBand: evening.costBand,
      because: evening.because,
    }))
  }

  private async onDeck(req: Request): Promise<unknown[]> {
    const name = req.data.name === 'gift' ? 'gift' : 'activity'
    const rows = (await SELECT.from(IDEAS).where({ deck: name }).limit(60)) as Array<{
      ID: string
      title: string
      summary?: string | null
      costBand?: string | null
      minutes?: number | null
      tags?: string | null
    }>
    return rows.map(row => ({
      ID: row.ID,
      title: row.title,
      summary: row.summary ?? '',
      costBand: row.costBand ?? null,
      minutes: row.minutes ?? null,
      tags: (row.tags ?? '')
        .split(',')
        .map(tag => tag.trim())
        .filter(isPlaceTag),
    }))
  }

  /* ----------------------------------------------------------------- write */

  private async onRate(req: Request): Promise<Card> {
    const author = await this.author(req)
    const stars = Math.round(numberOf(req.data.stars) ?? 0)
    if (stars < 1 || stars > 5) return req.reject(400, 'A rating is one to five stars.')

    const costBand = isCostBand(req.data.costBand) ? req.data.costBand : null
    const tags = cleanTags(req.data.tags)
    const tip = cleanTip(req.data.tip)
    if (tip instanceof Error) return req.reject(400, tip.message)

    const place = await this.findOrCreatePlace(req)
    const existing = one<{ ID: string; stars: number; tip?: string | null }>(
      await SELECT.one
        .from(RATINGS)
        .columns('ID', 'stars', 'tip')
        .where({ place_ID: place.ID, authorKey: author }),
    )

    let histogram = await this.histogramOf(place.ID)
    if (existing === null) {
      const id = cds.utils.uuid()
      await INSERT.into(RATINGS).entries({
        ID: id,
        place_ID: place.ID,
        authorKey: author,
        stars,
        costBand,
        tip,
        tipHidden: false,
        createdAt: new Date().toISOString(),
      })
      await this.writeTags(id, place.ID, [], tags)
      histogram = applyStar(histogram, stars, 1)
    } else {
      // Rating again amends the first rather than adding a second — one household, one voice,
      // which is what stops a place being pushed up the list by one enthusiastic kitchen.
      await UPDATE.entity(RATINGS, existing.ID).with({ stars, costBand, tip, tipHidden: false })
      const before = (await SELECT.from(RATING_TAGS)
        .columns('tag')
        .where({ rating_ID: existing.ID })) as Array<{ tag: string }>
      await this.writeTags(
        existing.ID,
        place.ID,
        before.map(row => row.tag),
        tags,
      )
      histogram = applyStar(applyStar(histogram, existing.stars, -1), stars, 1)
    }

    await this.writeStats(place, histogram)
    const [card] = await this.cards([await this.statsOf(place.ID)], null, null, place)
    return card!
  }

  private async onWithdrawRating(req: Request): Promise<Card> {
    const author = await this.author(req)
    const placeId = String(req.data.placeID ?? '')
    const mine = one<{ ID: string; stars: number }>(
      await SELECT.one
        .from(RATINGS)
        .columns('ID', 'stars')
        .where({ place_ID: placeId, authorKey: author }),
    )
    if (mine === null) return req.reject(404, 'You have not rated this place.')

    const place = one<PlaceRow>(await SELECT.one.from(PLACES).where({ ID: placeId }))
    if (place === null) return req.reject(404, 'No such place.')

    const before = (await SELECT.from(RATING_TAGS)
      .columns('tag')
      .where({ rating_ID: mine.ID })) as Array<{ tag: string }>
    await this.writeTags(
      mine.ID,
      placeId,
      before.map(row => row.tag),
      [],
    )
    await DELETE.from(RATINGS).where({ ID: mine.ID })

    await this.writeStats(place, applyStar(await this.histogramOf(placeId), mine.stars, -1))
    const [card] = await this.cards([await this.statsOf(placeId)], null, null, place)
    return card!
  }

  private async onReportTip(req: Request): Promise<boolean> {
    const placeId = String(req.data.placeID ?? '')
    const rows = (await SELECT.from(RATINGS)
      .columns('ID')
      .where({ place_ID: placeId, tipHidden: false })) as Array<{ ID: string }>
    if (rows.length === 0) return false

    // Hidden, not deleted, and the stars stay counted: a rating is somebody's honest opinion
    // even when the sentence attached to it is not, and deleting the row would quietly move
    // the score of a place because somebody objected to a word.
    await UPDATE.entity(RATINGS)
      .where({ ID: { in: rows.map(row => row.ID) } })
      .with({ tipHidden: true })
    await UPDATE.entity(STATS).where({ place_ID: placeId }).with({ tips: 0 })
    return true
  }

  /* --------------------------------------------------------------- helpers */

  /**
   * One page of the read model.
   *
   * A single range scan over `PlaceStats` — cell, kind, then score — which is the whole
   * reason those two filter columns are copied onto it. Keyset, never offset: the cursor
   * carries the last row's score and id, so page fifty costs exactly what page one did.
   */
  private async pageOf(input: {
    cells: readonly string[]
    kind: readonly PlaceKind[] | null
    cursor: string | null
    limit: number
    tag: string | null
  }): Promise<StatsRow[]> {
    const where: Record<string, unknown> = { geohash6: { in: [...input.cells] } }
    if (input.kind !== null) where.kind = { in: [...input.kind] }

    if (input.tag !== null) {
      const tagged = (await SELECT.from(TAG_COUNTS)
        .columns('place_ID')
        .where({ tag: input.tag })) as Array<{ place_ID: string }>
      where.place_ID = { in: tagged.map(row => row.place_ID) }
    }

    let query = SELECT.from(STATS).where(where).orderBy('score desc', 'place_ID asc')
    const after = decodeCursor(input.cursor)
    if (after !== null) {
      query = SELECT.from(STATS).where(where)
        .and`score < ${after.score} or (score = ${after.score} and place_ID > ${after.id})`.orderBy(
        'score desc',
        'place_ID asc',
      )
    }

    const rows = (await query.limit(input.limit)) as StatsRow[]
    // The threshold is applied here, on the way out, and never on the way in: a place with
    // two ratings has real rows and a real score, it simply may not be shown yet.
    return rows.filter(row => isPublishable(row.ratings))
  }

  /** Turns read-model rows into cards, fetching the place rows for just this page. */
  private async cards(
    rows: readonly StatsRow[],
    lat: number | null,
    lon: number | null,
    known?: PlaceRow,
  ): Promise<Card[]> {
    if (rows.length === 0) {
      return known === undefined ? [] : [this.card(known, null, lat, lon, [])]
    }
    const places =
      known !== undefined
        ? [known]
        : ((await SELECT.from(PLACES).where({
            ID: { in: rows.map(row => row.place_ID) },
          })) as PlaceRow[])

    const tagRows = (await SELECT.from(TAG_COUNTS)
      .columns('place_ID', 'tag', 'count')
      .where({ place_ID: { in: rows.map(row => row.place_ID) } })) as Array<{
      place_ID: string
      tag: string
      count: number
    }>

    const byPlace = new Map(places.map(place => [place.ID, place]))
    const cards: Card[] = []
    for (const row of rows) {
      const place = byPlace.get(row.place_ID)
      if (place === undefined) continue
      const tags = tagRows
        .filter(entry => entry.place_ID === row.place_ID)
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map(entry => entry.tag)
      cards.push(this.card(place, row, lat, lon, tags))
    }
    return cards
  }

  private card(
    place: PlaceRow,
    stats: StatsRow | null,
    lat: number | null,
    lon: number | null,
    tags: string[],
  ): Card {
    const ratings = stats?.ratings ?? 0
    const published = isPublishable(ratings)
    const links = mapLinks(place.lat, place.lon, place.name)
    return {
      ID: place.ID,
      name: place.name,
      kind: place.kind ?? 'other',
      lat: place.lat,
      lon: place.lon,
      city: place.city ?? null,
      distance:
        lat === null || lon === null
          ? null
          : Math.round(distanceMetres(lat, lon, place.lat, place.lon)),
      // Below the threshold a place has no stars, no chips and no cost band — not zeroes,
      // nulls, so a client cannot render "0.0 ★" for somewhere nobody has judged yet.
      stars: published ? (stats?.mean ?? null) : null,
      households: ratings,
      published,
      needs: ratingsUntilPublishable(ratings),
      costBand: published ? (stats?.costBand ?? null) : null,
      tags: published ? tags : [],
      googleUrl: links.google,
      appleUrl: links.apple,
    }
  }

  private async findOrCreatePlace(req: Request): Promise<PlaceRow> {
    const given = typeof req.data.placeID === 'string' ? req.data.placeID : null
    if (given !== null && given.length > 0) {
      const found = one<PlaceRow>(await SELECT.one.from(PLACES).where({ ID: given }))
      if (found === null) return req.reject(404, 'No such place.')
      return found
    }

    const name = String(req.data.name ?? '').trim()
    const lat = numberOf(req.data.lat)
    const lon = numberOf(req.data.lon)
    if (name.length === 0 || lat === null || lon === null) {
      return req.reject(400, 'A new place needs a name and coordinates.')
    }

    const osmType = typeof req.data.osmType === 'string' ? req.data.osmType : null
    const osmId = typeof req.data.osmId === 'string' ? req.data.osmId : null
    const cell = geohash(lat, lon)

    // Identity is the OSM id where there is one, and name-in-a-cell where there is not.
    // Two households adding the same restaurant must land on one row, or the corpus becomes
    // a list of near-duplicates that never reaches the threshold to be shown.
    const existing = one<PlaceRow>(
      await SELECT.one
        .from(PLACES)
        .where(osmId !== null && osmType !== null ? { osmType, osmId } : { name, geohash6: cell }),
    )
    if (existing !== null) return existing

    const row: PlaceRow = {
      ID: cds.utils.uuid(),
      name: name.slice(0, 200),
      kind: isPlaceKind(req.data.kind) ? req.data.kind : 'other',
      lat,
      lon,
      city: typeof req.data.city === 'string' ? req.data.city.slice(0, 120) : null,
      geohash6: cell,
    }
    await INSERT.into(PLACES).entries({
      ...row,
      country:
        typeof req.data.country === 'string' ? req.data.country.slice(0, 2).toUpperCase() : null,
      osmType,
      osmId,
      createdAt: new Date().toISOString(),
    })
    return row
  }

  private async histogramOf(placeId: string): Promise<Histogram> {
    const row = one<Histogram>(
      await SELECT.one
        .from(STATS)
        .columns('s1', 's2', 's3', 's4', 's5')
        .where({ place_ID: placeId }),
    )
    return row ?? { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 }
  }

  private async statsOf(placeId: string): Promise<StatsRow> {
    const row = one<StatsRow>(await SELECT.one.from(STATS).where({ place_ID: placeId }))
    return row ?? ({ place_ID: placeId, ratings: 0 } as StatsRow)
  }

  /** Writes the read model for one place from a histogram. Upserts, because a place's first
   *  rating is also the first time its stats row exists. */
  private async writeStats(place: PlaceRow, histogram: Histogram): Promise<void> {
    const { count, sum } = totals(histogram)
    const commonest = (await SELECT.from(RATINGS)
      .columns('costBand')
      .where({ place_ID: place.ID })) as Array<{ costBand?: string | null }>
    const tally = new Map<string, number>()
    for (const row of commonest) {
      if (row.costBand) tally.set(row.costBand, (tally.get(row.costBand) ?? 0) + 1)
    }
    const costBand = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    const tips = (await SELECT.from(RATINGS)
      .columns('ID')
      .where({ place_ID: place.ID, tipHidden: false })) as Array<{ ID: string }>

    const values = {
      ...histogram,
      place_ID: place.ID,
      geohash6: place.geohash6 ?? geohash(place.lat, place.lon),
      kind: place.kind ?? 'other',
      ratings: count,
      starSum: sum,
      mean: mean(sum, count),
      score: bayesianScore(sum, count),
      tips: tips.length,
      costBand,
      changedAt: new Date().toISOString(),
    }

    const found = one<{ ID: string }>(
      await SELECT.one.from(STATS).columns('ID').where({ place_ID: place.ID }),
    )
    if (found === null) await INSERT.into(STATS).entries({ ID: cds.utils.uuid(), ...values })
    else await UPDATE.entity(STATS, found.ID).with(values)
  }

  /** Replaces one rating's chips and moves the per-place counters by the difference. */
  private async writeTags(
    ratingId: string,
    placeId: string,
    before: readonly string[],
    after: readonly string[],
  ): Promise<void> {
    const added = after.filter(tag => !before.includes(tag))
    const removed = before.filter(tag => !after.includes(tag))
    if (added.length === 0 && removed.length === 0) return

    await DELETE.from(RATING_TAGS).where({ rating_ID: ratingId })
    if (after.length > 0) {
      await INSERT.into(RATING_TAGS).entries(after.map(tag => ({ rating_ID: ratingId, tag })))
    }

    for (const tag of [...added, ...removed]) {
      const delta = added.includes(tag) ? 1 : -1
      const row = one<{ count: number }>(
        await SELECT.one.from(TAG_COUNTS).where({ place_ID: placeId, tag }),
      )
      const next = Math.max(0, (row?.count ?? 0) + delta)
      if (row === null) {
        if (next > 0) await INSERT.into(TAG_COUNTS).entries({ place_ID: placeId, tag, count: next })
      } else if (next === 0) {
        await DELETE.from(TAG_COUNTS).where({ place_ID: placeId, tag })
      } else {
        await UPDATE.entity(TAG_COUNTS).where({ place_ID: placeId, tag }).with({ count: next })
      }
    }
  }
}

/* ------------------------------------------------------------------ plain */

/**
 * Narrows a `SELECT.one` result.
 *
 * `SELECT.one` resolves to **`undefined`** when nothing matched, not `null` — so a cast to
 * `T | null` type-checks, reads correctly, and is wrong: `found !== null` is true for a row
 * that does not exist, and the code goes on to use it. That is a whole class of bug and it
 * fails a long way from its cause, so no handler in this file casts a `SELECT.one` directly.
 */
function one<T>(row: unknown): T | null {
  return (row ?? null) as T | null
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function coordinates(req: Request): { lat: number; lon: number } {
  const lat = numberOf(req.data.lat)
  const lon = numberOf(req.data.lon)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return req.reject(400, 'A latitude and a longitude are needed.')
  }
  return { lat, lon }
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = [...new Set(value.filter(isPlaceTag))]
  return unique.slice(0, MAX_TAGS_PER_RATING)
}

/**
 * Checks a tip before it becomes public.
 *
 * Length, and then two things prose must not carry into a corpus of strangers: a link, which
 * is how a review section becomes an advertising channel, and an `@handle`, which is how an
 * anonymous tip stops being anonymous. Both are refused with a sentence rather than stripped
 * silently — somebody who typed a link meant to, and should be told it is not wanted.
 */
function cleanTip(value: unknown): string | null | Error {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  if (text.length > MAX_TIP_LENGTH) {
    return new Error(`A tip is at most ${MAX_TIP_LENGTH} characters.`)
  }
  if (/https?:\/\/|www\.|\b\S+\.(com|net|org|ch|de|io)\b/i.test(text)) {
    return new Error('A tip cannot contain a link.')
  }
  if (/@\w/.test(text)) {
    return new Error('A tip cannot name an account. Say what worked, not who.')
  }
  return text
}

function toDealtPlace(card: Card): DealtPlace {
  return {
    ID: card.ID,
    name: card.name,
    kind: card.kind,
    lat: card.lat,
    lon: card.lon,
    city: card.city,
    distance: card.distance,
    stars: card.stars,
    households: card.households,
    costBand: (card.costBand ?? null) as CostBand | null,
    tags: card.tags,
  }
}

/** `score|id`, base64. Opaque to the client, which is the point of a cursor. */
function encodeCursor(score: number, id: string): string {
  return Buffer.from(`${score}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | null): { score: number; id: string } | null {
  if (cursor === null || cursor.length === 0) return null
  try {
    const [score, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    const parsed = Number(score)
    if (!Number.isFinite(parsed) || id === undefined) return null
    return { score: parsed, id }
  } catch {
    return null
  }
}
