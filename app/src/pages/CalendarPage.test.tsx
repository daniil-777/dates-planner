/**
 * The calendar.
 *
 * The date maths is tested first and hardest, because a calendar breaks at exactly two
 * places and both of them are boring: the seam between two months, and February. So
 * there are cell counts for a leap February and for a month that starts on a Sunday —
 * the six-week month a grid hard-coded to five weeks silently truncates — plus the day
 * steps across a year boundary and onto 29 February.
 *
 * After that, three claims the page makes:
 *
 *  - one `upcoming(from, to)` read covers the whole month, and a multi-day event is
 *    spread across its days on the client, because the service sends it once;
 *  - the next-up strip counts down to the nearest reminder that is still ahead, never to
 *    one already ticked off;
 *  - the view toggle is remembered, so a phone that prefers the list keeps the list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CalendarEntry, Event, Reminder } from '@/api/types'

/* ------------------------------------------------------------------ *
 *  Fixtures the mocked hooks read from
 * ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  reminders: [] as unknown[],
  events: [] as unknown[],
  upcomingCalls: [] as string[],
  createReminder: vi.fn(),
  completeReminder: vi.fn(),
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
  return {
    useUpcoming: (from: string, to: string) => {
      state.upcomingCalls.push(`${from}..${to}`)
      return query(state.entries)
    },
    useReminders: () => query(state.reminders),
    useEvents: () => query(state.events),
    useCreateReminder: () => ({
      mutateAsync: state.createReminder,
      mutate: vi.fn(),
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
    useCompleteReminder: () => ({
      mutateAsync: state.completeReminder,
      mutate: vi.fn(),
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
  }
})

import { CalendarPage } from './CalendarPage'
import { MonthGrid } from './calendar/MonthGrid'
import { NextUpStrip } from './calendar/NextUpStrip'
import {
  bucketEntries,
  bucketsInOrder,
  countdownLabel,
  countsOf,
  leadLabel,
  pickNextReminder,
  reminderTitle,
} from './calendar/entries'
import {
  addDays,
  monthGrid,
  periodOfDate,
  sameDayInPeriod,
  weekdayIndex,
  weeksOf,
} from './calendar/grid'
import { isOptedIn, notifyDueReminders, setOptedIn } from './calendar/notifications'
import { deleteReminder } from './calendar/reminders'
import { DEFAULT_VIEW, VIEW_STORAGE_KEY, readView, writeView } from './calendar/view'
import { formatLongDate, todayIso } from './memories/dates'
import { currentPeriod } from '@/theme'

const TODAY = todayIso()

const entry = (overrides: Partial<CalendarEntry> & Pick<CalendarEntry, 'ID' | 'kind'>) =>
  ({
    date: TODAY,
    endsOn: null,
    title: 'Something',
    place: null,
    eventId: overrides.ID,
    onlyYou: false,
    leadDays: null,
    done: null,
    ...overrides,
  }) satisfies CalendarEntry

const reminder = (overrides: Partial<Reminder> & Pick<Reminder, 'ID'>) =>
  ({
    event_ID: 'e-9',
    leadDays: 1,
    note: null,
    done: false,
    dueOn: TODAY,
    eventName: 'Engadin Between the Years',
    eventStartsOn: TODAY,
    ...overrides,
  }) satisfies Reminder

const event = (overrides: Partial<Event> & Pick<Event, 'ID' | 'name' | 'startsOn'>) =>
  ({
    endsOn: null,
    place: null,
    note: null,
    participants: [],
    ...overrides,
  }) satisfies Event

const DINNER = entry({
  ID: 'e-1',
  kind: 'event',
  title: 'Kronenhalle Dinner',
  place: 'Zürich',
  eventId: 'e-1',
})

const SECRET = entry({
  ID: 'e-2',
  kind: 'event',
  title: 'Weekend in Vals',
  place: 'Vals',
  eventId: 'e-2',
  onlyYou: true,
})

const NUDGE = entry({
  ID: 'r-1',
  kind: 'reminder',
  title: 'Book the sleeper',
  place: 'Pontresina',
  eventId: 'e-3',
  leadDays: 14,
  done: false,
})

/** `1 September 2026` also matches `11 September 2026`; anchor it to the label's start. */
function dayButton(date: string): HTMLElement {
  const label = formatLongDate(date).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return screen.getByRole('button', { name: new RegExp(`^${label},`) })
}

/**
 * jsdom ships no Notification API at all, and the strip reads that honestly: with no
 * API there is nothing to opt into and no button. These tests hand it one.
 */
function stubNotifications(permission: 'default' | 'granted' | 'denied') {
  const fired: Array<{ title: string; body: string }> = []
  const requestPermission = vi.fn().mockResolvedValue('granted')
  class FakeNotification {
    static permission = permission
    static requestPermission = requestPermission
    constructor(title: string, options?: { body?: string }) {
      fired.push({ title, body: options?.body ?? '' })
    }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return { fired, requestPermission }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/calendar']}>
        <Routes>
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/events/:id" element={<div>event route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  state.entries = [DINNER, SECRET, NUDGE]
  state.reminders = []
  state.events = []
  state.upcomingCalls = []
  state.createReminder = vi.fn()
  state.completeReminder = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 *  Date maths
 * ------------------------------------------------------------------ */

describe('the month grid', () => {
  it('gives a leap February its 29th, in five whole weeks', () => {
    const cells = monthGrid('2024-02', '2024-02-14')

    // 1 February 2024 is a Thursday: 3 leading days + 29 = 32, padded to five rows.
    expect(cells).toHaveLength(35)
    expect(weeksOf(cells)).toHaveLength(5)
    expect(cells[0].date).toBe('2024-01-29')
    expect(cells[34].date).toBe('2024-03-03')

    const inMonth = cells.filter(cell => cell.inMonth)
    expect(inMonth).toHaveLength(29)
    expect(inMonth[28].date).toBe('2024-02-29')
    expect(cells.filter(cell => cell.isToday).map(cell => cell.date)).toEqual(['2024-02-14'])
  })

  it('gives the same February 28 days in a common year', () => {
    const cells = monthGrid('2023-02', '2023-02-14')

    // 1 February 2023 is a Wednesday: 2 leading + 28 = 30, still five rows.
    expect(cells).toHaveLength(35)
    expect(cells.filter(cell => cell.inMonth)).toHaveLength(28)
    expect(cells.filter(cell => cell.date === '2023-02-29')).toHaveLength(0)
  })

  it('needs six rows for a month that starts on a Sunday', () => {
    // The week starts on Monday, so a 31-day month beginning on a Sunday pushes six
    // leading days in front of it: 6 + 31 = 37, which does not fit in five rows.
    expect(weekdayIndex('2026-03-01')).toBe(6)

    const cells = monthGrid('2026-03', '2026-03-01')
    expect(cells).toHaveLength(42)
    expect(weeksOf(cells)).toHaveLength(6)
    expect(cells[0].date).toBe('2026-02-23')
    expect(cells[41].date).toBe('2026-04-05')
    expect(cells.filter(cell => cell.inMonth)).toHaveLength(31)
  })

  it('starts every row on a Monday and ends it on a Sunday', () => {
    for (const period of ['2024-02', '2026-03', '2025-12', '2100-02']) {
      for (const week of weeksOf(monthGrid(period))) {
        expect(week).toHaveLength(7)
        expect(weekdayIndex(week[0].date)).toBe(0)
        expect(weekdayIndex(week[6].date)).toBe(6)
      }
    }
  })

  it('refuses to invent a month', () => {
    expect(monthGrid('2026-13')).toEqual([])
    expect(monthGrid('nonsense')).toEqual([])
  })
})

describe('stepping a day at a time', () => {
  it('lands on 29 February in a leap year and skips it otherwise', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    // 2100 is divisible by 4 and by 100 but not by 400: not a leap year.
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01')
  })

  it('crosses a year boundary in both directions', () => {
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01')
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31')
    expect(addDays('2026-03-14', 0)).toBe('2026-03-14')
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01')
  })

  it('leaves a value it cannot read alone', () => {
    expect(addDays('', 1)).toBe('')
    expect(addDays('2026-02-30', 1)).toBe('2026-02-30')
  })

  it('clamps a paged month onto a day it actually has', () => {
    expect(sameDayInPeriod('2026-02', '2026-01-31')).toBe('2026-02-28')
    expect(sameDayInPeriod('2024-02', '2024-01-31')).toBe('2024-02-29')
    expect(sameDayInPeriod('2026-04', '2026-03-14')).toBe('2026-04-14')
    expect(periodOfDate('2026-03-14')).toBe('2026-03')
  })
})

/* ------------------------------------------------------------------ *
 *  One read, spread across days
 * ------------------------------------------------------------------ */

describe('bucketing one month of entries', () => {
  const trip = entry({
    ID: 'e-trip',
    kind: 'event',
    title: 'Engadin Between the Years',
    place: 'Pontresina',
    date: '2026-12-27',
    endsOn: '2026-12-30',
    eventId: 'e-trip',
  })

  it('spreads a multi-day event across every day it covers', () => {
    const byDay = bucketEntries([trip], '2026-12-01', '2026-12-31')

    expect([...byDay.keys()].sort()).toEqual([
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
    ])
    // One row, four days, four distinct React keys.
    expect(new Set([...byDay.values()].flat().map(item => item.key)).size).toBe(4)
    expect(byDay.get('2026-12-27')?.[0].isFirstDay).toBe(true)
    expect(byDay.get('2026-12-30')?.[0].isLastDay).toBe(true)
    expect(byDay.get('2026-12-28')?.[0].span).toBe(4)
  })

  it('draws a trip once per day however many rows the service sends for it', () => {
    // Today the service sends one row with an `endsOn`. A row per covered day would be a
    // reasonable thing for it to send instead, and must not put the trip on a day twice.
    const perDay = ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30'].map(date =>
      entry({ ID: 'e-trip', kind: 'event', date, endsOn: '2026-12-30', eventId: 'e-trip' }),
    )
    const byDay = bucketEntries(perDay, '2026-12-01', '2026-12-31')

    expect([...byDay.keys()]).toHaveLength(4)
    for (const items of byDay.values()) expect(items).toHaveLength(1)
  })

  it('keeps an event that reaches into the window from before it, clamped', () => {
    // The service answers a 28–31 December window with the trip dated the 27th.
    const byDay = bucketEntries([trip], '2026-12-28', '2026-12-31')

    expect([...byDay.keys()].sort()).toEqual(['2026-12-28', '2026-12-29', '2026-12-30'])
    expect(byDay.get('2026-12-28')?.[0].isFirstDay).toBe(false)
    expect(byDay.get('2026-12-28')?.[0].span).toBe(4)
  })

  it('puts events before reminders on the same day, and done reminders last', () => {
    const open = entry({ ID: 'r-open', kind: 'reminder', title: 'Book it', done: false })
    const done = entry({ ID: 'r-done', kind: 'reminder', title: 'Already booked', done: true })
    const byDay = bucketEntries([done, open, DINNER], TODAY, TODAY)

    expect(byDay.get(TODAY)?.map(item => item.entry.ID)).toEqual(['e-1', 'r-open', 'r-done'])
    expect(countsOf(byDay.get(TODAY))).toEqual({
      events: 1,
      reminders: 2,
      openReminders: 1,
      onlyYou: false,
    })
  })

  it('reports a surprise only its creator can see, and counts nothing when a day is empty', () => {
    const byDay = bucketEntries([SECRET], TODAY, TODAY)
    expect(countsOf(byDay.get(TODAY)).onlyYou).toBe(true)
    expect(countsOf(byDay.get('1999-01-01'))).toEqual({
      events: 0,
      reminders: 0,
      openReminders: 0,
      onlyYou: false,
    })
  })

  it('orders the days it hands to the list view', () => {
    const later = entry({ ID: 'e-later', kind: 'event', date: '2026-12-29' })
    const buckets = bucketsInOrder(bucketEntries([later, trip], '2026-12-01', '2026-12-31'))
    expect(buckets.map(bucket => bucket.date)).toEqual([
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
    ])
    expect(buckets[2].items).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ *
 *  Next up
 * ------------------------------------------------------------------ */

describe('the next-up strip', () => {
  const overdue = reminder({ ID: 'r-late', dueOn: '2026-03-10', note: 'Long gone' })
  const soon = reminder({ ID: 'r-soon', dueOn: '2026-03-16', note: 'Book the sleeper' })
  const later = reminder({ ID: 'r-later', dueOn: '2026-04-02', note: 'Pack' })
  const ticked = reminder({ ID: 'r-done', dueOn: '2026-03-15', note: 'Done already', done: true })

  it('picks the nearest reminder that is still ahead', () => {
    const picked = pickNextReminder([later, overdue, ticked, soon], '2026-03-14')

    expect(picked?.reminder.ID).toBe('r-soon')
    expect(picked?.daysUntil).toBe(2)
    expect(picked?.overdue).toBe(false)
  })

  it('counts a reminder due today as due today, not as missed', () => {
    const picked = pickNextReminder([soon], '2026-03-16')
    expect(picked?.daysUntil).toBe(0)
    expect(picked?.overdue).toBe(false)
    expect(countdownLabel(0)).toBe('Today')
    expect(countdownLabel(1)).toBe('Tomorrow')
    expect(countdownLabel(6)).toBe('in 6 days')
    expect(countdownLabel(-2)).toBe('2 days ago')
  })

  it('falls back to the most recently missed one when nothing is ahead', () => {
    const older = reminder({ ID: 'r-older', dueOn: '2026-03-01' })
    const picked = pickNextReminder([older, overdue], '2026-03-14')

    expect(picked?.reminder.ID).toBe('r-late')
    expect(picked?.overdue).toBe(true)
    expect(picked?.daysUntil).toBe(-4)
  })

  it('has nothing to count down to when every reminder is ticked off', () => {
    expect(pickNextReminder([ticked], '2026-03-14')).toBeNull()
    expect(pickNextReminder([], '2026-03-14')).toBeNull()
  })

  it('names a reminder after its event when it carries no note', () => {
    expect(reminderTitle(reminder({ ID: 'r-x', note: null }))).toBe('Engadin Between the Years')
    expect(reminderTitle(reminder({ ID: 'r-x', note: '  ' }))).toBe('Engadin Between the Years')
    expect(reminderTitle(soon)).toBe('Book the sleeper')
    expect(leadLabel(0)).toBe('on the day')
    expect(leadLabel(1)).toBe('1 day before')
    expect(leadLabel(14)).toBe('14 days before')
  })

  it('renders the nearest one with its countdown, and offers the opt-in as a button', () => {
    stubNotifications('default')
    render(
      <NextUpStrip
        next={pickNextReminder([later, overdue, ticked, soon], '2026-03-14')}
        reminders={[]}
        busyId={null}
        onOpenEvent={vi.fn()}
        onComplete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByText('Book the sleeper')).toBeInTheDocument()
    expect(screen.getByText(/in 2 days/)).toBeInTheDocument()
    expect(screen.queryByText('Pack')).toBeNull()
    // Opt-in only, and only from a tap: the strip offers the button and asks nothing.
    expect(screen.getByText('Nudge me')).toBeInTheDocument()
  })
})

describe('the nudges', () => {
  it('asks the browser for nothing until the button is tapped', async () => {
    const { requestPermission } = stubNotifications('default')
    render(
      <NextUpStrip
        next={pickNextReminder([reminder({ ID: 'r-1', dueOn: TODAY })], TODAY)}
        reminders={[]}
        busyId={null}
        onOpenEvent={vi.fn()}
        onComplete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    // Mounting the page must never prompt: browsers hold that against a site forever.
    expect(requestPermission).not.toHaveBeenCalled()
    expect(isOptedIn()).toBe(false)

    fireEvent.click(screen.getByText('Nudge me'))

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Turn off')).toBeInTheDocument())
    expect(isOptedIn()).toBe(true)
  })

  it('says so plainly where the browser cannot show one', () => {
    stubNotifications('denied')
    render(
      <NextUpStrip
        next={null}
        reminders={[]}
        busyId={null}
        onOpenEvent={vi.fn()}
        onComplete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByText('Reminders are blocked in the browser settings.')).toBeInTheDocument()
    expect(screen.queryByText('Nudge me')).toBeNull()
  })

  it('nudges each due reminder once, and never one that is still ahead', () => {
    const { fired } = stubNotifications('granted')
    setOptedIn(true)

    const due = reminder({ ID: 'r-due', dueOn: '2026-03-14', note: 'Book the sleeper' })
    const missed = reminder({ ID: 'r-missed', dueOn: '2026-03-01', note: 'Long gone' })
    const ahead = reminder({ ID: 'r-ahead', dueOn: '2026-03-20', note: 'Pack' })
    const ticked = reminder({ ID: 'r-done', dueOn: '2026-03-14', done: true })
    const all = [due, missed, ahead, ticked]

    expect(notifyDueReminders(all, '2026-03-14')).toBe(2)
    expect(fired.map(one => one.title).sort()).toEqual(['Book the sleeper', 'Long gone'])

    // Idempotent: a second pass over the same list fires nothing.
    expect(notifyDueReminders(all, '2026-03-14')).toBe(0)
    expect(fired).toHaveLength(2)
  })

  it('stays quiet while nobody has opted in', () => {
    const { fired } = stubNotifications('granted')
    expect(notifyDueReminders([reminder({ ID: 'r-due', dueOn: '2026-03-14' })], '2026-03-14')).toBe(
      0,
    )
    expect(fired).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 *  The grid, rendered
 * ------------------------------------------------------------------ */

function Harness({ period, today }: { period: string; today: string }) {
  const [focused, setFocused] = useState(`${period}-14`)
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <MonthGrid
      period={period}
      cells={monthGrid(period, today)}
      byDay={bucketEntries(
        [
          entry({ ID: 'e-a', kind: 'event', date: `${period}-14`, eventId: 'e-a' }),
          entry({ ID: 'r-a', kind: 'reminder', date: `${period}-15`, done: false }),
        ],
        `${period}-01`,
        `${period}-28`,
      )}
      focusedDate={focused}
      selectedDate={selected}
      onFocusDate={setFocused}
      onOpenDate={setSelected}
    />
  )
}

describe('the rendered grid', () => {
  it('draws 35 cells for a leap February and 42 for a month starting on a Sunday', () => {
    const { unmount } = render(<Harness period="2024-02" today="2024-02-14" />)
    expect(screen.getAllByRole('gridcell')).toHaveLength(35)
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ])
    expect(screen.getByRole('button', { name: /29 February 2024/ })).toBeInTheDocument()
    unmount()

    render(<Harness period="2026-03" today="2026-03-01" />)
    expect(screen.getAllByRole('gridcell')).toHaveLength(42)
    expect(screen.getAllByRole('row')).toHaveLength(7) // six weeks plus the headings
  })

  it('marks today and only today', () => {
    render(<Harness period="2024-02" today="2024-02-14" />)
    const marked = screen
      .getAllByRole('button')
      .filter(button => button.getAttribute('aria-current') === 'date')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toHaveAccessibleName(/14 February 2024/)
  })

  it('says what a day carries instead of drawing dots at a screen reader', () => {
    render(<Harness period="2024-02" today="2024-02-14" />)
    expect(screen.getByRole('button', { name: '14 February 2024, 1 event' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '15 February 2024, 1 reminder' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '16 February 2024, nothing scheduled' }),
    ).toBeInTheDocument()
  })

  it('moves the focused day with the arrows, across the end of the month', () => {
    render(<Harness period="2024-02" today="2024-02-14" />)
    const start = screen.getByRole('button', { name: /14 February 2024/ })
    start.focus()

    fireEvent.keyDown(start, { key: 'ArrowRight' })
    expect(document.activeElement).toHaveAccessibleName(/15 February 2024/)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName(/22 February 2024/)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toHaveAccessibleName(/18 February 2024/)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toHaveAccessibleName(/12 February 2024/)
  })

  it('draws a dot for an event and a different mark for a reminder', () => {
    const { container } = render(<Harness period="2024-02" today="2024-02-14" />)

    const withEvent = container.querySelector('[data-date="2024-02-14"]') as HTMLElement
    expect(withEvent.querySelectorAll('.cal-dot')).toHaveLength(1)
    expect(withEvent.querySelectorAll('.cal-mark')).toHaveLength(0)

    const withReminder = container.querySelector('[data-date="2024-02-15"]') as HTMLElement
    expect(withReminder.querySelectorAll('.cal-mark')).toHaveLength(1)
    expect(withReminder.querySelectorAll('.cal-dot')).toHaveLength(0)

    const empty = container.querySelector('[data-date="2024-02-16"]') as HTMLElement
    expect(empty.querySelectorAll('.cal-dot, .cal-mark')).toHaveLength(0)
  })

  it('makes every day a real button, which is what makes Enter open one', () => {
    render(<Harness period="2024-02" today="2024-02-14" />)
    const day = screen.getByRole('button', { name: /14 February 2024/ })
    expect(day.tagName).toBe('BUTTON')
    expect(day.getAttribute('type')).toBe('button')
  })

  it('keeps exactly one tab stop', () => {
    render(<Harness period="2024-02" today="2024-02-14" />)
    const stops = screen.getAllByRole('button').filter(button => button.tabIndex === 0)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName(/14 February 2024/)
  })
})

/* ------------------------------------------------------------------ *
 *  The page
 * ------------------------------------------------------------------ */

describe('CalendarPage', () => {
  it('reads the whole month in one call, not one per day', () => {
    renderPage()

    const cells = monthGrid(currentPeriod(), TODAY)
    const expected = `${cells[0].date}..${cells[cells.length - 1].date}`
    expect(state.upcomingCalls.length).toBeGreaterThan(0)
    expect(new Set(state.upcomingCalls)).toEqual(new Set([expected]))
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument()
  })

  it('opens a day, lists what is on it, and routes an event to its own page', async () => {
    renderPage()

    // The day used to be a modal that opened on a tap. It is a panel under the grid now and
    // is always present, opened on today — so the assertion is that it is there and is
    // showing today, not that it is absent until something is clicked.
    expect(screen.getByTestId('day-panel')).toBeInTheDocument()
    fireEvent.click(dayButton(TODAY))

    const sheet = within(await screen.findByTestId('day-panel'))
    expect(sheet.getByText('Kronenhalle Dinner')).toBeInTheDocument()
    expect(sheet.getByText('Book the sleeper')).toBeInTheDocument()
    // The reminder says when it fires, and says it in days rather than in a stored date.
    expect(sheet.getByText(/14 days before/)).toBeInTheDocument()

    fireEvent.click(sheet.getByText('Kronenhalle Dinner'))
    expect(await screen.findByText('event route')).toBeInTheDocument()
  })

  it('badges a surprise the viewer created, and never invents one it was not sent', async () => {
    renderPage()

    fireEvent.click(dayButton(TODAY))
    const sheet = within(await screen.findByTestId('day-panel'))

    const secret = sheet.getByText('Weekend in Vals').closest('[data-testid="calendar-entry"]')
    expect(secret).not.toBeNull()
    expect(within(secret as HTMLElement).getByText('Only you')).toBeInTheDocument()

    const dinner = sheet.getByText('Kronenhalle Dinner').closest('[data-testid="calendar-entry"]')
    expect(within(dinner as HTMLElement).queryByTestId('only-you')).toBeNull()
  })

  it('remembers the list toggle across a remount', async () => {
    expect(readView()).toBe(DEFAULT_VIEW)

    const first = renderPage()
    expect(screen.getByTestId('calendar-grid')).toBeInTheDocument()

    fireEvent.click(screen.getByText('List'))

    await waitFor(() => expect(screen.getByTestId('calendar-list')).toBeInTheDocument())
    expect(screen.queryByTestId('calendar-grid')).toBeNull()
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('list')
    first.unmount()

    renderPage()
    expect(screen.getByTestId('calendar-list')).toBeInTheDocument()
    expect(screen.queryByTestId('calendar-grid')).toBeNull()
    // And back again, remembered the other way.
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.getByTestId('calendar-grid')).toBeInTheDocument())
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('grid')
  })

  it('survives a browser that will not remember anything', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    vi.stubGlobal('localStorage', broken)

    expect(readView()).toBe('grid')
    expect(() => writeView('list')).not.toThrow()
  })

  it('shows the nearest reminder above the grid', () => {
    state.reminders = [
      reminder({ ID: 'r-late', dueOn: addDays(TODAY, -3), note: 'Long gone' }),
      reminder({ ID: 'r-soon', dueOn: addDays(TODAY, 2), note: 'Book the sleeper' }),
      reminder({ ID: 'r-later', dueOn: addDays(TODAY, 9), note: 'Pack' }),
    ]
    renderPage()

    const strip = within(screen.getByTestId('next-up'))
    expect(strip.getByText('Book the sleeper')).toBeInTheDocument()
    expect(strip.getByText(/in 2 days/)).toBeInTheDocument()
    expect(strip.queryByText('Long gone')).toBeNull()
  })

  it('creates a reminder from a day, with the lead time that lands it on that day', async () => {
    const target = addDays(TODAY, 10)
    state.events = [event({ ID: 'e-3', name: 'Engadin Between the Years', startsOn: target })]
    state.createReminder.mockResolvedValue(
      reminder({ ID: 'r-new', note: 'Book the sleeper', dueOn: TODAY }),
    )
    renderPage()

    fireEvent.click(dayButton(TODAY))
    const sheet = await screen.findByTestId('day-panel')
    fireEvent.click(within(sheet).getByText('Add a reminder'))

    const dialog = within(await screen.findByTestId('reminder-dialog'))
    // Ten days between the chosen day and the event, so the nudge lands on the day tapped.
    expect(dialog.getByText(new RegExp(`Fires on ${formatLongDate(TODAY)}`))).toBeInTheDocument()

    fireEvent.click(dialog.getByText('Add reminder'))
    await waitFor(() =>
      expect(state.createReminder).toHaveBeenCalledWith({
        eventId: 'e-3',
        leadDays: 10,
        note: null,
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull())
  })

  it('pins a reminder to an event from that event\u2019s own row', async () => {
    const starts = addDays(TODAY, 5)
    state.events = [event({ ID: 'e-1', name: 'Kronenhalle Dinner', startsOn: starts })]
    state.createReminder.mockResolvedValue(reminder({ ID: 'r-new', note: 'Book a table' }))
    renderPage()

    fireEvent.click(dayButton(TODAY))
    const sheet = await screen.findByTestId('day-panel')
    const row = within(sheet)
      .getByText('Kronenhalle Dinner')
      .closest('[data-testid="calendar-entry"]') as HTMLElement

    fireEvent.click(row.querySelector('ui5-button[accessible-name^="Remind me"]') as Element)

    const dialog = within(await screen.findByTestId('reminder-dialog'))
    // A day before it starts, and the dialog says which day that is before anything is saved.
    expect(
      dialog.getByText(new RegExp(`Fires on ${formatLongDate(addDays(starts, -1))}`)),
    ).toBeInTheDocument()

    fireEvent.click(dialog.getByText('Add reminder'))
    await waitFor(() =>
      expect(state.createReminder).toHaveBeenCalledWith({
        eventId: 'e-1',
        leadDays: 1,
        note: null,
      }),
    )
  })

  it('ticks a reminder off from the day it sits on', async () => {
    state.completeReminder.mockResolvedValue(reminder({ ID: 'r-1', done: true }))
    renderPage()

    fireEvent.click(dayButton(TODAY))
    const sheet = await screen.findByTestId('day-panel')
    const row = within(sheet)
      .getByText('Book the sleeper')
      .closest('[data-testid="calendar-entry"]') as HTMLElement

    const done = row.querySelector('ui5-button[accessible-name^="Mark"]')
    expect(done).not.toBeNull()
    fireEvent.click(done as Element)

    await waitFor(() => expect(state.completeReminder).toHaveBeenCalledWith('r-1'))
  })

  it('deletes a reminder, and says out loud that the event survives it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    fireEvent.click(dayButton(TODAY))
    const sheet = await screen.findByTestId('day-panel')
    const row = within(sheet)
      .getByText('Book the sleeper')
      .closest('[data-testid="calendar-entry"]') as HTMLElement

    fireEvent.click(row.querySelector('ui5-button[accessible-name^="Delete"]') as Element)

    expect(await screen.findByText(/stay exactly as they are/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // Not a UUID, so it goes onto the wire as an OData string literal.
    expect(url).toBe("/api/ledger/Reminders('r-1')")
    expect(init.method).toBe('DELETE')

    // A real key is an `Edm.Guid`, and those are bare in OData V4.
    await deleteReminder('f0000000-0000-4000-8000-000000000003')
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/ledger/Reminders(f0000000-0000-4000-8000-000000000003)',
    )
  })

  it('turns a refused delete into an ApiError carrying what the service said', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: '404', message: 'no such reminder.' } }), {
          status: 404,
        }),
      ),
    )

    await expect(deleteReminder('r-9')).rejects.toMatchObject({
      status: 404,
      message: 'no such reminder.',
    })
  })
})
