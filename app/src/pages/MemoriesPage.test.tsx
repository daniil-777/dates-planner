/**
 * Memories.
 *
 * The bulk of this file is the anniversary calendar and the ordering rule —
 * the two pieces of logic with edge cases (leap days, an anniversary that is
 * today, one that just passed) and the rule that makes the pinned section a
 * section. The render pass at the bottom is a guard against the page wiring
 * itself to the wrong shape of data.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense, Memory } from '@/api/types'
import MemoriesPage from './MemoriesPage'
import {
  computeAnniversaries,
  nextAnniversary,
  type AnniversarySeed,
} from './memories/anniversaries'
import { clampToMonth, isLeapYear, parseSwissDate, toIsoDate } from './memories/dates'
import {
  buildTimeline,
  groupByMonth,
  sortTimelineEntries,
  splitPinned,
  undocumentedExpenses,
  type TimelineEntry,
} from './memories/timeline'

/* ------------------------------------------------------------------ *
 *  Fixtures
 * ------------------------------------------------------------------ */

function memory(overrides: Partial<Memory> & Pick<Memory, 'ID'>): Memory {
  return {
    expense_ID: null,
    title: 'A memory',
    note: null,
    occurredOn: '2026-05-01',
    kind: 'date_night',
    pinned: false,
    place: null,
    lat: null,
    lon: null,
    ...overrides,
  }
}

function expense(overrides: Partial<Expense> & Pick<Expense, 'ID'>): Expense {
  return {
    date: '2026-05-01',
    time: null,
    merchantRaw: 'RESTAURANT BLAUE ENTE',
    merchantNorm: 'restaurant blaue ente',
    amount: 148.5,
    currency: 'CHF',
    category_code: 'Dining',
    categoryConfidence: 0.98,
    moment: 'date_night',
    momentConfidence: 0.9,
    paidBy_ID: 'person-a',
    event_ID: null,
    status: 'confirmed',
    source: 'manual',
    note: null,
    place: null,
    lat: null,
    lon: null,
    receipt_ID: null,
    documentNumber: null,
    settlement_ID: null,
    ...overrides,
  }
}

function entry(overrides: Partial<TimelineEntry> & Pick<TimelineEntry, 'key'>): TimelineEntry {
  return {
    source: 'memory',
    memoryID: overrides.key,
    expenseID: null,
    title: 'Entry',
    date: '2026-05-01',
    kind: 'date_night',
    pinned: false,
    note: null,
    place: null,
    lat: null,
    lon: null,
    amount: null,
    currency: 'CHF',
    photos: [],
    isDocumentOne: false,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 *  Anniversaries
 * ------------------------------------------------------------------ */

describe('nextAnniversary', () => {
  it('counts the days to the next recurrence', () => {
    // Document #1 in CONTRACTS §10, seen from a September.
    expect(nextAnniversary('2024-06-15', '2026-09-01')).toEqual({
      nextDate: '2027-06-15',
      years: 3,
      daysUntil: 287,
    })
  })

  it('reports an anniversary that falls today as today, not as a year away', () => {
    expect(nextAnniversary('2024-06-15', '2026-06-15')).toEqual({
      nextDate: '2026-06-15',
      years: 2,
      daysUntil: 0,
    })
  })

  it('rolls to next year the day after it passes', () => {
    const justPassed = nextAnniversary('2024-06-15', '2026-06-16')
    expect(justPassed).toEqual({ nextDate: '2027-06-15', years: 3, daysUntil: 364 })
  })

  it('never returns a zeroth anniversary for a memory written today', () => {
    const sameDay = nextAnniversary('2026-09-01', '2026-09-01')
    expect(sameDay?.years).toBe(1)
    expect(sameDay?.nextDate).toBe('2027-09-01')
  })

  describe('leap years', () => {
    it('keeps 29 February on 29 February when the year has one', () => {
      expect(nextAnniversary('2024-02-29', '2028-01-01')).toEqual({
        nextDate: '2028-02-29',
        years: 4,
        daysUntil: 59,
      })
    })

    it('falls back to 28 February in a common year rather than spilling into March', () => {
      expect(nextAnniversary('2024-02-29', '2026-01-01')).toEqual({
        nextDate: '2026-02-28',
        years: 2,
        daysUntil: 58,
      })
    })

    it('treats 28 February as the anniversary day itself in a common year', () => {
      expect(nextAnniversary('2024-02-29', '2027-02-28')).toEqual({
        nextDate: '2027-02-28',
        years: 3,
        daysUntil: 0,
      })
    })

    it('rolls a leap-day anniversary forward once 28 February has passed', () => {
      expect(nextAnniversary('2024-02-29', '2027-03-01')).toEqual({
        nextDate: '2028-02-29',
        years: 4,
        daysUntil: 365,
      })
    })

    it('crosses a leap day correctly when counting days', () => {
      // Both spans contain 29 February 2028, so each is 365 days where a
      // common year would give 364.
      expect(nextAnniversary('2024-06-15', '2027-06-16')?.daysUntil).toBe(365)
      expect(nextAnniversary('2024-03-15', '2027-03-16')?.daysUntil).toBe(365)
      // The same span one year later, with no leap day in it.
      expect(nextAnniversary('2024-03-15', '2028-03-16')?.daysUntil).toBe(364)
    })

    it('agrees with the century rule', () => {
      expect(isLeapYear(2024)).toBe(true)
      expect(isLeapYear(2026)).toBe(false)
      expect(isLeapYear(1900)).toBe(false)
      expect(isLeapYear(2000)).toBe(true)
      expect(toIsoDate(clampToMonth(1900, 2, 29))).toBe('1900-02-28')
      expect(toIsoDate(clampToMonth(2000, 2, 29))).toBe('2000-02-29')
    })
  })

  it('rejects a date that is not a calendar date', () => {
    expect(nextAnniversary('2026-02-30', '2026-01-01')).toBeNull()
    expect(nextAnniversary('not-a-date', '2026-01-01')).toBeNull()
  })
})

describe('computeAnniversaries', () => {
  const seeds: AnniversarySeed[] = [
    { ID: 'doc1', title: 'Document #1', occurredOn: '2024-06-15', source: 'document-one' },
    { ID: 'm1', title: 'Lucerne', occurredOn: '2025-09-14', source: 'memory' },
    { ID: 'm2', title: 'Ascona', occurredOn: '2025-09-02', source: 'memory' },
    { ID: 'bad', title: 'Broken', occurredOn: '', source: 'memory' },
  ]

  it('orders by how soon the anniversary is and drops unparseable dates', () => {
    const result = computeAnniversaries(seeds, '2026-09-01')
    expect(result.map(item => item.ID)).toEqual(['m2', 'm1', 'doc1'])
    expect(result[0].daysUntil).toBe(1)
    expect(result[0].years).toBe(1)
    expect(result[2].daysUntil).toBe(287)
  })

  it('puts Document #1 first when two anniversaries land on the same day', () => {
    const sameDay: AnniversarySeed[] = [
      { ID: 'm9', title: 'Aare swim', occurredOn: '2025-09-01', source: 'memory' },
      { ID: 'doc1', title: 'Document #1', occurredOn: '2024-09-01', source: 'document-one' },
    ]
    const result = computeAnniversaries(sameDay, '2026-09-01')
    expect(result.map(item => item.ID)).toEqual(['doc1', 'm9'])
    expect(result.every(item => item.daysUntil === 0)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  Ordering
 * ------------------------------------------------------------------ */

describe('sortTimelineEntries', () => {
  it('floats pinned items above everything, however old they are', () => {
    const sorted = sortTimelineEntries([
      entry({ key: 'recent', date: '2026-08-30' }),
      entry({ key: 'ancient-pin', date: '2019-01-04', pinned: true }),
      entry({ key: 'older', date: '2026-02-11' }),
      entry({ key: 'newer-pin', date: '2026-07-01', pinned: true }),
    ])
    expect(sorted.map(item => item.key)).toEqual(['newer-pin', 'ancient-pin', 'recent', 'older'])
  })

  it('sorts each block newest first and breaks ties deterministically', () => {
    const sorted = sortTimelineEntries([
      entry({ key: 'b', title: 'Bellinzona', date: '2026-05-01' }),
      entry({ key: 'a', title: 'Aarau', date: '2026-05-01' }),
      entry({ key: 'c', title: 'Chur', date: '2026-05-02' }),
    ])
    expect(sorted.map(item => item.title)).toEqual(['Chur', 'Aarau', 'Bellinzona'])
  })

  it('does not mutate its input', () => {
    const input = [entry({ key: 'x', date: '2020-01-01' }), entry({ key: 'y', pinned: true })]
    const before = input.map(item => item.key)
    sortTimelineEntries(input)
    expect(input.map(item => item.key)).toEqual(before)
  })
})

describe('splitPinned', () => {
  it('separates the pinned section from the month groups', () => {
    const { pinned, rest } = splitPinned([
      entry({ key: 'p', date: '2020-04-04', pinned: true }),
      entry({ key: 'r', date: '2026-04-04' }),
    ])
    expect(pinned.map(item => item.key)).toEqual(['p'])
    expect(rest.map(item => item.key)).toEqual(['r'])
  })
})

/* ------------------------------------------------------------------ *
 *  Timeline assembly
 * ------------------------------------------------------------------ */

describe('buildTimeline', () => {
  it('folds a linked expense into its memory and lends it the amount', () => {
    const linked = expense({ ID: 'e1', amount: 212.4, place: 'Zürich' })
    const written = memory({ ID: 'm1', expense_ID: 'e1', title: 'Blaue Ente', pinned: true })
    const timeline = buildTimeline([written], [linked])

    expect(timeline).toHaveLength(1)
    expect(timeline[0].source).toBe('memory')
    expect(timeline[0].amount).toBe(212.4)
    expect(timeline[0].place).toBe('Zürich')
    expect(timeline[0].pinned).toBe(true)
  })

  it('keeps memorable expenses that nobody wrote up, and ignores everyday ones', () => {
    const timeline = buildTimeline(
      [],
      [
        expense({ ID: 'e1', moment: 'trip', date: '2026-07-04' }),
        expense({ ID: 'e2', moment: 'everyday', date: '2026-07-05' }),
        expense({ ID: 'e3', moment: null, date: '2026-07-06' }),
        expense({ ID: 'e4', moment: 'gift', date: '2026-07-07' }),
      ],
    )
    expect(timeline.map(item => item.expenseID)).toEqual(['e4', 'e1'])
    expect(timeline.every(item => item.source === 'expense')).toBe(true)
  })

  it('flags Document #1 wherever it appears', () => {
    const first = expense({ ID: 'e0', documentNumber: 1, date: '2024-06-15' })
    expect(buildTimeline([], [first])[0].isDocumentOne).toBe(true)
    expect(
      buildTimeline([memory({ ID: 'm0', expense_ID: 'e0', occurredOn: '2024-06-15' })], [first])[0]
        .isDocumentOne,
    ).toBe(true)
  })

  it('groups by month, newest month first', () => {
    const groups = groupByMonth(
      buildTimeline(
        [
          memory({ ID: 'a', occurredOn: '2026-08-02' }),
          memory({ ID: 'b', occurredOn: '2026-08-20' }),
          memory({ ID: 'c', occurredOn: '2026-06-01' }),
        ],
        [],
      ),
    )
    expect(groups.map(group => group.label)).toEqual(['August 2026', 'June 2026'])
    expect(groups[0].entries.map(item => item.memoryID)).toEqual(['b', 'a'])
  })
})

describe('undocumentedExpenses', () => {
  it('lists only recent memorable expenses with no memory behind them', () => {
    const rows = undocumentedExpenses(
      [memory({ ID: 'm1', expense_ID: 'written' })],
      [
        expense({ ID: 'written', moment: 'trip', date: '2026-08-20' }),
        expense({ ID: 'fresh', moment: 'date_night', date: '2026-08-25' }),
        expense({ ID: 'boring', moment: 'everyday', date: '2026-08-26' }),
        expense({ ID: 'stale', moment: 'gift', date: '2025-01-01' }),
      ],
      '2026-09-01',
    )
    expect(rows.map(row => row.ID)).toEqual(['fresh'])
  })
})

/* ------------------------------------------------------------------ *
 *  Date entry
 * ------------------------------------------------------------------ */

describe('parseSwissDate', () => {
  it('reads what the DatePicker writes and rejects impossible days', () => {
    expect(parseSwissDate('15.06.2024')).toBe('2024-06-15')
    expect(parseSwissDate('1.6.2024')).toBe('2024-06-01')
    expect(parseSwissDate('29.02.2024')).toBe('2024-02-29')
    expect(parseSwissDate('29.02.2026')).toBeNull()
    expect(parseSwissDate('2024-06-15')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  The page
 * ------------------------------------------------------------------ */

/**
 * UI5's Timeline observes its items to decide when to fire `load-more`, and
 * jsdom ships no IntersectionObserver. The shared test setup shims matchMedia
 * and ResizeObserver but not this one, so it is shimmed here rather than in a
 * file this page does not own.
 */
class NoopIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver =
    NoopIntersectionObserver as unknown as typeof IntersectionObserver
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** Wire rows: OData sends decimals as strings, which the client coerces. */
const WIRE_EXPENSES = [
  {
    ID: 'e1',
    documentNumber: 12,
    date: '2026-08-12',
    time: null,
    merchantRaw: 'RESTAURANT BLAUE ENTE',
    merchantNorm: 'restaurant blaue ente',
    amount: '212.40',
    currency: 'CHF',
    category_code: 'Dining',
    categoryConfidence: '0.9871',
    moment: 'date_night',
    momentConfidence: '0.9102',
    paidBy_ID: 'pa',
    event_ID: null,
    status: 'confirmed',
    source: 'scan',
    note: null,
    place: 'Zürich',
    lat: 47.3661,
    lon: 8.5504,
    receipt_ID: null,
    settlement_ID: null,
  },
  {
    ID: 'e2',
    documentNumber: 13,
    date: '2026-08-28',
    time: null,
    merchantRaw: 'KINO ABATON',
    merchantNorm: 'kino abaton',
    amount: '46.00',
    currency: 'CHF',
    category_code: 'Entertainment',
    categoryConfidence: '0.81',
    moment: 'date_night',
    momentConfidence: '0.74',
    paidBy_ID: 'pb',
    event_ID: null,
    status: 'confirmed',
    source: 'scan',
    note: null,
    place: null,
    lat: null,
    lon: null,
    receipt_ID: null,
    settlement_ID: null,
  },
  {
    ID: 'e0',
    documentNumber: 1,
    date: '2024-06-15',
    time: '19:30:00',
    merchantRaw: 'The place where it started',
    merchantNorm: 'the place where it started',
    amount: '0.00',
    currency: 'CHF',
    category_code: 'Dining',
    categoryConfidence: '1.0000',
    moment: 'date_night',
    momentConfidence: '1.0000',
    paidBy_ID: 'pa',
    event_ID: null,
    status: 'confirmed',
    source: 'manual',
    note: 'Document #1. Everything since has been a follow-up posting.',
    place: 'The place where it started',
    lat: null,
    lon: null,
    receipt_ID: null,
    settlement_ID: null,
  },
]

const WIRE_MEMORIES = [
  {
    ID: 'm1',
    expense_ID: 'e1',
    title: 'Blaue Ente',
    note: 'Walked all the way home along the lake afterwards.',
    occurredOn: '2026-08-12',
    kind: 'date_night',
    pinned: true,
    place: 'Zürich',
    lat: 47.3661,
    lon: 8.5504,
    photos: [{ ID: 'p1', mediaType: 'image/jpeg', caption: 'The lake' }],
  },
  {
    ID: 'm2',
    expense_ID: null,
    title: 'Ascona weekend',
    note: null,
    occurredOn: '2026-06-02',
    kind: 'trip',
    pinned: false,
    place: 'Ascona',
    lat: 46.1547,
    lon: 8.7739,
  },
]

const WIRE_PEOPLE = [
  { ID: 'pa', name: 'Ada', colour: '#0070F2', isDefault: true },
  { ID: 'pb', name: 'Bruno', colour: '#F31DED', isDefault: true },
  { ID: 'pc', name: 'Noemi', colour: '#049F9A', isDefault: false },
]

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoriesPage />
    </QueryClientProvider>,
  )
}

const settled = () =>
  waitFor(() => expect(document.querySelector('.tw-anniversary')).not.toBeNull())

describe('MemoriesPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/Memories')) return ok({ value: WIRE_MEMORIES })
        if (url.includes('/Expenses')) return ok({ value: WIRE_EXPENSES })
        if (url.includes('/People')) return ok({ value: WIRE_PEOPLE })
        return ok({ value: [] })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders one pinned timeline and one grouped by month, newest month first', async () => {
    renderPage()
    await settled()

    const titles = [...document.querySelectorAll('ui5-timeline-item')].map(item =>
      item.getAttribute('title-text'),
    )
    expect(titles[0]).toBe('Blaue Ente')
    expect(titles).toContain('Ascona weekend')

    const months = [...document.querySelectorAll('ui5-timeline-group-item')].map(group =>
      group.getAttribute('group-name'),
    )
    expect(months).toEqual(['August 2026', 'June 2026', 'June 2024'])

    // Two timelines: the pinned section and the single spine of month groups.
    expect(document.querySelectorAll('ui5-timeline')).toHaveLength(2)
    expect(screen.getByText('Pinned')).toBeInTheDocument()
  })

  it('nudges about the memorable expense nobody wrote up, and flags Document #1', async () => {
    renderPage()
    await settled()

    expect(screen.getByText('New memories detected')).toBeInTheDocument()
    expect(screen.getByText('Kino Abaton')).toBeInTheDocument()
    // The written-up dinner is not nudged about a second time.
    expect(screen.queryByText('Restaurant Blaue Ente')).toBeNull()
    expect(screen.getByText('#1')).toBeInTheDocument()
    // The linked expense lends the memory its amount, in Swiss format.
    expect(screen.getByText(/212/)).toBeInTheDocument()
  })

  it('reveals Document #1 as a receipt', async () => {
    renderPage()
    await settled()

    fireEvent.click(screen.getByText('Open Document #1'))
    await waitFor(() =>
      expect(
        screen.getByText('Document 1 · 15 June 2024 · The place where it started'),
      ).toBeInTheDocument(),
    )
    // The note also shows as an excerpt on the timeline item, so scope to the slip.
    expect(document.querySelector('.tw-receipt__note')?.textContent).toBe(
      'Document #1. Everything since has been a follow-up posting.',
    )
    expect(screen.getByText('Thank you for your continued business')).toBeInTheDocument()
  })

  it('opens the editor with every memory kind, and the map with real pins', async () => {
    renderPage()
    await settled()

    fireEvent.click(screen.getByText('New'))
    await waitFor(() => expect(document.querySelector('.tw-editor')).not.toBeNull())
    expect(
      [...document.querySelectorAll('ui5-option')].map(option => option.getAttribute('value')),
    ).toEqual(['date_night', 'trip', 'gift', 'anniversary', 'other'])
    fireEvent.click(screen.getAllByText('Cancel')[0])

    fireEvent.click(screen.getByText('Map'))
    await waitFor(() => expect(document.querySelector('.leaflet-container')).not.toBeNull(), {
      timeout: 5000,
    })
    // Markers are div icons, never the default asset that bundlers break.
    await waitFor(() => expect(document.querySelectorAll('.tw-pin').length).toBeGreaterThan(0))
    expect(document.querySelector('img.leaflet-marker-icon')).toBeNull()
  })
})
