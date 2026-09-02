# Architecture — TWM-ADR-002

The full decision record, with diagrams, is **`app/public/architecture.html`** (served in-app
at `/architecture.html`) and **`docs/Two-Way-Match-Architecture.pdf`**. The normative
contract derived from it is `docs/CONTRACTS.md` §12. This file is the summary.

| Question                 | Decision                                                                                         | Rejected                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Where does data live?    | Server is the system of record; each device keeps an IndexedDB cache and an outbox               | Local-only per phone; pure cloud with no cache |
| How are groups isolated? | One database, `group` on every tenant table, one `scopeToGroup` handler that narrows every query | DB per group; schema per group                 |
| Who is a user?           | `Users` log in; `People` are a group's roster; `Memberships` join them with a role               | Reusing People as accounts                     |
| Live messages?           | Server-sent events; sends are plain POSTs; poll fallback                                         | WebSockets; hosted pub/sub                     |
| Voice notes?             | Recorded in-browser, stored as recorded, served only via the API; 120 s / 5 MB                   | Server transcoding; public URLs                |
| Database engine?         | SQLite on the Fly volume; Postgres on a second machine, a 2 GB file, or sustained chat load      | Postgres from day one                          |
| E2E-encrypted chat?      | No, deliberately, in v1 — the server must read the household's data to do its job                | E2EE                                           |

## Phases

0. **Foundation** — `Groups`, `Users`, `Memberships`, `Conversations`, `Messages`; nullable `group` on every tenant entity; default group seeded and backfilled. _Gate: compile, 478 backend tests unchanged._
1. **Isolation** — session carries `groupId`; `scopeToGroup` on every tenant entity and action; register / invite / join; column mandatory. _Gate: two-group isolation suite._
2. **Chat** — SSE stream, `sendMessage` + media endpoint, thread UI with press-to-record and waveform bubbles, outbox promoted from the scan queue. _Gate: two-browser round trip in Playwright; a voice note recorded, uploaded, played._
3. **Polish** — card system, launcher motion, dark parity, mobile fixes, group-voice copy. _Gate: phone screenshots of every page; Lighthouse ≥ 90._
