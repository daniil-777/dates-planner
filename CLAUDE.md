# Two-Way Match

A private web app for a household of any size — scan receipts, record who paid and
which trip or dinner it belongs to, close the month, and keep a timeline of memories.
**Nobody owes anybody:** an expense records a payer, and everything downstream is a
sum rather than a balance. It deliberately wears SAP clothing — Fiori/Horizon look,
"payment run", "clearing document", "Verify" — because that is the joke and the love
letter.

## Stack

| Layer     | Choice |
|-----------|--------|
| Backend   | SAP CAP (`@sap/cds` 10) on Node 22+, **TypeScript** handlers run via `cds-tsx`, types from `@cap-js/cds-typer` |
| Database  | SQLite in dev (`@cap-js/sqlite`); SQLite-on-volume or Postgres in prod; optional HANA Cloud path |
| Frontend  | React 19 + `@ui5/webcomponents-react` (theme `sap_horizon`) as an installable PWA, built by Vite 8 |
| Receipts  | SAP Document AI (BTP), with a bundled **mock mode** so dev needs no BTP account |
| ML        | Two-head classifier (category + moment). Trained in Python (`/ml`), executed in TypeScript (`/srv/lib/classifier`) with a byte-for-byte parity test |
| LLM       | Provider abstraction: native Anthropic → OpenAI-compatible → SAP generative AI hub → deterministic template |

## Layout

```
db/      CDS domain model + seed CSVs
srv/     CAP services, handlers, and libraries
  lib/classifier/   TypeScript inference port of the Python model
  lib/documentai/   SAP Document AI client + mapper + mock fixtures
  lib/llm/          LLM provider abstraction
app/     React + UI5 PWA (own package.json / node_modules)
ml/      Python trainer, data generator, exporter (own venv at ml/.venv)
test/    vitest suites (backend, run in-process via cds.test)
scripts/ operational one-shots (backup, password hashing, training export)
docs/    API.md, MODEL.md, CONTRACTS.md, DEPLOY.md, RUNBOOK.md, ...
```

## Conventions

- **Strict TypeScript, no `any`.** Prefer generated `#cds-models` types.
- **vitest** for unit/integration tests; Playwright for end-to-end.
- **Never commit secrets.** Everything sensitive comes from `.env`; keep `.env.example` current.
- Prettier (no semicolons, single quotes, width 100).
- `docs/CONTRACTS.md` is the **authoritative interface contract** between subsystems.
  Change it deliberately — the Python trainer and the TypeScript inference port must
  agree exactly, and a parity test enforces it.
- Money is `Decimal(10,2)`; never use floats for stored amounts.
- Category codes and moment codes are shared by CDS, Python and TypeScript. See CONTRACTS.md.

## Commands

```bash
npm run dev         # CAP on :4004 + Vite on :5173 (proxied)
npm test            # vitest (backend)
npm run typecheck   # tsc --noEmit, backend + app
npm run build       # app build + cds build --production

npm run ml:setup    # create ml/.venv and install requirements
npm run ml:gen      # regenerate ml/data/transactions.csv
npm run ml:train    # train both heads
npm run ml:export   # write ml/model/weights.json + parity_fixture.json
npm run ml:retrain  # export live data → train → export → parity test
```

## Identity placeholders

The seeded people and "Document #1" (the first date) come from
`db/data/twowaymatch-People.csv` and `db/data/twowaymatch-Expenses.csv` with
**placeholder values**. Two people are seeded so the app is usable immediately, and
more can be added at runtime through Settings — nothing in the code may assume there
are exactly two. Everything is editable through Settings → Onboarding; search for
`PLACEHOLDER` to find every spot that wants real values.
