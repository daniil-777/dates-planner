import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The evening this app exists for, driven through the actual interface.
 *
 *   photograph a receipt → check what the model guessed → post it →
 *   find it in the ledger → run the payment run → write a memory → generate the statement
 *
 * REQUIRES THE BACKEND AND THE SPA, and it WRITES. playwright.config.ts starts CAP with
 * `--in-memory`, so the ledger it changes is a throwaway seeded from db/data/*.csv and
 * thrown away again when the run ends. That is the only reason a spec is allowed to run a
 * payment run at all — see the safety note in playwright.config.ts, and do not point this
 * at anything you care about.
 *
 * Runs in the `mobile` project only. Not because it would fail on a desktop viewport, but
 * because the payment run in the middle can only happen once per period: a second project
 * running the same journey against the same server would hit
 * "period 2026-03 has already been cleared" and fail for a reason that has nothing to do
 * with the app.
 *
 * ---------------------------------------------------------------------------
 * When this goes red
 * ---------------------------------------------------------------------------
 * Run `npx playwright test --project=api` first. That spec asserts the same journey at the
 * HTTP layer with no markup involved. If it is green, the backend is fine and something in
 * the UI moved — a label, a testid, a layout. This file is the most coupled thing in the
 * repository and it is supposed to be: it is the only test that knows whether a person can
 * actually get from a photograph to a posted expense.
 */

/** A 64×96 grey JPEG, 302 bytes. In mock mode Document AI chooses its fixture from the
 *  *filename*, so the pixels do not matter — but sharp has to be able to decode them. */
const RECEIPT_JPEG_BASE64 = [
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwg',
  'IyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgo',
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABgAEADASIAAhEBAxEB/8QA',
  'FQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAA',
  'AAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKjAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k=',
].join('')

/** `migros` in the name is what selects the grocery fixture (CONTRACTS.md §6). */
const RECEIPT_FILE_NAME = 'e2e-receipt-migros.jpg'

/**
 * What that fixture extracts to. Verified against a live `cds-tsx serve --in-memory`.
 * The merchant string is distinct from the seeded `MIGROS ZÜRICH HB`, which matters:
 * "did my posting arrive" must not be answered by a row that was already there.
 */
const EXPECTED_MERCHANT = 'MIGROS Zürich Löwenstrasse'
const EXPECTED_AMOUNT = 'CHF 47.85'
const EXPECTED_CATEGORY = 'Groceries'

/** The date on the fixture. The ledger opens on the current month, so the journey has to
 *  walk back to this one to find its own posting. */
const RECEIPT_PERIOD = '2026-03'

/** How far back the month picker is allowed to walk before giving up. Generous: the
 *  fixture date is fixed and "now" keeps moving away from it. */
const MAX_MONTH_STEPS = 48

test.describe.configure({ mode: 'serial' })

/** Present and on screen right now — no waiting, and no throw when there is nothing there. */
async function isShowing(marker: Locator): Promise<boolean> {
  try {
    return await marker.first().isVisible()
  } catch {
    return false
  }
}

/**
 * Walk the ledger's month picker backwards until `marker` is on screen.
 *
 * Written as a loop rather than as "click previous six times" on purpose: six is only
 * right while today is September 2026. This is right for as long as the fixture is.
 */
async function walkBackTo(page: Page, marker: Locator): Promise<number> {
  const previous = page.getByTestId('month-previous')

  for (let step = 0; step <= MAX_MONTH_STEPS; step += 1) {
    if (await isShowing(marker)) return step
    if (step === MAX_MONTH_STEPS) break

    await previous.click()
    // The period change refetches; wait for the list to settle rather than for a timeout.
    await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 15_000 })
  }

  throw new Error(
    `walked back ${MAX_MONTH_STEPS} months without finding the posting. ` +
      `It should be in ${RECEIPT_PERIOD}; check what scanReceipt returned for "date".`,
  )
}

test('a receipt becomes a posting, a payment run, a memory and a statement', async ({ page }) => {
  // ------------------------------------------------------------------
  // 1. Scan
  // ------------------------------------------------------------------
  await test.step('photograph a receipt', async () => {
    await page.goto('/scan')

    // The camera and the library inputs are both real <input type="file"> elements kept
    // out of the layout by CSS — which is exactly what makes them drivable. The button in
    // front of them opens the phone's camera, and Playwright has no camera.
    const upload = page.getByTestId('scan-file-input')
    await expect(upload).toBeAttached()

    await upload.setInputFiles({
      name: RECEIPT_FILE_NAME,
      mimeType: 'image/jpeg',
      buffer: Buffer.from(RECEIPT_JPEG_BASE64, 'base64'),
    })

    // Document AI's mock deliberately waits 800 ms, so there is a real busy state to see.
    // It may already be gone by the time this runs; either way the confirm card is next.
    await expect(page.getByTestId('scan-confirm-card')).toBeVisible({ timeout: 45_000 })
  })

  await test.step('the extraction and the model agree with the receipt', async () => {
    const card = page.getByTestId('scan-confirm-card')
    await expect(card).toBeVisible()

    // The extracted merchant is in an editable field, not in the card's text — the whole
    // point of this screen is that every value is still yours to correct. So it has to be
    // read as a form value, and from the real <input> that ui5-input keeps in its shadow
    // root (Playwright's CSS engine goes through open shadow roots, so `input` finds it).
    await expect
      .poll(
        () =>
          card
            .locator('input')
            .evaluateAll(
              (nodes, expected) =>
                nodes.some(node => (node as HTMLInputElement).value === expected),
              EXPECTED_MERCHANT,
            ),
        { message: `no field in the confirm card holds "${EXPECTED_MERCHANT}"`, timeout: 15_000 },
      )
      .toBe(true)

    // Swiss format, from MoneyText — not a raw 47.85 anywhere.
    await expect(
      card.getByTestId('money').filter({ hasText: EXPECTED_AMOUNT }).first(),
    ).toBeVisible()

    // The classifier picked the category, in-process, from ml/model/weights.json.
    await expect(page.getByTestId('scan-categories')).toContainText(EXPECTED_CATEGORY)

    // Both heads cleared NEEDS_REVIEW_THRESHOLD (0.6) on this fixture, so the "needs
    // review" strip must not be up. If it is, either the weights changed or the threshold
    // did, and the confidence assertions in api-journey.spec.ts will say which.
    await expect(page.getByTestId('scan-review-strip')).toHaveCount(0)
  })

  await test.step('say who paid and post it', async () => {
    // The payer is pre-filled from the person the shell is "wearing", but choosing it
    // explicitly is what a person does, and it exercises the picker.
    const payers = page.getByTestId('scan-paid-by')
    await expect(payers).toBeVisible()
    await payers.getByRole('button').first().click()

    // accessibleName wins over the button's text for the accessible name, so this matches
    // "Post this expense to the ledger" rather than the visible "Post".
    const post = page.getByRole('button', { name: /post this expense/i })
    await expect(post).toBeEnabled()
    await post.click()

    // The posting is real: it has a document number now.
    const posted = page.getByTestId('scan-posted-card')
    await expect(posted).toBeVisible({ timeout: 30_000 })
    await expect(posted).toContainText(/Posted as document #\d+/)
    await expect(posted).toContainText(EXPECTED_MERCHANT)
  })

  // ------------------------------------------------------------------
  // 2. The ledger shows it
  // ------------------------------------------------------------------
  await test.step('the ledger shows it', async () => {
    await page.getByRole('button', { name: /open the ledger/i }).click()
    await expect(page).toHaveURL(/\/ledger$/)

    // Wait for the ledger itself, not just for the URL. React swaps the route in a later
    // frame, and until it does the posted card is still mounted — with the merchant name
    // on it, which would make the search below succeed against the page we just left.
    await expect(page.getByRole('button', { name: 'Payment run' })).toBeVisible()
    await expect(page.getByTestId('scan-posted-card')).toHaveCount(0)
    await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 20_000 })

    // The receipt is dated 2026-03-07 and the ledger opens on the current month, so the
    // posting is in the past. Walk back to it the way a person would.
    const posting = page.getByText(EXPECTED_MERCHANT, { exact: false })
    const steps = await walkBackTo(page, posting)
    // eslint-disable-next-line no-console
    console.log(`found the posting ${steps} month(s) back, in ${RECEIPT_PERIOD}`)

    await expect(posting.first()).toBeVisible()
    await expect(
      page.getByTestId('money').filter({ hasText: EXPECTED_AMOUNT }).first(),
    ).toBeVisible()
  })

  // ------------------------------------------------------------------
  // 3. Payment run
  // ------------------------------------------------------------------
  await test.step('run the payment run for that period', async () => {
    await page.getByRole('button', { name: 'Payment run' }).click()

    // The dialog states what it is about to do before it does it.
    const document = page.getByTestId('payment-run-document')
    await expect(document).toBeVisible()
    await expect(document).toHaveText(`CLR-${RECEIPT_PERIOD}`)
    await expect(page.getByTestId('payment-run-period')).toContainText(RECEIPT_PERIOD)

    // Our posting plus whatever the seed put in that month — at least one.
    const postings = Number((await page.getByTestId('payment-run-postings').innerText()).trim())
    expect(postings).toBeGreaterThan(0)

    // A sentence in words, not a bare number: what the month totalled, over how many
    // postings. Never a balance — nobody owes anybody (CONTRACTS.md §9).
    const result = page.getByTestId('payment-run-result')
    await expect(result).toContainText(/totalled/)
    await expect(result).not.toContainText(/owes|owed|settle up/i)

    await page.getByRole('button', { name: /^Run$/ }).click()

    // The dialog closes and the clearing document takes its place on the page.
    await expect(page.getByTestId('payment-run-document')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByText('Clearing document').first()).toBeVisible()
    await expect(page.getByText(`CLR-${RECEIPT_PERIOD}`).first()).toBeVisible()
  })

  // ------------------------------------------------------------------
  // 4. Memory
  // ------------------------------------------------------------------
  await test.step('write a memory', async () => {
    await page.goto('/memories')
    await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 20_000 })

    // "New" in the toolbar, or "New memory" in the empty state — whichever this ledger
    // happens to be showing.
    await page
      .getByRole('button', { name: /^New( memory)?$/ })
      .first()
      .click()

    // `getByPlaceholder` matches twice here — ui5-input copies the placeholder onto both
    // the custom element and the real input inside its shadow root. Naming the tag picks
    // the one that can actually be typed into.
    const title = page.locator('input[placeholder="What happened"]')
    await expect(title).toBeVisible()
    await title.fill('The night the receipt survived')

    // "Occurred on" is pre-filled with today, which is what a person leaves it at.
    await page.getByRole('button', { name: /^Post memory$/ }).click()

    await expect(page.getByRole('button', { name: /^Post memory$/ })).toBeHidden({
      timeout: 30_000,
    })
    await expect(page.getByText('The night the receipt survived').first()).toBeVisible({
      timeout: 20_000,
    })
  })

  // ------------------------------------------------------------------
  // 5. Statement
  // ------------------------------------------------------------------
  await test.step('generate the Statement of Us', async () => {
    await page.goto('/statement')
    await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 20_000 })

    // "Generate" the first time, "Regenerate" once one exists for the selected year.
    await page.getByRole('button', { name: /^(Generate|Regenerate)$/ }).click()

    // The deterministic template provider renders this locally in milliseconds, but a
    // configured LLM would take much longer — so the timeout is sized for the slow case
    // even though this suite forces the fast one.
    //
    // The marker is the sheet's own footer, not the masthead: the masthead carries
    // `twm-print-only` and is display:none on screen, so it exists in the DOM whether or
    // not anything was generated. This line only renders when a statement does.
    await expect(page.getByText(/unaudited, wholly reliable/).first()).toBeVisible({
      timeout: 120_000,
    })
    await expect(page.getByText(/^Generated /).first()).toBeVisible()
    await expect(page.getByText(/^Engine: /).first()).toBeVisible()

    // The rendered markdown is a document, not a stub.
    const article = page.locator('#twm-main')
    await expect(article).toContainText(/Executive Summary|Statement of Us/i)
    expect((await article.innerText()).length).toBeGreaterThan(400)
  })
})
