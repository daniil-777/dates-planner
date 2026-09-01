import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Category, Event, Expense, Person, ScanResult } from '@/api/types'

/* ------------------------------------------------------------------ *
 *  Fixtures
 * ------------------------------------------------------------------ */

const CATEGORIES: Category[] = [
  { code: 'Groceries', name: 'Groceries', icon: 'cart', colour: '#0070F2', sortOrder: 10 },
  { code: 'Dining', name: 'Dining', icon: 'meal', colour: '#E76500', sortOrder: 20 },
  { code: 'Cafes', name: 'Cafés', icon: 'cup', colour: '#A45D00', sortOrder: 30 },
  {
    code: 'Transport',
    name: 'Transport',
    icon: 'bus-public-transport',
    colour: '#7858FF',
    sortOrder: 40,
  },
]

/** Three people, not two: nothing in the page may assume a couple (CONTRACTS.md §10). */
const PEOPLE: Person[] = [
  { ID: 'a-1', name: 'Ada', colour: '#0070F2', isDefault: true },
  { ID: 'b-1', name: 'Bruno', colour: '#F31DED', isDefault: true },
  { ID: 'c-1', name: 'Noemi', colour: '#049F9A', isDefault: false },
]

const EVENTS: Event[] = [
  {
    ID: 'ev-1',
    name: 'Lisbon Weekend',
    startsOn: '2026-04-10',
    endsOn: '2026-04-13',
    place: 'Lisboa',
    note: null,
    participants: PEOPLE,
  },
]

/** A draft the model was not sure about: both heads below NEEDS_REVIEW_THRESHOLD. */
const UNCERTAIN_DRAFT: ScanResult = {
  ID: 'e-uncertain',
  date: '2026-03-14',
  time: '20:15:00',
  merchantRaw: 'KIOSK 42',
  merchantNorm: 'kiosk',
  amount: 18.4,
  currency: 'CHF',
  category_code: 'Cafes',
  categoryConfidence: 0.31,
  moment: 'everyday',
  momentConfidence: 0.28,
  paidBy_ID: null,
  event_ID: null,
  status: 'draft',
  source: 'scan',
  note: null,
  place: 'Zürich',
  lat: null,
  lon: null,
  receipt_ID: 'r-1',
  documentNumber: null,
  settlement_ID: null,
  needsReview: true,
  categoryTop3: [
    { label: 'Cafes', p: 0.31 },
    { label: 'Dining', p: 0.29 },
    { label: 'Groceries', p: 0.2 },
  ],
  momentTop3: [
    { label: 'everyday', p: 0.28 },
    { label: 'date_night', p: 0.26 },
  ],
}

/* ------------------------------------------------------------------ *
 *  Hook mocks — the page is unit-tested against the contract, not the wire
 * ------------------------------------------------------------------ */

// `vi.mock` factories are hoisted above the imports, so every double they touch
// has to be created in a hoisted block too.
const {
  scanReceipt,
  updateExpense,
  createExpense,
  confirmExpense,
  createMemory,
  deleteExpense,
  duplicates,
} = vi.hoisted(() => ({
  scanReceipt: vi.fn<(vars: { file: Blob; fileName: string }) => Promise<ScanResult>>(),
  updateExpense: vi.fn(),
  createExpense: vi.fn(),
  confirmExpense: vi.fn(),
  createMemory: vi.fn(),
  deleteExpense: vi.fn(),
  duplicates: vi.fn<(id: string) => Promise<Expense[]>>(),
}))

function query<T>(data: T) {
  return { data, isLoading: false, isError: false, error: null, refetch: vi.fn() }
}

function mutation(mutateAsync: ReturnType<typeof vi.fn>) {
  return { mutate: mutateAsync, mutateAsync, isPending: false, error: null }
}

vi.mock('@/api/hooks', () => ({
  useCategories: () => query(CATEGORIES),
  usePeople: () => query(PEOPLE),
  useEvents: () => query(EVENTS),
  useDeleteExpense: () => mutation(deleteExpense),
  useCreateExpense: () => mutation(createExpense),
  useUpdateExpense: () => mutation(updateExpense),
  useConfirmExpense: () => mutation(confirmExpense),
  useCreateMemory: () => mutation(createMemory),
  useScanReceipt: () => ({ mutateAsync: scanReceipt, isPending: false, error: null }),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, api: { ...actual.api, duplicates } }
})

import { ScanPage } from './ScanPage'

function renderPage() {
  return render(
    <MemoryRouter>
      <ScanPage />
    </MemoryRouter>,
  )
}

beforeAll(() => {
  // jsdom implements neither of these; the scan flow leans on both.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:receipt')
  globalThis.URL.revokeObjectURL = vi.fn()
  // Present so `prepareImage` takes the ImageBitmap branch rather than the
  // <img> branch, which never resolves in jsdom. The canvas itself has no 2d
  // context here, so it falls back to uploading the original file.
  globalThis.createImageBitmap = vi.fn(
    async () => ({ width: 1200, height: 1600, close: () => {} }) as unknown as ImageBitmap,
  )
})

const CONFIRMED: Expense = { ...UNCERTAIN_DRAFT, status: 'confirmed', documentNumber: 20 }

const EARLIER_POSTING: Expense = {
  ...CONFIRMED,
  ID: 'e-earlier',
  documentNumber: 12,
  date: '2026-03-13',
}

beforeEach(() => {
  scanReceipt.mockReset()
  updateExpense.mockReset().mockResolvedValue(UNCERTAIN_DRAFT)
  createExpense.mockReset().mockResolvedValue(UNCERTAIN_DRAFT)
  confirmExpense.mockReset().mockResolvedValue(CONFIRMED)
  createMemory.mockReset().mockResolvedValue({ ID: 'm-1' })
  deleteExpense.mockReset()
  duplicates.mockReset().mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe('ScanPage', () => {
  it('opens on the capture state with no receipts queued', () => {
    renderPage()

    expect(screen.getByTestId('scan-capture')).toBeInTheDocument()
    expect(screen.getByText('Scan receipt')).toBeInTheDocument()
    expect(screen.getByText('Choose photos')).toBeInTheDocument()
    expect(screen.getByText('Enter manually')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state')).toBeInTheDocument()

    // Nothing to confirm, nothing in flight, nothing posted.
    expect(screen.queryByTestId('scan-confirm-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('scan-busy-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('scan-queue-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('scan-posted-card')).not.toBeInTheDocument()
  })

  it('offers the manual-entry card when there is no receipt', async () => {
    renderPage()

    fireEvent.click(screen.getByText('Enter manually'))

    const card = await screen.findByTestId('scan-confirm-card')
    expect(card).toBeInTheDocument()
    // A hand-typed posting is nobody's guess, so it is not flagged for review.
    expect(screen.queryByTestId('scan-review-strip')).not.toBeInTheDocument()
  })

  it('opens the confirm card in REVIEW state when the model is unsure', async () => {
    scanReceipt.mockResolvedValue(UNCERTAIN_DRAFT)
    renderPage()

    const input = screen.getByTestId('scan-camera-input')
    const file = new File(['receipt-bytes'], 'kiosk-42.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(scanReceipt).toHaveBeenCalledTimes(1))

    expect(await screen.findByTestId('scan-review-strip')).toBeInTheDocument()
    expect(screen.getByText('Two-way match needed — please confirm')).toBeInTheDocument()

    // Both heads were under 0.6, so both fields carry a warning.
    expect(screen.getByText('Low confidence — pick the right category')).toBeInTheDocument()
    expect(screen.getByText('Low confidence — confirm the moment')).toBeInTheDocument()
  })

  it('names Document AI while the extraction is still running', async () => {
    let release: (result: ScanResult) => void = () => {}
    scanReceipt.mockReturnValue(
      new Promise<ScanResult>(resolve => {
        release = resolve
      }),
    )
    renderPage()

    const file = new File(['receipt-bytes'], 'kiosk-42.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByTestId('scan-camera-input'), { target: { files: [file] } })

    expect(await screen.findByTestId('scan-busy-card')).toBeInTheDocument()
    expect(await screen.findAllByText('Extracting… (Document AI)')).not.toHaveLength(0)

    release(UNCERTAIN_DRAFT)
    expect(await screen.findByTestId('scan-confirm-card')).toBeInTheDocument()
  })

  it('posts the draft with the model prediction and verifies a likely duplicate', async () => {
    scanReceipt.mockResolvedValue(UNCERTAIN_DRAFT)
    duplicates.mockResolvedValue([EARLIER_POSTING])
    renderPage()

    const file = new File(['receipt-bytes'], 'kiosk-42.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByTestId('scan-camera-input'), { target: { files: [file] } })

    await screen.findByTestId('scan-confirm-card')
    fireEvent.click(screen.getByText('Post'))

    expect(await screen.findByTestId('scan-posted-card')).toBeInTheDocument()

    // The prediction travels with the confirmation — that is what feeds Corrections.
    expect(confirmExpense).toHaveBeenCalledWith({
      id: 'e-uncertain',
      predictedCategory: 'Cafes',
      predictedMoment: 'everyday',
    })
    // The human's edits are stored before the posting, never after.
    expect(updateExpense).toHaveBeenCalledTimes(1)
    expect(updateExpense.mock.invocationCallOrder[0]).toBeLessThan(
      confirmExpense.mock.invocationCallOrder[0],
    )

    expect(screen.getByTestId('scan-duplicate-warning')).toBeInTheDocument()
    expect(screen.getByText('Posted as document #20')).toBeInTheDocument()
  })
})
