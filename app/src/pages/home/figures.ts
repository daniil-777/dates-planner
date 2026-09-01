/**
 * The live figures on the tiles — FRONTEND-CONTRACT §8's table, one function per row.
 *
 * Everything here is pure: a query's answer in, a `Figure` out. That is what makes the
 * three states the contract asks for cheap to get right — a skeleton while the figure is
 * loading, the number when it lands, and **the tile with its label and no number** when the
 * request failed. A launcher that shows an error banner where a number should be is a
 * launcher nobody trusts; a tile that quietly omits its figure is one you can still tap.
 */

import type { Event, Expense, Memory, PeriodTotals, Person, Statement } from '@/api/types'
import { DEFAULT_CURRENCY, formatPeriod } from '@/theme'
import { sectionEvents } from '../events/summary'
import { buildTimeline } from '../memories/timeline'
import { KIND_LABELS, countdownLabel, type NextUpItem } from './nextUp'

/**
 * What a tile prints where its number goes.
 *
 * `emphasis` is explicit rather than guessed from the string's length: "12" is a figure and
 * wants to be large, "Post a receipt" is a sentence and wants not to shout.
 */
export type Figure =
  | { kind: 'text'; value: string; emphasis: 'number' | 'phrase'; caption: string | null }
  | { kind: 'money'; amount: number; currency: string; caption: string | null }

export type FigureState =
  { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; figure: Figure }

/** The slice of a TanStack query result a figure actually depends on. */
export interface QueryLike<T> {
  data: T | undefined
  isPending: boolean
  isError: boolean
}

const LOADING: FigureState = { status: 'loading' }
const UNAVAILABLE: FigureState = { status: 'unavailable' }

/**
 * Data wins over an error: a figure held from a previous fetch is still true enough to
 * show while a refetch fails. Only a tile that has never had an answer goes blank.
 */
export function figureFrom<T>(query: QueryLike<T>, read: (data: T) => Figure): FigureState {
  if (query.data !== undefined) return { status: 'ready', figure: read(query.data) }
  if (query.isError) return UNAVAILABLE
  if (query.isPending) return LOADING
  return UNAVAILABLE
}

/**
 * A figure that needs two reads before it can be honest.
 *
 * Only the Memories tile wants this, and for a specific reason: its number is the length of
 * the timeline, and the timeline is built from memories *and* expenses. Reading only the
 * memories half would let the tile print a number the page it opens then contradicts, so it
 * waits for both rather than announcing half of one.
 */
export function figureFromBoth<A, B>(
  first: QueryLike<A>,
  second: QueryLike<B>,
  read: (first: A, second: B) => Figure,
): FigureState {
  if (first.data !== undefined && second.data !== undefined) {
    return { status: 'ready', figure: read(first.data, second.data) }
  }
  if (first.isError || second.isError) return UNAVAILABLE
  if (first.isPending || second.isPending) return LOADING
  return UNAVAILABLE
}

function countFigure(value: number, caption: string | null): Figure {
  return { kind: 'text', value: String(value), emphasis: 'number', caption }
}

function phraseFigure(value: string, caption: string | null): Figure {
  return { kind: 'text', value, emphasis: 'phrase', caption }
}

/**
 * Scan — the drafts waiting to be posted, or the invitation to make one.
 *
 * A draft *is* the review queue: `srv` writes every scan as `status: 'draft'` and the
 * Ledger's "Needs review" filter is exactly `status === 'draft'`, so counting them here
 * agrees with what the ledger shows when you arrive.
 */
export function draftsFigure(expenses: readonly Expense[]): Figure {
  const drafts = expenses.filter(expense => expense.status === 'draft').length
  if (drafts === 0) return phraseFigure('Post a receipt', 'nothing waiting')
  return countFigure(drafts, drafts === 1 ? 'draft to post' : 'drafts to post')
}

/** Ledger — what this month has come to so far. */
export function monthFigure(totals: PeriodTotals): Figure {
  return {
    kind: 'money',
    amount: totals.grandTotal,
    currency: DEFAULT_CURRENCY,
    caption: formatPeriod(totals.period),
  }
}

/** Events — how many are running now or still to come. */
export function eventsFigure(events: readonly Event[], today: string): Figure {
  const current = sectionEvents(events, today).current.length
  return countFigure(current, current === 0 ? 'nothing planned' : 'current or upcoming')
}

/**
 * Calendar — the next reminder or the next event, whichever lands first.
 *
 * `buildNextUp` has already sorted by date and broken ties in favour of the reminder, so
 * "the next reminder, or the next event" is the head of the list with the anniversaries
 * left out: those belong to Memories, and they are on the strip below.
 */
export function calendarFigure(items: readonly NextUpItem[]): Figure {
  const next = items.find(item => item.kind !== 'anniversary')
  if (!next) return phraseFigure('Clear', 'nothing in the next 90 days')
  return phraseFigure(countdownLabel(next), `${KIND_LABELS[next.kind]} · ${next.title}`)
}

/**
 * Memories — how much of the year has been written down.
 *
 * Counted with `buildTimeline`, not `memories.length`, because the Memories page's own
 * header counts the timeline: memories plus the memorable expenses no memory has absorbed
 * yet. Counting raw rows here made the tile promise "1 entry" and the page it opened
 * announce "10 entries" — the same word for two different numbers, one tap apart.
 */
export function memoriesFigure(memories: readonly Memory[], expenses: readonly Expense[]): Figure {
  const entries = buildTimeline(memories, expenses).length
  return countFigure(entries, entries === 1 ? 'entry' : 'entries')
}

/** Statement — the most recent year that has actually been generated. */
export function statementFigure(statements: readonly Statement[]): Figure {
  let latest: number | null = null
  for (const statement of statements) {
    if (!Number.isFinite(statement.year)) continue
    if (latest === null || statement.year > latest) latest = statement.year
  }
  if (latest === null) return phraseFigure('Not yet', 'none generated')
  return countFigure(latest, 'latest statement')
}

/** Settings — the roster. Never assumed to be two (CONTRACTS §10). */
export function peopleFigure(people: readonly Person[]): Figure {
  return countFigure(people.length, people.length === 1 ? 'person' : 'people')
}
