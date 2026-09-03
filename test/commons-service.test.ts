/// <reference types="@cap-js/cds-types" />
/**
 * CommonsService — behaviour tests.
 *
 * Bootstrapped exactly like `ledger-service.test.ts`: model loaded, deployed to a throwaway
 * in-memory SQLite, service constructed with the real implementation class. No HTTP.
 *
 * ## What this file is guarding
 *
 * The commons is the only place in this app where one household's words reach another, so
 * the assertions here are mostly about restraint rather than function. Three of them would
 * be a privacy incident if they ever failed:
 *
 * - **Nothing is published below the threshold.** Two households rating a place must leave
 *   it invisible — no stars, no chips, no tips, not in a list, not on a card.
 * - **No response ever carries an author.** Not the key, not a group id, not a person, not a
 *   timestamp fine enough to place somebody. This is asserted by walking whole responses
 *   rather than by naming the fields we remembered to check, because the ones we would
 *   forget to name are exactly the ones a future change would add.
 * - **One household is one voice.** Rating twice amends; it never stacks. A place that can
 *   be pushed up the ranking by one enthusiastic household is a ranking nobody should read.
 *
 * ## How households are told apart
 *
 * Each request carries a session cookie naming its group, so the handler derives a different
 * author key per household exactly as it would in production. That is the only way these
 * tests can be about more than one household at once, and it exercises the real derivation
 * rather than a stub of it.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import CommonsServiceImpl from '../srv/commons-service'
import { SESSION_COOKIE, issueSessionToken } from '../srv/lib/auth'
import { ANONYMITY_THRESHOLD } from '../srv/lib/commons/vocabulary'

const bootstrap = cds as unknown as {
  deploy: (model: unknown) => { to: (target: unknown, options?: unknown) => Promise<Service> }
  serve: (name: string) => {
    from: (model: unknown) => { with: (impl: unknown) => Promise<Service> }
  }
}

let csn: cds.csn.CSN
let db: Service
let commons: Service

/** Zürich, near enough to the seeded household to be plausible. */
const HERE = { lat: 47.3769, lon: 8.5417 }

/** Sixteen households, so a test can build a corpus with real weight behind a place. */
const HOUSEHOLDS = Array.from(
  { length: 16 },
  (_unused, i) => `g0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
)

/** A request as a given household, the way a phone would make it. */
function as(group: string): { cookie: string } {
  return {
    cookie: `${SESSION_COOKIE}=${issueSessionToken('tester', Date.now(), { groupId: group })}`,
  }
}

async function rate(
  group: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await commons.send({
    event: 'rate',
    data,
    headers: as(group),
  })) as Record<string, unknown>
}

async function nearby(
  group: string,
  data: Record<string, unknown> = {},
): Promise<{ items: Array<Record<string, unknown>>; next: string | null }> {
  return (await commons.send({
    event: 'nearby',
    data: { ...HERE, ...data },
    headers: as(group),
  })) as { items: Array<Record<string, unknown>>; next: string | null }
}

/** A new place, rated by whoever is passed in. Returns the place id. */
async function place(
  name: string,
  group: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const card = await rate(group, {
    name,
    kind: 'restaurant',
    ...HERE,
    stars: 5,
    costBand: 'c30_60',
    tags: ['quiet'],
    ...overrides,
  })
  return String(card.ID)
}

/** Every string anywhere in a response, however deeply nested. */
function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) strings(entry, found)
  else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) strings(entry, found)
  }
  return found
}

beforeAll(async () => {
  cds.root = process.cwd()
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }

  csn = await cds.load(['db', 'srv'])
  const compiled = cds.compile.for.nodejs(csn)
  cds.model = compiled
  db = await bootstrap.deploy(csn).to('db', { silent: true })
  commons = await bootstrap.serve('CommonsService').from(compiled).with(CommonsServiceImpl)
})

beforeEach(async () => {
  await bootstrap.deploy(csn).to(db, { silent: true })
})

describe('the anonymity threshold', () => {
  it('shows nothing at all until enough households have rated a place', async () => {
    const id = await place('Kafi Dihei', HOUSEHOLDS[0]!)

    // One household. The row exists; the place does not.
    expect((await nearby(HOUSEHOLDS[1]!)).items).toHaveLength(0)

    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4, costBand: 'c30_60', tags: ['quiet'] })
    expect((await nearby(HOUSEHOLDS[2]!)).items).toHaveLength(0)

    // The third one publishes it.
    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5, costBand: 'c30_60', tags: ['quiet'] })
    const items = (await nearby(HOUSEHOLDS[3]!)).items
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('Kafi Dihei')
    expect(items[0]!.households).toBe(ANONYMITY_THRESHOLD)
  })

  it('withholds the stars themselves, not merely the row', async () => {
    const id = await place('Too Few', HOUSEHOLDS[0]!, { tip: 'ask for the corner table' })
    const detail = (await commons.send({
      event: 'placeDetail',
      data: { ID: id },
      headers: as(HOUSEHOLDS[1]!),
    })) as {
      place: Record<string, unknown>
      histogram: number[]
      tips: unknown[]
    }

    // A card for an unpublished place is null where a number would be, never a zero — a
    // client cannot then render "0.0 ★" for somewhere nobody has judged.
    expect(detail.place.published).toBe(false)
    expect(detail.place.stars).toBeNull()
    expect(detail.place.costBand).toBeNull()
    expect(detail.place.tags).toEqual([])
    expect(detail.histogram).toEqual([])
    expect(detail.tips).toEqual([])
    expect(detail.place.needs).toBe(ANONYMITY_THRESHOLD - 1)
  })

  it('keeps a tip sealed until its place is published, then shows it', async () => {
    const id = await place('Slow Burn', HOUSEHOLDS[0]!, { tip: 'the corner table is the one' })
    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4 })

    const before = (await commons.send({
      event: 'placeDetail',
      data: { ID: id },
      headers: as(HOUSEHOLDS[2]!),
    })) as { tips: unknown[] }
    expect(before.tips).toEqual([])

    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5 })
    const after = (await commons.send({
      event: 'placeDetail',
      data: { ID: id },
      headers: as(HOUSEHOLDS[3]!),
    })) as { tips: Array<{ text: string }> }
    expect(after.tips.map(tip => tip.text)).toContain('the corner table is the one')
  })
})

describe('what a response may contain', () => {
  it('never carries an author, a group or a person, anywhere in it', async () => {
    const id = await place('Open Book', HOUSEHOLDS[0]!, { tip: 'sit upstairs' })
    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4, tip: 'go early' })
    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5, tip: 'the terrace' })

    const responses = [
      await nearby(HOUSEHOLDS[3]!),
      await commons.send({ event: 'placeDetail', data: { ID: id }, headers: as(HOUSEHOLDS[3]!) }),
      await commons.send({ event: 'tonight', data: HERE, headers: as(HOUSEHOLDS[3]!) }),
    ]

    // Walk every string in every response rather than naming the fields we remembered to
    // check: the field a future change adds is exactly the one this would otherwise miss.
    for (const response of responses) {
      const all = strings(response).join(' ')
      for (const household of HOUSEHOLDS) {
        expect(all, 'a response named a household').not.toContain(household)
      }
      // An author key is 64 hex characters. Nothing that shape belongs in a response.
      expect(all).not.toMatch(/\b[0-9a-f]{64}\b/)
    }
  })

  it('does not answer a question about who rated a place', async () => {
    const id = await place('Whose Is It', HOUSEHOLDS[0]!)
    const detail = (await commons.send({
      event: 'placeDetail',
      data: { ID: id },
      headers: as(HOUSEHOLDS[0]!),
    })) as Record<string, unknown>

    // It will say whether *you* rated it — that is your own row, and the sheet needs it to
    // open on your answer — and nothing about anybody else's.
    expect(detail.ratedByYou).toBe(true)
    expect(detail.yourStars).toBe(5)
    expect(Object.keys(detail)).not.toContain('ratings')
    expect(Object.keys(detail)).not.toContain('authorKey')

    const other = (await commons.send({
      event: 'placeDetail',
      data: { ID: id },
      headers: as(HOUSEHOLDS[1]!),
    })) as Record<string, unknown>
    expect(other.ratedByYou).toBe(false)
    expect(other.yourStars).toBeNull()
  })
})

describe('one household, one voice', () => {
  it('amends a rating rather than stacking a second one', async () => {
    const id = await place('Second Thoughts', HOUSEHOLDS[0]!, { stars: 5 })
    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 5 })
    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5 })

    // The first household changes its mind, twice.
    await rate(HOUSEHOLDS[0]!, { placeID: id, stars: 2 })
    await rate(HOUSEHOLDS[0]!, { placeID: id, stars: 1 })

    const items = (await nearby(HOUSEHOLDS[3]!)).items
    expect(items[0]!.households).toBe(3)
    // 1 + 5 + 5 over three households, not five ratings' worth.
    expect(Number(items[0]!.stars)).toBeCloseTo(11 / 3, 2)
  })

  it('lets a household take its rating back, and unpublishes the place if that was the third', async () => {
    const id = await place('Regret', HOUSEHOLDS[0]!)
    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4 })
    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 4 })
    expect((await nearby(HOUSEHOLDS[3]!)).items).toHaveLength(1)

    await commons.send({
      event: 'withdrawRating',
      data: { placeID: id },
      headers: as(HOUSEHOLDS[2]!),
    })

    // Back below the threshold, so it stops being shown — the corpus does not keep a place
    // published on the strength of a rating that was taken back.
    expect((await nearby(HOUSEHOLDS[3]!)).items).toHaveLength(0)
  })

  it('refuses to withdraw a rating a household never made', async () => {
    const id = await place('Not Yours', HOUSEHOLDS[0]!)
    await expect(
      commons.send({ event: 'withdrawRating', data: { placeID: id }, headers: as(HOUSEHOLDS[1]!) }),
    ).rejects.toThrow(/not rated/i)
  })
})

describe('the same place, added twice', () => {
  it('lands on one row, so it can actually reach the threshold', async () => {
    // Two households add the same restaurant independently, as they would.
    await place('Zeughauskeller', HOUSEHOLDS[0]!)
    await place('Zeughauskeller', HOUSEHOLDS[1]!)
    await place('Zeughauskeller', HOUSEHOLDS[2]!)

    const items = (await nearby(HOUSEHOLDS[3]!)).items
    expect(items).toHaveLength(1)
    expect(items[0]!.households).toBe(3)
  })

  it('keeps two different places apart even in the same cell', async () => {
    for (const group of HOUSEHOLDS.slice(0, 3)) {
      await place('Kafi Dihei', group)
      await place('Zeughauskeller', group)
    }
    expect((await nearby(HOUSEHOLDS[3]!)).items).toHaveLength(2)
  })
})

describe('what a tip may say', () => {
  it('refuses a link, because a review section is not an advertising channel', async () => {
    await expect(
      rate(HOUSEHOLDS[0]!, { name: 'Spam', ...HERE, stars: 5, tip: 'see https://buy.example' }),
    ).rejects.toThrow(/link/i)
  })

  it('refuses an @handle, because an anonymous tip that names an account is not anonymous', async () => {
    await expect(
      rate(HOUSEHOLDS[0]!, { name: 'Spam', ...HERE, stars: 5, tip: 'ask for @maria' }),
    ).rejects.toThrow(/account/i)
  })

  it('refuses a rating that is not one to five stars', async () => {
    await expect(rate(HOUSEHOLDS[0]!, { name: 'Nope', ...HERE, stars: 9 })).rejects.toThrow(
      /one to five/i,
    )
  })

  it('drops chips that are not in the vocabulary rather than storing them', async () => {
    const id = await place('Chips', HOUSEHOLDS[0]!, {
      tags: ['quiet', 'romantic_for_couples', 'view'],
    })
    await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 5, tags: ['quiet', 'view'] })
    await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5, tags: ['quiet'] })

    const items = (await nearby(HOUSEHOLDS[3]!)).items
    expect(items[0]!.tags).toContain('quiet')
    expect(items[0]!.tags).not.toContain('romantic_for_couples')
  })
})

describe('ordering and paging', () => {
  it('ranks by the shrunk score, so a few enthusiasts do not beat a settled favourite', async () => {
    // Twelve households, averaging 4.67 — a place with a real reputation.
    const loved = await place('Settled Favourite', HOUSEHOLDS[0]!, { stars: 5 })
    for (const [i, group] of HOUSEHOLDS.slice(1, 12).entries()) {
      await rate(group, { placeID: loved, stars: i % 3 === 0 ? 4 : 5 })
    }

    // Three households, all five stars — a better mean on much less evidence.
    const shiny = await place('Three Fans', HOUSEHOLDS[0]!, { name: 'Three Fans', stars: 5 })
    await rate(HOUSEHOLDS[1]!, { placeID: shiny, stars: 5 })
    await rate(HOUSEHOLDS[2]!, { placeID: shiny, stars: 5 })

    const items = (await nearby(HOUSEHOLDS[13]!)).items
    const byName = new Map(items.map(item => [item.name, item]))
    const favourite = byName.get('Settled Favourite')!
    const fans = byName.get('Three Fans')!

    // The raw mean says the opposite — which is the entire reason the score is not the mean.
    expect(Number(fans.stars)).toBeGreaterThan(Number(favourite.stars))

    const names = items.map(item => item.name)
    expect(names.indexOf('Settled Favourite')).toBeLessThan(names.indexOf('Three Fans'))
  })

  it('pages with a cursor and never repeats a row', async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = await place(`Place ${i}`, HOUSEHOLDS[0]!, { stars: 5 - (i % 3) })
      await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4 })
      await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 4 })
    }

    const first = await nearby(HOUSEHOLDS[3]!, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.next).toBeTruthy()

    const second = await nearby(HOUSEHOLDS[3]!, { limit: 2, cursor: first.next })
    const seen = [...first.items, ...second.items].map(item => item.ID)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('does not return a place beyond the radius asked for', async () => {
    // Bern, about 95 km away, rated by three households so it is otherwise publishable.
    const far = await place('Far Away', HOUSEHOLDS[0]!, { lat: 46.9489, lon: 7.4396 })
    await rate(HOUSEHOLDS[1]!, { placeID: far, stars: 5 })
    await rate(HOUSEHOLDS[2]!, { placeID: far, stars: 5 })

    expect((await nearby(HOUSEHOLDS[3]!, { radiusM: 3000 })).items).toHaveLength(0)
  })
})

describe('tonight', () => {
  it('deals nothing rather than something bad when the corpus is empty', async () => {
    const cards = (await commons.send({
      event: 'tonight',
      data: HERE,
      headers: as(HOUSEHOLDS[0]!),
    })) as unknown[]
    expect(cards).toEqual([])
  })

  it('deals the same three cards to the same household twice in a day', async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = await place(`Dinner ${i}`, HOUSEHOLDS[0]!)
      await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4 })
      await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5 })
    }

    const first = (await commons.send({
      event: 'tonight',
      data: HERE,
      headers: as(HOUSEHOLDS[3]!),
    })) as Array<{ ID: string }>
    const again = (await commons.send({
      event: 'tonight',
      data: HERE,
      headers: as(HOUSEHOLDS[3]!),
    })) as Array<{ ID: string }>

    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(3)
    expect(again.map(card => card.ID)).toEqual(first.map(card => card.ID))
  })

  it('deals a different hand to a different household', async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = await place(`Dinner ${i}`, HOUSEHOLDS[0]!)
      await rate(HOUSEHOLDS[1]!, { placeID: id, stars: 4 })
      await rate(HOUSEHOLDS[2]!, { placeID: id, stars: 5 })
    }
    const mine = (await commons.send({
      event: 'tonight',
      data: HERE,
      headers: as(HOUSEHOLDS[2]!),
    })) as Array<{ ID: string }>
    const theirs = (await commons.send({
      event: 'tonight',
      data: HERE,
      headers: as(HOUSEHOLDS[3]!),
    })) as Array<{ ID: string }>

    expect(mine.map(card => card.ID)).not.toEqual(theirs.map(card => card.ID))
  })
})
