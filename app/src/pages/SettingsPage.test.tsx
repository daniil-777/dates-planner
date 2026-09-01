/**
 * Settings, and the first launch it hides behind.
 *
 * The gate is one flag in `localStorage`: with `twm.onboarded` absent the wizard owns the
 * screen, with it present Settings does. That is the behaviour worth pinning down, because
 * getting it wrong means either an introduction nobody can escape or one nobody ever sees.
 *
 * The other thing worth pinning down is that nothing here counts to two. The roster is a
 * list of however many people there are, and the planner divides a set-aside between all
 * of them (CONTRACTS.md §10).
 *
 * The rest of the file covers the pure machinery the page leans on — the CSV reader, the
 * planner's clamping, and the ZIP writer — none of which needs a DOM.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { SettingsPage } from './SettingsPage'
import { ONBOARDED_KEY } from './settings/onboarding'
import {
  detectNegativeIsSpending,
  guessMapping,
  parseAmount,
  parseCsv,
  parseCsvDate,
  prepareRows,
  sniffDelimiter,
} from './settings/csv'
import { derivePlannerFacts, horizonMonths, planSpend, type PlannerFacts } from './settings/planner'
import { crc32, zipBytes } from './settings/zip'

/* ------------------------------------------------------------------ *
 *  Test doubles for the API layer
 * ------------------------------------------------------------------ */

const PEOPLE = [
  { ID: 'p-1', name: 'Ada', colour: '#0070F2', email: 'ada@example.com', isDefault: true },
  { ID: 'p-2', name: 'Grace', colour: '#F31DED', email: 'grace@example.com', isDefault: true },
  { ID: 'p-3', name: 'Noemi', colour: '#049F9A', isDefault: false },
]

const DOCUMENT_ONE = {
  ID: 'e-1',
  date: '2024-06-15',
  time: '19:30:00',
  merchantRaw: 'The place where it started',
  merchantNorm: 'the place where it started',
  amount: 0,
  currency: 'CHF',
  category_code: 'Dining',
  categoryConfidence: 1,
  moment: 'date_night',
  momentConfidence: 1,
  paidBy_ID: 'p-1',
  event_ID: null,
  status: 'confirmed',
  source: 'manual',
  note: 'Document #1. Everything since has been a follow-up posting.',
  place: 'The place where it started',
  lat: null,
  lon: null,
  receipt_ID: null,
  documentNumber: 1,
  settlement_ID: null,
}

const query = (data: unknown) => ({
  data,
  isPending: false,
  isLoading: false,
  isError: false,
  isSuccess: true,
  error: null,
  refetch: vi.fn(),
})

const mutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null,
})

vi.mock('@/api/hooks', () => ({
  usePeople: () => query(PEOPLE),
  useExpenses: () => query([DOCUMENT_ONE]),
  useMonthlyTotals: () =>
    query([
      { period: '2026-01', category: 'Dining', total: 220 },
      { period: '2026-01', category: 'Groceries', total: 400 },
      { period: '2026-02', category: 'Dining', total: 180 },
    ]),
  useHealth: () =>
    query({ status: 'ok', model: '2026-09-01T10:00:00', docai: 'mock', llm: 'template' }),
  useCreatePerson: () => mutation(),
  useUpdatePerson: () => mutation(),
  useDeletePerson: () => mutation(),
  useUpdateExpense: () => mutation(),
}))

function renderPage(): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{<SettingsPage />}</QueryClientProvider>
}

beforeEach(() => {
  window.localStorage.clear()
  // `useModelInfo` asks the admin service for the metrics; in a test there is nobody there.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsPage onboarding gate', () => {
  it('shows the wizard when the localStorage flag is absent', async () => {
    render(renderPage())

    const wizard = await screen.findByRole('dialog', { name: /welcome to two-way match/i })
    expect(wizard).toBeInTheDocument()
    expect(screen.getByText('Two-Way Match')).toBeInTheDocument()
    expect(screen.getByText('Open the books')).toBeInTheDocument()
    expect(screen.getByText(/Company code 001 · Joint venture/)).toBeInTheDocument()
  })

  it('does not show the wizard when the flag is present', () => {
    window.localStorage.setItem(ONBOARDED_KEY, '2026-09-01T10:00:00.000Z')

    render(renderPage())

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('People')).toBeInTheDocument()
    expect(screen.getByText(/This browser was introduced on/)).toBeInTheDocument()
  })

  it('writes the flag when the introduction is skipped, and stays gone', async () => {
    render(renderPage())

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Skip'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.localStorage.getItem(ONBOARDED_KEY)).not.toBeNull()
  })

  it('walks from the welcome screen to the roster, one row per person', async () => {
    render(renderPage())

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Open the books'))

    expect(await screen.findByText('Who is on this ledger?')).toBeInTheDocument()
    // Three seeded people, three rows — the wizard counts the roster, never to two.
    expect(screen.getByText('Person 1')).toBeInTheDocument()
    expect(screen.getByText('Person 2')).toBeInTheDocument()
    expect(screen.getByText('Person 3')).toBeInTheDocument()
    expect(screen.getByText('Add another person')).toBeInTheDocument()
    // Still not onboarded: the flag is only written when the wizard finishes or is skipped.
    expect(window.localStorage.getItem(ONBOARDED_KEY)).toBeNull()
  })

  it('adds a fourth row on request', async () => {
    render(renderPage())

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Open the books'))
    await screen.findByText('Who is on this ledger?')

    fireEvent.click(screen.getByText('Add another person'))
    expect(await screen.findByText('Person 4')).toBeInTheDocument()
  })
})

describe('SettingsPage people card', () => {
  it('lists everybody, not a fixed pair', () => {
    window.localStorage.setItem(ONBOARDED_KEY, '2026-09-01T10:00:00.000Z')
    render(renderPage())

    const card = within(screen.getByRole('region', { name: 'People' }))
    const avatars = card.getAllByTestId('person-avatar') as Array<
      HTMLElement & { initials?: string }
    >
    expect(avatars.map(avatar => avatar.initials)).toEqual(['AD', 'GR', 'NO'])
    expect(card.getByText('Add someone')).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ *
 *  CSV
 * ------------------------------------------------------------------ */

const SEMICOLON_CSV = [
  'Buchungsdatum;Buchungstext;Betrag;Konto',
  '31.12.2026;"COOP PRONTO, BAHNHOF";-12.50;Ada',
  "02.01.2027;MIGROS ZÜRICH HB;-1'234.50;Grace",
  '03.01.2027;SALARY;+4200.00;Ada',
  '04.01.2027;"He said ""hello""";-9,90;Noemi',
].join('\r\n')

describe('CSV reading', () => {
  it('sniffs the delimiter outside quoted fields', () => {
    expect(sniffDelimiter(SEMICOLON_CSV)).toBe(';')
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('parses quoted fields, escaped quotes and CRLF', () => {
    const table = parseCsv(SEMICOLON_CSV)
    expect(table.delimiter).toBe(';')
    expect(table.headerless).toBe(false)
    expect(table.header).toEqual(['Buchungsdatum', 'Buchungstext', 'Betrag', 'Konto'])
    expect(table.rows).toHaveLength(4)
    expect(table.rows[0][1]).toBe('COOP PRONTO, BAHNHOF')
    expect(table.rows[3][1]).toBe('He said "hello"')
  })

  it('reads Swiss, German and French amounts', () => {
    expect(parseAmount("1'234.50")).toBe(1234.5)
    expect(parseAmount('1.234,50')).toBe(1234.5)
    expect(parseAmount('1 234,50')).toBe(1234.5)
    expect(parseAmount('CHF 12.50')).toBe(12.5)
    expect(parseAmount('-12,50')).toBe(-12.5)
    expect(parseAmount('(12.50)')).toBe(-12.5)
    expect(parseAmount('1.234')).toBe(1234)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('COOP')).toBeNull()
  })

  it('reads dates in both orders and rejects nonsense', () => {
    expect(parseCsvDate('31.12.2026')).toBe('2026-12-31')
    expect(parseCsvDate('2026-12-31')).toBe('2026-12-31')
    expect(parseCsvDate('03/04/2026', 'dmy')).toBe('2026-04-03')
    expect(parseCsvDate('03/04/2026', 'mdy')).toBe('2026-03-04')
    expect(parseCsvDate('31.02.2026')).toBeNull()
    expect(parseCsvDate('not a date')).toBeNull()
  })

  it('guesses the columns from the header', () => {
    const table = parseCsv(SEMICOLON_CSV)
    const mapping = guessMapping(table)
    expect(mapping.date).toBe(0)
    expect(mapping.merchant).toBe(1)
    expect(mapping.amount).toBe(2)
    expect(mapping.payer).toBe(3)
    expect(detectNegativeIsSpending(table, mapping.amount)).toBe(true)
  })

  it('prepares rows, skipping money coming in and keeping the reason', () => {
    const table = parseCsv(SEMICOLON_CSV)
    const mapping = guessMapping(table)
    const rows = prepareRows(table, {
      mapping,
      dateOrder: 'dmy',
      negativeIsSpending: true,
      resolvePayer: raw => PEOPLE.find(person => person.name === raw)?.ID ?? null,
      defaultPayerId: 'p-1',
    })

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      line: 2,
      date: '2026-12-31',
      merchant: 'COOP PRONTO, BAHNHOF',
      amount: 12.5,
      payerId: 'p-1',
      include: true,
    })
    expect(rows[1].amount).toBe(1234.5)
    expect(rows[1].payerId).toBe('p-2')
    // The fourth row is booked against the third person, who exists like anybody else.
    expect(rows[3].payerId).toBe('p-3')

    // The salary is a credit; it is kept in the preview and excluded from the import.
    expect(rows[2].include).toBe(false)
    expect(rows[2].issues).toContain('looks like money coming in')
  })

  it('handles a file with no header row', () => {
    const table = parseCsv('2026-01-02;COOP;12.50\n2026-01-03;MIGROS;18.00')
    expect(table.headerless).toBe(true)
    expect(table.header).toEqual(['Column 1', 'Column 2', 'Column 3'])
    expect(table.rows).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ *
 *  Planner
 * ------------------------------------------------------------------ */

const TODAY = new Date(2026, 8, 1) // 1 September 2026, local time

describe('pre-spend planner', () => {
  const facts = derivePlannerFacts(
    [
      { period: '2026-07', category: 'Dining', total: 300 },
      { period: '2026-07', category: 'Groceries', total: 500 },
      { period: '2026-08', category: 'Dining', total: 300 },
      { period: '2026-08', category: 'Groceries', total: 500 },
    ],
    [],
    PEOPLE,
    '2025-10',
    '2026-09',
  )

  it('derives the run-rate from monthlyTotals', () => {
    expect(facts.monthsObserved).toBe(2)
    expect(facts.averageMonthly).toBe(800)
    expect(facts.discretionaryMonthly).toBe(300)
  })

  it('puts everybody on the roster, including the people who have paid nothing', () => {
    expect(facts.paidShares.map(share => share.personId)).toEqual(['p-1', 'p-2', 'p-3'])
    expect(facts.paidShares.every(share => share.share === 0)).toBe(true)
  })

  it('clamps an absurd horizon instead of dividing by it', () => {
    expect(horizonMonths('2026-10-01', TODAY).months).toBe(1)
    expect(horizonMonths('2027-09-01', TODAY).months).toBe(12)

    const far = horizonMonths('9999-01-01', TODAY)
    expect(far.months).toBe(120)
    expect(far.clamped).toBe(true)

    const past = horizonMonths('2020-01-01', TODAY)
    expect(past.months).toBe(1)
    expect(past.clamped).toBe(true)
    expect(past.requested).toBeLessThan(0)
  })

  it('approves what fits in the discretionary run-rate, one share each', () => {
    const plan = planSpend(
      { target: 1800, targetDate: '2027-09-01', shareMode: 'equal', today: TODAY },
      facts,
    )
    expect(plan.horizonMonths).toBe(12)
    expect(plan.monthlySetAside).toBe(150)
    expect(plan.perPerson).toEqual([
      { personId: 'p-1', name: 'Ada', amount: 50 },
      { personId: 'p-2', name: 'Grace', amount: 50 },
      { personId: 'p-3', name: 'Noemi', amount: 50 },
    ])
    expect(plan.verdict).toBe('approved')
  })

  it('refers a plan that costs more than everything trimmable', () => {
    const plan = planSpend(
      { target: 12000, targetDate: '2027-03-01', shareMode: 'equal', today: TODAY },
      facts,
    )
    expect(plan.verdict).toBe('referred')
    expect(plan.monthlySetAside).toBe(2000)
  })

  it('weights the set-aside by what each person has actually paid', () => {
    const skewed: PlannerFacts = {
      ...facts,
      paidShares: [
        { personId: 'p-1', name: 'Ada', share: 0.5 },
        { personId: 'p-2', name: 'Grace', share: 0.3 },
        { personId: 'p-3', name: 'Noemi', share: 0.2 },
      ],
    }
    const plan = planSpend(
      { target: 1200, targetDate: '2027-09-01', shareMode: 'observed', today: TODAY },
      skewed,
    )
    expect(plan.monthlySetAside).toBe(100)
    expect(plan.perPerson.map(contribution => contribution.amount)).toEqual([50, 30, 20])
  })

  it('divides evenly when nobody has paid for anything yet', () => {
    const plan = planSpend(
      { target: 900, targetDate: '2027-09-01', shareMode: 'observed', today: TODAY },
      facts,
    )
    expect(plan.perPerson.map(contribution => contribution.amount)).toEqual([25, 25, 25])
  })

  it('adds up to the whole even when the division does not, to the rappen', () => {
    const two: PlannerFacts = {
      ...facts,
      paidShares: [
        { personId: 'p-1', name: 'Ada', share: 0.5 },
        { personId: 'p-2', name: 'Grace', share: 0.5 },
        { personId: 'p-3', name: 'Noemi', share: 0 },
      ],
    }
    const plan = planSpend(
      { target: 100.01, targetDate: '2026-10-01', shareMode: 'equal', today: TODAY },
      two,
    )
    const sum = plan.perPerson.reduce((total, contribution) => total + contribution.amount, 0)
    expect(Math.round(sum * 100) / 100).toBe(plan.monthlySetAside)
  })

  it('never produces a set-aside of nothing, whatever the date says', () => {
    const plan = planSpend(
      { target: 5000, targetDate: '2926-01-01', shareMode: 'equal', today: TODAY },
      facts,
    )
    expect(plan.horizonMonths).toBe(120)
    expect(plan.monthlySetAside).toBeGreaterThan(0)
    expect(plan.clamped).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  Export archive
 * ------------------------------------------------------------------ */

describe('zip writer', () => {
  it('agrees with zlib on CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes an archive with the signatures an unzip tool looks for', () => {
    const bytes = zipBytes(
      [
        { name: 'manifest.json', content: '{"a":1}' },
        { name: 'statements/FY2026.md', content: '# Statement of Us — FY2026\n' },
      ],
      new Date(2026, 8, 1, 12, 0, 0),
    )

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50) // first local file header

    // The end-of-central-directory record is the last 22 bytes and names both entries.
    const end = bytes.byteLength - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)

    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('manifest.json')
    expect(text).toContain('statements/FY2026.md')
    expect(text).toContain('# Statement of Us')
  })
})
