/**
 * Events.
 *
 * The date range and the roll-up are the only real arithmetic on the page, and both have edge
 * cases — a single-day dinner, a weekend that crosses a month, everyday spending that belongs
 * to no event at all. The render pass guards the claims the feature makes: that an empty list
 * is a real invitation rather than a blank screen, and that the detail page reports *sums*,
 * including a zero for somebody who was there and never reached for their wallet. Nothing on
 * this page is a debt, and one test says exactly that.
 *
 * CONTRACTS §11 adds three more claims worth pinning down:
 *
 *  - a **finished** event with no pictures asks for them by name — "Add the photos from
 *    Lisboa" — rather than reporting an absence;
 *  - the **lightbox** opens on a thumbnail and is driven from the keyboard, because a photo
 *    viewer you cannot leave with Escape is a trap;
 *  - the **"Only you can see this" badge belongs to the creator and to nobody else**. The
 *    service already withholds other people's surprises, so the test that matters is the
 *    negative one: an event marked `isSurprise` whose `createdBy_ID` is somebody else gets
 *    no badge and no Reveal, even when it somehow arrives in the payload.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Category, Event, EventPhoto, EventTotals, Expense, Person } from '@/api/types'

/* ------------------------------------------------------------------ *
 *  Fixtures the mocked hooks read from
 * ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  events: [] as Event[],
  expenses: [] as Expense[],
  people: [] as Person[],
  categories: [] as Category[],
  totals: undefined as EventTotals | undefined,
}))

vi.mock('@/api/hooks', () => {
  const query = <T,>(data: T) => ({
    data,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  })
  return {
    useEvents: () => query(state.events),
    useEvent: (id?: string) => query(state.events.find(event => event.ID === id)),
    useEventTotals: () => query(state.totals),
    useExpenses: (opts?: { event?: string }) =>
      query(
        opts?.event
          ? state.expenses.filter(expense => expense.event_ID === opts.event)
          : state.expenses,
      ),
    usePeople: () => query(state.people),
    useCategories: () => query(state.categories),
    useCreateEvent: mutation,
    useUpdateEvent: mutation,
    useDeleteEvent: mutation,
    useRevealSurprise: mutation,
    useAddEventPhoto: mutation,
    useDeleteEventPhoto: mutation,
  }
})

import { EventsPage } from './EventsPage'
import { formatDateRange, spanLabel, todayIso } from './events/dates'
import { isPastEvent, photoInvitation, sortPhotos } from './events/photos'
import {
  currencyOf,
  formatShare,
  participantLabel,
  postingsLabel,
  rollupByEvent,
  sectionEvents,
} from './events/summary'
import { isOwnSecret, isStillSecret, resolveViewer, surpriseLock } from './events/surprise'

const ADA: Person = { ID: 'p-1', name: 'Ada Lovelace', colour: '#0070F2', isDefault: true }
const GRACE: Person = { ID: 'p-2', name: 'Grace Hopper', colour: '#F31DED', isDefault: true }
const NOEMI: Person = { ID: 'p-3', name: 'Noemi Berger', colour: '#049F9A', isDefault: false }

const LISBON: Event = {
  ID: 'e-1',
  name: 'Lisbon Weekend',
  startsOn: '2026-04-10',
  endsOn: '2026-04-13',
  place: 'Lisboa',
  note: 'Booked late, as usual.',
  participants: [ADA, GRACE, NOEMI],
}

const DINNER: Event = {
  ID: 'e-2',
  name: 'Kronenhalle Dinner',
  startsOn: '2026-06-15',
  endsOn: null,
  place: 'Zürich',
  note: null,
  participants: [ADA, GRACE],
}

const CATEGORIES: Category[] = [
  { code: 'Travel', name: 'Travel', icon: 'flight', colour: '#049F9A', sortOrder: 50 },
  { code: 'Dining', name: 'Dining', icon: 'meal', colour: '#E76500', sortOrder: 20 },
]

const expense = (
  overrides: Partial<Expense> & Pick<Expense, 'ID' | 'date' | 'amount'>,
): Expense => ({
  time: null,
  merchantRaw: 'Merchant',
  merchantNorm: null,
  currency: 'CHF',
  category_code: 'Travel',
  categoryConfidence: 0.98,
  moment: 'trip',
  momentConfidence: 0.9,
  paidBy_ID: ADA.ID,
  event_ID: null,
  status: 'confirmed',
  source: 'scan',
  note: null,
  place: null,
  lat: null,
  lon: null,
  receipt_ID: null,
  documentNumber: null,
  settlement_ID: null,
  ...overrides,
})

const LISBON_POSTINGS: Expense[] = [
  expense({
    ID: 'x-1',
    date: '2026-04-08',
    amount: 640.4,
    merchantRaw: 'TAP AIR PORTUGAL',
    event_ID: 'e-1',
  }),
  expense({
    ID: 'x-2',
    date: '2026-04-10',
    amount: 360,
    merchantRaw: 'HOTEL DO CHIADO',
    event_ID: 'e-1',
    paidBy_ID: GRACE.ID,
  }),
  expense({
    ID: 'x-3',
    date: '2026-04-11',
    amount: 18,
    merchantRaw: 'PASTEIS DE BELEM',
    event_ID: 'e-1',
    category_code: 'Dining',
  }),
]

const ALL_POSTINGS: Expense[] = [
  ...LISBON_POSTINGS,
  expense({
    ID: 'x-4',
    date: '2026-06-15',
    amount: 214,
    merchantRaw: 'KRONENHALLE',
    event_ID: 'e-2',
    category_code: 'Dining',
  }),
  // Everyday spending: belongs to no event and must never land on a card.
  expense({ ID: 'x-5', date: '2026-06-02', amount: 42.5, merchantRaw: 'MIGROS' }),
]

/** What `eventTotals('e-1')` hands back — a roster, including the person who paid nothing. */
const LISBON_TOTALS: EventTotals = {
  eventId: 'e-1',
  name: 'Lisbon Weekend',
  grandTotal: 1018.4,
  perHead: 339.47,
  participantCount: 3,
  count: 3,
  byPerson: [
    { personId: ADA.ID, name: 'Ada Lovelace', paid: 658.4, count: 2, share: 0.6465 },
    { personId: GRACE.ID, name: 'Grace Hopper', paid: 360, count: 1, share: 0.3535 },
    { personId: NOEMI.ID, name: 'Noemi Berger', paid: 0, count: 0, share: 0 },
  ],
}

/**
 * A day offset from today, on the same local wall clock `todayIso()` reads.
 *
 * Every fixture below that has to be "still to come" is built from this rather than from a
 * literal date, because a test that quietly stops testing anything the moment the calendar
 * passes it is worse than no test at all.
 */
const isoFromToday = (days: number): string => {
  const day = new Date()
  day.setDate(day.getDate() + days)
  const month = String(day.getMonth() + 1).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`
}

/** Three pictures on the Lisbon trip, deliberately out of order — the gallery sorts them. */
const PHOTOS: EventPhoto[] = [
  {
    ID: 'ph-3',
    event_ID: 'e-1',
    mediaType: 'image/jpeg',
    caption: 'Pastéis, obviously',
    takenOn: '2026-04-13',
  },
  {
    ID: 'ph-1',
    event_ID: 'e-1',
    mediaType: 'image/jpeg',
    caption: 'Tram 28',
    takenOn: '2026-04-11',
  },
  { ID: 'ph-2', event_ID: 'e-1', mediaType: 'image/jpeg', caption: null, takenOn: '2026-04-12' },
]

/** A trip that has not happened yet, so the gallery is not allowed to nag about it. */
const ENGADIN: Event = {
  ID: 'e-4',
  name: 'Engadin Between the Years',
  startsOn: isoFromToday(60),
  endsOn: isoFromToday(63),
  place: 'Pontresina',
  note: null,
  participants: [ADA, GRACE],
}

/**
 * A hidden surprise. `createdBy_ID` defaults to Ada, who is also the person the app resolves
 * as "you" in these tests: nobody has touched the shell's person switcher, so the roster's
 * first `isDefault` stands in — the same fallback CONTRACTS §11.3 gives the backend.
 */
const surprise = (overrides: Partial<Event> = {}): Event => ({
  ID: 'e-3',
  name: 'Weekend in Vals',
  startsOn: isoFromToday(30),
  endsOn: isoFromToday(31),
  place: 'Vals',
  note: null,
  participants: [ADA, GRACE],
  isSurprise: true,
  createdBy_ID: ADA.ID,
  revealedAt: null,
  ...overrides,
})

function seed(overrides: Partial<typeof state> = {}): void {
  state.events = overrides.events ?? [LISBON, DINNER]
  state.expenses = overrides.expenses ?? ALL_POSTINGS
  state.people = overrides.people ?? [ADA, GRACE, NOEMI]
  state.categories = overrides.categories ?? CATEGORIES
  state.totals = 'totals' in overrides ? overrides.totals : LISBON_TOTALS
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/events/*" element={<EventsPage />} />
      </Routes>
    </MemoryRouter>,
  )

/** UI5 and the layout sprinkle non-breaking spaces; comparisons want plain ones. */
const flatten = (value: string | null | undefined) =>
  (value ?? '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim()

/* ------------------------------------------------------------------ *
 *  Dates
 * ------------------------------------------------------------------ */

describe('formatDateRange', () => {
  it('prints one date for a single-day event', () => {
    expect(formatDateRange('2026-06-15', null)).toBe('15 Jun 2026')
    expect(formatDateRange('2026-06-15', '2026-06-15')).toBe('15 Jun 2026')
  })

  it('says the month and the year once when the range stays inside them', () => {
    expect(formatDateRange('2026-04-10', '2026-04-13')).toBe('10 – 13 Apr 2026')
  })

  it('repeats the month across a month boundary, and the year across a new year', () => {
    expect(formatDateRange('2026-03-28', '2026-04-02')).toBe('28 Mar – 2 Apr 2026')
    expect(formatDateRange('2025-12-28', '2026-01-02')).toBe('28 Dec 2025 – 2 Jan 2026')
  })

  it('survives an event with no usable start date', () => {
    expect(formatDateRange(null, null)).toBe('—')
    expect(formatDateRange('not a date', '2026-04-13')).toBe('13 Apr 2026')
  })

  it('counts both ends of the span', () => {
    expect(spanLabel('2026-04-10', '2026-04-13')).toBe('4 days')
    expect(spanLabel('2026-06-15', null)).toBe('One day')
    expect(spanLabel('2024-02-28', '2024-03-01')).toBe('3 days')
  })
})

/* ------------------------------------------------------------------ *
 *  Roll-ups
 * ------------------------------------------------------------------ */

describe('rollupByEvent', () => {
  it('sums and counts the postings booked on each event', () => {
    const rollups = rollupByEvent(ALL_POSTINGS)
    expect(rollups.get('e-1')).toEqual({ count: 3, total: 1018.4 })
    expect(rollups.get('e-2')).toEqual({ count: 1, total: 214 })
  })

  it('leaves everyday spending out — an expense with no event belongs to no event', () => {
    const rollups = rollupByEvent(ALL_POSTINGS)
    expect(rollups.size).toBe(2)
    expect([...rollups.keys()]).not.toContain(null)
  })

  it('rounds once at the end, not on every addition', () => {
    const thirds = [0.005, 0.005, 0.005].map((amount, index) =>
      expense({ ID: `t-${index}`, date: '2026-01-01', amount, event_ID: 'e-9' }),
    )
    // Rounding each 0.005 first would give 0.03; one rounding of 0.015 gives 0.02.
    expect(rollupByEvent(thirds).get('e-9')).toEqual({ count: 3, total: 0.02 })
  })

  it('reads the currency off the postings and falls back to the default', () => {
    expect(currencyOf(ALL_POSTINGS)).toBe('CHF')
    expect(currencyOf([])).toBe('CHF')
    expect(currencyOf([expense({ ID: 'e', date: '2026-01-01', amount: 1, currency: 'EUR' })])).toBe(
      'EUR',
    )
  })
})

describe('sectionEvents', () => {
  it('keeps an event current until the end of its last day', () => {
    const sections = sectionEvents([LISBON, DINNER], '2026-04-13')
    expect(sections.current.map(event => event.ID)).toEqual(['e-1', 'e-2'])
    expect(sections.past).toEqual([])
  })

  it('moves it to the past the day after it ends, newest first', () => {
    const sections = sectionEvents([LISBON, DINNER], '2026-06-16')
    expect(sections.current).toEqual([])
    expect(sections.past.map(event => event.ID)).toEqual(['e-2', 'e-1'])
  })
})

describe('labels', () => {
  it('names the roster without ever assuming there are two people', () => {
    expect(participantLabel([])).toBe('Nobody yet')
    expect(participantLabel([ADA])).toBe('Ada Lovelace')
    expect(participantLabel([ADA, GRACE])).toBe('Ada Lovelace and Grace Hopper')
    expect(participantLabel([ADA, GRACE, NOEMI])).toBe('Ada Lovelace, Grace Hopper and 1 other')
  })

  it('counts postings in the singular where it should', () => {
    expect(postingsLabel(0)).toBe('No postings yet')
    expect(postingsLabel(1)).toBe('1 posting')
    expect(postingsLabel(3)).toBe('3 postings')
  })

  it('never shows a real contribution as nothing', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.0002)).toBe('<1%')
    expect(formatShare(0.6465)).toBe('65%')
  })
})

/* ------------------------------------------------------------------ *
 *  The list
 * ------------------------------------------------------------------ */

describe('/events', () => {
  it('renders a card per event with its dates, place, postings and total', () => {
    seed()
    renderAt('/events')

    const cards = screen.getAllByTestId('event-card')
    expect(cards).toHaveLength(2)

    const lisbon = cards.find(card => card.dataset.eventId === 'e-1')
    expect(lisbon).toBeDefined()
    const inLisbon = within(lisbon as HTMLElement)
    expect(inLisbon.getByText('Lisbon Weekend')).toBeInTheDocument()
    expect(inLisbon.getByText('10 – 13 Apr 2026')).toBeInTheDocument()
    expect(inLisbon.getByText('4 days')).toBeInTheDocument()
    expect(inLisbon.getByText('Lisboa')).toBeInTheDocument()
    expect(inLisbon.getByText('3 postings')).toBeInTheDocument()
    expect(flatten(inLisbon.getByTestId('money').textContent)).toBe("CHF 1'018.40")

    // Everyday spending is not on any card: 214.00, not 256.50.
    const dinner = cards.find(card => card.dataset.eventId === 'e-2') as HTMLElement
    expect(flatten(within(dinner).getByTestId('money').textContent)).toBe('CHF 214.00')
    expect(within(dinner).getByText('15 Jun 2026')).toBeInTheDocument()
  })

  it('draws one avatar per participant, no matter how many there are', () => {
    seed()
    renderAt('/events')

    const lisbon = screen
      .getAllByTestId('event-card')
      .find(card => card.dataset.eventId === 'e-1') as HTMLElement
    expect(within(lisbon).getAllByTestId('person-avatar')).toHaveLength(3)
    expect(within(lisbon).getByLabelText('Ada Lovelace, Grace Hopper and 1 other')).toBeVisible()
  })

  it('links each card to its own event', () => {
    seed()
    renderAt('/events')
    const lisbon = screen
      .getAllByTestId('event-card')
      .find(card => card.dataset.eventId === 'e-1') as HTMLAnchorElement
    expect(lisbon.getAttribute('href')).toBe('/events/e-1')
  })

  it('offers an illustrated invitation, not a blank screen, when there are none', () => {
    seed({ events: [], expenses: [] })
    const { container } = renderAt('/events')

    const empty = screen.getByTestId('empty-state')
    expect(empty).toBeInTheDocument()

    const message = container.querySelector('ui5-illustrated-message') as
      (HTMLElement & { titleText?: string }) | null
    expect(message?.titleText ?? message?.getAttribute('title-text')).toBe('No events yet')

    // The call to action lives in the light DOM, where a person can actually reach it.
    expect(within(empty).getByText('New event')).toBeInTheDocument()
    expect(screen.queryAllByTestId('event-card')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 *  One event
 * ------------------------------------------------------------------ */

describe('/events/:id', () => {
  it('reports the event total and posting count from eventTotals', () => {
    seed()
    renderAt('/events/e-1')

    expect(screen.getByTestId('event-detail')).toBeInTheDocument()
    expect(flatten(screen.getByTestId('event-total').textContent)).toBe("CHF 1'018.40")
    expect(screen.getByText(/3 postings · 3 participants/)).toBeInTheDocument()

    // Its own details, and everybody who was on it.
    expect(screen.getByText('Lisbon Weekend')).toBeInTheDocument()
    expect(screen.getByText('10 – 13 Apr 2026')).toBeInTheDocument()
    expect(screen.getByText('Booked late, as usual.')).toBeInTheDocument()
    const roster = screen.getByRole('list', { name: 'Ada Lovelace, Grace Hopper and 1 other' })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(3)
  })

  it('shows per-head as an average, with wording that cannot be read as a bill', () => {
    seed()
    renderAt('/events/e-1')

    const perHead = screen.getByTestId('per-head')
    expect(flatten(perHead.textContent)).toContain('CHF 339.47 each')
    expect(flatten(perHead.textContent)).toContain('an average, shown for scale')
    expect(flatten(perHead.textContent)).toContain('Nothing on this page is a bill')
  })

  it('keeps a participant who paid nothing on the roster, at zero', () => {
    seed()
    const { container } = renderAt('/events/e-1')

    const breakdown = screen.getByTestId('paid-breakdown')
    expect(within(breakdown).getAllByRole('listitem')).toHaveLength(3)

    const noemi = container.querySelector('[data-person-id="p-3"]') as HTMLElement
    expect(noemi).not.toBeNull()
    expect(within(noemi).getByText('Noemi Berger')).toBeInTheDocument()
    expect(flatten(within(noemi).getByTestId('money').textContent)).toBe('CHF 0.00')
    expect(within(noemi).getByText(/still here/i)).toBeInTheDocument()
  })

  it('draws each payer their own proportion bar, in their own colour', () => {
    seed()
    const { container } = renderAt('/events/e-1')

    const ada = container.querySelector('[data-person-id="p-1"]') as HTMLElement
    const bar = ada.querySelector('.ev-breakdown__fill') as HTMLElement
    expect(bar.style.width).toBe('64.65%')
    expect(bar.style.backgroundColor).toBe('rgb(0, 112, 242)')
    expect(within(ada).getByText('65%')).toBeInTheDocument()

    // A zero row gets no bar at all rather than a bar of width zero pretending to be one.
    const noemi = container.querySelector('[data-person-id="p-3"]') as HTMLElement
    expect(noemi.querySelector('.ev-breakdown__fill')).toBeNull()
  })

  it('lists the postings booked on the event, and nothing else', () => {
    seed()
    renderAt('/events/e-1')

    expect(screen.getByText('TAP AIR PORTUGAL')).toBeInTheDocument()
    expect(screen.getByText('HOTEL DO CHIADO')).toBeInTheDocument()
    expect(screen.getByText('PASTEIS DE BELEM')).toBeInTheDocument()
    expect(screen.queryByText('KRONENHALLE')).toBeNull()
    expect(screen.queryByText('MIGROS')).toBeNull()
  })

  it('says nothing about anybody owing anybody, anywhere on either screen', () => {
    seed()
    const list = renderAt('/events')
    const listText = flatten(list.container.textContent)
    list.unmount()

    seed()
    const detail = renderAt('/events/e-1')
    const detailText = flatten(detail.container.textContent)

    for (const text of [listText, detailText]) {
      expect(text).not.toMatch(/\bowe[sd]?\b/i)
      expect(text).not.toMatch(/\bbalance\b/i)
      expect(text).not.toMatch(/\bsettle up\b/i)
      expect(text).not.toMatch(/\bnet\b/i)
      expect(text).not.toMatch(/\bsplit\b/i)
    }
  })
})

/* ------------------------------------------------------------------ *
 *  Surprises — the rules, before the pixels
 * ------------------------------------------------------------------ */

describe('the surprise rules', () => {
  it('mirrors the server: an event stops being a secret on its own first day', () => {
    const base = { isSurprise: true, revealedAt: null, startsOn: '2026-10-17' }
    expect(isStillSecret(base, '2026-09-01')).toBe(true)
    // The day itself counts as arrived. There is nothing left to spoil by then, and an event
    // that stayed hidden through its own opening day would be missing on the day it mattered.
    expect(isStillSecret(base, '2026-10-17')).toBe(false)
    expect(isStillSecret(base, '2026-10-18')).toBe(false)
  })

  it('is over the moment it is revealed, whatever the dates say', () => {
    const revealed = {
      isSurprise: true,
      revealedAt: '2026-09-01T09:00:00Z',
      startsOn: '2026-12-27',
    }
    expect(isStillSecret(revealed, '2026-09-01')).toBe(false)
  })

  it('keeps an unreadable start date shut, the way the server does', () => {
    expect(isStillSecret({ isSurprise: true, revealedAt: null, startsOn: '' }, '2026-09-01')).toBe(
      true,
    )
  })

  it('leaves an ordinary event alone', () => {
    expect(
      isStillSecret({ isSurprise: false, revealedAt: null, startsOn: '2026-12-27' }, '2026-09-01'),
    ).toBe(false)
  })

  it('falls back to the first default person when nobody has been chosen', () => {
    expect(resolveViewer(null, [NOEMI, ADA, GRACE])?.ID).toBe(ADA.ID)
    expect(resolveViewer(null, [NOEMI])?.ID).toBe(NOEMI.ID)
    expect(resolveViewer(null, [])).toBeNull()
    // An explicit choice wins, and is re-read off the live roster so a rename follows.
    expect(resolveViewer(GRACE, [ADA, { ...GRACE, name: 'Grace B. Hopper' }])?.name).toBe(
      'Grace B. Hopper',
    )
  })

  it('badges the creator and nobody else — including when there is no creator at all', () => {
    const today = '2026-09-01'
    const mine = surprise({ createdBy_ID: ADA.ID, startsOn: '2026-10-17', endsOn: '2026-10-18' })
    expect(isOwnSecret(mine, ADA, today)).toBe(true)
    expect(isOwnSecret(mine, GRACE, today)).toBe(false)
    expect(isOwnSecret(mine, null, today)).toBe(false)
    expect(isOwnSecret({ ...mine, createdBy_ID: null }, ADA, today)).toBe(false)
  })

  it('says why the switch has stopped mattering', () => {
    expect(surpriseLock({ revealedAt: null, startsOn: '2026-12-27' }, '2026-09-01')).toBeNull()
    expect(surpriseLock({ revealedAt: null, startsOn: '2026-09-01' }, '2026-09-01')).toMatch(
      /day has arrived/i,
    )
    expect(
      surpriseLock({ revealedAt: '2026-08-01T00:00:00Z', startsOn: '2026-12-27' }, '2026-09-01'),
    ).toMatch(/revealed already/i)
  })
})

/* ------------------------------------------------------------------ *
 *  Photographs — the helpers
 * ------------------------------------------------------------------ */

describe('photo helpers', () => {
  it('counts an event as past only after its last day is over', () => {
    expect(isPastEvent({ startsOn: '2026-04-10', endsOn: '2026-04-13' }, '2026-04-13')).toBe(false)
    expect(isPastEvent({ startsOn: '2026-04-10', endsOn: '2026-04-13' }, '2026-04-14')).toBe(true)
    // A one-day dinner is still "now" on the evening it happens.
    expect(isPastEvent({ startsOn: '2026-06-15', endsOn: null }, '2026-06-15')).toBe(false)
    expect(isPastEvent(ENGADIN, todayIso())).toBe(false)
  })

  it('asks for the photos by the name they are filed under', () => {
    expect(photoInvitation(LISBON)).toBe('Add the photos from Lisboa')
    // No place: the event's own name is the next best handle.
    expect(photoInvitation({ name: 'Kronenhalle Dinner', place: null })).toBe(
      'Add the photos from Kronenhalle Dinner',
    )
    expect(photoInvitation({ name: '', place: '  ' })).toBe('Add the photos')
  })

  it('walks the album forwards through the trip, undated pictures last', () => {
    const undated: EventPhoto = {
      ID: 'ph-0',
      event_ID: 'e-1',
      mediaType: 'image/jpeg',
      caption: null,
      takenOn: null,
    }
    expect(sortPhotos([...PHOTOS, undated]).map(photo => photo.ID)).toEqual([
      'ph-1',
      'ph-2',
      'ph-3',
      'ph-0',
    ])
  })
})

/* ------------------------------------------------------------------ *
 *  Photographs — on screen
 * ------------------------------------------------------------------ */

describe('photographs on an event', () => {
  it('asks a finished event for its photos by name instead of reporting an absence', () => {
    seed()
    renderAt('/events/e-1')

    const invitation = screen.getByTestId('photo-invitation')
    expect(within(invitation).getByText('Add the photos from Lisboa')).toBeInTheDocument()
    expect(flatten(invitation.textContent)).toContain('It finished on 13 Apr 2026')
    expect(within(invitation).getByTestId('add-photos')).toBeInTheDocument()

    // It is an invitation, not an empty state and not a grid.
    expect(screen.queryByTestId('photo-grid')).toBeNull()
    expect(screen.queryByTestId('photo-waiting')).toBeNull()
  })

  it('does not nag an event that has not happened yet', () => {
    seed({ events: [ENGADIN] })
    renderAt('/events/e-4')

    expect(screen.queryByTestId('photo-invitation')).toBeNull()
    const waiting = screen.getByTestId('photo-waiting')
    expect(flatten(waiting.textContent)).toContain('do not have to wait until it is over')
  })

  it('drops the invitation as soon as there is something in the album', () => {
    seed({ events: [{ ...LISBON, photos: PHOTOS }, DINNER] })
    renderAt('/events/e-1')

    expect(screen.queryByTestId('photo-invitation')).toBeNull()
    expect(screen.getAllByTestId('photo-thumb')).toHaveLength(3)
    expect(screen.getByText('3 photos')).toBeInTheDocument()
  })

  it('opens the lightbox on a thumbnail and walks the album from the keyboard', () => {
    seed({ events: [{ ...LISBON, photos: PHOTOS }, DINNER] })
    renderAt('/events/e-1')

    expect(screen.queryByTestId('photo-lightbox')).toBeNull()

    const thumbs = screen.getAllByTestId('photo-thumb')
    fireEvent.click(thumbs[0])

    const lightbox = screen.getByTestId('photo-lightbox')
    expect(lightbox).toHaveAttribute('role', 'dialog')
    expect(lightbox).toHaveAttribute('aria-modal', 'true')
    expect(within(lightbox).getByTestId('lightbox-counter')).toHaveTextContent('1 of 3')
    expect(within(lightbox).getByTestId('lightbox-caption-text')).toHaveTextContent('Tram 28')
    expect(within(lightbox).getByTestId('lightbox-date')).toHaveTextContent('11 Apr 2026')

    // Arrows move.
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('2 of 3')
    expect(screen.getByTestId('lightbox-caption-text')).toHaveTextContent('No caption yet.')

    fireEvent.click(screen.getByTestId('lightbox-next'))
    expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('3 of 3')
    expect(screen.getByTestId('lightbox-caption-text')).toHaveTextContent('Pastéis, obviously')

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('2 of 3')

    // Home and End are the cheap way to the ends of a long album.
    fireEvent.keyDown(document, { key: 'End' })
    expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('3 of 3')
    fireEvent.keyDown(document, { key: 'Home' })
    expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('1 of 3')
  })

  it('closes on Escape, and on the close button', () => {
    seed({ events: [{ ...LISBON, photos: PHOTOS }, DINNER] })
    renderAt('/events/e-1')

    fireEvent.click(screen.getAllByTestId('photo-thumb')[1])
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('photo-lightbox')).toBeNull()

    fireEvent.click(screen.getAllByTestId('photo-thumb')[0])
    fireEvent.click(screen.getByTestId('lightbox-close'))
    expect(screen.queryByTestId('photo-lightbox')).toBeNull()
  })

  it('offers a caption to write and a caption to change, on the picture itself', () => {
    seed({ events: [{ ...LISBON, photos: PHOTOS }, DINNER] })
    renderAt('/events/e-1')

    // The undated middle picture has no caption: the control invites one.
    fireEvent.click(screen.getAllByTestId('photo-thumb')[1])
    expect(screen.getByTestId('lightbox-caption')).toHaveTextContent('Add caption')
    expect(screen.queryByTestId('caption-form')).toBeNull()

    fireEvent.click(screen.getByTestId('lightbox-caption'))
    expect(screen.getByTestId('caption-form')).toBeInTheDocument()

    // The one that already has words offers to change them instead.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getAllByTestId('photo-thumb')[0])
    expect(screen.getByTestId('lightbox-caption')).toHaveTextContent('Edit caption')
  })
})

/* ------------------------------------------------------------------ *
 *  Surprises — on screen
 * ------------------------------------------------------------------ */

describe('a surprise on screen', () => {
  it('badges the creator’s own hidden surprise and offers to reveal it', () => {
    seed({ events: [surprise(), LISBON] })
    renderAt('/events/e-3')

    expect(screen.getByTestId('only-you-badge')).toHaveTextContent('Only you can see this')
    expect(screen.getByTestId('reveal-surprise')).toBeInTheDocument()

    // And the reason the money is not hidden with it, said out loud.
    expect(flatten(screen.getByTestId('surprise-note').textContent)).toContain(
      'counts towards the month exactly as usual',
    )
  })

  it('says nothing whatsoever about a surprise somebody else created', () => {
    seed({ events: [surprise({ createdBy_ID: GRACE.ID }), LISBON] })
    renderAt('/events/e-3')

    // The service would not have sent it at all; if it ever does, the page treats it as an
    // ordinary event rather than announcing that there is a secret to be had.
    expect(screen.getByTestId('event-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('only-you-badge')).toBeNull()
    expect(screen.queryByTestId('reveal-surprise')).toBeNull()
    expect(screen.queryByTestId('surprise-note')).toBeNull()
  })

  it('drops the badge once the secret is out', () => {
    seed({ events: [surprise({ revealedAt: '2026-08-30T18:00:00Z' })] })
    renderAt('/events/e-3')

    expect(screen.queryByTestId('only-you-badge')).toBeNull()
    expect(screen.queryByTestId('reveal-surprise')).toBeNull()
    expect(screen.getByText(/revealed already/i)).toBeInTheDocument()
  })

  it('locks the switch on an event whose day has already come', () => {
    seed()
    renderAt('/events/e-1')
    expect(screen.getByText(/The day has arrived/i)).toBeInTheDocument()
  })

  it('marks the creator’s card in the list, and leaves everybody else’s plain', () => {
    seed({
      events: [
        surprise(),
        surprise({ ID: 'e-9', name: 'A plan of their own', createdBy_ID: GRACE.ID }),
        LISBON,
      ],
    })
    renderAt('/events')

    const cards = screen.getAllByTestId('event-card')
    const mine = cards.find(card => card.dataset.eventId === 'e-3') as HTMLElement
    expect(within(mine).getByTestId('only-you-badge')).toHaveTextContent('Only you')

    const theirs = cards.find(card => card.dataset.eventId === 'e-9') as HTMLElement
    expect(within(theirs).queryByTestId('only-you-badge')).toBeNull()

    const ordinary = cards.find(card => card.dataset.eventId === 'e-1') as HTMLElement
    expect(within(ordinary).queryByTestId('only-you-badge')).toBeNull()
  })
})
