import { expect, test, type Page } from '@playwright/test'

/**
 * A round of "What? Where? When?", driven the way a table drives it.
 *
 * REQUIRES THE BACKEND only because the shell does; the game itself is entirely client-side
 * and works offline, which is the point of bundling the questions rather than serving them.
 *
 * The one thing worth stating about how this is written: it never waits out the minute. A
 * test that sleeps for sixty seconds is a test nobody runs. The early-answer path — which is
 * a real rule of the game, not a shortcut — reaches the same reveal.
 */

async function open(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('twm.lang', 'en')
    // A clean pile every run, or a machine that has played before gets different questions
    // and eventually none.
    window.localStorage.removeItem('twm.chgk.played.v1')
  })
  await page.goto(path)
  await expect(page.locator('main')).toBeVisible()
}

test('the chapter offers the game and says what it is', async ({ page }) => {
  await open(page, '/games')
  await expect(page.getByRole('heading', { name: 'Games' })).toBeVisible()
  await expect(page.getByText('What? Where? When?')).toBeVisible()
  // The card says how long and how many people, because that is what decides whether a table
  // starts a game at half past nine.
  await expect(page.getByText(/2 players or more/)).toBeVisible()
})

test('a whole round: spin, read, discuss, reveal, score', async ({ page }) => {
  await open(page, '/games')
  await page.getByText('What? Where? When?').click()

  // 0:0 before anything happens.
  const score = page.locator('.chgk-score')
  await expect(score).toContainText('0')

  await page.getByRole('button', { name: 'Start' }).click()

  // The top turns for a moment before the question appears — the pause is deliberate.
  await expect(page.locator('.chgk-top--spinning')).toBeVisible()
  await expect(page.getByText('Choosing…')).toBeVisible()

  // Then a question, with the clock not yet running: the reader needs to read it aloud first.
  const card = page.locator('.chgk-card')
  await expect(card).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('The question', { exact: true })).toBeVisible()
  await expect(page.locator('.chgk-timer--idle')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start the minute' })).toBeVisible()

  await page.getByRole('button', { name: 'Start the minute' }).click()

  // Sixty seconds, counting.
  const timer = page.locator('.chgk-timer')
  await expect(timer).toHaveAttribute('aria-label', /\d+ seconds left/)
  await expect(page.getByRole('button', { name: 'We have an answer' })).toBeVisible()

  // The team commits early, which is a rule of the game rather than a way to skip a wait.
  await page.getByRole('button', { name: 'We have an answer' }).click()

  await expect(page.getByText('The answer', { exact: true })).toBeVisible()
  await expect(card).toHaveClass(/chgk-card--revealed/)
  // Every question carries the line that makes it worth having asked.
  await expect(page.locator('.chgk-card__note')).not.toBeEmpty()

  await page.getByRole('button', { name: 'We got it' }).click()
  await expect(score).toContainText('1')
  await expect(page.getByRole('button', { name: 'Next question' })).toBeVisible()
})

test('the clock is read from a deadline, so it actually counts down', async ({ page }) => {
  await open(page, '/games')
  await page.getByText('What? Where? When?').click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.getByRole('button', { name: 'Start the minute' }).click({ timeout: 6_000 })

  const timer = page.locator('.chgk-timer')
  const first = await timer.getAttribute('aria-label')
  await page.waitForTimeout(2_200)
  const later = await timer.getAttribute('aria-label')

  const seconds = (label: string | null): number => Number(/(\d+)/.exec(label ?? '')?.[1] ?? -1)
  expect(seconds(later)).toBeLessThan(seconds(first))
  expect(seconds(later)).toBeGreaterThan(50)
})

test('a played question does not come round again', async ({ page }) => {
  await open(page, '/games')
  await page.getByText('What? Where? When?').click()

  const asked: string[] = []
  for (let round = 0; round < 3; round += 1) {
    await page.getByRole('button', { name: round === 0 ? 'Start' : 'Next question' }).click()
    const text = await page.locator('.chgk-card__q').textContent({ timeout: 6_000 })
    asked.push(text ?? '')
    await page.getByRole('button', { name: 'Start the minute' }).click()
    await page.getByRole('button', { name: 'We have an answer' }).click()
    await page.getByRole('button', { name: 'We did not' }).click()
  }

  // A party game that repeats itself inside three rounds is one nobody suggests twice.
  expect(new Set(asked).size).toBe(3)
})
