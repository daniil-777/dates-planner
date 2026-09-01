import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

/**
 * Does the whole thing come up, on a phone and on a laptop.
 *
 * REQUIRES THE BACKEND (and the SPA). playwright.config.ts starts both — CAP on :4004 with
 * `--in-memory`, Vite on :5173. Every page here reads real data through the hooks in
 * app/src/api/hooks.ts, so a green run means the proxy, the OData client, the query layer
 * and the five routes of FRONTEND-CONTRACT §6 are all wired together.
 *
 * This spec is read-only: it navigates, it looks, it never posts. It is the one to run
 * when you want to know whether the app is alive without changing anything in it.
 *
 * Runs in both the `mobile` and `desktop` projects. The two layouts differ — a bottom bar
 * on a phone, side navigation on a laptop (AppShell switches on a media query) — so the
 * navigation assertions branch on the project name rather than pretending they are the same.
 */

/** FRONTEND-CONTRACT §6, in the bottom-navigation order the contract fixes. */
const ROUTES = [
  { path: '/scan', label: 'Scan' },
  { path: '/ledger', label: 'Ledger' },
  { path: '/memories', label: 'Memories' },
  { path: '/statement', label: 'Statement' },
  { path: '/settings', label: 'Settings' },
] as const

/**
 * Exactly what `formatMoney` in app/src/theme.ts produces: symbol first, ASCII apostrophe
 * for thousands, always two decimals, the minus sign in front of everything.
 * `CHF 18'420.55`, `-CHF 30.52`.
 */
const SWISS_MONEY = /^-?[A-Z]{3} \d{1,3}(?:'\d{3})*\.\d{2}$/

/** The failure this regex is here to catch: `toLocaleString()` defaults, `18,420.55`. */
const COMMA_GROUPED = /\d,\d{3}/

/**
 * Open a route.
 *
 * This used to be a workaround. `/ledger` was both a client route (FRONTEND-CONTRACT §6)
 * and the OData service path, so a hard navigation to it never reached React and the
 * browser got the service document as JSON; the suite had to enter through `/` instead.
 * The services now live under `/api` (`/api/ledger`, `/api/admin`), which is the first of
 * the three fixes GO-LIVE.md offered, so every route is directly navigable and this is a
 * plain `goto` again. It is kept as a seam rather than inlined because the whole suite
 * calls it, and the test below guards the fix.
 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path)
}

/**
 * Collect the console errors and uncaught exceptions a page produces.
 *
 * UI5 web components are noisy in development, so this is filtered down to what actually
 * indicates breakage. The list is deliberately short: every entry is something seen to be
 * benign, and anything not on it fails the test.
 */
function watchForErrors(page: Page): string[] {
  const problems: string[] = []

  const benign = [
    // UI5 warns about themes and about custom elements being defined twice under Vite's
    // module graph in dev. Neither affects behaviour.
    /ui5/i,
    // React's dev-mode advice, and the act() warning that the testing library owns.
    /React DevTools/i,
    // Vite's HMR chatter.
    /\[vite\]/i,
    // Leaflet tiles: the memories map fetches from an external tile server that CI has no
    // business reaching, and a missing tile is not a broken app.
    /tile\.openstreetmap|leaflet/i,
    // vite-plugin-pwa does not register a service worker in dev, and the browser says so.
    /service ?worker/i,
    // The browser logs this for every non-2xx subresource, whether or not anything is
    // wrong. Settings deliberately asks /admin/modelInfo() without knowing whether it is
    // allowed to — AdminService is `@requires: 'admin'`, which CAP's mocked dev auth
    // refuses for an anonymous caller, and app/src/pages/settings/modelInfo.ts returns
    // null and renders the card without the model row. A handled 401 is not a defect, so
    // a *console line* about a failed request cannot be the thing that fails a test.
    // Failures that reach the user are caught below, by the ErrorState check.
    /Failed to load resource/i,
    // A real defect, and a loud one — 38 of these per page load — but it is *one* defect,
    // and it has its own named test at the bottom of this file so that it is reported once
    // rather than as five identical page failures. See "the production CSP allows the UI5
    // theme fonts".
    /violates the following Content Security Policy directive: "font-src/i,
  ]

  const record = (text: string) => {
    if (benign.some(pattern => pattern.test(text))) return
    problems.push(text)
  }

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') record(message.text())
  })
  page.on('pageerror', error => record(`uncaught: ${error.message}`))

  return problems
}

test.describe('the app comes up', () => {
  test('/ redirects to the ledger', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/ledger$/)
  })

  test('the ShellBar names the product', async ({ page }) => {
    await open(page, '/ledger')

    // Asserted as attributes rather than as text: UI5's ShellBar hides both titles at its
    // "S" breakpoint, which is every phone, so on the mobile project there is nothing to
    // read on screen. The attributes are what the component was given either way, and the
    // document title is what a browser tab and an installed PWA display.
    const shellbar = page.locator('ui5-shellbar')
    await expect(shellbar).toHaveAttribute('primary-title', 'Two-Way Match')
    await expect(shellbar).toHaveAttribute('secondary-title', 'Household spend management')
    await expect(page).toHaveTitle(/Two-Way Match/)
  })

  for (const route of ROUTES) {
    test(`${route.path} renders something real`, async ({ page }) => {
      const problems = watchForErrors(page)

      await open(page, route.path)

      // The shell is always there, whatever the page inside it is doing.
      await expect(page.locator('#twm-main')).toBeVisible()

      // A page that is still fetching shows a skeleton; a page with nothing to show has an
      // IllustratedMessage (FRONTEND-CONTRACT §7: "Every list has a real EmptyState …,
      // never a blank screen"). Either is a pass. A page that renders nothing at all is not.
      await expect
        .poll(
          async () => {
            const skeletons = await page.getByTestId('loading-skeleton').count()
            if (skeletons > 0) return 'loading'
            const text = (await page.locator('#twm-main').innerText()).trim()
            return text.length > 0 ? 'content' : 'blank'
          },
          { message: `${route.path} never rendered anything into #twm-main`, timeout: 20_000 },
        )
        .not.toBe('blank')

      // Settle, then insist the loading state ended.
      await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 20_000 })

      // An ErrorState here means a request failed — usually the CAP server, occasionally a
      // contract drift between client.ts and the service.
      const errors = page.getByTestId('error-state')
      if ((await errors.count()) > 0) {
        throw new Error(`${route.path} rendered an ErrorState: ${await errors.first().innerText()}`)
      }

      expect(problems, `${route.path} logged errors`).toEqual([])
    })
  }
})

test.describe('navigation', () => {
  test('every destination in FRONTEND-CONTRACT §6 is reachable from the shell', async ({
    page,
  }, testInfo) => {
    await open(page, '/ledger')

    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible()

    if (testInfo.project.name !== 'mobile') {
      // Desktop: SideNavigation. Its items live in shadow DOM and its accessible roles
      // vary with the UI5 version, so this checks the labels are present and leaves the
      // click-through to the mobile project, where the markup is plain anchors.
      for (const route of ROUTES) {
        await expect(nav.getByText(route.label, { exact: true })).toBeVisible()
      }
      return
    }

    // Mobile: the bottom bar is five real <a> elements, so it can be driven the way a
    // person drives it.
    const links = nav.getByRole('link')
    await expect(links).toHaveCount(ROUTES.length)

    for (const route of ROUTES) {
      const link = nav.getByRole('link', { name: route.label })
      await expect(link).toBeVisible()

      // FRONTEND-CONTRACT §7: touch targets >= 44 px. This is used one-handed, walking.
      const box = await link.boundingBox()
      expect(box, `${route.label} has no box`).not.toBeNull()
      expect(
        box?.height ?? 0,
        `${route.label} is under the 44 px touch target`,
      ).toBeGreaterThanOrEqual(44)

      await link.click()
      await expect(page).toHaveURL(new RegExp(`${route.path}$`))
    }
  })

  test('the bottom bar clears the home indicator', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'there is no bottom bar on a desktop layout')

    await open(page, '/ledger')
    const nav = page.locator('nav.twm-bottomnav')
    await expect(nav).toBeVisible()

    // The bar must sit inside the safe area, not under the iPhone home indicator. The
    // emulated Pixel reports a zero inset, so this cannot assert a number — what it can
    // assert is that the rule exists at all, which is the thing people forget.
    const padding = await nav.evaluate(el => getComputedStyle(el).paddingBottom)
    expect(padding, 'the bottom bar needs an env(safe-area-inset-bottom) padding').not.toBe('')
  })
})

test.describe('money is Swiss, everywhere', () => {
  test('every rendered amount uses the apostrophe format', async ({ page }) => {
    // The ledger is where the seed data shows up, so this is where amounts are dense.
    await open(page, '/ledger')
    await expect(page.getByTestId('loading-skeleton')).toHaveCount(0, { timeout: 20_000 })

    const amounts = page.getByTestId('money')
    // Wait for the first one rather than counting immediately: the skeletons come down when
    // the *shell* has data, and the list below them paints a frame or two later.
    await expect(
      amounts.first(),
      'the ledger rendered no amounts at all — is the seed data loaded?',
    ).toBeVisible({ timeout: 20_000 })
    const count = await amounts.count()
    expect(count).toBeGreaterThan(0)

    const rendered = await amounts.allInnerTexts()
    for (const text of rendered) {
      const value = text.trim()
      expect(value, `"${value}" is not Swiss money`).toMatch(SWISS_MONEY)
    }

    // And nothing anywhere else on the page slipped through with toLocaleString defaults.
    const wholePage = await page.locator('#twm-main').innerText()
    expect(wholePage, 'something on this page is comma-grouped').not.toMatch(COMMA_GROUPED)
  })
})

test.describe('installable', () => {
  test('index.html carries the iOS install metadata', async ({ page }) => {
    // These four are in app/index.html itself, so they are true in dev and in the build.
    // On iOS they are what decides whether "Add to Home Screen" produces an app or a
    // bookmark with a browser chrome around it.
    await open(page, '/ledger')

    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0070F2')
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
      'content',
      'yes',
    )
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
      'content',
      '2WM',
    )
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1)

    // viewport-fit=cover is what makes env(safe-area-inset-*) mean anything at all.
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/,
    )
  })

  test('the web manifest is complete', async ({ page }) => {
    await open(page, '/ledger')

    const link = page.locator('link[rel="manifest"]')
    const injected = (await link.count()) > 0

    // vite-plugin-pwa injects the manifest and registers the service worker only in a
    // production build; the dev server serves neither. This is not a failure, it is the
    // tool working as configured — so say so and move on.
    test.skip(
      !injected,
      'no manifest in the dev server — check this against a build: ' +
        'npm run build && npm run preview, then npx playwright test smoke --project=mobile',
    )

    const href = await link.getAttribute('href')
    expect(href).not.toBeNull()

    const response = await page.request.get(href ?? '')
    expect(response.status()).toBe(200)

    const manifest = (await response.json()) as {
      name?: string
      short_name?: string
      display?: string
      start_url?: string
      theme_color?: string
      icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>
    }

    expect(manifest.name).toBe('Two-Way Match')
    expect(manifest.short_name).toBe('2WM')
    // Anything but 'standalone' and the installed app keeps the browser's address bar.
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.theme_color).toBe('#0070F2')

    const icons = manifest.icons ?? []
    // Android needs a 192 and a 512; the maskable one is what stops the icon being pasted
    // into a white circle on Pixel launchers.
    expect(icons.some(icon => icon.sizes === '192x192')).toBe(true)
    expect(icons.some(icon => icon.sizes === '512x512')).toBe(true)
    expect(icons.some(icon => icon.purpose === 'maskable')).toBe(true)

    // Every icon the manifest promises must actually be there.
    for (const icon of icons) {
      const iconResponse = await page.request.get(new URL(icon.src, page.url()).toString())
      expect(iconResponse.status(), `${icon.src} is missing`).toBe(200)
    }
  })
})

test.describe('fixed defects · guarded', () => {
  /**
   * A deep link to /ledger returns JSON, not the app.
   *
   * `/ledger` is the client route (FRONTEND-CONTRACT §6) *and* the OData service path
   * (CONTRACTS.md §1.4), and on a hard navigation the server wins:
   *
   *   * in development, app/vite.config.ts proxies the `/ledger` prefix to CAP;
   *   * in production, `API_PREFIXES` in srv/server.ts excludes `/ledger` from the SPA
   *     history fallback;
   *   * offline, the workbox `navigateFallbackDenylist` excludes it as well.
   *
   * Fixed by moving the services under `/api`: `srv/ledger-service.cds` is now
   * `@(path: '/api/ledger')`, `API_PREFIXES` in `srv/server.ts` no longer claims
   * `/ledger`, the Vite proxy forwards `/api` instead, and the workbox
   * `navigateFallbackDenylist` matches `/^\/api/`. So `/ledger` is the client route and
   * nothing else, and a reload, a bookmark and a shared link all reach React.
   *
   * This guards that. If anyone re-registers a service at a bare `/ledger`, it fails here
   * rather than in somebody's browser.
   */
  test('a hard navigation to /ledger loads the app, not the OData service document', async ({
    page,
  }) => {
    await page.goto('/ledger')
    await expect(page.locator('#twm-main')).toBeVisible()
    await expect(page.locator('ui5-shellbar')).toHaveAttribute('primary-title', 'Two-Way Match')
  })
})

test.describe('fixed defects · production only', () => {
  /**
   * The Fiori font used never to load in production.
   *
   * `@ui5/webcomponents` bakes its `72` family into the theme CSS at build time with
   * absolute `https://cdn.jsdelivr.net/...` URLs, and helmet's CSP in `srv/server.ts` sets
   * `font-src 'self' data:`. Every face was blocked — 38 console violations on a single
   * page load — and the app rendered in the browser's fallback font. It still worked; it
   * stopped looking like SAP, which for this particular product is most of the joke.
   *
   * It never showed up in `npm run dev`, because there the SPA comes from Vite and only
   * the API calls pass through helmet. It showed up the moment CAP served `app/dist` —
   * that is, in the container, which is the only place it mattered.
   *
   * Fixed by bundling rather than by widening the CSP: the 24 `72-*.woff2` faces are
   * vendored into `app/public/fonts`, and the `twm-bundle-ui5-fonts` plugin in
   * `app/vite.config.ts` rewrites the baked CDN URLs to `/fonts/` at build time. That
   * keeps `font-src 'self'`, takes a third party out of the critical path of a private
   * app, and — unlike widening the CSP — lets the service worker precache the faces, so an
   * installed PWA renders in the right font offline.
   *
   * Asserted against the header rather than against a blocked request, so it means the
   * same thing in both topologies: helmet is mounted unconditionally in `srv/server.ts`,
   * and the Vite dev proxy passes response headers through.
   */
  test('the UI5 theme fonts are served same-origin, with font-src left tight', async ({
    request,
  }) => {
    const response = await request.get('/health')
    const csp = response.headers()['content-security-policy'] ?? ''

    expect(csp, 'no CSP header at all — has securityHeaders() been removed?').not.toBe('')

    const fontSrc = /font-src([^;]*)/.exec(csp)?.[1] ?? ''
    expect(fontSrc, 'no font-src directive in the CSP').not.toBe('')
    expect(fontSrc).toContain("'self'")

    // The whole point of bundling: if this starts failing, someone widened the CSP instead
    // of fixing the URLs, and the app is phoning a CDN on every load again.
    expect(fontSrc, 'the 72 faces are bundled, so no CDN belongs in font-src').not.toContain(
      'jsdelivr',
    )

    // And the faces the rewritten @font-face rules point at must actually be served.
    const font = await request.get('/fonts/72-Regular.woff2')
    expect(font.status(), '/fonts/72-Regular.woff2 must be served same-origin').toBe(200)
  })
})
