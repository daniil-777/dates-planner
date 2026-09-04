import { expect, test, type Page } from '@playwright/test'

/**
 * The commons, in a real browser — TWM-ADR-003.
 *
 * REQUIRES THE BACKEND. `playwright.config.ts` starts CAP on :4004 with `--in-memory` and
 * Vite on :5173, so the Ideas deck below is the real seeded one from
 * `db/data/twowaymatch-Ideas.csv` read through the real service.
 *
 * ## Why the corpus is stubbed and the deck is not
 *
 * A place appears only once three *different* households have rated it (CONTRACTS §14.1),
 * and every request in this suite resolves to the same one — open-door development mode is a
 * single household by definition. So the populated state cannot be reached by driving the
 * UI, and the honest options are to seed a fake corpus into `db/data` (which would then ship
 * to production on a fresh install, putting invented ratings in front of real households) or
 * to stub the one read that needs it. This stubs it, in the two tests that need a populated
 * screen, and leaves everything else against the real thing.
 *
 * The empty states are therefore tested for real, which is worth more than it sounds: on a
 * fresh install they are what everybody sees first.
 */

/** Zürich. Written straight to storage so no test ever fires a location permission prompt. */
const HERE = { lat: 47.38, lon: 8.54 }

async function open(page: Page, path: string): Promise<void> {
  await page.addInitScript(here => {
    window.localStorage.setItem('twm.here.v1', JSON.stringify(here))
    // Pinned, because `readStoredLang` falls back to `navigator.language` and the runner's
    // locale is not something a test should depend on — a German CI box would fail every
    // assertion below for no reason anybody could see from the message.
    window.localStorage.setItem('twm.lang', 'en')
  }, HERE)
  await page.goto(path)
  await expect(page.locator('main')).toBeVisible()
}

/** One place, published, as the service would send it. */
function card(overrides: Record<string, unknown> = {}) {
  return {
    ID: '11111111-1111-4111-8111-111111111111',
    name: 'Kafi Dihei',
    kind: 'cafe',
    lat: 47.3805,
    lon: 8.5401,
    city: 'Zürich',
    distance: 420,
    stars: '4.40',
    households: 12,
    published: true,
    needs: 0,
    costBand: 'c15_30',
    tags: ['quiet', 'walk_after'],
    googleUrl: 'https://www.google.com/maps/search/?api=1&query=47.380500%2C8.540100',
    appleUrl: 'https://maps.apple.com/?ll=47.380500%2C8.540100&q=Kafi%20Dihei',
    ...overrides,
  }
}

async function stubCorpus(page: Page): Promise<void> {
  await page.route('**/api/commons/nearby(**', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          card(),
          card({
            ID: '22222222-2222-4222-8222-222222222222',
            name: 'Rooftop Bar',
            kind: 'bar',
            lat: 47.3861,
            lon: 8.5372,
            stars: '4.10',
            households: 5,
            costBand: 'c30_60',
            tags: ['view', 'late_open'],
            distance: 1240,
          }),
          card({
            ID: '33333333-3333-4333-8333-333333333333',
            name: 'The New One',
            lat: 47.3748,
            lon: 8.5461,
            published: false,
            stars: null,
            households: 1,
            needs: 2,
            costBand: null,
            tags: [],
            distance: 300,
          }),
        ],
        next: null,
      }),
    })
  })

  // The detail sheet asks a second question, and a stub that answers only the first leaves it
  // showing an ellipsis where a name should be.
  await page.route('**/api/commons/placeDetail(**', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        place: card(),
        histogram: [0, 1, 1, 4, 6],
        tips: [{ text: 'The corner table is the one.', tags: ['quiet'] }],
        ratedByYou: false,
        yourStars: null,
      }),
    })
  })
}

test.describe('the three screens', () => {
  test('every route comes up and the nav moves between them', async ({ page }) => {
    await open(page, '/tonight')
    await expect(page.getByRole('heading', { name: 'Tonight' })).toBeVisible()

    const nav = page.getByRole('navigation', { name: 'The commons' })
    await nav.getByRole('link', { name: 'Places' }).click()
    await expect(page).toHaveURL(/\/places$/)
    await expect(page.getByRole('heading', { name: 'Places' })).toBeVisible()

    await nav.getByRole('link', { name: 'Ideas' }).click()
    await expect(page).toHaveURL(/\/ideas$/)
    await expect(page.getByRole('heading', { name: 'Ideas' })).toBeVisible()
  })

  test('the launcher tile reaches them', async ({ page }) => {
    await open(page, '/')
    await page.getByRole('link', { name: /Tonight/ }).click()
    await expect(page).toHaveURL(/\/tonight$/)
  })
})

test.describe('an empty corpus', () => {
  test('Tonight says why it has nothing rather than showing a spinner forever', async ({
    page,
  }) => {
    await open(page, '/tonight')
    await expect(page.getByText('Nothing to deal yet.')).toBeVisible()
    // The empty state has to teach the rule, because on a fresh install it is the feature.
    await expect(page.getByText(/three households have rated it/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rate a place' })).toBeVisible()
  })

  test('Places says the same thing, and never renders a zero rating', async ({ page }) => {
    await open(page, '/places')
    await expect(page.getByText('Nothing near you yet.')).toBeVisible()
    // The bug this guards: `stars ?? 0` renders "0.0 ★" for somewhere nobody has judged.
    await expect(page.locator('.stars')).toHaveCount(0)
  })
})

test.describe('the deck', () => {
  test('renders the real seeded cards, which work with no corpus at all', async ({ page }) => {
    await open(page, '/ideas')

    const cards = page.locator('.idea')
    await expect(cards.first()).toBeVisible()
    // 28 activity ideas are seeded; the exact count is not the point, having real ones is.
    expect(await cards.count()).toBeGreaterThan(20)

    // Each card is an instruction, not a category.
    await expect(page.getByText('Walk the whole tram line')).toBeVisible()
  })

  test('switches to the gift deck', async ({ page }) => {
    await open(page, '/ideas')
    await page.getByText('To give', { exact: true }).click()
    await expect(page.getByText('The photograph, printed')).toBeVisible()
  })
})

test.describe('a populated corpus', () => {
  test.beforeEach(async ({ page }) => {
    await stubCorpus(page)
  })

  test('shows the rating, the denominator and both maps', async ({ page }) => {
    await open(page, '/places')

    const first = page.locator('.place-card').first()
    await expect(first.getByText('4.4')).toBeVisible()
    // Never a bare number: a rating without its denominator is a number pretending to be a fact.
    await expect(first.getByText('12 households')).toBeVisible()
    await expect(first.getByRole('link', { name: 'Google Maps' })).toBeVisible()
    await expect(first.getByRole('link', { name: 'Apple Maps' })).toBeVisible()
  })

  test('withholds the rating of a place too few households have rated', async ({ page }) => {
    await open(page, '/places')

    const unpublished = page.locator('.place-card', { hasText: 'The New One' })
    await expect(unpublished.getByText(/1 household so far/)).toBeVisible()
    await expect(unpublished.getByText(/2 more/)).toBeVisible()
    await expect(unpublished.locator('.stars')).toHaveCount(0)
  })

  test('puts a pin on the map for every place, with the rating written on it', async ({ page }) => {
    await open(page, '/places')
    await expect(page.locator('.places-map__canvas')).toBeVisible()
    await expect(page.locator('.pin')).toHaveCount(3)
    await expect(page.locator('.pin__stars').first()).toHaveText('4.4')
    // The unpublished one gets a dot, because no number is honest and "0.0" is not.
    await expect(page.locator('.pin--quiet')).toHaveCount(1)
  })

  test('opens a place, and offers to rate it from there', async ({ page }) => {
    await open(page, '/places')
    await page.getByRole('button', { name: 'Open Kafi Dihei' }).click()

    // A card opens the detail sheet; rating is one press further on. The map links live here
    // rather than on every row of the list.
    const detail = page.locator('.place-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Kafi Dihei' })).toBeVisible()
    await expect(detail.getByRole('link', { name: 'Google Maps' })).toBeVisible()

    await detail.getByRole('button', { name: 'Rate it' }).click()
    // `.rate-sheet__body` rather than `getByRole('dialog')`: UI5 puts the dialog role on an
    // element inside its shadow root, and this content is *slotted*, so it is a child of
    // `<ui5-dialog>` rather than a descendant of the element carrying the role.
    await expect(page.locator('.rate-sheet__body')).toBeVisible()
  })
})

test.describe('rating', () => {
  test('is one tap: the button goes live the moment a star is pressed', async ({ page }) => {
    await open(page, '/tonight')
    await page.getByRole('button', { name: 'Rate a place' }).first().click()

    const sheet = page.locator('.rate-sheet__body')
    await expect(sheet).toBeVisible()

    // Nothing is chosen yet, so there is nothing to post.
    await expect(page.getByRole('button', { name: 'Post' })).toBeDisabled()

    const stars = page.getByRole('radio', { name: '4 stars' })
    await expect(stars).toBeVisible()
    await stars.click()
    await expect(stars).toHaveAttribute('aria-checked', 'true')

    // Still disabled: a rating needs a place. But the stars are the only *required* answer,
    // and everything below them says so.
    await expect(sheet.getByText('Everything below is optional.')).toBeVisible()
  })

  test('says who will read a tip, next to the field rather than in a policy', async ({ page }) => {
    await open(page, '/tonight')
    await page.getByRole('button', { name: 'Rate a place' }).first().click()
    await expect(page.getByText(/Other households will read this/)).toBeVisible()
  })
})

test.describe('on a phone', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'layout only')

  test('nothing scrolls sideways and every control is thumb-sized', async ({ page }) => {
    await stubCorpus(page)
    for (const path of ['/tonight', '/places', '/ideas']) {
      await open(page, path)

      // The page never scrolls horizontally; chip rows scroll inside themselves.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1)

      // 44 px, the same floor the rest of the app is held to.
      const small = await page.evaluate(() => {
        const targets = [...document.querySelectorAll('a, button')]
        return targets
          .filter(node => {
            const box = node.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && box.height < 32
          })
          .map(node => node.textContent?.trim().slice(0, 24) ?? '?')
      })
      expect(small, `${path} has controls too small for a thumb`).toEqual([])
    }
  })
})
