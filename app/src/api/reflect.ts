/**
 * The reflective journal client — CONTRACTS.md §18.
 *
 * A fourth service root. It is separate for the reason the others are, plus one specific to
 * it: everything on this path is text that nobody but its author may read, and a client that
 * could also reach the shared ledger is a client somebody could point at the wrong one.
 *
 * Nothing here caches. TanStack Query is used everywhere else in this app and deliberately
 * not here — a journal entry sitting in a query cache is a journal entry that survives a
 * sign-out in memory, and the whole point of the screen is that it is nobody else's.
 */

const BASE = '/api/reflect'

export interface Helpline {
  name: string
  contact: string
  detail: string
}

export interface Reflection {
  ID: string
  at: string
  entry: string
  reply: string
  /** True when a person's help was offered instead of a model's reply. */
  concerned: boolean
  helplines: Helpline[]
}

export class ReflectError extends Error {}

async function unwrap(response: Response): Promise<unknown> {
  const text = await response.text()
  const body: unknown = text.length === 0 ? null : JSON.parse(text)
  if (!response.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { message?: string } }).error
        : undefined
    throw new ReflectError(error?.message ?? `Request failed (${response.status})`)
  }
  return body
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as { value?: unknown }).value
    return Array.isArray(inner) ? inner : []
  }
  return []
}

function toReflection(row: unknown): Reflection {
  const one = (row ?? {}) as Record<string, unknown>
  return {
    ID: String(one.ID ?? ''),
    at: String(one.at ?? ''),
    entry: String(one.entry ?? ''),
    reply: String(one.reply ?? ''),
    concerned: one.concerned === true,
    helplines: list(one.helplines).map(row2 => {
      const line = (row2 ?? {}) as Record<string, unknown>
      return {
        name: String(line.name ?? ''),
        contact: String(line.contact ?? ''),
        detail: String(line.detail ?? ''),
      }
    }),
  }
}

export const reflect = {
  async write(entry: string): Promise<Reflection> {
    const response = await fetch(`${BASE}/reflect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ entry }),
    })
    return toReflection(await unwrap(response))
  },

  async mine(limit = 20): Promise<Reflection[]> {
    const response = await fetch(`${BASE}/myReflections(limit=${limit})`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    return list(await unwrap(response)).map(toReflection)
  },

  async forget(ID: string): Promise<void> {
    await unwrap(
      await fetch(`${BASE}/forgetReflection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ID }),
      }),
    )
  },

  async available(): Promise<{ available: boolean; engine: string }> {
    const body = (await unwrap(
      await fetch(`${BASE}/reflectAvailable()`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    )) as Record<string, unknown>
    return { available: body.available === true, engine: String(body.engine ?? 'none') }
  },
}
