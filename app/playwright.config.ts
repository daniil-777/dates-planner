import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright — end-to-end for Two-Way Match.
 *
 * Run it from `app/`:
 *
 *     npm run e2e                         # everything
 *     npx playwright test --project=api   # backend contract only, no browser
 *     npx playwright test --ui            # pick tests by hand
 *
 * ---------------------------------------------------------------------------
 * What starts, and what it writes to
 * ---------------------------------------------------------------------------
 * This config boots both halves of the app itself. You do not need `npm run dev` running —
 * in fact you must not have the CAP half running, see "safety" below.
 *
 *   1. CAP on :4004, with `--in-memory`. That flag is the whole safety story: CAP
 *      bootstraps a transient SQLite database on every start and seeds it from
 *      db/data/*.csv, so the suite gets a known ledger and your real one is never opened.
 *      The port is not configurable — app/vite.config.ts hard-codes http://localhost:4004
 *      as the proxy target for /ledger.
 *
 *   2. Vite on :5173, which proxies /ledger, /admin and /health to CAP.
 *
 * The CAP process is launched with MOCK_DOCAI=1 and with every LLM credential explicitly
 * blanked. Both matter:
 *
 *   * MOCK_DOCAI makes `scanReceipt` return the bundled fixtures, picked by filename
 *     keyword (CONTRACTS.md §6) — so the journey spec uploads a file called "…migros…"
 *     and gets the grocery receipt, every time, with no BTP account.
 *   * Blank LLM variables select the deterministic `template` provider (§7). Without them,
 *     CAP loads the developer's .env in development mode and `generateStatement` would
 *     call a real API — slow, billable, and different on every run. Verified: an
 *     empty-string variable in the launching environment beats the .env file, and /health
 *     then reports "Deterministic template".
 *
 * ---------------------------------------------------------------------------
 * Safety
 * ---------------------------------------------------------------------------
 * The journey spec is destructive by nature: it posts an expense, runs a payment run
 * (which stamps a settlement id onto every confirmed expense in a period) and writes a
 * statement. Against a real ledger that is not a test, it is an accident.
 *
 * So neither server is reused by default. If something is already listening on 4004 —
 * almost certainly your own `npm run dev` — Playwright refuses to start rather than
 * quietly aiming the suite at your live database. The same goes for 5173: a dev server on
 * that port is not necessarily *this* app's dev server, and attaching to a stranger's
 * project produces a page of failures that all look like bugs in this one. (That is not
 * hypothetical. It is how this paragraph came to be written.)
 *
 * Set E2E_REUSE_CAP=1 / E2E_REUSE_WEB=1 to attach to servers you know are yours.
 *
 * ---------------------------------------------------------------------------
 * The two ports, and why only one of them can move
 * ---------------------------------------------------------------------------
 * E2E_WEB_PORT moves the SPA off 5173 — but only for read-only specs. Anything that writes
 * will fail with `{"code":"cross_origin_denied"}`, because the Vite proxy forwards the
 * browser's `Origin` header unchanged and `DEV_ORIGINS` in srv/server.ts trusts exactly
 * `http://localhost:5173` and `http://127.0.0.1:5173`. A GET carries no Origin and so
 * slips through; a POST does not.
 *
 * When 5173 is genuinely unavailable, use E2E_SAME_ORIGIN=1 instead. That builds the SPA
 * and lets CAP serve it from `app/dist` at :4004 — no Vite, no proxy, no cross-origin
 * anything, and the same topology the Fly deployment runs. It is slower to start (a full
 * `vite build`) and has no hot reload, which is why it is not the default.
 */

/** Fixed by app/vite.config.ts, which proxies /ledger to this port. */
const CAP_PORT = 4004
const CAP_URL = `http://localhost:${CAP_PORT}`

/**
 * Serve the built SPA from CAP instead of running Vite: one origin, exactly like
 * production. Read the section above before using it for anything that writes.
 */
const SAME_ORIGIN = process.env.E2E_SAME_ORIGIN === '1'

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173)
const WEB_URL = SAME_ORIGIN ? CAP_URL : `http://localhost:${WEB_PORT}`

const isCI = process.env.CI === 'true' || process.env.CI === '1'

/**
 * Blanked rather than deleted. Playwright merges `webServer.env` into the parent
 * environment, so an absent key would let a value inherited from the shell through; an
 * empty string is what `srv/lib/llm/index.ts` and `srv/lib/documentai/client.ts` both
 * treat as "not configured".
 */
const capEnv: Record<string, string> = {
  PORT: String(CAP_PORT),
  NODE_ENV: 'development',
  MOCK_DOCAI: '1',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_BASE_URL: '',
  LLM_BASE_URL: '',
  LLM_API_KEY: '',
  AICORE_SERVICE_KEY: '',
  CLASSIFIER_URL: '',
  CLASSIFIER_TOKEN: '',
}

/**
 * In same-origin mode CAP serves `app/dist`, so `app/dist` has to exist and be current.
 *
 * `npx vite build` rather than the project's own `npm run build`, and that is not a
 * shortcut: `app/package.json` builds with `tsc -b --noEmit false`, which — with no
 * `outDir` — writes a `.js` file next to every `.ts`/`.tsx` under `src/` and `e2e/`. Vite
 * resolves `.js` before `.tsx`, so those files can shadow the real modules on the next
 * build, and Playwright's default `testMatch` collects `*.spec.js`, so every spec would
 * run twice — the second copy failing, because the first one already used up the payment
 * run. Typechecking is CI's job (`npm run typecheck`), not the e2e runner's.
 */
const capCommand = SAME_ORIGIN
  ? 'cd app && npx vite build && cd .. && npx cds-tsx serve --in-memory'
  : 'npx cds-tsx serve --in-memory'

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',

  // `.ts` only. Playwright's default also collects `*.spec.js`, and a stray build can put
  // one of those next to every spec here — see the note on `capCommand` above. Every spec
  // in this directory is TypeScript; anything else is debris.
  testMatch: /\.spec\.ts$/,

  // One ledger, shared by every spec. Parallelism here would mean two payment runs racing
  // for the same period.
  fullyParallel: false,
  workers: 1,

  forbidOnly: isCI,
  retries: isCI ? 1 : 0,

  // A scan is a real image upload through sharp, Document AI (mocked, with a deliberate
  // 800 ms delay) and the classifier. 60 s is generous but not silly.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: isCI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,

    // The app formats money as CHF 1'234.50 through its own formatter, never through
    // toLocaleString defaults (FRONTEND-CONTRACT §5). Pinning locale and timezone means a
    // failure there is a real formatting bug and not a CI runner in UTC-with-en-US.
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
  },

  projects: [
    {
      // No browser is launched: these tests use only the `request` fixture. Fastest and
      // least brittle of the three — it asserts the backend contract the pages are written
      // against, so when a UI spec fails you can tell in one run whether the API or the
      // markup moved.
      name: 'api',
      testMatch: /api-.*\.spec\.ts$/,
      use: { baseURL: CAP_URL },
    },
    {
      // The app is mobile-first and this is how it is actually used: one hand, at a
      // restaurant table. Everything except the API specs runs here.
      name: 'mobile',
      testIgnore: /api-.*\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
    {
      // Desktop gets the smoke pass only. Running the journey twice would put two payment
      // runs on one period, and the second one is supposed to fail.
      name: 'desktop',
      testMatch: /smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: capCommand,
      // `cwd` is resolved against this config file's directory, so this is the repo root
      // no matter where playwright was invoked from.
      cwd: '..',
      url: `${CAP_URL}/health`,
      // In development /health is public and answers 200. (In production it is behind basic
      // auth and answers 401 — see fly.toml. Do not point this at a deployment; nothing
      // here would work.)
      reuseExistingServer: process.env.E2E_REUSE_CAP === '1',
      // Cold start compiles the CDS model and every TypeScript handler through tsx, and in
      // same-origin mode builds the SPA first.
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: capEnv,
    },
    // In same-origin mode CAP serves the SPA and there is no second server.
    ...(SAME_ORIGIN
      ? []
      : [
          {
            command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
            url: WEB_URL,
            reuseExistingServer: process.env.E2E_REUSE_WEB === '1',
            timeout: 120_000,
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
          },
        ]),
  ],
})
