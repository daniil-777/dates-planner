# RUNBOOK — operating Two-Way Match

This is the document for the people who actually use the app. It assumes you are
one of them, that it is a Tuesday evening, and that something either needs doing
or has gone wrong.

Everything below is written against the code as it stands: the commands are the
ones in `package.json`, the thresholds are the ones in `srv/lib/constants.ts`,
and the log lines are the ones the code really prints. Where a number matters it
is named with its source file so you can check it has not drifted.

---

## 0. The five-minute mental model

```
 phone photo ──► POST /ledger/scanReceipt
                      │
                      ├─ srv/lib/images.ts      strip EXIF, rotate, ≤2000 px, JPEG q85
                      ├─ srv/lib/documentai/    submit job → poll → map to ExtractedReceipt
                      ├─ srv/lib/classifier/    two heads: category + moment, from weights.json
                      └─ writes Receipts + a *draft* Expense, returns it
                                     │
                       you press Verify in the UI
                                     │
                            POST /ledger/confirmExpense
                                     │
                      ├─ status: draft → confirmed, documentNumber assigned
                      └─ any label you changed is logged in Corrections
                                     │
                    end of month: POST /ledger/runSettlement
                                     │
                      └─ Settlements row = the clearing document
```

Three things never need credentials: Document AI (bundled fixtures), the LLM
(deterministic `template` provider) and the classifier (runs in-process from
`ml/model/weights.json`). If the app is broken, none of those is usually why.

---

## 1. Running it

### Everyday development

```bash
npm run dev          # CAP on http://localhost:4004, Vite on http://localhost:5173
```

Open **5173**, not 4004 — Vite proxies `/ledger` to the CAP process and gives you
hot reload. 4004 serves the raw OData service and CAP's own index page, which is
what you want when you are poking at the API with curl.

`cds-tsx watch` restarts on any change under `db/` or `srv/`. A change to
`db/schema.cds` recreates the in-memory schema and **re-seeds from
`db/data/*.csv`**, which silently throws away anything you typed. If you have
data you care about, back up first (§7).

### Running it for real

```bash
npm run build        # Vite build of app/ + cds build --production
NODE_ENV=production npm start
```

`NODE_ENV=production` is what turns on basic auth, helmet and rate limiting, and
makes the CAP process serve the built SPA itself. There is no separate web
server.

### Checks before you push anything

```bash
npm test             # vitest, whole backend suite
npm run typecheck    # tsc --noEmit, backend + app
```

`npm test` includes `test/classifier-parity.test.ts`, which compares the
TypeScript inference port against 60 rows of Python output to 1e-4. If that one
fails, the model and the app disagree and **no scan result can be trusted** —
see §6.

---

## 2. The daily loop

1. **Scan.** Take the photo in the app. The upload ceiling is 10 MB
   (`MAX_UPLOAD_BYTES`, `srv/lib/images.ts`); a modern phone photo is 3–8 MB, so
   you will occasionally hit it on a panorama-mode accident. Everything is
   re-encoded to JPEG at 2000 px on the long edge, and **all EXIF is stripped** —
   GPS, device serial, capture time. That is deliberate: this is a private
   ledger, and `sharp` drops metadata unless asked to keep it, which we never do.
2. **Verify.** The draft comes back with a category, a moment, and two
   confidences. Anything below **0.6** (`NEEDS_REVIEW_THRESHOLD`) is flagged for
   a human. Fix what is wrong _before_ pressing Verify — see §4 for why the
   timing matters.
3. **Confirm.** `confirmExpense` flips `status` to `confirmed` and assigns the
   next `documentNumber`. Until then the row is invisible to the totals and to
   the payment run.

A draft you never confirm is harmless. It sits there, it is not in any total,
and you can delete it. Deleting a _confirmed_ expense is the thing to think
twice about, because its `documentNumber` is then a gap in the sequence forever.

**Document #1 is special.** `documentNumber = 1` is the first date. It is
read-only except for `note`; the API refuses any other change to it. That is not
a bug to be fixed.

---

## 3. When a scan misfires

Work down this list. Each symptom has exactly one likely cause.

### The scan came back as "Blaue Ente, CHF 148.50" and you were at Migros

You are in **mock mode**. The mock picks a bundled fixture by filename keyword
(`migros` → grocery, `hotel` → hotel invoice, anything else → the restaurant),
so an unrecognised filename always yields the restaurant receipt.

Check the server log at startup or on the first scan:

```
[documentai] mock mode (MOCK_DOCAI)                 ← you set MOCK_DOCAI in .env
[documentai] mock mode (no Document AI credentials) ← one of the four is missing/blank
[documentai] live mode                              ← real BTP calls
```

Mock mode is on when `MOCK_DOCAI` is truthy (`1`, `true`, `yes`, `on`) **or**
when any one of `DOCAI_URL`, `DOCAI_UAA_URL`, `DOCAI_CLIENT_ID`,
`DOCAI_CLIENT_SECRET` is missing or blank. `.env.example` ships with
`MOCK_DOCAI=1` on purpose, so a fresh checkout lands in mock mode rather than in
a 401. Comment it out and fill in the four credentials to go live.

The mock also waits 800 ms (`MOCK_DELAY_MS`) so the busy indicators get
exercised. A scan that returns instantly is not the mock.

### `Document AI token request failed with HTTP 401`

The two URLs are swapped. `DOCAI_UAA_URL` is the **authentication** host
(`...authentication.eu10.hana.ondemand.com`), `DOCAI_URL` is the **API** host
(`aiservices-dox...`). This is the single most common setup mistake and the
message deliberately carries no response body, because the token endpoint is the
one place a reply could quote your secret back at you.

### `Document AI job <id> did not finish within 60000 ms (last status RUNNING)`

The BTP service is slow or wedged. The job id in the message is real — you can
look it up in the BTP cockpit. Retry the scan; the image is already stored in
`Receipts`, so nothing is lost. If it happens twice in a row, flip `MOCK_DOCAI=1`
for the evening and type the expense in by hand.

### The amount is wrong by a factor of 1000, or a comma became a dot

`srv/lib/documentai/mapper.ts` handles `1'234.50` (CH), `1.234,50` (DE/IT) and
`1 234,50` (FR). One asymmetry is deliberate and will bite you exactly once: a
**dot followed by three digits** is read as a decimal, not a thousands group,
because `1.235` is far more often 1.235 kg of bananas than 1235 francs. A German
receipt printing `2.500` for two and a half thousand euros comes back as 2.50.
Fix it in the confirm card; there is nothing to configure.

If the total is unreadable the mapper falls back to the **net** total rather than
giving up, so an amount that is consistently ~7.7 % low is the VAT-exclusive
figure and means `grossAmount` did not extract.

### The receipt is a black rectangle

That would be a transparent PNG composited onto black — but `open()` in
`srv/lib/images.ts` flattens onto white first, so it should not happen. If it
does, the image reached the database without going through
`processReceiptImage`, which is a code bug, not an operational one.

### `could not read this image: ...`

`decode_failed`. Either the upload was truncated (`failOn: 'error'` refuses half
a receipt rather than storing it) or it is genuinely not an image. HEIC from an
iPhone is supported. PDFs are not — `unsupported_type`.

### The category is right but the moment is nonsense

Normal, and the reason the moment head exists as a separate classifier. `moment`
needs context the receipt does not carry (was it a Saturday, was it CHF 148,
were you celebrating). Correct it; that correction is worth more to the next
training round than a category correction, because moment is the weaker head
(see `metrics.momentF1` in `ml/model/weights.json`).

---

## 4. Correcting a category, and why it is worth doing

When you change `category` or `moment` on a draft and then confirm it,
`confirmExpense` compares what the model predicted against what you stored and
writes a **`Corrections`** row for each field that differs:

```
Corrections: { expense, field: 'category' | 'moment', predicted, corrected, createdAt }
```

That table is the entire input to the continuous-learning loop. `npm run
ml:export-data` reads confirmed expenses _and expands their corrections_ into
`ml/data/live_transactions.csv`, which the retrainer then trains on. So:

- **Correct it before you press Verify.** The prediction the model made is passed
  to `confirmExpense` as `predictedCategory` / `predictedMoment`. Editing the row
  afterwards changes the ledger but records no correction, and the model learns
  nothing.
- **Correcting the same merchant twice is not wasted.** The text features are
  character n-grams of the normalised merchant string, so two corrections on
  "COOP PRONTO BAHNHOF ZUERICH HB" also nudge every other Coop Pronto.
- **Do not correct to a category that is not on the list.** The ten codes in
  `CONTRACTS.md` §1.1 are the labels the model was trained on; there is no
  eleventh, and the UI will not offer you one.

A correction does nothing until you retrain (§6). Nothing changes under you
mid-month.

---

## 5. The monthly payment run

A payment run **closes a period**. It records what the month totalled so it can be
marked done; it moves no money and it computes no debt, because nobody owes anybody
(`CONTRACTS.md` §9).

The ritual, on the first evening of the month, over whatever you are drinking:

1. **Confirm the stragglers.** Anything still `draft` is not in the run. Sort by
   date, work through them.
2. **Look at the totals.** `GET /ledger/periodTotals(period='2026-03')` — or the
   tile on the home page. `grandTotal` is what the month came to and `byPerson`
   says what each person put in, with a `share` that is a proportion of the spend
   and never a claim on anybody.
3. **Run it.** `POST /ledger/runSettlement` with `period: '2026-03'`. This
   freezes the period's total into a `Settlements` row — the clearing document —
   and stamps every expense it covered with `settlement`, which takes them out of
   the open month permanently.
4. **Mark it settled.** `POST /ledger/markSettled` with the settlement's ID.
   `status` goes `open` → `settled` and `settledAt` is stamped.

Things worth knowing:

- **Totals are frozen at run time on purpose.** If you confirm a March expense in
  April, after March has been run, it does _not_ retroactively change the March
  clearing document. It lands in the next run. That is the whole reason the
  totals are stored rather than recomputed.
- **The odd rappen.** Money is carried as exact cents and rounded half-up once,
  at the end. A lone CHF 0.05 expense split equally leaves B owing CHF 0.03,
  while the UI's own two-halves display (`splitEqual`) gives A the extra rappen
  and shows 0.03 / 0.02. They differ by at most one rappen and the ledger's
  figure is the one that counts.
- **`payer_only` rows move money but create no claim.** They still show up in
  `totalA` / `totalB`, which is correct: it is what that person actually spent.
  Birthday presents are `payer_only`.
- **A period is `YYYY-MM` with a real month.** `2026-13` is refused.

---

## 6. Retraining

Do this a few times a year, or after a run of corrections that annoyed you.

```bash
npx tsx scripts/export-training-data.ts                                   # 1
ml/.venv/bin/python ml/train.py --csv ml/data/live_transactions.csv \
  --n-buckets 65536                                                      # 2
npm run ml:export                                                        # 3
npx vitest run test/classifier-parity.test.ts                            # 4
```

which is, in order:

1. confirmed expenses + corrections → `ml/data/live_transactions.csv`
2. `ml/train.py` → `ml/model/model.pkl`
3. `ml/export_ts.py` → `ml/model/weights.json` + `ml/model/parity_fixture.json`
4. the parity gate

> `package.json` bundles this as `npm run ml:retrain`, but that alias is
> **currently broken**: it starts with `ml:export-data`, wired as
> `cds-tsx run scripts/export-training-data.ts`, and `cds run` reads its first
> positional argument as a _project folder_, not a script — so it dies with
> `No such folder or package: … -> 'scripts/export-training-data.ts'`. The same
> applies to `npm run backup` and `npm run hash`. Until `package.json` says
> `tsx scripts/…` instead of `cds-tsx run scripts/…`, run the four steps above
> by hand.

**Step 4 is the gate.** If the parity test fails, the Python trainer and the
TypeScript inference port no longer agree, and the weights you just produced must
not ship. `git checkout ml/model/` and investigate before doing anything else —
the two most likely causes are a featurisation change made in `ml/features.py`
without the matching change in `srv/lib/classifier/features.ts`, and a binary
head (`nClasses == 2`) hitting the `[0, w]` expansion path in `export_ts.py` that
`CONTRACTS.md` §2.5 describes.

The running app caches the weights in memory on first use, so a retrain on disk
changes nothing until you tell it. There is a small admin service for exactly
this, at `/admin`, behind the `admin` role (both production logins carry it; in
dev, CAP's mocked `alice` has it and `bob` does not, so `-u alice:` gets in and
`-u bob:` gets a 403, and no credentials at all get a 401):

```bash
curl -s -u 'partner-a@example.com:...' https://twm.example.com/admin/modelInfo()
curl -s -u 'partner-a@example.com:...' -X POST https://twm.example.com/admin/reloadModel
curl -s -u 'partner-a@example.com:...' -X POST https://twm.example.com/admin/retrain
```

`modelInfo()` answers with what is actually deployed — `trainedAt`,
`trainedRows`, `nBuckets` and the metrics — so you can tell at a glance whether
the process is still serving last month's weights. `reloadModel` drops the cache
without bouncing the process. `retrain` runs the pipeline above from the server.

Two safety rails:

- `weights.json` and `parity_fixture.json` are committed. `model.pkl` is not. So
  a bad retrain is one `git checkout` away from being undone, and a good one is a
  reviewable diff.
- Retraining on live data alone will overfit to your own habits and forget the
  categories you rarely use. The synthetic set (`npm run ml:gen`, ~4000 rows from
  a fixed seed) is the floor; keep it in the mix.

Checking what is deployed without shipping weights around:

```bash
ml/.venv/bin/python ml/predict.py --merchant "RESTAURANT BLAUE ENTE" --amount 148.5 --when 2026-03-14T20:15
```

---

## 7. Backup and restore

The whole ledger — expenses, memories, receipt images, photos, statements — is
one SQLite file. Back that up and you have backed up everything.

The scripted way, wired in `package.json`:

```bash
npx tsx scripts/backup.ts                       # -> backups/twoway-match-<stamp>.tar.gz
npx tsx scripts/backup.ts --out /Volumes/stick  # somewhere else
```

Not `npm run backup`: that alias is wired as `cds-tsx run scripts/backup.ts`,
and `cds run` reads the path as a project folder rather than a script
(`No such folder or package: … -> 'scripts/backup.ts'`). `npx tsx` runs the same
file and works. See the note in §6 — three of the `package.json` script aliases
have this bug.

`scripts/backup.ts` takes a consistent snapshot with SQLite's own online backup
API (safe against a running server) and writes one gzipped tarball holding:

```
manifest.json          what this is, row counts per table, where it came from
db.sqlite              the snapshot — the whole ledger
images/receipts/<id>.jpg   every receipt scan, also as a plain file
images/photos/<id>.jpg     every memory photo, likewise
```

The images are already blobs inside `db.sqlite`; the loose copies are deliberate
redundancy, so the archive is still readable in ten years without this codebase.
`tar tzf` lists it and `tar xzf` unpacks it — no dependency on the app.

> The script's closing line offers `scripts/restore.ts`, which is **not in the
> repository yet**. Until it is, restore by hand: unpack the archive and copy its
> `db.sqlite` into place, as below.

The by-hand way, which works on any machine with the `sqlite3` CLI and is worth
knowing because it is what you will reach for at 23:00. Do **not** just
`cp db.sqlite`: a copy taken while the server is writing can be torn. Use
SQLite's own online backup, which is consistent against a live writer:

```bash
sqlite3 db.sqlite ".backup '/path/to/backups/twm-$(date +%Y%m%d-%H%M).sqlite'"
```

Restore is the reverse, with the server **stopped**:

```bash
# stop the app first
cp /path/to/backups/twm-20260301-2140.sqlite db.sqlite
NODE_ENV=production npm start

# or, from a scripts/backup.ts tarball:
tar xzf backups/twoway-match-2026-03-01T21-40-00Z.tar.gz -C /tmp/restore
cp /tmp/restore/db.sqlite db.sqlite
NODE_ENV=production npm start
```

Do not restore into a running process. CAP holds the database open and you will
get a file whose journal does not match its pages.

What is _not_ in the backup, and does not need to be:

- `.env` — secrets, kept separately (§8). Losing it costs you a re-paste, not data.
- `ml/model/weights.json` — in git.
- `node_modules`, `gen/`, `app/dist` — all rebuildable.

Test the restore once. A backup you have never restored is a hope, not a backup.
The cheapest test: restore into `db.test.sqlite`, point `cds.requires.db.credentials.url`
at it for one boot, confirm the expense count and that Document #1 is still
`documentNumber = 1`.

---

## 8. Rotating secrets

Nothing sensitive is in git. Everything comes from `.env`, and `.env.example`
lists every variable the code reads — if you find one in the code that is not in
that file, that file is the bug.

| Secret                                   | Where it comes from                               | How to rotate                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOCAI_CLIENT_SECRET`, `DOCAI_CLIENT_ID` | BTP service key for the Document AI instance      | Delete the service key in the BTP cockpit and create a new one, then paste both fields. There is no in-place rotation; the old key stops working the moment it is deleted.                       |
| `ANTHROPIC_API_KEY`                      | console.anthropic.com → API Keys                  | Create the new key, paste it, restart, _then_ revoke the old one. The provider is resolved per request, so a restart is enough.                                                                  |
| `LLM_API_KEY` / `LLM_BASE_URL`           | whatever OpenAI-compatible endpoint you point at  | Same order: add, restart, revoke.                                                                                                                                                                |
| `AICORE_SERVICE_KEY`                     | BTP AI Core instance → Service Keys               | Whole JSON on one line. Same delete-and-recreate as Document AI.                                                                                                                                 |
| `CLASSIFIER_TOKEN`                       | XSUAA client-credentials token, expires ~12 h     | A stale one costs nothing: any remote failure falls back to local inference with a logged warning. The warning never contains the payload, because that holds merchant names.                    |
| `AUTH_HASH_A` / `AUTH_HASH_B`            | `npx tsx scripts/hash-password.ts 'the password'` | Generate, paste (single-quoted — bcrypt hashes contain `$`), restart. Usernames must match a `People.email`, or the request authenticates and then finds no person row.                          |
| `HANA_PASSWORD`                          | HANA Cloud user `TWM_APP`                         | `ALTER USER TWM_APP PASSWORD ...`. Never point the app at `DBADMIN`.                                                                                                                             |

After any rotation: restart, do one scan, and generate one statement. Those two
actions between them touch every credential the app has.

**Rules that are not negotiable.** Never commit `.env`. Never paste a secret into
a log, an issue or a commit message — the code goes out of its way not to log
them (the Document AI cache key is a SHA-256 of the environment precisely so a
second copy of the client secret is not sitting in memory), and it would be a
shame to undo that by hand.

---

## 9. Failure modes at a glance

| What you see                                                                                   | What it is                                                                   | What to do                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Scan returns Blaue Ente for everything                                                         | mock mode, unrecognised filename                                             | check the `[documentai] mock mode (...)` line; fill in the four `DOCAI_*` vars |
| `HTTP 401` from the token endpoint                                                             | `DOCAI_URL` / `DOCAI_UAA_URL` swapped                                        | swap them back                                                                 |
| `job ... did not finish within 60000 ms`                                                       | BTP slow or wedged                                                           | retry; the image is already stored                                             |
| `image is N bytes, the limit is 10485760`                                                      | photo over 10 MB                                                             | retake, or crop before uploading                                               |
| `application/pdf is not an image`                                                              | PDF upload                                                                   | screenshot the PDF, or type it in                                              |
| `could not read this image: ...`                                                               | truncated or corrupt upload                                                  | retake                                                                         |
| Amount ~7.7 % low                                                                              | gross unreadable, net used as a stand-in                                     | correct it in the confirm card                                                 |
| `2.500` became `2.50`                                                                          | dotted-thousands ambiguity, deliberate                                       | correct it; nothing to configure                                               |
| Statement reads flat and templated                                                             | no LLM credentials → `template` provider                                     | that is by design and it never fails; set `ANTHROPIC_API_KEY` for prose        |
| Classifier parity test fails                                                                   | Python and TypeScript disagree                                               | do not ship the weights; `git checkout ml/model/`                              |
| A month's total looks wrong after a payment run                                                | expense confirmed after the run                                              | it lands in the next run; the frozen total is correct                          |
| Every login fails in production                                                                | `AUTH_HASH_*` not single-quoted, so `$` was expanded                         | quote it, restart                                                              |
| Production refuses to start, `refusing to start in production without working credentials`     | `AUTH_USER_*` / `AUTH_HASH_*` empty or not a bcrypt hash                     | `npx tsx scripts/hash-password.ts '...'`, paste single-quoted                  |
| Writes rejected although the login worked, plus a `matches no People row` warning at startup   | `AUTH_USER_*` does not match any `People.email`                              | fix it in Settings → Onboarding, or change the env var                         |
| `429` on a scan or a statement                                                                 | rate limits in `srv/server.ts`: 60 scans/h, 10 statements/h per client       | wait, or fix the client that is looping                                        |
| `413` on a scan                                                                                | the base64 body exceeded the transport ceiling (10 MB image + 4/3 inflation) | retake the photo smaller                                                       |
| Data vanished after a schema edit                                                              | `cds watch` re-seeded from the CSVs                                          | restore from backup (§7)                                                       |

---

## 10. Where to look when nothing above fits

- **CAP service log.** `cds.log` is configured with `service: true`, so every
  request through `LedgerService` prints. The Document AI client prints only job
  ids and job status, on purpose — never bodies, never image bytes.
- **`Receipts.extraction`.** The raw Document AI answer is stored verbatim on
  every scan, and `Receipts.extractionStatus` says which path produced it
  (`done`, `mock`, `failed`, `pending`). That means a mapper fix can be replayed
  against a real bad scan without re-uploading anything — which is exactly what
  it is there for.
- **`Corrections`.** If the model has started getting a merchant wrong, look at
  what you have been correcting. The answer is usually visible in ten rows.
- **`ml/model/weights.json`.** `trainedAt`, `trainedRows` and `metrics` tell you
  which model is actually running.

And if something is genuinely broken at 23:00: switch `MOCK_DOCAI=1`, enter the
expense by hand with `source: 'manual'`, and deal with it on the weekend. The
ledger is a ledger. It will wait.
