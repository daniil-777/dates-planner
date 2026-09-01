# Two-Way Match — Claude Code build sequence

> **Historical record, kept verbatim.** These are the prompts the app was originally
> built from, in the order they were sent. They are *not* a description of the app as it
> stands: the domain has since dropped debt entirely — no `balance()`, no `owedByA` /
> `owedByB`, no per-expense split — and replaced the two-row `Partners` table with
> `People` plus `Events`. Where a prompt below asks for any of that, the authoritative
> answer is `docs/CONTRACTS.md` §9 and §10, not this file. Nothing here is edited to
> match, because a record of what was asked for stops being a record the moment it is
> rewritten to agree with the answer.

Copy each prompt into Claude Code (VS Code extension or `claude` in the integrated terminal), **one at a time, in order**. Review the diff, run the "check", commit, then move on. Each prompt is self-contained; Claude Code keeps repo context between them anyway.

**Stack (all TypeScript):** SAP CAP (Node, TypeScript handlers via `tsx`, `cds-typer` types) · SQLite in dev / Postgres or SQLite-on-volume in prod (optional HANA Cloud path) · React + **UI5 Web Components** (Horizon theme = the Fiori look she knows) as an installable PWA · **SAP Document AI** for receipt extraction · the custom two-head model (from `twoway-match.zip`) ported to TS inference, retrained in Python · optional SAP AI Core / generative AI hub / HANA PAL modules.

---

## Before prompt 1 (you, not Claude)

1. Install: Node 22 LTS, `npm i -g @sap/cds-dk`, Python 3.11+, Docker Desktop (only for AI Core/deploy), Git.
2. `mkdir twoway-match && cd twoway-match && git init`, unzip `twoway-match.zip` so the Python model lives in `./ml/` (`ml/train.py`, `ml/features.py`, …). Open the folder in VS Code and start Claude Code.
3. SAP BTP trial (free, email only) → Boosters → "Set up account for SAP Document AI" → create a service key. Keep it for prompt 5; you'll paste it into `.env`, **never into a prompt**. Until then the app runs in mock mode.
4. Optional later: generative AI hub 30-day trial (Statement of Us), AI Core free tier (cloud retraining), HANA Cloud free tier (PAL forecasts).
5. Decide the two names and the first-date facts (date, place, one sentence) — prompt 2 asks for them.

Working style that keeps Claude Code honest: start bigger prompts with "Plan first, show me the plan, then implement." Ask for tests. Commit after every prompt (`git add -A && git commit -m "..."` or `/commit`).

---

## Prompt 1 — Project charter, CLAUDE.md, monorepo scaffold

```
Create the foundation for "Two-Way Match", a private web app for two people (a couple) to scan receipts, track shared spending, settle up monthly, and keep a timeline of memories. Everything in TypeScript. Plan first, show the plan, then implement.

1. Write CLAUDE.md with: project purpose; stack (SAP CAP on Node with TypeScript handlers via tsx and @cap-js/cds-typer generated types; SQLite for dev via @cap-js/sqlite; React + @ui5/webcomponents-react with the sap_horizon theme as a Vite PWA in /app; Python model in /ml that we port to TS inference); conventions (strict TS, no `any`, vitest for unit tests, ESLint+Prettier, small commits, never commit secrets, .env.example kept current); commands (npm run dev = CAP on :4004 + Vite on :5173 with proxy; npm test; npm run build); folder layout: /db (CDS models + seed CSVs), /srv (services + lib), /app (frontend), /ml (python model, untouched except where a prompt says so), /docs.
2. Scaffold the CAP project in the repo root with `cds init` semantics but TypeScript-first: tsconfig strict, tsx dev runner (`cds-tsx watch`), cds-typer with @cds-models path alias, vitest configured to run CAP in-process (`cds.test`). Add a health check endpoint /health.
3. Add the root package.json scripts: dev (concurrently CAP + Vite), test, lint, typecheck, build, and `ml:*` placeholders that will call the python scripts.
4. Add .gitignore (node_modules, .env, *.sqlite, dist, ml/.venv, ml/model/*), .env.example (empty for now), README.md with a 10-line quickstart.
Done when `npm run dev` starts CAP with an empty service without errors and `npm test` runs one passing test.
```

Check: `npm run dev` → http://localhost:4004 shows the CAP index page.

---

## Prompt 2 — Domain model + seed data (incl. Document #1)

```
Design and implement the CDS domain model in /db/schema.cds under namespace twowaymatch, with seed CSVs in /db/data. Generate types with cds-typer. Plan first.

Entities (use cuid + managed aspects where sensible):
- Partners: name, shortName, avatarColor, email. Exactly two rows seeded: <NAME_A> and <NAME_B>.
- Categories: code (key), name, icon (SAP icon name), colour, sortOrder. Seed: Groceries, Dining, Cafés, Transport, Travel, Gifts, Home, Health, Entertainment, Subscriptions — same codes as ml/train.py labels.
- Expenses: date, time, merchantRaw, merchantNorm, amount Decimal(10,2), currency default 'CHF', category (assoc), categoryConfidence, moment (enum everyday/date_night/trip/gift), momentConfidence, paidBy (assoc Partners), split (enum equal/payer_only/custom), shareA Decimal(5,2) default 50, status (enum draft/confirmed), source (enum scan/import/manual), note LargeString, place String, lat/lon Double nullable, receipt (assoc Receipts), documentNumber Integer (auto-increment style, human-readable, starts at 1), settlement (assoc Settlements nullable).
- Receipts: image LargeBinary with @Core.MediaType, mediaType, fileName, docaiJobId, extraction LargeString (raw JSON), extractionStatus (enum pending/done/failed/mock).
- Memories: expense (assoc, optional), title, note LargeString, occurredOn Date, kind (enum date_night/trip/gift/anniversary/other), pinned Boolean, photos: Composition of many Photos (image LargeBinary + mediaType + caption).
- Settlements: period (YYYY-MM), totalA, totalB, owedByA, owedByB, net, status (open/settled), settledAt, clearingDocument String (e.g. 'CLR-2026-09'), approvedBy String.
- Statements: year Integer, contentMarkdown LargeString, generatedAt, engine String.
- Corrections: expense (assoc), field (category|moment), predicted, corrected, createdAt — this is the training-data log.

Seed Document #1 in Expenses: documentNumber 1, source manual, status confirmed, date <FIRST_DATE_YYYY-MM-DD>, merchantRaw '<FIRST_DATE_PLACE>', category Dining, moment date_night, amount <FIRST_DATE_AMOUNT_OR_0>, note '<ONE_SENTENCE_FOR_HER>'. Also seed one Memory linked to it, pinned, kind anniversary.

Add CDS annotations (@title, @Common.Label, value helps) so a Fiori elements UI could be generated later. Add unit tests that the seed loads and Document #1 exists. Update CLAUDE.md with the model overview.
```

Replace the `<PLACEHOLDERS>` before sending. Check: `npm test` green; `sqlite3 db.sqlite "select documentNumber, merchantRaw from twowaymatch_Expenses"` shows #1.

---

## Prompt 3 — LedgerService (OData V4) + business logic

```
Implement /srv/ledger-service.cds and /srv/ledger-service.ts (TypeScript handlers, typed with cds-typer). Plan first, then implement with vitest tests using cds.test.

Service LedgerService at path /ledger exposing Expenses, Receipts (media stream), Memories, Photos, Settlements, Statements, Categories, Partners, Corrections.

Actions and functions:
- action confirmExpense(ID) : Expenses — sets status confirmed, assigns the next documentNumber atomically, writes Corrections rows if category/moment differ from the *_predicted values passed in the request (accept optional predictedCategory/predictedMoment params).
- function balance() : { owedByA, owedByB, net, asOf } — computed from confirmed, unsettled expenses respecting split rules.
- action runSettlement(period: String) : Settlements — 'payment run': aggregates the period, creates a Settlement with clearingDocument 'CLR-<period>', approvedBy 'CEO of the household', links expenses, status open; a second action markSettled(ID).
- function monthlyTotals(fromPeriod, toPeriod) : array of { period, category, total } for charts.
- function duplicates(ID) : possible duplicate expenses (same amount ± 0.05 and same merchantNorm within 2 days) — the 'Verify' check.
Business rules: amount > 0; currency 3 letters; a draft cannot be settled; Document #1 is read-only except note.
Validation errors as proper OData errors with messages. 90%+ line coverage on the handlers. Document the API in docs/API.md with curl examples.
```

Check: `curl localhost:4004/ledger/balance()` returns JSON.

---

## Prompt 4 — Port the model to TypeScript inference (Python stays the trainer)

```
Make the custom expense model run natively in the Node process, with exact parity to the Python trainer in /ml. Read ml/features.py, ml/train.py and ml/predict.py first, then plan.

Python side (small, surgical edits):
1. In ml/train.py replace sklearn's HashingVectorizer with a CSR matrix built from features.hashed_ngram_ids (crc32-based, char_wb 2–4-grams, alternate_sign-free counting, then L2 row normalisation) so hashing is reproducible outside sklearn. Add --n-buckets (default 65536) and keep everything else identical. Retrain on data/transactions.csv and confirm metrics are still ~1.0 category / ~0.84 moment.
2. Add ml/export_ts.py: writes ml/model/weights.json containing n_buckets, numeric feature names, StandardScaler mean/scale, and for each head: class labels, intercepts, and the coefficient matrix as base64 float32 (row-major, shape [n_classes, n_buckets + n_numeric]). Also write ml/model/parity_fixture.json: 60 random rows from the CSV with the Python predictions and probabilities.

TypeScript side (/srv/lib/classifier/):
3. features.ts: port normalise_merchant (umlaut transliteration, NFKD strip, date/id removal, punctuation collapse), char_wb n-grams, crc32 hashing modulo n_buckets, numeric_features (log1p amount, weekend, evening, hour/weekday sin-cos). Use a crc32 that matches Python's zlib.crc32.
4. model.ts: load weights.json once (Float32Array), compute logits = W·x + b for the sparse L2-normalised text vector concatenated with scaled numeric features, softmax, return { category, categoryConfidence, categoryTop3, moment, momentConfidence, momentTop3 } — the same JSON shape as ml/predict.py.
5. A parity test in vitest: every row in parity_fixture.json must match the Python label and probabilities within 1e-4.
6. index.ts exposes classify(merchantRaw, amount, whenISO). If env CLASSIFIER_URL is set, call that HTTP endpoint instead (same JSON contract as ml/serve.py, so a Python sidecar or an SAP AI Core deployment can be swapped in without code changes).
7. Wire it into LedgerService: a new action classify(ID) and automatic classification on Expenses CREATE when category is empty.
Add npm scripts ml:train (python ml/train.py --n-buckets 65536) and ml:export (python ml/export_ts.py) and document the retrain flow in docs/MODEL.md.
```

Check: `npm test` parity test green; creating an expense via OData with `merchantRaw: "RESTAURANT BLAUE ENTE", amount: 148.5` returns Dining/date_night.

---

## Prompt 5 — SAP Document AI client + scanReceipt action (with mock mode)

```
Implement receipt extraction with SAP Document AI (the BTP service formerly Document Information Extraction), in TypeScript, with a mock mode so development works without BTP. Read the API reference first (SAP Business Accelerator Hub → SAP Document AI, and help.sap.com "SAP Document AI" → API usage: OAuth2 client-credentials token from the service key's uaa.url, POST /document-information-extraction/v1/document/jobs with multipart 'file' + 'options' JSON, then poll GET /document/jobs/{id} until status DONE). Plan first.

1. /srv/lib/documentai/client.ts: reads DOCAI_URL, DOCAI_UAA_URL, DOCAI_CLIENT_ID, DOCAI_CLIENT_SECRET from env (document them in .env.example with a comment on which service-key fields they map to). Token caching with expiry. submitJob(imageBuffer, mimeType, options), getJob(id), pollJob(id, {timeoutMs, intervalMs}). Start with the standard 'invoice' document type and headerFields documentDate, grossAmount, currencyCode, senderName, senderAddress, netAmount plus lineItems description/quantity/netAmount; make the schema/field list configurable so we can switch to a custom 'receipt' schema created in the Document AI UI later (DOCAI_SCHEMA_NAME, DOCAI_DOCUMENT_TYPE).
2. mapper.ts: Document AI result → { merchantRaw, date, time?, amount, currency, place, lineItems[], rawFields } with confidence per field; handle missing values gracefully; convert DE/FR/IT number formats.
3. Mock mode: if MOCK_DOCAI=1 or credentials are missing, return one of three fixtures in /srv/lib/documentai/fixtures (a Migros receipt, a restaurant receipt, a hotel invoice) chosen by file name, with a 800 ms artificial delay.
4. LedgerService action scanReceipt(image: LargeBinary, mediaType, fileName) : Expenses — stores the Receipt (strip EXIF, downscale to max 2000 px on the long edge, JPEG q85, reject > 10 MB), submits to Document AI, maps to a draft Expense, runs the classifier, returns the draft with confidences and a needsReview flag when any confidence < 0.6 or amount/date missing.
5. Tests: mapper unit tests with real-looking Document AI JSON; an integration test of scanReceipt in mock mode.
Never log secrets or full images. Document the setup in docs/DOCUMENT_AI.md including the BTP booster steps and how to create the custom receipt schema in the Document AI UI.
```

Check: with `MOCK_DOCAI=1`, `POST /ledger/scanReceipt` with a JPEG returns a draft expense.

---

## Prompt 6 — Frontend scaffold: React + UI5 Web Components, Horizon theme, PWA

```
Create the frontend in /app: Vite + React 18 + TypeScript strict, @ui5/webcomponents, @ui5/webcomponents-fiori, @ui5/webcomponents-react, @ui5/webcomponents-icons, theme sap_horizon (and sap_horizon_dark following prefers-color-scheme). Plan first.

- App shell: ShellBar titled "Two-Way Match" with a small tagline "Spend management for two", profile avatar switching between the two partners (persisted in localStorage), bottom navigation on mobile (Scan, Ledger, Memories, Statement, Settings) using UI5 components, side navigation on desktop.
- Data layer: a typed OData V4 client for /ledger (generate types from the CAP CSN or hand-write DTOs), TanStack Query for caching, error toasts via MessageStrip/Toast.
- Vite dev proxy /ledger and /health to http://localhost:4004; production build output copied into the CAP app folder so CAP serves the SPA at / with history-fallback routing.
- PWA: vite-plugin-pwa with manifest (name, short name "2WM", icons — generate simple SVG-based icons with two overlapping tick marks in Horizon blue), standalone display, offline shell caching (API responses network-first).
- Mobile-first layout, safe-area insets, 44 px touch targets, loading skeletons.
- Placeholder pages for the five routes with correct titles.
- vitest + React Testing Library setup with one test per page rendering.
Done when npm run dev serves the shell at :5173 with live data from /ledger/balance() on the Ledger page.
```

Check: open on your phone via the Mac's LAN IP — the app installs to the home screen.

---

## Prompt 7 — The scan flow (ExpenseIt for two)

```
Build the Scan page end-to-end. Plan first.

1. Capture: a big primary button opens the camera on mobile via <input type="file" accept="image/*" capture="environment"> (and file picker on desktop); allow multi-select for batch scanning; client-side downscale before upload; show a thumbnail strip with upload progress.
2. Call LedgerService.scanReceipt per image; while waiting show a Fiori-style busy card "Extracting… (Document AI)" and then "Classifying…".
3. Confirm card (UI5 Card + Form): merchant (editable), date, time, amount + currency, place; category as selectable chips (Tokens/ToggleButtons) sorted by model probability with the confidence shown subtly; moment as a SegmentedButton (Everyday / Date night / Trip / Gift) pre-selected from the model; Paid by (avatar toggle); Split (equal / payer only / custom slider); note field; 'Also save as a memory' switch that pre-fills a Memory (title = merchant, occurredOn = date) with an optional extra photo.
4. Low confidence (< 0.6) or missing amount/date → the card opens in review state with the uncertain field highlighted (ObjectStatus warning) and a one-line prompt "Two-way match needed — please confirm".
5. Save → confirmExpense with predictedCategory/predictedMoment so corrections are logged; success MessageToast with the new document number ("Posted as document #<n>"); the duplicates() check runs after save and shows a gentle 'Verify' warning if a likely duplicate exists.
6. Manual entry fallback (no receipt) with the same confirm card.
Keyboard-friendly, accessible labels, and Playwright smoke test for the mock flow.
```

---

## Prompt 8 — Ledger + Payment run

```
Build the Ledger page and the settlement flow. Plan first.

- Month picker (default current), list of expenses grouped by day (UI5 List with GroupHeaderListItem), each row: merchant, category icon+colour, amount, paid-by avatar, moment badge; tap opens a detail sheet with the receipt image and edit/delete.
- Header KPIs as UI5 Cards: month total, per-partner paid, current balance from balance() with the sentence "<A> owes <B> CHF x" / "All settled".
- Category breakdown chart for the month and a 6-month trend from monthlyTotals(): use a lightweight chart library (recharts) styled with the Horizon palette and the category colours.
- Filters: category, moment, paid by, needs review (drafts).
- "Payment run" button → dialog summarising the period, then runSettlement(period); render the resulting Settlement as a 'Clearing document CLR-YYYY-MM' card with an 'Approved by CEO of the household' stamp (subtle, tasteful, rotated 8°), a 'Mark as settled' action, and a share-as-image button (html-to-image).
- Settlements history list.
Add tests for balance arithmetic edge cases (custom split, payer_only, cross-month drafts).
```

---

## Prompt 9 — Memories timeline (the romantic layer)

```
Build the Memories page. Plan first.

- Vertical timeline (UI5 Timeline from webcomponents-fiori) of Memories and of Expenses with moment in (date_night, trip, gift), newest first, grouped by month; each item: kind icon, title, place, amount if any, note excerpt, photo thumbnails; pinned items float to a 'Pinned' section at the top.
- Auto-suggestions: a 'New memories detected' strip listing recent date_night/trip/gift expenses that have no Memory yet, one tap to create a Memory from them.
- Memory editor: title, note (multiline), photos (upload to Photos composition, downscaled), kind, occurredOn, place with optional geocoding via Nominatim (rate-limited, cached) and lat/lon.
- Map view toggle: Leaflet + OpenStreetMap tiles with pins for memories that have coordinates; clustering; tapping a pin scrolls to the item.
- Anniversaries: compute yearly recurrences of pinned memories (and Document #1); show a small countdown card 'Next anniversary in N days' and a browser notification opt-in.
- Document #1 gets special treatment: a discreet '#1' badge and, when opened, a full-screen reveal of its note with the receipt-style layout ('Document 1 · <date> · <place>').
Tests for the anniversary computation (leap years, today).
```

---

## Prompt 10 — Statement of Us (yearly report via LLM, with fallbacks)

```
Build the Statement page and generator. Plan first.

Backend: action generateStatement(year) in LedgerService.
1. Aggregate in TypeScript: totals per category, per partner, per moment; count of date nights, trips (distinct trip clusters = trip expenses within 3 days), gifts each direction; top merchants; longest streak of weeks with a date night; cities/places visited; first and last memory of the year.
2. Prompt an LLM to write a warm, witty 'Statement of Us' in the voice of a value-realization report (sections: Executive Summary, Key Achievements, Investment Overview, Highlights by Quarter, Outlook, Closing note) using only the aggregated facts (no hallucinated events). Provider abstraction in /srv/lib/llm: (a) SAP generative AI hub via @sap-ai-sdk/orchestration when AICORE_SERVICE_KEY is set (model configurable, default a Claude model available in the hub); (b) any OpenAI-compatible endpoint via LLM_BASE_URL/LLM_API_KEY/LLM_MODEL (e.g. Ollama at http://localhost:11434/v1); (c) no LLM → a deterministic template statement so the feature always works.
3. Store in Statements with engine name; regenerate allowed.
Frontend: a report-styled page (Fiori ObjectPage look, Horizon typography), print stylesheet for A4 PDF via the browser, 'Regenerate' and 'Print' actions, year selector. Include a tiny footer line 'Prepared for <NAME_B> · Two-Way Match · unaudited, wholly reliable'.
Unit-test the aggregation with a synthetic year of data.
```

---

## Prompt 11 — Pre-spend planner / forecast (optional HANA PAL path)

```
Add forecasting. Plan first.

- /srv/lib/forecast.ts: Holt-Winters (additive, monthly seasonality when ≥ 24 months, otherwise damped Holt / seasonal-naive fallback) on monthlyTotals per category and overall; function forecast(monthsAhead) returns point forecasts and a simple 80% band from residuals.
- Trip fund planner: function planTrip(targetAmount, targetDate) → required monthly set-aside vs. forecast free cash (average monthly total minus forecast), feasibility label, and a suggested per-partner split.
- Settings page section 'Pre-spend planner' UI: a card 'Lisbon in October?' with target amount/date inputs and the verdict.
- Optional SAP HANA path behind env HANA_HOST/HANA_USER/HANA_PASSWORD: push monthlyTotals into a HANA Cloud table with @sap/hana-client and call PAL's unified time-series (_SYS_AFL.PAL_UNIFIED_TIME_SERIES via a generated procedure, documented in docs/HANA_PAL.md) — only if configured; the TS forecaster remains the default.
Tests with a synthetic seasonal series.
```

---

## Prompt 12 — Continuous learning loop (retrain from corrections; optional AI Core)

```
Close the training loop. Plan first.

1. npm run ml:export-data → /ml/data/live_transactions.csv from confirmed Expenses joined with Corrections (final labels win), columns exactly as ml/train.py expects (date,time,merchant_raw,amount_chf,payer,category,moment); anonymise nothing else is needed since this is our own data but never include images or notes.
2. npm run ml:retrain → export-data, python ml/train.py --csv ... --n-buckets 65536, python ml/export_ts.py, run the parity test, then hot-reload the classifier weights in the running CAP app via an admin action reloadModel() (protected).
3. A scheduled job (node-cron inside CAP, 03:00 local) that retrains only if ≥ 20 new confirmed rows since the last training; write a training log to Settings and show 'Model: trained <date> on <n> rows · category acc <x> · moment F1 <y>' in the Settings page.
4. Optional cloud path: docs/AI_CORE.md describing how to run the same job on SAP AI Core free tier using ml/aicore/training-template.yaml and serving-template.yaml (Docker image built with --platform linux/amd64), and how to point CLASSIFIER_URL at the AI Core deployment with the AI-Resource-Group header and bearer token — implement the auth header handling in the CLASSIFIER_URL client (env CLASSIFIER_TOKEN, CLASSIFIER_RESOURCE_GROUP).
```

---

## Prompt 13 — Auth, privacy and hardening

```
Make the app safe to put on the internet for exactly two users. Plan first.

- CAP auth: dev uses mocked users <NAME_A>/<NAME_B>; production uses HTTP basic auth over HTTPS with users and bcrypt password hashes from env (AUTH_USER_A, AUTH_HASH_A, AUTH_USER_B, AUTH_HASH_B) mapped to the Partners rows; every request must be authenticated; write a CLI script to generate hashes.
- Optional: document XSUAA/Cloud Identity Services setup for BTP in docs/AUTH_BTP.md (only if we deploy there).
- Security headers (helmet), CORS locked to same origin, upload limits, EXIF stripping verified by test, rate limiting on scanReceipt and generateStatement, request logging without bodies, secrets only via env, .env.example complete and commented.
- Backups: npm run backup exports the SQLite DB and all images to a timestamped tar.gz; restore script; document in docs/RUNBOOK.md.
- Data export: Settings → 'Export everything' downloads a zip (CSV + images) — it's our data.
```

---

## Prompt 14 — Deploy to the web

Pick **A** (pragmatic, always-on) or **B** (pure SAP BTP). A first, B later if she wants to see it on BTP.

```
A) Deploy to Fly.io as a single container. Plan first.
- Multi-stage Dockerfile: build /app, then run CAP in production mode serving the SPA and /ledger; Node 22 alpine; non-root user; HEALTHCHECK /health.
- SQLite on a persistent Fly volume mounted at /data (DB and images), region fra/ams; fly.toml with 512 MB memory, auto-stop disabled; secrets set via `fly secrets set` (list them in docs/DEPLOY.md, values from .env).
- GitHub Actions: on push to main run tests, build, deploy; on schedule run the backup job and upload to a Fly storage bucket or a GitHub artifact (encrypted).
- Custom domain + HTTPS notes. A checklist to verify PWA install on iPhone and Android over the deployed URL.
```

```
B) Deploy to SAP BTP Cloud Foundry (free tier account). Plan first.
- Add mta.yaml with: CAP Node module (Node 22), SAP HANA Cloud free-tier hdi-shared binding and @cap-js/hana, XSUAA (xs-security.json with role Partner assigned to two users), an approuter serving /app build with authentication, destinations only if needed.
- cds add hana,xsuaa,approuter,mta; adapt LargeBinary handling for HANA; keep SQLite for dev.
- docs/DEPLOY_BTP.md: entitlements to add in the BTP cockpit, `cds build && mbt build && cf deploy`, and the caveat that the HANA Cloud free-tier instance stops nightly and must be started before use (so this is the demo deployment, Fly is the daily one).
```

---

## Prompt 15 — Go-live polish

```
Final pass before go-live. Plan first.
- Playwright end-to-end: login → scan (mock) → confirm → ledger shows it → payment run → memory created → statement generated; run in CI against the Docker image.
- Lighthouse PWA and accessibility ≥ 90 on the Scan and Ledger pages; fix what fails.
- Empty states with friendly Fiori illustrations (IllustratedMessage) and copy that matches the product tone (Concur/Ariba-style wording: 'Post', 'Payment run', 'Clearing document', 'Verify').
- Onboarding: first launch asks for names/colours, shows Document #1, and offers to import a bank CSV (column mapper UI, preview, classify on import).
- docs/RUNBOOK.md: daily use, retrain, backup/restore, rotate secrets, update Document AI schema.
- Bump to v1.0.0, changelog, and a GO-LIVE.md checklist I can tick off.
```

---

## Optional Prompt 16 — Fiori elements "back office" ledger (pure SAP UI)

```
Add a second UI in /app-fe: a Fiori elements List Report + Object Page on LedgerService.Expenses generated purely from CDS annotations (UI.LineItem, UI.SelectionFields, UI.HeaderInfo, UI.Facets, value helps for category/partner) using SAPUI5 with sap.fe.templates, served by CAP under /backoffice with the same auth. Keep it read/edit only — no scanning. Verify it renders in the sap_horizon theme and document in docs/FIORI_ELEMENTS.md why a customer-facing SAP person will recognise it instantly.
```

---

## Reveal

Deploy, install it on her phone as "2WM", make sure Document #1 is seeded with your real first date, and open the app together on the Memories tab. Then scan the receipt from that evening as document #2.
