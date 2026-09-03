/**
 * Home — the launcher of FRONTEND-CONTRACT §8.
 *
 * Four claims are worth a test, and they are the four the contract makes. The grid offers
 * every destination, as links, so a keyboard and a screen reader get there the same way a
 * thumb does. A tile carries a **live figure** from the API rather than a label alone. A
 * figure that failed leaves the tile with its label and no number — never an error, because
 * one dead request must not cost you the other six destinations. And the strip underneath
 * knows what is coming, including the one date this ledger is built around.
 *
 * The rest is the arithmetic behind the strip, tested directly: it has edge cases (a trip
 * arrives once per day it covers, a ticked-off reminder is not "upcoming") that would be
 * miserable to pin down through the DOM.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type {
  CalendarEntry,
  Event,
  Expense,
  Memory,
  PeriodTotals,
  Person,
  Statement,
} from '@/api/types'

/* ------------------------------------------------------------------ *
 *  The fixtures the mocked hooks read from
 * ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  expenses: [] as Expense[],
  totals: undefined as PeriodTotals | undefined,
  events: [] as Event[],
  upcoming: [] as CalendarEntry[],
  memories: [] as Memory[],
  statements: [] as Statement[],
  people: [] as Person[],
  /** Query names whose request failed, and ones still in flight. */
  failing: new Set<string>(),
  pending: new Set<string>(),
}))

vi.mock('@/api/hooks', () => {
  const query = <T,>(name: string, data: T) => {
    const isPending = state.pending.has(name)
    const isError = state.failing.has(name)
    return {
      data: isPending || isError ? undefined : data,
      isPending,
      isLoading: isPending,
      isFetching: isPending,
      isError,
      error: isError ? new Error(`${name} is down`) : null,
      refetch: vi.fn(),
    }
  }
  return {
    useExpenses: () => query('expenses', state.expenses),
    usePeriodTotals: () => query('periodTotals', state.totals),
    useEvents: () => query('events', state.events),
    useUpcoming: () => query('upcoming', state.upcoming),
    useMemories: () => query('memories', state.memories),
    useStatements: () => query('statements', state.statements),
    usePeople: () => query('people', state.people),
  }
})

import { HomePage } from './HomePage'
import { todayIso } from './events/dates'
import { HOME_TILES } from './home/tiles'
import {
  calendarFigure,
  draftsFigure,
  figureFrom,
  statementFigure,
  type Figure,
} from './home/figures'
import { addIsoDays, buildNextUp, countdownLabel } from './home/nextUp'

const TODAY = todayIso()
const inDays = (days: number): string => addIsoDays(TODAY, days)

const ADA: Person = { ID: 'p-1', name: 'Ada Lovelace', colour: '#0070F2', isDefault: true }
const GRACE: Person = { ID: 'p-2', name: 'Grace Hopper', colour: '#F31DED', isDefault: true }

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    ID: 'x-1',
    date: TODAY,
    time: null,
    merchantRaw: 'MIGROS ZUERICH HB',
    merchantNorm: 'migros zuerich hb',
    amount: 42.5,
    currency: 'CHF',
    category_code: 'Groceries',
    categoryConfidence: 0.97,
    moment: 'everyday',
    momentConfidence: 0.91,
    paidBy_ID: ADA.ID,
    event_ID: null,
    status: 'confirmed',
    source: 'scan',
    note: null,
    place: null,
    lat: null,
    lon: null,
    receipt_ID: null,
    documentNumber: 42,
    settlement_ID: null,
    ...overrides,
  }
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    ID: 'm-1',
    expense_ID: null,
    title: 'A walk up the Uetliberg',
    note: null,
    occurredOn: '2025-05-04',
    kind: 'other',
    pinned: false,
    place: null,
    lat: null,
    lon: null,
    ...overrides,
  }
}

function entry(overrides: Partial<CalendarEntry> & { ID: string }): CalendarEntry {
  return {
    kind: 'event',
    date: TODAY,
    endsOn: null,
    title: 'Something',
    place: null,
    eventId: overrides.ID,
    onlyYou: false,
    leadDays: null,
    done: null,
    ...overrides,
  }
}

/** A household that has been using the app for a while. */
function seedHappyPath(): void {
  state.expenses = [
    expense({ ID: 'x-1', status: 'draft', documentNumber: null }),
    expense({ ID: 'x-2', status: 'draft', documentNumber: null }),
    expense({ ID: 'x-3' }),
  ]
  state.totals = {
    period: '2026-09',
    grandTotal: 460.35,
    count: 3,
    byPerson: [
      { personId: ADA.ID, name: ADA.name, paid: 300.35, count: 2, share: 0.6524 },
      { personId: GRACE.ID, name: GRACE.name, paid: 160, count: 1, share: 0.3476 },
    ],
  }
  state.events = [
    {
      ID: 'e-1',
      name: 'Engadin Between the Years',
      startsOn: inDays(30),
      endsOn: inDays(33),
      place: 'Pontresina',
      note: null,
      participants: [ADA, GRACE],
    },
  ]
  state.upcoming = [
    entry({
      ID: 'r-1',
      kind: 'reminder',
      date: inDays(2),
      title: 'Engadin Between the Years',
      eventId: 'e-1',
      leadDays: 28,
      done: false,
    }),
    entry({
      ID: 'e-1',
      date: inDays(30),
      endsOn: inDays(33),
      title: 'Engadin Between the Years',
      place: 'Pontresina',
    }),
  ]
  state.memories = [memory({ ID: 'm-1' }), memory({ ID: 'm-2' }), memory({ ID: 'm-3' })]
  state.statements = [
    {
      ID: 's-1',
      year: 2025,
      contentMarkdown: '# 2025',
      generatedAt: '2026-01-02',
      engine: 'template',
    },
    {
      ID: 's-2',
      year: 2026,
      contentMarkdown: '# 2026',
      generatedAt: '2027-01-02',
      engine: 'template',
    },
  ]
  state.people = [ADA, GRACE]
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <HomePage />
    </MemoryRouter>,
  )
}

const tile = (id: string): HTMLElement => screen.getByTestId(`home-tile-${id}`)

beforeEach(() => {
  state.failing.clear()
  state.pending.clear()
  seedHappyPath()
})

/* ------------------------------------------------------------------ *
 *  The grid
 * ------------------------------------------------------------------ */

describe('the home grid', () => {
  it('offers one tile per destination, each a real link', () => {
    renderHome()

    expect(HOME_TILES.map(spec => spec.to)).toEqual([
      '/scan',
      '/mood',
      '/ledger',
      '/events',
      '/calendar',
      '/memories',
      '/statement',
      '/settings',
      '/chat',
      '/how-it-works',
    ])

    for (const spec of HOME_TILES) {
      const cell = tile(spec.id)
      expect(cell.tagName).toBe('A')
      expect(cell).toHaveAttribute('href', spec.to)
      expect(within(cell).getByText(spec.label)).toBeInTheDocument()
    }

    expect(screen.getAllByTestId(/^home-tile-/)).toHaveLength(HOME_TILES.length)
  })

  it('gives every tile its own accent from the palette, and never invents one', () => {
    // CONTRACTS §1.1 fixes these ten; §8 asks for tiles that are not a wall of one blue.
    const palette = new Set([
      '#0070F2',
      '#E76500',
      '#A45D00',
      '#7858FF',
      '#049F9A',
      '#F31DED',
      '#5B738B',
      '#D20A0A',
      '#C87200',
      '#256F3A',
    ])
    const accents = HOME_TILES.map(spec => spec.accent)
    for (const accent of accents) expect(palette.has(accent)).toBe(true)
    expect(new Set(accents).size).toBe(HOME_TILES.length)
  })

  it('shows the live figure each tile is for', () => {
    renderHome()

    // Ledger: this month's total, in Swiss money, from periodTotals().
    expect(within(tile('ledger')).getByTestId('money')).toHaveTextContent('CHF 460.35')

    // Scan: the drafts waiting to be posted.
    expect(within(tile('scan')).getByText('2')).toBeInTheDocument()
    expect(within(tile('scan')).getByText('drafts to post')).toBeInTheDocument()

    // Events: how many are running or still to come.
    expect(within(tile('events')).getByText('1')).toBeInTheDocument()
    expect(within(tile('events')).getByText('current or upcoming')).toBeInTheDocument()

    // Calendar: the next reminder, with its countdown.
    expect(within(tile('calendar')).getByText('in 2 days')).toBeInTheDocument()
    expect(
      within(tile('calendar')).getByText('Reminder · Engadin Between the Years'),
    ).toBeInTheDocument()

    // Memories, Statement, Settings.
    expect(within(tile('memories')).getByText('3')).toBeInTheDocument()
    expect(within(tile('statement')).getByText('2026')).toBeInTheDocument()
    expect(within(tile('settings')).getByText('2')).toBeInTheDocument()
  })

  it('counts the Memories tile the way the Memories page counts its own header', () => {
    // The timeline is memories *plus* the memorable expenses no memory has absorbed
    // (`buildTimeline`). Counting raw Memories rows here made the tile say "1 entry" and
    // the page it opens say "10 entries" — one tap apart, same word, different number.
    state.expenses = [
      ...state.expenses,
      expense({ ID: 'x-4', moment: 'date_night', documentNumber: null }),
      expense({ ID: 'x-5', moment: 'trip', documentNumber: null }),
    ]

    renderHome()

    // Three memories and two memorable expenses that no memory claims.
    expect(within(tile('memories')).getByText('5')).toBeInTheDocument()
    expect(within(tile('memories')).getByText('entries')).toBeInTheDocument()
  })

  it('holds the Memories figure until both of its reads have landed', () => {
    // It needs memories and expenses. Printing the memories half alone would show a
    // number that jumps the moment the postings arrive.
    state.pending.add('expenses')
    renderHome()

    expect(within(tile('memories')).getByTestId('home-tile-shimmer')).toBeInTheDocument()
    expect(tile('memories')).toHaveAttribute('href', '/memories')
  })

  it('invites a first receipt when nothing is waiting', () => {
    state.expenses = [expense({ ID: 'x-3' })]
    renderHome()
    expect(within(tile('scan')).getByText('Post a receipt')).toBeInTheDocument()
  })

  it('draws a skeleton in every figure that is still loading, never a blank grid', () => {
    for (const name of [
      'expenses',
      'periodTotals',
      'events',
      'upcoming',
      'memories',
      'statements',
      'people',
    ])
      state.pending.add(name)

    renderHome()

    // Every tile whose figure is still in flight shimmers. Two exceptions by design, both
    // constants with nothing to wait for: the write-up tile (the article is a static
    // asset) and the mood tile (its figure is an invitation, not a number) — shimmering
    // on either would be a lie.
    // ...and the chat tile, whose figure is an invitation too: there is no unread count
    // until the app keeps a read marker.
    const STATIC_FIGURES = new Set(['howItWorks', 'mood', 'chat'])
    const awaited = HOME_TILES.filter(spec => !STATIC_FIGURES.has(spec.id))
    expect(screen.getAllByTestId('home-tile-shimmer')).toHaveLength(awaited.length)
    expect(tile('howItWorks')).not.toHaveAttribute('aria-busy', 'true')
    expect(tile('mood')).not.toHaveAttribute('aria-busy', 'true')
    expect(tile('chat')).not.toHaveAttribute('aria-busy', 'true')
    // The destinations are reachable while their numbers are still in the post.
    expect(tile('ledger')).toHaveAttribute('href', '/ledger')
    expect(tile('ledger')).toHaveAttribute('aria-busy', 'true')
  })

  it('drops the number and keeps the tile when a figure fails', () => {
    state.failing.add('statements')
    renderHome()

    const failed = tile('statement')
    expect(within(failed).getByText('Statement')).toBeInTheDocument()
    expect(failed.textContent ?? '').not.toMatch(/\d/)
    expect(within(failed).queryByTestId('home-tile-shimmer')).toBeNull()

    // The other six are unaffected, and nothing on the page shouts about it.
    expect(within(tile('memories')).getByText('3')).toBeInTheDocument()
    expect(screen.queryByTestId('error-state')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  Next up
 * ------------------------------------------------------------------ */

describe('the next-up strip', () => {
  it('leads with the nearest thing and counts down to it', () => {
    renderHome()

    const strip = screen.getByTestId('next-up')
    const rows = within(strip).getAllByRole('link')
    // The first link is the "Calendar" shortcut in the heading; the entries follow.
    const lead = within(strip).getAllByTestId('next-up-reminder')[0]
    expect(lead).toHaveTextContent('Engadin Between the Years')
    expect(lead).toHaveTextContent('in 2 days')
    expect(lead).toHaveTextContent('28 days before it starts')
    expect(lead).toHaveAttribute('href', '/events/e-1')
    expect(rows.length).toBeGreaterThan(1)
  })

  it('puts Document #1 on the strip when its anniversary is near', () => {
    const anniversary = inDays(9)
    state.expenses = [
      expense({
        ID: 'x-doc-1',
        documentNumber: 1,
        // Two years ago, on the same day of the year as nine days from now.
        date: `${Number(anniversary.slice(0, 4)) - 2}${anniversary.slice(4)}`,
        place: 'The place where it started',
      }),
    ]
    renderHome()

    const strip = screen.getByTestId('next-up')
    expect(within(strip).getByText('Document #1')).toBeInTheDocument()
    expect(within(strip).getByTestId('next-up-anniversary')).toHaveTextContent('anniversary')
  })

  it('says so plainly when the diary is empty', () => {
    state.upcoming = []
    state.expenses = []
    state.memories = []
    renderHome()

    expect(screen.getByText(/Nothing in the next 90 days/)).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ *
 *  The arithmetic behind the strip
 * ------------------------------------------------------------------ */

describe('buildNextUp', () => {
  const base = { anniversaries: [], today: TODAY }

  it('collapses a multi-day event to the day it starts', () => {
    const days = [0, 1, 2, 3].map(offset =>
      entry({
        ID: 'e-1',
        date: inDays(10 + offset),
        endsOn: inDays(13),
        title: 'Engadin Between the Years',
      }),
    )
    const items = buildNextUp({ ...base, entries: days })

    expect(items).toHaveLength(1)
    expect(items[0].date).toBe(inDays(10))
    expect(items[0].daysUntil).toBe(10)
  })

  it('calls a trip that has already started "on now"', () => {
    const items = buildNextUp({
      ...base,
      entries: [entry({ ID: 'e-9', date: TODAY, endsOn: inDays(3), title: 'Vals' })],
    })
    expect(items[0].running).toBe(true)
    expect(countdownLabel(items[0])).toBe('On now')
  })

  it('leaves a reminder that has been ticked off out of it', () => {
    const items = buildNextUp({
      ...base,
      entries: [
        entry({
          ID: 'r-1',
          kind: 'reminder',
          date: inDays(1),
          title: 'Book the train',
          done: true,
        }),
        entry({ ID: 'r-2', kind: 'reminder', date: inDays(4), title: 'Pack', done: false }),
      ],
    })
    expect(items.map(item => item.title)).toEqual(['Pack'])
  })

  it('puts the nudge before the thing it is a nudge about, on the same day', () => {
    const items = buildNextUp({
      ...base,
      entries: [
        entry({ ID: 'e-2', date: inDays(5), title: 'Kronenhalle' }),
        entry({ ID: 'r-3', kind: 'reminder', date: inDays(5), title: 'Kronenhalle', done: false }),
      ],
    })
    expect(items.map(item => item.kind)).toEqual(['reminder', 'event'])
  })

  it('keeps the badge on a surprise the current person created', () => {
    const items = buildNextUp({
      ...base,
      entries: [entry({ ID: 'e-3', date: inDays(6), title: 'Weekend in Vals', onlyYou: true })],
    })
    expect(items[0].onlyYou).toBe(true)
  })

  it('looks no further ahead than its horizon', () => {
    const items = buildNextUp({
      ...base,
      entries: [entry({ ID: 'e-4', date: inDays(200), title: 'Next summer' })],
    })
    expect(items).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 *  Figure states
 * ------------------------------------------------------------------ */

describe('figureFrom', () => {
  const read = (): Figure => ({ kind: 'text', value: '1', emphasis: 'number', caption: null })

  it('is loading only while nothing has arrived', () => {
    expect(figureFrom({ data: undefined, isPending: true, isError: false }, read).status).toBe(
      'loading',
    )
  })

  it('is unavailable when the request failed and there is nothing to fall back on', () => {
    expect(figureFrom({ data: undefined, isPending: false, isError: true }, read).status).toBe(
      'unavailable',
    )
  })

  it('shows the data it has even while a refetch is failing', () => {
    const figure = figureFrom({ data: [], isPending: false, isError: true }, read)
    expect(figure.status).toBe('ready')
  })
})

describe('the figures themselves', () => {
  it('counts one draft in the singular', () => {
    const figure = draftsFigure([expense({ status: 'draft' })])
    expect(figure).toMatchObject({ value: '1', caption: 'draft to post' })
  })

  it('says the diary is clear rather than showing a dash', () => {
    expect(calendarFigure([])).toMatchObject({ value: 'Clear' })
  })

  it('names the most recent year generated, whatever order they arrive in', () => {
    expect(
      statementFigure([
        { ID: 's-1', year: 2024, contentMarkdown: '', generatedAt: '', engine: 'template' },
        { ID: 's-2', year: 2026, contentMarkdown: '', generatedAt: '', engine: 'template' },
        { ID: 's-3', year: 2025, contentMarkdown: '', generatedAt: '', engine: 'template' },
      ]),
    ).toMatchObject({ value: '2026' })
  })

  it('does not pretend a statement exists before one has been written', () => {
    expect(statementFigure([])).toMatchObject({ value: 'Not yet' })
  })
})
