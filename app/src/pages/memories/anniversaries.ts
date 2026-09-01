/**
 * Yearly recurrences of the things worth remembering: every pinned memory and
 * Document #1, the first date the whole ledger is built around.
 *
 * The rules, so the tests can be read as a specification:
 *
 *  - An anniversary is the *next* occurrence on or after today, and it is
 *    always at least the first one — a memory written today does not have its
 *    zeroth anniversary today, it has its first one next year.
 *  - An anniversary falling exactly on today counts as today (`daysUntil` 0),
 *    not as "just missed, see you in a year".
 *  - 29 February recurs on 28 February in a common year. Rolling it into
 *    1 March would put the memory in the wrong month.
 */

import { clampToMonth, diffInDays, parseIsoDate, toIsoDate, todayIso } from './dates'

export type AnniversarySourceKind = 'document-one' | 'memory'

export interface AnniversarySeed {
  ID: string
  title: string
  /** `YYYY-MM-DD` of the original occurrence. */
  occurredOn: string
  source: AnniversarySourceKind
  place?: string | null
}

export interface Anniversary extends AnniversarySeed {
  /** `YYYY-MM-DD` of the next occurrence. */
  nextDate: string
  /** Which anniversary this will be: 1 is the first. */
  years: number
  /** 0 when it is today. Never negative. */
  daysUntil: number
}

export interface NextOccurrence {
  nextDate: string
  years: number
  daysUntil: number
}

/**
 * The next yearly recurrence of `occurredOn` on or after `today`.
 * Returns `null` when either date is not a valid calendar date.
 */
export function nextAnniversary(
  occurredOn: string,
  today: string = todayIso(),
): NextOccurrence | null {
  const origin = parseIsoDate(occurredOn)
  const now = parseIsoDate(today)
  if (!origin || !now) return null

  // At least the first anniversary: never the same year as the original.
  let year = Math.max(now.y, origin.y + 1)
  let candidate = toIsoDate(clampToMonth(year, origin.m, origin.d))

  // `<` and not `<=`: an anniversary that is today is still ahead of us.
  if (candidate < today) {
    year += 1
    candidate = toIsoDate(clampToMonth(year, origin.m, origin.d))
  }

  return {
    nextDate: candidate,
    years: year - origin.y,
    daysUntil: Math.max(0, diffInDays(today, candidate)),
  }
}

/**
 * Resolves every seed to its next occurrence, soonest first. Ties break in
 * favour of Document #1, then by title, so the order never flickers between
 * renders.
 */
export function computeAnniversaries(
  seeds: readonly AnniversarySeed[],
  today: string = todayIso(),
): Anniversary[] {
  const resolved: Anniversary[] = []
  for (const seed of seeds) {
    const next = nextAnniversary(seed.occurredOn, today)
    if (!next) continue
    resolved.push({ ...seed, ...next })
  }
  return resolved.sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil
    if (a.source !== b.source) return a.source === 'document-one' ? -1 : 1
    return a.title.localeCompare(b.title) || a.ID.localeCompare(b.ID)
  })
}
