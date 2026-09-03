/**
 * Reading and writing touch maps — CONTRACTS.md §13.
 *
 * This lives beside the page rather than in `app/src/api/client.ts` for the same reason
 * `pages/events/photos.ts` does: `client.ts` is the shared surface every screen imports,
 * and a set of calls used by exactly one route does not belong in it. Keeping them here
 * also keeps the most sensitive endpoints in the app in one file that is easy to audit.
 *
 * ## The shape of a save
 *
 * A mark is one row. Setting a level is a POST or a PATCH of that row, clearing it is a
 * DELETE — there is no "level 0" to write, because a region with no opinion is the
 * absence of a row and not a value (§13.2). The alternative, PUTting the whole map on
 * every tap, would make two people editing at once silently overwrite each other.
 */
import { isZoneCode, type BodyForm, type Level, type ZoneCode } from './zones'

const BASE = '/api/ledger'

interface ODataList {
  value?: unknown[]
}

function rows(payload: unknown): Array<Record<string, unknown>> {
  const list = (payload as ODataList | null)?.value
  return Array.isArray(list)
    ? list.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : []
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    // CAP puts the useful sentence in `error.message`; falling back to the status keeps
    // the caller from rendering "undefined" when something upstream fails differently.
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null
    throw new Error(body?.error?.message ?? `The server answered ${response.status}.`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export interface Mark {
  id: string
  zone: ZoneCode
  level: Level
  note: string | null
}

export interface TouchMap {
  id: string
  personId: string
  form: BodyForm
  marks: Mark[]
}

function toLevel(value: unknown): Level | null {
  const level = Number(value)
  return level === -1 || level === 1 || level === 2 || level === 3 ? level : null
}

function toForm(value: unknown): BodyForm {
  return value === 'feminine' || value === 'masculine' ? value : 'neutral'
}

/**
 * Every map in the household, each with its marks.
 *
 * One request with `$expand` rather than one per person: a household is small, and the
 * alternative makes the number of round trips depend on the roster size for no gain.
 * Rows whose zone is not a code this build knows are dropped — that is the forward
 * compatibility half of the additive-only rule in §13.1.
 */
export async function listTouchMaps(): Promise<TouchMap[]> {
  const payload = await send<unknown>(
    `${BASE}/BodyMaps?${new URLSearchParams({ $expand: 'zones' }).toString()}`,
  )
  return rows(payload).flatMap(row => {
    const id = typeof row.ID === 'string' ? row.ID : null
    const personId = typeof row.person_ID === 'string' ? row.person_ID : null
    if (id === null || personId === null) return []

    const zones = Array.isArray(row.zones) ? row.zones : []
    const marks = zones.flatMap((entry): Mark[] => {
      if (entry === null || typeof entry !== 'object') return []
      const zone = (entry as Record<string, unknown>).zone
      const level = toLevel((entry as Record<string, unknown>).level)
      const markId = (entry as Record<string, unknown>).ID
      if (!isZoneCode(zone) || level === null || typeof markId !== 'string') return []
      const note = (entry as Record<string, unknown>).note
      return [
        { id: markId, zone, level, note: typeof note === 'string' && note !== '' ? note : null },
      ]
    })

    return [{ id, personId, form: toForm(row.form), marks }]
  })
}

/** Creates the caller's map. The server refuses one pointed at anybody else (§13.3). */
export async function createTouchMap(personId: string, form: BodyForm): Promise<TouchMap> {
  const created = await send<Record<string, unknown>>(`${BASE}/BodyMaps`, {
    method: 'POST',
    body: JSON.stringify({ person_ID: personId, form }),
  })
  return {
    id: String(created.ID),
    personId,
    form: toForm(created.form),
    marks: [],
  }
}

export async function setForm(mapId: string, form: BodyForm): Promise<void> {
  await send(`${BASE}/BodyMaps(${mapId})`, { method: 'PATCH', body: JSON.stringify({ form }) })
}

export async function addMark(mapId: string, zone: ZoneCode, level: Level): Promise<Mark> {
  const created = await send<Record<string, unknown>>(`${BASE}/BodyZones`, {
    method: 'POST',
    body: JSON.stringify({ map_ID: mapId, zone, level }),
  })
  return { id: String(created.ID), zone, level, note: null }
}

export async function setMarkLevel(markId: string, level: Level): Promise<void> {
  await send(`${BASE}/BodyZones(${markId})`, { method: 'PATCH', body: JSON.stringify({ level }) })
}

export async function setMarkNote(markId: string, note: string | null): Promise<void> {
  await send(`${BASE}/BodyZones(${markId})`, {
    method: 'PATCH',
    body: JSON.stringify({ note: note ?? '' }),
  })
}

export async function clearMark(markId: string): Promise<void> {
  await send(`${BASE}/BodyZones(${markId})`, { method: 'DELETE' })
}
