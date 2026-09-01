import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'

/**
 * The whole product, at the wire.
 *
 *     scan (mock) → confirm → the ledger shows it → payment run → memory → statement
 *
 * REQUIRES THE BACKEND. playwright.config.ts starts it: CAP on :4004 with `--in-memory`,
 * MOCK_DOCAI=1 and every LLM credential blanked. No browser is launched by this file —
 * it uses only the `request` fixture, which makes it the fastest and by far the least
 * brittle spec in the suite. When `journey.spec.ts` goes red, run this one first: if it
 * is green the API is fine and a page moved; if it is red, do not blame the markup.
 *
 * Every assertion below was checked against a real `cds-tsx serve --in-memory` before it
 * was written — the merchant string, the amount, the clearing-document format, the 400
 * on a second payment run for the same period, all of it.
 *
 * ---------------------------------------------------------------------------
 * Why the year 2099
 * ---------------------------------------------------------------------------
 * `runSettlement` is a real payment run: it stamps a settlement id onto every confirmed,
 * unsettled expense in the period, which permanently changes them. Doing that to a period
 * that contains real spending would be vandalism, and `--in-memory` is a promise this
 * suite cannot enforce for someone running it with E2E_REUSE_CAP=1.
 *
 * So the journey books into a period nothing else can be in. The month shifts by the retry
 * index because the second payment run for one period is refused with
 * "period 2099-01 has already been cleared by CLR-2099-01" — correct behaviour, and it
 * would otherwise turn every retry into a false failure.
 */

/** A 64×96 grey JPEG, 302 bytes. Content is irrelevant — in mock mode Document AI picks
 *  its fixture from the *filename* (CONTRACTS.md §6) — but it must be a real image,
 *  because srv/lib/images.ts runs it through sharp before anything else happens. */
const RECEIPT_JPEG_BASE64 = [
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwg',
  'IyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgo',
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABgAEADASIAAhEBAxEB/8QA',
  'FQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAA',
  'AAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKjAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k=',
].join('')

/** The filename is the input Document AI's mock mode actually reads. `migros` → groceries. */
const RECEIPT_FILE_NAME = 'e2e-receipt-migros.jpg'

/* ------------------------------------------------------------------ *
 *  Wire types
 * ------------------------------------------------------------------ */

/**
 * Deliberately not `app/src/api/types.ts`. Those DTOs describe what the *client* hands to
 * a page after coercing `Decimal` fields, and this file is below the client: on the wire,
 * CAP sends `"47.85"`, a string. Modelling that honestly is the point — a spec that
 * pretended `amount` were a number would pass while the coercion in api/client.ts was
 * broken.
 */
type Decimal = string

interface ODataCollection<T> {
  value: T[]
}

interface WirePerson {
  ID: string
  name: string
  colour: string
  isDefault: boolean
}

interface WireExpense {
  ID: string
  date: string
  time: string | null
  merchantRaw: string
  merchantNorm: string | null
  amount: Decimal
  currency: string
  category_code: string | null
  categoryConfidence: Decimal | null
  moment: string | null
  momentConfidence: Decimal | null
  paidBy_ID: string | null
  event_ID: string | null
  status: string
  source: string
  note: string | null
  place: string | null
  receipt_ID: string | null
  documentNumber: number | null
  settlement_ID: string | null
  needsReview?: boolean
}

interface WireSettlement {
  ID: string
  period: string
  grandTotal: Decimal
  status: string
  settledAt: string | null
  clearingDocument: string
  approvedBy: string
}

/** `periodTotals(period='YYYY-MM')` — a sum per payer, never a claim on anybody. */
interface WirePersonTotal {
  personId: string
  name: string
  paid: Decimal
  count: number
  share: Decimal
}

interface WirePeriodTotals {
  period: string
  grandTotal: Decimal
  count: number
  byPerson: WirePersonTotal[]
}

interface WireMemory {
  ID: string
  title: string
  occurredOn: string
  kind: string
  note: string | null
  pinned: boolean
}

interface WireStatement {
  ID: string
  year: number
  contentMarkdown: string
  generatedAt: string
  engine: string
}

interface WireHealth {
  status: string
  docai: string
  llm: string
  model: string | null
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/**
 * Read a JSON body, or fail with the server's own words.
 *
 * CAP's errors are specific and useful — "period 2099-01 has already been cleared by
 * CLR-2099-01" tells you exactly what happened. A bare `expect(status).toBe(200)` throws
 * that away and leaves you with `expected 200, received 400`.
 */
async function body<T>(response: APIResponse, what: string, expected = 200): Promise<T> {
  if (response.status() !== expected) {
    const detail = await response.text()
    throw new Error(`${what}: expected HTTP ${expected}, got ${response.status()} — ${detail}`)
  }
  return (await response.json()) as T
}

/** OData `Decimal` arrives as a string; every comparison here goes through this. */
function money(value: Decimal | null): number {
  return Number(value ?? 0)
}

async function action<T>(
  request: APIRequestContext,
  name: string,
  payload: Record<string, unknown>,
  expected = 200,
): Promise<T> {
  const response = await request.post(`/ledger/${name}`, { data: payload })
  return body<T>(response, `POST /ledger/${name}`, expected)
}

/* ------------------------------------------------------------------ *
 *  The journey
 * ------------------------------------------------------------------ */

test.describe('the whole product, over HTTP', () => {
  test('scan → confirm → ledger → payment run → memory → statement', async ({
    request,
  }, testInfo) => {
    // Retry 0 books into 2099-01, retry 1 into 2099-02, and so on. See the header.
    const year = 2099
    const month = String(1 + testInfo.retry).padStart(2, '0')
    const period = `${year}-${month}`
    const bookingDate = `${period}-05`

    let expenseId = ''
    let receiptId = ''
    let payerId = ''

    await test.step('the service is up, mocked, and offline', async () => {
      const health = await body<WireHealth>(await request.get('/health'), 'GET /health')

      expect(health.status).toBe('ok')
      // If this says 'live', playwright.config.ts did not get MOCK_DOCAI=1 through and the
      // scan below is about to spend real Document AI quota on a 302-byte grey rectangle.
      expect(health.docai, 'Document AI must be in mock mode for this suite').toBe('mock')
      // Likewise: a real LLM here would make the statement step slow, billable and
      // different every run.
      expect(health.llm, 'the LLM must be the deterministic template provider').toContain(
        'template',
      )
      // The classifier's weights are loaded — otherwise every prediction below is a
      // fallback and the category assertion means nothing.
      expect(health.model, 'ml/model/weights.json must be readable').not.toBeNull()
    })

    await test.step('the seed data has somebody who can pay', async () => {
      const people = await body<ODataCollection<WirePerson>>(
        await request.get('/api/ledger/People'),
        'GET /ledger/People',
      )

      // However many the household has — the only requirement is that it is not empty
      // (CONTRACTS.md §10). Two are seeded as defaults; more can be added at runtime.
      expect(people.value.length).toBeGreaterThan(0)
      const payer = people.value.find(person => person.isDefault) ?? people.value[0]
      expect(payer, 'no people in the seed — check db/data/twowaymatch-People.csv').toBeDefined()
      expect(payer.colour, 'every person carries their own colour').toMatch(/^#[0-9A-Fa-f]{6}$/)
      payerId = payer.ID
      expect(payerId).not.toBe('')
    })

    await test.step('scan: a photograph becomes a draft posting', async () => {
      const draft = await action<WireExpense>(request, 'scanReceipt', {
        image: RECEIPT_JPEG_BASE64,
        mediaType: 'image/jpeg',
        fileName: RECEIPT_FILE_NAME,
      })

      expenseId = draft.ID
      receiptId = draft.receipt_ID ?? ''

      // Straight from the mock grocery fixture.
      expect(draft.merchantRaw).toContain('MIGROS')
      expect(money(draft.amount)).toBeCloseTo(47.85, 2)
      expect(draft.currency).toBe('CHF')
      expect(draft.place).toBe('Zürich')

      // The classifier ran, in-process, from ml/model/weights.json.
      expect(draft.category_code).toBe('Groceries')
      expect(draft.moment).toBe('everyday')
      // NEEDS_REVIEW_THRESHOLD is 0.6 (CONTRACTS.md §1.4) and both heads clear it on this
      // fixture, so the draft must not be flagged.
      expect(money(draft.categoryConfidence)).toBeGreaterThan(0.6)
      expect(draft.needsReview).toBe(false)

      // A draft is a draft: unposted, no document number, and nobody has said who paid.
      expect(draft.status).toBe('draft')
      expect(draft.source).toBe('scan')
      expect(draft.documentNumber).toBeNull()
      expect(draft.paidBy_ID).toBeNull()
      // Not part of an event until somebody says so: a scan is everyday spending.
      expect(draft.event_ID).toBeNull()

      expect(receiptId, 'the scan must have stored a receipt').not.toBe('')
    })

    await test.step('the stored receipt image is served back', async () => {
      // The media stream is what the confirm screen shows next to the extracted fields.
      const image = await request.get(`/ledger/Receipts(${receiptId})/image`)
      expect(image.status()).toBe(200)
      expect(image.headers()['content-type']).toContain('image/')
      expect((await image.body()).byteLength).toBeGreaterThan(0)
    })

    await test.step('the human corrects the draft: who paid, and when', async () => {
      const patched = await body<WireExpense>(
        await request.patch(`/ledger/Expenses(${expenseId})`, {
          data: { paidBy_ID: payerId, date: bookingDate, note: 'posted by the e2e journey' },
        }),
        `PATCH /ledger/Expenses(${expenseId})`,
      )

      expect(patched.paidBy_ID).toBe(payerId)
      expect(patched.date).toBe(bookingDate)
      expect(patched.status).toBe('draft')
    })

    await test.step('confirm: the draft is posted and gets a document number', async () => {
      const posted = await action<WireExpense>(request, 'confirmExpense', {
        ID: expenseId,
        // What the model proposed before the human looked at it. Identical to what is
        // stored, so no Corrections row should be written from this journey.
        predictedCategory: 'Groceries',
        predictedMoment: 'everyday',
      })

      expect(posted.status).toBe('confirmed')
      expect(posted.documentNumber).not.toBeNull()
      expect(posted.documentNumber ?? 0).toBeGreaterThan(0)
      expect(posted.settlement_ID).toBeNull()
    })

    await test.step('the ledger shows it', async () => {
      const listed = await body<ODataCollection<WireExpense>>(
        await request.get(
          `/ledger/Expenses?$filter=date ge ${period}-01 and date le ${period}-31&$orderby=date desc`,
        ),
        'GET /ledger/Expenses (period filter)',
      )

      // The sentinel period is ours alone, which is what makes the arithmetic in the
      // payment run below predictable.
      expect(listed.value).toHaveLength(1)
      const [row] = listed.value
      expect(row.ID).toBe(expenseId)
      expect(row.merchantRaw).toContain('MIGROS')
      expect(row.status).toBe('confirmed')
      expect(money(row.amount)).toBeCloseTo(47.85, 2)
    })

    await test.step('period close: the month is recorded and stamped', async () => {
      const settlement = await action<WireSettlement>(request, 'runSettlement', { period })

      expect(settlement.period).toBe(period)
      expect(settlement.clearingDocument).toBe(`CLR-${period}`)
      expect(settlement.approvedBy).toBe('CEO of the household')
      expect(settlement.status).toBe('open')
      expect(settlement.settledAt).toBeNull()

      // CONTRACTS.md §9: a payment run records what the period totalled and moves no
      // money. One posting of 47.85, so that is the whole month.
      expect(money(settlement.grandTotal)).toBeCloseTo(47.85, 2)

      // The posting is now frozen against that clearing document.
      const cleared = await body<WireExpense>(
        await request.get(`/ledger/Expenses(${expenseId})`),
        'GET the cleared expense',
      )
      expect(cleared.settlement_ID).toBe(settlement.ID)
    })

    await test.step('the period totals attribute the spend to whoever paid it', async () => {
      const totals = await body<WirePeriodTotals>(
        await request.get(`/api/ledger/periodTotals(period='${period}')`),
        'GET /ledger/periodTotals',
      )

      expect(totals.period).toBe(period)
      expect(totals.count).toBe(1)
      expect(money(totals.grandTotal)).toBeCloseTo(47.85, 2)

      // Everybody appears, including the people who paid nothing: a roster, not a
      // leaderboard, and nowhere in it a figure anyone has to hand over.
      const payerRow = totals.byPerson.find(person => person.personId === payerId)
      expect(payerRow, 'the payer must appear in byPerson').toBeDefined()
      expect(money(payerRow?.paid ?? null)).toBeCloseTo(47.85, 2)
      expect(Number(payerRow?.share ?? 0)).toBeCloseTo(1, 4)
      const paid = totals.byPerson.reduce((sum, person) => sum + money(person.paid), 0)
      expect(paid).toBeCloseTo(money(totals.grandTotal), 2)
    })

    await test.step('a period cannot be cleared twice', async () => {
      // Not a curiosity: this is what stops a double tap on "Run payment run" from
      // producing two clearing documents for one month.
      const refused = await request.post('/api/ledger/runSettlement', { data: { period } })
      expect(refused.status()).toBe(400)
      expect(await refused.text()).toContain('already been cleared')
    })

    await test.step('a memory is created and shows up in the timeline', async () => {
      const created = await body<WireMemory>(
        await request.post('/api/ledger/Memories', {
          data: {
            title: 'The e2e dinner',
            occurredOn: bookingDate,
            kind: 'other',
            note: 'created by the end-to-end journey',
            pinned: false,
          },
        }),
        'POST /ledger/Memories',
        201,
      )

      expect(created.ID).toBeTruthy()
      expect(created.title).toBe('The e2e dinner')

      const timeline = await body<ODataCollection<WireMemory>>(
        await request.get(`/ledger/Memories?$filter=occurredOn eq ${bookingDate}`),
        'GET /ledger/Memories',
      )
      expect(timeline.value.map(m => m.ID)).toContain(created.ID)
    })

    await test.step('the Statement of Us is generated', async () => {
      const statement = await action<WireStatement>(request, 'generateStatement', { year })

      expect(statement.year).toBe(year)
      // The template provider, not a network call. If this ever says 'anthropic', the
      // credential blanking in playwright.config.ts stopped working.
      expect(statement.engine).toBe('template')
      expect(statement.contentMarkdown.length).toBeGreaterThan(200)
      expect(statement.contentMarkdown).toContain(`FY${year}`)
      // The roster reached the renderer — and nothing in the prose turns a total into a
      // debt (CONTRACTS.md §9).
      expect(statement.contentMarkdown).toMatch(/Reporting entity/)
      expect(statement.contentMarkdown).not.toMatch(/\bowes?\b|\bowed\b|settle up/i)

      // Regenerating overwrites rather than duplicating, so the page can offer a
      // "regenerate" button without growing a pile of statements.
      const again = await action<WireStatement>(request, 'generateStatement', { year })
      expect(again.ID).toBe(statement.ID)

      const stored = await body<ODataCollection<WireStatement>>(
        await request.get(`/ledger/Statements?$filter=year eq ${year}`),
        'GET /ledger/Statements',
      )
      expect(stored.value).toHaveLength(1)
    })
  })
})

test.describe('the reference data the pages are built on', () => {
  test('categories carry the display metadata the UI needs', async ({ request }) => {
    const categories = await body<
      ODataCollection<{
        code: string
        name: string
        icon: string
        colour: string
        sortOrder: number
      }>
    >(await request.get('/api/ledger/Categories?$orderby=sortOrder'), 'GET /ledger/Categories')

    // CONTRACTS.md §1.1 — exactly these ten codes, ASCII, case-sensitive.
    expect(categories.value.map(c => c.code)).toEqual([
      'Groceries',
      'Dining',
      'Cafes',
      'Transport',
      'Travel',
      'Gifts',
      'Home',
      'Health',
      'Entertainment',
      'Subscriptions',
    ])

    // FRONTEND-CONTRACT §7: "Category colours come from the Category.colour field, never
    // hardcoded." That only works if every row actually has one.
    for (const category of categories.value) {
      expect(category.colour, `${category.code} has no colour`).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(category.icon, `${category.code} has no icon`).not.toBe('')
      expect(category.name, `${category.code} has no display name`).not.toBe('')
    }
    // The display name may be prettier than the ASCII code.
    expect(categories.value.find(c => c.code === 'Cafes')?.name).toBe('Cafés')
  })

  test('there is no debt endpoint to read', async ({ request }) => {
    // Nobody owes anybody (CONTRACTS.md §9). The function that used to answer "A owes B"
    // is gone, and this asserts it stays gone rather than quietly coming back.
    const gone = await request.get('/api/ledger/balance()')
    expect(gone.status()).toBeGreaterThanOrEqual(400)
  })
})
