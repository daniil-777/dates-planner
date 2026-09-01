# Changelog

All notable changes to Two-Way Match. Format loosely after
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **A version stamp, and an honest update banner.** Every frontend build now carries its
  `package.json` version, short commit and build time — compiled into the bundle by
  `app/vite/buildStamp.ts` and written to `app/dist/build.json`, which `/health` reports as
  `build`. **Settings → Version** shows the build this device is running next to the one
  the server has, says which state the service worker is in, and has *Check for updates*.
  When a newer build is installed and waiting, a banner at the bottom of every screen offers
  *Reload*.
- `npm run deploy` (`scripts/deploy.sh`) — `fly deploy` with the commit handed in as
  `GIT_SHA`, since the build context has no `.git`. It refuses an uncommitted tree: the
  stamp names HEAD and `fly deploy` ships the working tree, and a stamp that lies is worse
  than none. `DEPLOY_DIRTY=1` ships anyway, stamped `8cea17b-dirty`.

### Changed

- The service worker now registers in `prompt` mode rather than `autoUpdate`: a new build
  waits for a tap on *Reload* instead of taking over the page underneath whatever was being
  typed. The app also asks for a new worker once an hour while it stays open, and when it
  comes back to the foreground after five minutes away — before, a phone that never closed
  the app never found out about a deploy. Readiness is read off the registration itself,
  not only off the plugin's callback, so the second deploy of a week-long session brings
  the banner back after *Later* just like the first.
- **One-time step for the deploy that ships this change:** phones running the previous
  `autoUpdate` build have no banner to show and never tell the new worker to take over, so
  after this deploy each installed app has to be closed (swiped away) and reopened once.
  From the next build on, the banner does it.

## [1.0.0] — 2026-09-01

First release. A private expense app for a household of any size, wearing SAP clothing on
purpose, installable on a phone, and complete with no credentials at all.

That last clause is the design rule the whole release is built on: with an empty `.env`,
receipts are extracted from bundled fixtures, the yearly statement is rendered by a
deterministic template, the classifier runs in-process, and authentication falls back to
CAP's mocked users in development. Every credential you add buys one more real service, and
none of them is required.

### The application

**Scan.** Photograph a receipt, and one action does the rest: `scanReceipt` normalises the
image with sharp (stripping every scrap of EXIF, geotags included), stores it, extracts it
with SAP Document AI, classifies it, and returns a draft posting. Number parsing handles
`1'234.50`, `1.234,50` and `1 234,50`, because a Swiss receipt and an Italian one look
different. Without Document AI credentials the client runs on bundled fixtures chosen by
filename keyword — a complete scan flow with no BTP account and no network.

**A two-head classifier, trained in Python and executed in TypeScript.** Category (ten
classes) and moment (four) from the merchant string, the amount and the time of day, over
65 536 hashed character n-grams. `ml/train.py` fits it; `ml/export_ts.py` writes
`ml/model/weights.json`; `srv/lib/classifier/` reproduces scikit-learn's feature pipeline
exactly — including `char_wb`'s short-word `break`, `zlib.crc32` bucketing and L2
normalisation — and `test/classifier-parity.test.ts` holds the two implementations to 1e-4
over 60 fixture rows. Predictions under the 0.6 confidence threshold are flagged
**Needs review** rather than quietly accepted.

**Ledger.** Postings by month, with charts, filters, and the month's total said in a
sentence rather than shown as a number. Every correction a human makes to a prediction is
written to `Corrections` and becomes training data for the next round.

**Nobody owes anybody.** An expense records who *paid* it and, optionally, which event —
a trip, a dinner, a party — it belongs to. Every aggregate downstream is a sum with a
proportion beside it: what a month totalled, what each person put in, what an occasion cost
and what that works out at per head. There is no balance, no netting and nothing to square
up.

**Payment run.** The monthly close, deadpan: it freezes a period's confirmed, unfiled
expenses into one clearing document (`CLR-2026-03`), records what the month totalled, and
refuses to clear the same period twice. It moves no money. All money rounds half-up to two
decimals once, at the end.

**People and events.** However many people share the bill; two are seeded so the app works
out of the box, and the rest are added from Settings. An event groups a subset of them with
the postings from a trip or an evening, and deleting one detaches its expenses rather than
losing them.

**Memories.** A timeline and a map of the moments behind the money, with photographs,
anniversaries, and document #1 — the first date, posted as `source='manual'`, read-only
except for its note.

**Statement of Us.** A yearly report in the voice of an annual report: totals, top
merchants, the longest date-night streak, trips clustered by three-day gaps, places
visited. Four LLM providers in a fixed order — Anthropic, any OpenAI-compatible endpoint,
SAP's generative AI hub, and a deterministic template — and the template is not a stub. It
renders a complete, warm statement from the aggregates and never fails.

**Settings.** People, onboarding, model information, bank import, planner, data export.

### The frontend

React 19 and `@ui5/webcomponents-react` in `sap_horizon`, switching to `sap_horizon_dark`
with the system, as an installable PWA. Mobile-first, 44 px touch targets, safe-area insets
— it is used one-handed at a restaurant table before the waiter takes the receipt away.

Money is rendered in exactly one place, `formatMoney` in `app/src/theme.ts`, in Swiss
format with an ASCII apostrophe: `CHF 18'420.55`. It is a byte-for-byte port of the
backend's statement renderer, because the same number appears on one screen from both
sides. `toLocaleString` is deliberately never used.

Category colours and icons come from the seed data, never from a hardcoded map. Every list
has a real empty state.

### Security

The app is a household's entire financial history on the public internet, and is built like
it.

* HTTP basic auth over bcrypt in production, with a decoy hash so an unknown username costs
  the same as a wrong password. The server **refuses to start** if the four `AUTH_*`
  variables are not present and well-formed — a missing variable must never fall back to
  CAP's mocked `'*': true`.
* A CSP written for this SPA rather than switched off for it: `script-src 'self'`, no
  `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`.
* Same-origin only. The API answers no cross-origin request except from the dev server.
* Rate limits on the two expensive actions, `scanReceipt` and `generateStatement`, and
  nowhere else — a blanket limiter on a two-person app would only ever fire on the owners.
* `/health` describes the *variables* credentials came from and never their values;
  `test/security.test.ts` asserts that with every secret set to a sentinel, none of them
  appears in the response.

### Operations

* **`Dockerfile`** — multi-stage, Node 22 alpine throughout (the build stage and the
  runtime must share a libc or `sharp` loads the wrong prebuilt binary), non-root
  application process, `HEALTHCHECK` that treats both 200 and 401 as healthy, and an
  entrypoint that creates and seeds the database on first boot only. *Never built: Docker
  is not installed on the machine this was written on. Its runtime decisions were each
  verified outside a container; the packaging was not.*
* **`fly.toml`** — 512 MB in `fra`, a 3 GB volume at `/data` that extends itself, machines
  that never auto-stop, and a TCP health check with a long comment explaining why it is not
  an HTTP check on `/health`.
* **`.github/workflows/ci.yml`** — install, typecheck, backend vitest, frontend vitest,
  build, on every push and PR, with npm caching. It does not run the Python trainer; it
  asserts instead that the committed `weights.json` parses, that its coefficient blob
  decodes to exactly `rows × cols` float32 values, and that its labels are sorted — then
  lets the parity test prove Python and TypeScript still agree.
* **`.github/workflows/backup.yml`** — nightly: snapshot on the machine through SQLite's
  online backup API, pull it down, open it, encrypt it with AES-256, prove it decrypts, keep
  it. *Unverified; it needs a deployed app and a Fly token.*
* **`scripts/backup.ts` / `restore.ts`** — one portable tarball holding a manifest, a
  consistent database snapshot, and every receipt and photo as an ordinary JPEG. The images
  are redundant with the database on purpose: in ten years a folder of JPEGs will still
  open.
* **`docs/DEPLOY.md`** (Fly, the daily driver) and **`docs/DEPLOY_BTP.md`** (BTP Cloud
  Foundry, the demo — its free-tier HANA stops every night, and the document says so in its
  first paragraph).

### Tests

* **Backend** — vitest in-process against CAP: classifier parity, Document AI mapping,
  settlement arithmetic, statement aggregates, the scan pipeline, the security headers.
* **Frontend** — vitest and Testing Library alongside each page.
* **End-to-end** — Playwright, three projects. `api-journey.spec.ts` drives
  scan → confirm → ledger → payment run → memory → statement over HTTP with no browser;
  `journey.spec.ts` drives the same thing through the interface on an emulated phone;
  `smoke.spec.ts` checks all five routes, the navigation, the 44 px touch targets, the
  Swiss money format and the PWA manifest on both a phone and a laptop. The config boots
  CAP and Vite itself, with `--in-memory` so the suite can never touch a real ledger, and
  refuses to attach to a server it did not start.

### Known issues

Two defects found by the e2e suite and left in, recorded as failing tests rather than
quietly worked around. Both are release blockers; `GO-LIVE.md` §1 has the diagnosis and the
options.

* **The UI5 theme fonts are blocked by the CSP in production.** `font-src 'self' data:`
  against a font family fetched from `cdn.jsdelivr.net`. The app works and stops looking
  like Fiori. Invisible in `npm run dev`, because there Vite serves the SPA and helmet never
  sees it.
* **A hard navigation to `/ledger` returns the OData service document.** The client route
  and the service path are the same string. Client-side navigation is fine, so daily use
  hides it — until someone reloads the page or shares a link.

Also open, and smaller: `npm run build` in `app/` emits a `.js` beside every source file
(including `vite.config.js`, which Vite then prefers over `vite.config.ts`), and
`package.json` still reads `0.1.0`.

[1.0.0]: https://github.com/-/two-way-match/releases/tag/v1.0.0
