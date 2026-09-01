import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type {
  Category,
  Event,
  Expense,
  MonthlyTotal,
  PeriodTotals,
  Person,
  Settlement,
} from '@/api/types'

/** Mutable fixture state the mocked hooks read from. */
const state = vi.hoisted(() => ({
  expenses: [] as Expense[],
  categories: [] as Category[],
  people: [] as Person[],
  events: [] as Event[],
  settlements: [] as Settlement[],
  monthly: [] as MonthlyTotal[],
  /** Keyed by period, so stepping a month back asks for a different answer. */
  periodTotals: {} as Record<string, PeriodTotals | undefined>,
  runSettlement: vi.fn(),
}))

vi.mock('@/api/hooks', () => {
  const query = <T,>(data: T) => ({
    data,
    isLoading: false,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  })
  const mutation = (mutateAsync: unknown = vi.fn()) => ({
    mutate: vi.fn(),
    mutateAsync,
    isPending: false,
    error: null,
    reset: vi.fn(),
  })
  return {
    useExpenses: (opts?: { period?: string }) =>
      query(
        opts?.period
          ? state.expenses.filter(expense => expense.date.startsWith(opts.period as string))
          : state.expenses,
      ),
    useExpense: () => query(undefined),
    useCategories: () => query(state.categories),
    usePeople: () => query(state.people),
    useEvents: () => query(state.events),
    useEvent: () => query(undefined),
    useEventTotals: () => query(undefined),
    useMemories: () => query([]),
    useSettlements: () => query(state.settlements),
    useStatements: () => query([]),
    usePeriodTotals: (period: string) => query(state.periodTotals[period]),
    useMonthlyTotals: () => query(state.monthly),
    useHealth: () => query({ status: 'ok' }),
    useUpdateExpense: () => mutation(),
    useDeleteExpense: () => mutation(),
    useConfirmExpense: () => mutation(),
    useScanReceipt: () => mutation(),
    useRunSettlement: () => mutation(state.runSettlement),
    useMarkSettled: () => mutation(),
    useGenerateStatement: () => mutation(),
    useCreateMemory: () => mutation(),
    useUpdateMemory: () => mutation(),
    useDeleteMemory: () => mutation(),
    useCreatePerson: () => mutation(),
    useUpdatePerson: () => mutation(),
    useDeletePerson: () => mutation(),
    useCreateEvent: () => mutation(),
    useUpdateEvent: () => mutation(),
    useDeleteEvent: () => mutation(),
  }
})

import { LedgerPage } from './LedgerPage'

/* The month the page defaults to, worked out without touching the page's own helpers. */
const NOW = new Date()
const pad = (value: number) => String(value).padStart(2, '0')
const THIS_PERIOD = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}`
const previous = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1)
const LAST_PERIOD = `${previous.getFullYear()}-${pad(previous.getMonth() + 1)}`
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const THIS_LABEL = `${MONTHS[NOW.getMonth()]} ${NOW.getFullYear()}`
const LAST_LABEL = `${MONTHS[previous.getMonth()]} ${previous.getFullYear()}`

const ADA: Person = { ID: 'person-a', name: 'Ada', colour: '#0070F2', isDefault: true }
const GRACE: Person = { ID: 'person-b', name: 'Grace', colour: '#F31DED', isDefault: true }
/** On the roster, on the trip, and out of pocket for exactly nothing this month. */
const NOEMI: Person = { ID: 'person-c', name: 'Noemi', colour: '#049F9A', isDefault: false }

const LISBON: Event = {
  ID: 'event-1',
  name: 'Lisbon Weekend',
  startsOn: `${THIS_PERIOD}-10`,
  endsOn: `${THIS_PERIOD}-13`,
  place: 'Lisboa',
  note: null,
  participants: [ADA, GRACE, NOEMI],
}

const CATEGORIES: Category[] = [
  { code: 'Groceries', name: 'Groceries', icon: 'cart', colour: '#0070F2', sortOrder: 10 },
  { code: 'Dining', name: 'Dining', icon: 'meal', colour: '#E76500', sortOrder: 20 },
  { code: 'Travel', name: 'Travel', icon: 'flight', colour: '#049F9A', sortOrder: 50 },
]

const expense = (
  overrides: Partial<Expense> & Pick<Expense, 'ID' | 'date' | 'amount'>,
): Expense => ({
  time: null,
  merchantRaw: 'Merchant',
  merchantNorm: null,
  currency: 'CHF',
  category_code: 'Groceries',
  categoryConfidence: 0.98,
  moment: 'everyday',
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

const renderPage = () =>
  render(
    <MemoryRouter>
      <LedgerPage />
    </MemoryRouter>,
  )

/** UI5 and JSX sprinkle non-breaking spaces through rendered text; flatten them all. */
const normalise = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

const paidRows = () => screen.getAllByTestId('paid-row')

const rowFor = (name: string): HTMLElement => {
  const row = paidRows().find(
    candidate => normalise(candidate.querySelector('.paid-row__name')?.textContent) === name,
  )
  if (!row) throw new Error(`No row for ${name} in the paid-by card`)
  return row
}

const amountIn = (row: HTMLElement) => normalise(within(row).getByTestId('money').textContent)

beforeEach(() => {
  vi.clearAllMocks()
  state.categories = CATEGORIES
  state.people = [ADA, GRACE, NOEMI]
  state.events = [LISBON]
  state.settlements = []
  state.monthly = []
  state.expenses = [
    expense({
      ID: 'e-1',
      date: `${THIS_PERIOD}-04`,
      amount: 120.4,
      merchantRaw: 'Migros Seefeld',
      paidBy_ID: ADA.ID,
    }),
    expense({
      ID: 'e-2',
      date: `${THIS_PERIOD}-11`,
      amount: 60,
      merchantRaw: 'Kronenhalle',
      category_code: 'Dining',
      moment: 'date_night',
      paidBy_ID: GRACE.ID,
      receipt_ID: 'receipt-2',
    }),
    expense({
      ID: 'e-3',
      date: `${THIS_PERIOD}-12`,
      amount: 12.5,
      merchantRaw: 'Sprüngli',
      status: 'draft',
      paidBy_ID: ADA.ID,
    }),
    expense({
      ID: 'e-5',
      date: `${THIS_PERIOD}-10`,
      amount: 400,
      merchantRaw: 'TAP Air Portugal',
      category_code: 'Travel',
      moment: 'trip',
      paidBy_ID: GRACE.ID,
      event_ID: LISBON.ID,
    }),
    expense({
      ID: 'e-4',
      date: `${LAST_PERIOD}-09`,
      amount: 300,
      merchantRaw: 'Hotel Belvédère',
      category_code: 'Dining',
      moment: 'trip',
      paidBy_ID: GRACE.ID,
    }),
  ]
  // What the server says the two months came to. Nobody's position, just sums.
  state.periodTotals = {
    [THIS_PERIOD]: {
      period: THIS_PERIOD,
      grandTotal: 592.9,
      count: 4,
      byPerson: [
        { personId: GRACE.ID, name: 'Grace', paid: 460, count: 2, share: 460 / 592.9 },
        { personId: ADA.ID, name: 'Ada', paid: 132.9, count: 2, share: 132.9 / 592.9 },
        { personId: NOEMI.ID, name: 'Noemi', paid: 0, count: 0, share: 0 },
      ],
    },
    [LAST_PERIOD]: {
      period: LAST_PERIOD,
      grandTotal: 300,
      count: 1,
      byPerson: [
        { personId: GRACE.ID, name: 'Grace', paid: 300, count: 1, share: 1 },
        { personId: ADA.ID, name: 'Ada', paid: 0, count: 0, share: 0 },
        { personId: NOEMI.ID, name: 'Noemi', paid: 0, count: 0, share: 0 },
      ],
    },
  }
  state.runSettlement = vi.fn()
})

describe('LedgerPage month total', () => {
  it('shows what the month came to', () => {
    renderPage()
    expect(normalise(screen.getByTestId('month-total').textContent)).toBe('CHF 592.90')
  })
})

describe('LedgerPage who paid', () => {
  it('lists every person, biggest payer first, with their share of the month', () => {
    renderPage()
    const names = paidRows().map(row =>
      normalise(row.querySelector('.paid-row__name')?.textContent),
    )
    expect(names).toEqual(['Grace', 'Ada', 'Noemi'])

    expect(amountIn(rowFor('Grace'))).toBe('CHF 460.00')
    expect(normalise(rowFor('Grace').textContent)).toContain('78% of the month · 2 postings')
    expect(amountIn(rowFor('Ada'))).toBe('CHF 132.90')
    expect(normalise(rowFor('Ada').textContent)).toContain('22% of the month · 2 postings')
  })

  it('keeps a line for somebody who paid nothing', () => {
    renderPage()
    const noemi = rowFor('Noemi')
    expect(amountIn(noemi)).toBe('CHF 0.00')
    expect(normalise(noemi.textContent)).toContain('0% of the month · 0 postings')
  })

  it('still lists the whole roster when the totals have not arrived yet', () => {
    // No answer for this period: the page adds up the postings it already has instead.
    state.periodTotals = {}
    renderPage()

    expect(normalise(screen.getByTestId('month-total').textContent)).toBe('CHF 592.90')
    expect(paidRows()).toHaveLength(3)
    expect(amountIn(rowFor('Grace'))).toBe('CHF 460.00')
    expect(amountIn(rowFor('Ada'))).toBe('CHF 132.90')
    expect(amountIn(rowFor('Noemi'))).toBe('CHF 0.00')
  })

  it('adds a line for somebody who paid but is no longer on the roster', () => {
    state.people = [ADA, GRACE]
    renderPage()
    expect(paidRows()).toHaveLength(3)
    expect(amountIn(rowFor('Noemi'))).toBe('CHF 0.00')
  })
})

describe('LedgerPage period close', () => {
  it('summarises the selected month', () => {
    renderPage()
    fireEvent.click(screen.getByText('Payment run'))

    expect(screen.getByTestId('payment-run-period')).toHaveTextContent(
      `${THIS_LABEL} · ${THIS_PERIOD}`,
    )
    expect(screen.getByTestId('payment-run-document')).toHaveTextContent(`CLR-${THIS_PERIOD}`)
    // Three verified postings this month; the draft is excluded and flagged.
    expect(screen.getByTestId('payment-run-postings')).toHaveTextContent('3')
    expect(screen.getByText(/still need review/)).toBeInTheDocument()
    expect(normalise(screen.getByTestId('payment-run-result').textContent)).toBe(
      `${THIS_LABEL} totalled CHF 592.90 across 4 postings.`,
    )
  })

  it('summarises the previous month after stepping a month back', () => {
    renderPage()
    fireEvent.click(screen.getByTestId('month-previous'))
    fireEvent.click(screen.getByText('Payment run'))

    expect(screen.getByTestId('payment-run-period')).toHaveTextContent(
      `${LAST_LABEL} · ${LAST_PERIOD}`,
    )
    expect(screen.getByTestId('payment-run-document')).toHaveTextContent(`CLR-${LAST_PERIOD}`)
    expect(screen.getByTestId('payment-run-postings')).toHaveTextContent('1')
    expect(screen.queryByText(/still need review/)).not.toBeInTheDocument()
    expect(normalise(screen.getByTestId('payment-run-result').textContent)).toBe(
      `${LAST_LABEL} totalled CHF 300.00 across 1 posting.`,
    )
  })

  it('closes the selected period', async () => {
    const created: Settlement = {
      ID: 'set-1',
      period: THIS_PERIOD,
      grandTotal: 592.9,
      status: 'open',
      settledAt: null,
      clearingDocument: `CLR-${THIS_PERIOD}`,
      approvedBy: 'CEO of the household',
    }
    state.runSettlement = vi.fn().mockResolvedValue(created)
    renderPage()

    fireEvent.click(screen.getByText('Payment run'))
    await act(async () => {
      fireEvent.click(screen.getByText('Run'))
    })

    expect(state.runSettlement).toHaveBeenCalledWith(THIS_PERIOD)
  })
})

describe('LedgerPage postings', () => {
  it('lists the postings of the month and flags the drafts', () => {
    renderPage()
    expect(screen.getByText('Migros Seefeld')).toBeInTheDocument()
    expect(screen.getByText('Kronenhalle')).toBeInTheDocument()
    expect(screen.getByText('Sprüngli')).toBeInTheDocument()
    // Last month's posting belongs to another period.
    expect(screen.queryByText('Hotel Belvédère')).not.toBeInTheDocument()
    expect(screen.getByText('Needs review')).toBeInTheDocument()
  })

  it('marks the posting that belongs to an event, and only that one', () => {
    const { container } = renderPage()
    const onTrip = container.querySelector('[data-expense-id="e-5"]') as HTMLElement
    expect(within(onTrip).getByTestId('event-chip')).toHaveTextContent('Lisbon Weekend')

    const everyday = container.querySelector('[data-expense-id="e-1"]') as HTMLElement
    expect(within(everyday).queryByTestId('event-chip')).toBeNull()
  })

  it('offers the events alongside the other filters', () => {
    const { container } = renderPage()
    const eventFilter = container.querySelector('[accessible-name="Event"]')
    expect(eventFilter).not.toBeNull()
    expect(eventFilter).toHaveTextContent('Lisbon Weekend')
    expect(eventFilter).toHaveTextContent('No event')
    expect(container.querySelector('[accessible-name="Paid by"]')).toHaveTextContent('Noemi')
  })

  it('opens the detail sheet with the receipt image for the tapped posting', () => {
    const { container } = renderPage()
    const row = container.querySelector('[data-expense-id="e-2"]') as HTMLElement
    const list = row.closest('ui5-list') as HTMLElement
    // UI5 raises `item-click` from inside its shadow DOM, which jsdom cannot replay from a
    // synthetic click on the host — dispatching the component's own event is the closest
    // stand-in for tapping the row.
    act(() => {
      list.dispatchEvent(new CustomEvent('item-click', { detail: { item: row } }))
    })

    const receipt = screen.getByRole('img', { name: /Receipt from Kronenhalle/ })
    expect(receipt).toHaveAttribute('src', expect.stringContaining('receipt-2'))
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getAllByText('Delete').length).toBeGreaterThan(0)
  })

  it('shows the clearing document with its approval stamp once a period is closed', () => {
    state.settlements = [
      {
        ID: 'set-1',
        period: THIS_PERIOD,
        grandTotal: 592.9,
        status: 'open',
        settledAt: null,
        clearingDocument: `CLR-${THIS_PERIOD}`,
        approvedBy: 'CEO of the household',
      },
    ]
    renderPage()
    expect(screen.getAllByText(`CLR-${THIS_PERIOD}`).length).toBeGreaterThan(0)
    expect(normalise(screen.getByTestId('clearing-total').textContent)).toBe('CHF 592.90')
    expect(screen.getByText('Approved by').parentElement).toHaveTextContent(
      'Approved by CEO of the household',
    )
    expect(screen.getByText('Mark as closed')).toBeInTheDocument()
  })
})
