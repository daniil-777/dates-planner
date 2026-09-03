/**
 * The commons client — CONTRACTS.md §14, FRONTEND-CONTRACT §10.
 *
 * A second service root, `/api/commons`, and deliberately a second client: `api` in
 * `client.ts` speaks to the household's own ledger, and nothing in this file may ever be
 * pointed at that one. The two have opposite rules — everything in the ledger is private to
 * one household, everything here is shared by all of them — and one client that could reach
 * both is one refactor away from mixing them up.
 *
 * The same three pieces of OData awkwardness apply as in `client.ts`, and are hidden here in
 * the same way:
 *
 *  - **Decimals arrive as strings.** `stars` is `Decimal(3,2)`, so it lands as `"4.40"`.
 *    Every mapper runs it through `numOrNull`; a page never wonders.
 *  - **Collections are enveloped** in `{ value: [...] }`.
 *  - **Functions are GET with inline arguments**, string literals single-quoted, doubled to
 *    escape; actions are POST with a JSON body.
 *
 * One rule specific to this file: **a card below the threshold has nulls, not zeroes.** The
 * server sends `stars: null` for a place fewer than three households have rated, and this
 * client keeps it null all the way to the component, so nothing can render "0.0 ★" for
 * somewhere nobody has judged yet.
 */

import type { CostBand, PlaceKind, PlaceTag } from '@/pages/places/vocabulary'

const BASE = '/api/commons'

export interface PlaceCard {
  ID: string
  name: string
  kind: PlaceKind
  lat: number
  lon: number
  city: string | null
  /** Metres from where the caller asked, or null if they asked about nowhere. */
  distance: number | null
  /** The mean, or **null** below the anonymity threshold. Never zero. */
  stars: number | null
  households: number
  published: boolean
  /** How many more households are needed before anything shows. */
  needs: number
  costBand: CostBand | null
  tags: PlaceTag[]
  googleUrl: string
  appleUrl: string
}

export interface PlaceTip {
  text: string
  tags: PlaceTag[]
}

export interface PlaceDetail {
  place: PlaceCard | null
  /** Five buckets, one to five stars. Empty below the threshold. */
  histogram: number[]
  tips: PlaceTip[]
  ratedByYou: boolean
  yourStars: number | null
}

export interface IdeaCard {
  ID: string
  title: string
  summary: string
  costBand: CostBand | null
  minutes: number | null
  tags?: PlaceTag[]
}

export interface Evening {
  ID: string
  eat: PlaceCard | null
  doPlace: PlaceCard | null
  doIdea: IdeaCard | null
  costBand: CostBand
  because: string
}

export interface PlaceCandidate {
  name: string
  label: string
  lat: number
  lon: number
  city: string | null
  country: string | null
  kind: PlaceKind
  osmType: string | null
  osmId: string | null
  /** Set when the corpus already knows this place. */
  placeID: string | null
}

export interface RatingInput {
  placeID?: string | null
  name?: string
  kind?: PlaceKind
  lat?: number
  lon?: number
  city?: string | null
  country?: string | null
  osmType?: string | null
  osmId?: string | null
  stars: number
  costBand?: CostBand | null
  tags?: readonly PlaceTag[]
  tip?: string | null
}

export class CommonsError extends Error {}

/* ------------------------------------------------------------------ plumbing */

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** OData string literal: single quotes, and a quote inside is doubled. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function read(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}/${path}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  return unwrap(response)
}

async function write(name: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  return unwrap(response)
}

async function unwrap(response: Response): Promise<unknown> {
  const text = await response.text()
  const body: unknown = text.length === 0 ? null : JSON.parse(text)
  if (!response.ok) {
    // CAP's message is written for a person — "A tip cannot contain a link." — so it is safe
    // to put in front of one verbatim.
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `The commons answered ${response.status}.`
    throw new CommonsError(message)
  }
  if (body !== null && typeof body === 'object' && 'value' in body) {
    return (body as { value: unknown }).value
  }
  return body
}

function toCard(row: Record<string, unknown>): PlaceCard {
  return {
    ID: String(row.ID),
    name: String(row.name ?? ''),
    kind: (row.kind ?? 'other') as PlaceKind,
    lat: numOrNull(row.lat) ?? 0,
    lon: numOrNull(row.lon) ?? 0,
    city: (row.city as string | null) ?? null,
    distance: numOrNull(row.distance),
    // Kept null rather than defaulted: see the header.
    stars: numOrNull(row.stars),
    households: numOrNull(row.households) ?? 0,
    published: row.published === true,
    needs: numOrNull(row.needs) ?? 0,
    costBand: (row.costBand as CostBand | null) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as PlaceTag[]) : [],
    googleUrl: String(row.googleUrl ?? ''),
    appleUrl: String(row.appleUrl ?? ''),
  }
}

function toIdea(row: Record<string, unknown> | null): IdeaCard | null {
  if (row === null || row === undefined || row.ID === undefined || row.ID === null) return null
  return {
    ID: String(row.ID),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    costBand: (row.costBand as CostBand | null) ?? null,
    minutes: numOrNull(row.minutes),
    tags: Array.isArray(row.tags) ? (row.tags as PlaceTag[]) : [],
  }
}

/* --------------------------------------------------------------------- api */

export interface NearbyQuery {
  lat: number
  lon: number
  radiusM?: number
  kind?: PlaceKind | null
  tag?: PlaceTag | null
  limit?: number
  cursor?: string | null
}

export const commons = {
  async nearby(query: NearbyQuery): Promise<{ items: PlaceCard[]; next: string | null }> {
    const args = [`lat=${query.lat}`, `lon=${query.lon}`]
    if (query.radiusM !== undefined) args.push(`radiusM=${Math.round(query.radiusM)}`)
    if (query.kind) args.push(`kind=${literal(query.kind)}`)
    if (query.tag) args.push(`tag=${literal(query.tag)}`)
    if (query.limit !== undefined) args.push(`limit=${Math.round(query.limit)}`)
    if (query.cursor) args.push(`cursor=${literal(query.cursor)}`)

    const body = (await read(`nearby(${args.join(',')})`)) as {
      items?: Array<Record<string, unknown>>
      next?: string | null
    } | null
    return {
      items: (body?.items ?? []).map(toCard),
      next: body?.next ?? null,
    }
  },

  async placeDetail(id: string): Promise<PlaceDetail> {
    // `Edm.Guid` literals are bare in OData V4 — no quotes.
    const body = (await read(`placeDetail(ID=${id})`)) as Record<string, unknown> | null
    const place = body?.place as Record<string, unknown> | null | undefined
    return {
      place: place === null || place === undefined ? null : toCard(place),
      histogram: Array.isArray(body?.histogram) ? (body.histogram as number[]) : [],
      tips: Array.isArray(body?.tips) ? (body.tips as PlaceTip[]) : [],
      ratedByYou: body?.ratedByYou === true,
      yourStars: numOrNull(body?.yourStars),
    }
  },

  async tonight(lat: number, lon: number, maxCost?: CostBand | null): Promise<Evening[]> {
    const args = [`lat=${lat}`, `lon=${lon}`]
    if (maxCost) args.push(`maxCost=${literal(maxCost)}`)
    const rows = (await read(`tonight(${args.join(',')})`)) as Array<Record<string, unknown>>
    return (rows ?? []).map(row => ({
      ID: String(row.ID),
      eat: row.eat ? toCard(row.eat as Record<string, unknown>) : null,
      doPlace: row.doPlace ? toCard(row.doPlace as Record<string, unknown>) : null,
      doIdea: toIdea(row.doIdea as Record<string, unknown> | null),
      costBand: (row.costBand ?? 'free') as CostBand,
      because: String(row.because ?? ''),
    }))
  },

  async deck(name: 'activity' | 'gift'): Promise<IdeaCard[]> {
    const rows = (await read(`deck(name=${literal(name)})`)) as Array<Record<string, unknown>>
    return (rows ?? []).map(row => toIdea(row)).filter((idea): idea is IdeaCard => idea !== null)
  },

  async search(q: string, lat?: number | null, lon?: number | null): Promise<PlaceCandidate[]> {
    const args = [`q=${literal(q)}`]
    if (lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
      args.push(`lat=${lat}`, `lon=${lon}`)
    }
    const rows = (await read(`search(${args.join(',')})`)) as Array<Record<string, unknown>>
    return (rows ?? []).map(row => ({
      name: String(row.name ?? ''),
      label: String(row.label ?? ''),
      lat: numOrNull(row.lat) ?? 0,
      lon: numOrNull(row.lon) ?? 0,
      city: (row.city as string | null) ?? null,
      country: (row.country as string | null) ?? null,
      kind: (row.kind ?? 'other') as PlaceKind,
      osmType: (row.osmType as string | null) ?? null,
      osmId: (row.osmId as string | null) ?? null,
      placeID: (row.placeID as string | null) ?? null,
    }))
  },

  async rate(input: RatingInput): Promise<PlaceCard> {
    const row = (await write('rate', {
      ...input,
      tags: [...(input.tags ?? [])],
    })) as Record<string, unknown>
    return toCard(row)
  },

  async withdrawRating(placeID: string): Promise<PlaceCard> {
    const row = (await write('withdrawRating', { placeID })) as Record<string, unknown>
    return toCard(row)
  },

  async reportTip(placeID: string, reason: string): Promise<boolean> {
    const body = (await write('reportTip', { placeID, reason })) as
      { value?: boolean } | boolean | null
    return typeof body === 'boolean' ? body : (body?.value ?? false)
  },
}
