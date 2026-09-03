# PRODUCT — what Two-Way Match is, and every feature in it

One page to brief a person (or a model) before a design or brainstorming session.
It is descriptive, not normative: `docs/CONTRACTS.md` is the spec, this is the map.

---

## 1. The goal

**Make shared time happen, and remember why it mattered — using the expense trail as
the evidence.** A household photographs receipts anyway; the app turns that chore into
a record of a life together, and dresses the whole thing as an SAP system because the
joke is the affection.

Three sentences that decide most arguments about scope:

1. **Nobody owes anybody.** An expense records *who paid* and *what it belonged to*.
   Every figure downstream is a sum with a proportion beside it — never a balance, a
   netting, or a "you owe me CHF 34.20". A feature that reintroduces debt is off-brief.
2. **It wears SAP clothing on purpose.** Fiori/Horizon, "payment run", "clearing
   document", "Verify", a Fiori elements back office over the same service. The costume
   is a product feature, not decoration — and it doubles as a portfolio artefact.
3. **It must work with an empty `.env`.** Every cloud service is an upgrade, never a
   requirement: receipts fall back to bundled fixtures, the yearly statement to a
   deterministic template, the classifier runs in-process. Any new feature needs a
   credential-free path or it is not shippable.

### Who it is for

A household of **any size** — a couple, a flat share, a friend circle, a family.
Two people are seeded so it works on first boot; nothing in the code may assume two.
`Groups.kind` (`couple | household | friends | family | other`) only presets roster size
and copy.

---

## 2. Principles that constrain new features

| Rule | Consequence for a new idea |
|---|---|
| Server is the system of record; devices cache | No local-only feature; no device that can diverge silently |
| One database, `group` on every tenant table, one `scopeToGroup` handler | A new entity gets the `tenant` aspect or it leaks across households |
| Money is `Decimal(10,2)`, rounded half-up once at the end | Never a float; never round twice |
| Money is formatted in exactly one place (`formatMoney`), Swiss style `CHF 18'420.55` | No `toLocaleString`, ever |
| Predictions are suggestions; humans confirm | Anything a model produces is labelled, overrulable, and below 0.6 confidence is **Needs review** |
| Corrections are training data | A new predicted field should write to `Corrections` |
| Special-category data never reaches a model | See §6; the statement's table allowlist is a hard boundary |
| Mobile-first, one-handed, 44 px targets, real empty states | Designed for a restaurant table before the waiter takes the receipt |

---

## 3. The features

### Money

| Feature | What it does | Where |
|---|---|---|
| **Scan** | One action: normalise the photo with sharp (EXIF and geotags stripped), store it, extract with SAP Document AI, classify, return a draft posting. Handles `1'234.50` / `1.234,50` / `1 234,50`. Offline scans queue on the device. | `scanReceipt`, `srv/lib/documentai/`, `app/src/pages/scan/` |
| **Two-head classifier** | Category (10 classes) + moment (4) from merchant string, amount, time of day, over 65 536 hashed char n-grams. Trained in Python, executed in TypeScript, held to 1e-4 by a parity test. | `ml/`, `srv/lib/classifier/`, `docs/MODEL.md` |
| **Ledger** | Postings by month, charts, filters, duplicate detection; the month's total said as a sentence. Every human correction is written to `Corrections`. | `LedgerPage`, `periodTotals`, `duplicates`, `classify` |
| **Payment run** | The monthly close, deadpan: freezes a period's confirmed, unfiled expenses into one clearing document (`CLR-2026-03`), records the total, refuses to clear a period twice. **Moves no money.** | `runSettlement`, `markSettled`, `srv/lib/settlement.ts` |
| **Bank CSV import** | Guess the columns, preview, post. Rows arrive with no category, so both classifier heads run on the way in — an import lands pre-sorted, as drafts. | `settings/BankImport.tsx` |
| **Pre-spend planner** | "Lisbon in October?" — Holt-Winters (or damped Holt / seasonal naive / last value, by how much history exists) over the last 12 months, with a band. Per-person figures are *intentions*, not invoices. | `srv/lib/forecast.ts`, `settings/PlannerCard.tsx` |

### Time together

| Feature | What it does | Where |
|---|---|---|
| **People & events** | Any number of people; an event groups a subset with the postings from a trip or an evening. Deleting an event detaches its expenses rather than losing them. | `Events`, `EventParticipants`, `eventTotals` |
| **Event photos** | Photographs attached to an occasion, with caption and date. | `addEventPhoto`, `deleteEventPhoto` |
| **Reminders** | Lead-time nudges hung off an event. | `createReminder`, `completeReminder` |
| **Surprises** | An event only its author can see until `revealSurprise`. Filtered **server-side** — it never reaches another person's calendar payload. | `revealSurprise`, CONTRACTS §11.3 |
| **Calendar** | One month, one read (`upcoming(from,to)` for the whole grid window incl. spill days). Multi-day trips bucketed client-side. Deliberately shows no money. | `CalendarPage`, `app/src/pages/calendar/` |
| **Memories** | Timeline and map of the moments behind the money — photographs, anniversaries, and *Document #1*, the first date, read-only except its note. | `Memories`, `Photos`, `MemoriesPage` |
| **Statement of Us** | A yearly report in the voice of an annual report: totals, top merchants, longest date-night streak, trips clustered by three-day gaps, places visited. Four LLM providers in fixed order (Anthropic → OpenAI-compatible → SAP AI hub → template), and the template is a complete renderer, not a stub. | `generateStatement`, `srv/lib/statement.ts`, `srv/lib/llm/` |

### Each other

| Feature | What it does | Where |
|---|---|---|
| **Chat** | Text, images and press-to-record voice notes (≤120 s, ≤5 MB, stored as recorded, served only through the API with `Range`). Server-sent events carry a *notification*, never data; 15 s polling fallback; every write carries an `Idempotency-Key`. Not E2E-encrypted, deliberately — the server must read the household's data to do its job. | `sendMessage`, `/api/chat/stream`, `ChatPage` |
| **Mood** | Five faces and an optional sentence — or a selfie to `detectMood`, which returns a *suggestion* with its own confidence. **The photograph is never stored**; saving the reading is a separate POST carrying no image. Without an LLM key the manual picker simply stays. | `detectMood`, `srv/lib/mood.ts`, `MoodPage` |
| **Between us (touch maps)** | A private, first-person map of where somebody likes being touched, drawn on a rotatable 3D mannequin (MakeHuman's CC0 `hm08` sculpt, baked to three forms by `app/scripts/bake-figure.ts`): 19 zones, levels `-1 rather not / 1 gently / 2 yes / 3 favourite` (no `0` — "no opinion" is *no row*). Read is household-wide, write is first-person only, enforced against the stored owner. Never sent to a model, never on a shared surface, no home-tile figure. `form` (feminine/masculine/neutral) is which mannequin to draw and is **not** an orientation field. | `BodyMaps`/`BodyZones`, CONTRACTS §13, `app/src/pages/intimacy/` |

### The system around it

| Feature | What it does |
|---|---|
| **Accounts, households, invites** | `Users` (a login) ≠ `People` (a seat in a roster), joined by `Memberships` with `owner`/`member`. Register → create a group → invite with an 8-char code, 72 h, single use. A wrong-group id answers **404**, never 403. |
| **PWA** | Installable, offline shell, scan queue, service worker in `prompt` mode — a new build waits for a tap on *Reload* rather than swapping under what is being typed. Checks hourly and on foreground-after-5-min. |
| **Settings** | People, onboarding wizard, household, language (en/de/ru, English fallback everywhere), theme, sessions, model info, bank import, planner, version/update, export everything. |
| **How it works** | The engineering write-up served in-app as a static, offline-readable article. |
| **Back office** | A second, JavaScript-free Fiori elements List Report + Object Page over the *same* `LedgerService`, at `/backoffice`. It proves the backend is right. |
| **Admin** | `modelInfo`, `reloadModel`, `retrain` (live data → train → export → parity test). |
| **Security** | bcrypt basic auth with a decoy hash; the server refuses to start without well-formed `AUTH_*`; CSP with `script-src 'self'`, no `unsafe-eval`, `frame-ancestors 'none'`; same-origin only; rate limits only on `scanReceipt`, `generateStatement` and login; `/health` names the *variables*, never the values. |
| **Operations** | Fly.io (SQLite on a volume) as the daily driver, BTP Cloud Foundry as the demo; nightly encrypted backup; one portable tarball holding the database *and* every image as an ordinary JPEG, because in ten years a folder of JPEGs will still open. |

---

## 4. The optional SAP ladder

Each rung is one environment variable, and switching back costs deleting it. All are
off by default and documented as honest trade-offs:

- **Document AI** for receipts → without it, bundled fixtures chosen by filename keyword.
- **LLM**: native Anthropic → any OpenAI-compatible endpoint → SAP generative AI hub →
  deterministic template.
- **AI Core** (`docs/AI_CORE.md`) to train and serve the classifier off-laptop.
- **HANA PAL** (`docs/HANA_PAL.md`) to compute the planner's forecast in a column store.
- **XSUAA / Cloud Identity** (`docs/AUTH_BTP.md`) instead of basic auth.

---

## 5. Data model at a glance

```
Groups ─┬─ Memberships ── Users            (a login)
        └─ People                          (a seat in this group's roster)

People ─┬─ Expenses ── Receipts            paidBy, category, moment, event?
        ├─ EventParticipants ── Events ─┬─ EventPhotos
        │                               └─ Reminders
        ├─ Moods                          level 1–5 + a sentence, no image
        ├─ BodyMaps ── BodyZones          19 zones × levels −1/1/2/3
        └─ Messages ── Conversations      text | audio | image

Settlements   one clearing document per closed period
Statements    one generated yearly report
Memories ── Photos
Corrections   every human override — next round's training data
Categories    the one shared vocabulary; the only table with no group
```

---

## 6. Deliberately not built

Useful to know before proposing them — each was decided, not overlooked:

- **Balances, debts, "settle up"** — the whole premise (§1.1).
- **E2E-encrypted chat** — the server has to read the data to classify, aggregate and
  summarise it. Revisit only with a story for that.
- **An orientation label or "couple type" enum** — GDPR Art. 9 / FADP decision, not a
  style choice. `Groups.kind` is copy, `Users.gender` is optional free text used for no
  logic, `BodyMaps.form` is which figure to draw.
- **Touch maps anywhere near a model or a shared surface** — the statement reads a hard
  five-table allowlist; adding to it is the mistake to avoid.
- **Face photographs stored anywhere** — mood analysis is in-memory only.
- **DB-per-group / schema-per-group, WebSockets, hosted pub/sub, Postgres from day one** —
  see the ADR table in `docs/ARCHITECTURE.md`.

---

## 7. Where the next feature probably lives

The product dossier (`docs/PRODUCT-BUSINESS-RESEARCH.html`) argues the app's real job is
**shared time, not shared accounting**, and proposes three carrying screens — *Today*,
*Places*, *History* — plus a private taste graph, a consent bridge, a place graph and a
merchant layer, monetised as a per-circle subscription before any marketplace. Treat it as
the standing brainstorming input; `docs/ML-AI-RESEARCH.html` is its counterpart for the
intelligence layer.

Open threads already in the tree: i18n coverage beyond the shell, guest→Person mapping,
key rotation, and the Postgres cut-over trigger (a 2 GB file or sustained chat load).

## 8. Where to look

`docs/CONTRACTS.md` (normative, read first) · `docs/ARCHITECTURE.md` + the in-app
`/architecture.html` (ADR-002) · `docs/API.md` · `docs/MODEL.md` · `docs/FRONTEND-CONTRACT.md`
· `docs/RUNBOOK.md` · `CHANGELOG.md` (feature history in prose) · `GO-LIVE.md`.
