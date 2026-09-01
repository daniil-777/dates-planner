# Two-Way Match

> Spend management for a household.

A private web app for however many people share the bill: scan a receipt, let a model
post it to the right category, say who paid and which trip or dinner it belongs to,
close the month with a *payment run*, and keep the good evenings in a timeline.
Nobody owes anybody — every figure is a sum, never a balance. It is an expense tool
wearing SAP clothing on purpose.

<!-- PLACEHOLDER: the seeded names and the first-date facts are placeholders.
     See docs/CONTRACTS.md §10, or just run the app and use Settings → Onboarding. -->

## Quickstart

```bash
npm install                 # backend
npm --prefix app install    # frontend
npm run ml:setup            # python venv for the trainer (once)
npm run ml:gen              # generate the training dataset
npm run ml:train            # train the two-head classifier
npm run ml:export           # export weights.json for the TypeScript runtime
npm run dev                 # CAP on :4004, Vite on :5173
```

Open http://localhost:5173. Receipt scanning runs in **mock mode** until SAP Document AI
credentials are in `.env`, and the yearly *Statement of Us* falls back to a deterministic
template until an LLM key is configured — so the whole app works with no cloud account at all.

## What is where

| Path | What |
|---|---|
| `db/` | CDS domain model and seed data |
| `srv/` | CAP services and libraries (classifier, Document AI, LLM, forecast) |
| `app/` | React + UI5 Web Components PWA |
| `ml/` | Python trainer, data generator, weight exporter |
| `docs/` | `CONTRACTS.md` first — it is the normative spec |
| `test/` | vitest suites, run against CAP in-process |

## Documentation

- **[docs/CONTRACTS.md](docs/CONTRACTS.md)** — the authoritative interface spec. Read this first.
- [docs/API.md](docs/API.md) — the OData service with curl examples
- [docs/MODEL.md](docs/MODEL.md) — how the classifier works and how to retrain it
- [docs/DOCUMENT_AI.md](docs/DOCUMENT_AI.md) — SAP Document AI setup, and mock mode
- [docs/DEPLOY.md](docs/DEPLOY.md) — shipping it
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — daily operation, backup, restore, secret rotation

## Licence

Private. Not for distribution.
