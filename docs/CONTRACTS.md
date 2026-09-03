# CONTRACTS — the authoritative interface spec

Every subsystem in this repo is built against this document. Python and TypeScript
must agree **exactly**; `test/classifier-parity.test.ts` enforces it to 1e-4.
Do not change a shape here without changing every consumer listed under it.

---

## 1. Shared vocabulary

### 1.1 Category codes (exact strings, ASCII, case-sensitive)

```
Groceries  Dining  Cafes  Transport  Travel  Gifts  Home  Health  Entertainment  Subscriptions
```

Consumers: `db/data/twowaymatch-Categories.csv` (key `code`), `ml/generate_data.py`,
`ml/train.py` labels, `srv/lib/classifier/*`, frontend chips.
Display names may be prettier than the code (`Cafes` → "Cafés"); **the code is ASCII**.

Display metadata (name, SAP icon, colour, sortOrder) lives only in the Categories CSV:

| code          | name          | icon                   | colour    | sortOrder |
| ------------- | ------------- | ---------------------- | --------- | --------- |
| Groceries     | Groceries     | `cart`                 | `#0070F2` | 10        |
| Dining        | Dining        | `meal`                 | `#E76500` | 20        |
| Cafes         | Cafés         | `cup`                  | `#A45D00` | 30        |
| Transport     | Transport     | `bus-public-transport` | `#7858FF` | 40        |
| Travel        | Travel        | `flight`               | `#049F9A` | 50        |
| Gifts         | Gifts         | `gift`                 | `#F31DED` | 60        |
| Home          | Home          | `home`                 | `#5B738B` | 70        |
| Health        | Health        | `heartbeat`            | `#D20A0A` | 80        |
| Entertainment | Entertainment | `video`                | `#C87200` | 90        |
| Subscriptions | Subscriptions | `subscription`         | `#256F3A` | 100       |

### 1.2 Moment codes

```
everyday  date_night  trip  gift
```

### 1.3 Other enums

- `Expenses.split`: **REMOVED.** Debt tracking is gone (see §9), so a per-expense
  split had no consumer left. An expense records who _paid_, not who owes.
- `Expenses.status`: `draft` | `confirmed`
- `Expenses.source`: `scan` | `import` | `manual`
- `Receipts.extractionStatus`: `pending` | `done` | `failed` | `mock`
- `Memories.kind`: `date_night` | `trip` | `gift` | `anniversary` | `other`
- `Settlements.status`: `open` | `settled`
- `Corrections.field`: `category` | `moment`

### 1.4 Constants

- CDS namespace: `twowaymatch`
- Service: `LedgerService`, path `/api/ledger` (the SPA owns `/ledger`; the API lives under `/api`)
- Default currency: `CHF`
- Confidence review threshold: **0.6** (`NEEDS_REVIEW_THRESHOLD`)
- Seed CSV naming: `db/data/twowaymatch-<Entity>.csv`

---

## 2. Feature pipeline (Python ⇄ TypeScript, must match bit-for-bit)

Implemented twice: `ml/features.py` and `srv/lib/classifier/features.ts`.

### 2.1 `normaliseMerchant(raw) -> string`

Applied in this exact order:

1. Lowercase (`str.lower()` / `toLowerCase()`).
2. German transliteration **before** accent stripping: `ä→ae ö→oe ü→ue ß→ss`.
3. Unicode NFKD normalise, then drop all combining marks (`Mn` category).
   (`café` → `cafe`, `zürich` → already `zuerich` from step 2.)
4. Remove date-like and id-like tokens with these regexes, in order, replacing with a space:
   - `\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b` (dates)
   - `\b\d{1,2}:\d{2}(:\d{2})?\b` (times)
   - `\b(nr|no|ref|trx|tid|kd)[.:]?\s*\d+\b` (reference ids)
   - `\b\d{4,}\b` (long digit runs)
5. Replace every character that is not `[a-z0-9 ]` with a space.
6. Collapse runs of whitespace to a single space; strip leading/trailing space.

### 2.2 `charWbNgrams(text, nMin=2, nMax=4) -> string[]`

Mirrors scikit-learn's `analyzer='char_wb'`:

- Split the normalised string on spaces into words, dropping empties.
- **Pad each word** with one space on each side: `w -> " " + w + " "`.
- For each padded word, loop `n` from `nMin` upward to `nMax`:
  - emit every contiguous slice of length `n` (left to right);
  - **if the word was shorter than the window** — i.e. only one slice was produced
    because `len(padded) <= n` — emit that single slice and then **stop widening**
    (`break` out of the `n` loop for this word).

  This is exactly scikit-learn's `_char_wb_ngrams` loop, which appends the short word
  once and breaks. It matters: for `"a"` (padded `" a "`) the correct output is
  `[" a", "a ", " a "]` — three items, **not** four. `" a "` must not be emitted again
  at `n = 4`. Reference outputs the TypeScript port must reproduce exactly:

  ```
  "a"     -> [' a', 'a ', ' a ']
  "ab"    -> [' a', 'ab', 'b ', ' ab', 'ab ', ' ab ']
  "abc"   -> [' a', 'ab', 'bc', 'c ', ' ab', 'abc', 'bc ', ' abc', 'abc ']
  ```

- Order: word by word, then n ascending, then left to right. Duplicates are kept
  (they become counts).

### 2.3 `hashedNgramIds(ngrams, nBuckets) -> Map<int, float>`

- `id = crc32(utf8Bytes(ngram)) % nBuckets`, where `crc32` is exactly
  Python's `zlib.crc32` (IEEE 802.3, reflected, init `0xFFFFFFFF`, final xor,
  **unsigned**). No sign alternation.
- Accumulate `+1.0` per occurrence.
- **L2-normalise** the resulting sparse vector: divide every value by
  `sqrt(sum(v^2))`. If the norm is `0`, leave the vector empty.

### 2.4 `numericFeatures(amount, whenISO) -> number[7]`

Fixed order — this is `numericFeatures` in `weights.json`:

| #   | name         | formula                                          |
| --- | ------------ | ------------------------------------------------ |
| 0   | `log_amount` | `log1p(max(amount, 0))`                          |
| 1   | `is_weekend` | `1.0` if ISO weekday is Sat/Sun else `0.0`       |
| 2   | `is_evening` | `1.0` if `hour >= 18` else `0.0`                 |
| 3   | `hour_sin`   | `sin(2π · (hour + minute/60) / 24)`              |
| 4   | `hour_cos`   | `cos(2π · (hour + minute/60) / 24)`              |
| 5   | `dow_sin`    | `sin(2π · dow / 7)`, `dow` = Monday 0 … Sunday 6 |
| 6   | `dow_cos`    | `cos(2π · dow / 7)`                              |

`whenISO` is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM(:SS)`. A missing time means `12:00`.
Parse as **local wall-clock**, never UTC-shifted.

### 2.5 Final vector and scoring

```
x = concat( textVector(nBuckets, L2-normalised, sparse),
            (numeric - scaler.mean) / scaler.scale )        # length nBuckets + 7
logits = coef · x + intercept                                # coef shape [nClasses, nBuckets+7]
p      = softmax(logits)                                     # max-subtracted for stability
```

Binary heads (`nClasses == 2` after sklearn training) must still be exported as a
**2-row** coefficient matrix so the TypeScript side has one code path. `ml/export_ts.py`
expands sklearn's single-row binary case into rows **`[0, w]` and intercepts `[0, b]`**.

That zero row is not arbitrary — it is the only expansion that reproduces sklearn.
sklearn's binary `predict_proba` is `sigmoid(z)` where `z = w·x + b`. Since
`softmax([0, z]) = [1/(1+e^z), 1/(1+e^-z)] = [1 - sigmoid(z), sigmoid(z)]`, the
`[0, w]` expansion is exact. The symmetric-looking `[-w, +w]` alternative yields
`sigmoid(2z)` instead — right label, wrong probabilities — which the parity test
would catch only if a head ever collapsed to two classes. Both heads shipped today
are multi-class, so this is a dormant path; keep it correct anyway.

---

## 3. `ml/model/weights.json`

```jsonc
{
  "version": 1,
  "nBuckets": 65536,
  "numericFeatures": ["log_amount","is_weekend","is_evening","hour_sin","hour_cos","dow_sin","dow_cos"],
  "scaler": { "mean": [7 floats], "scale": [7 floats] },
  "trainedAt": "2026-09-01T10:00:00",     // ISO, no timezone suffix
  "trainedRows": 4200,
  "metrics": { "categoryAccuracy": 0.99, "momentF1": 0.85 },
  "heads": {
    "category": {
      "labels": ["Cafes","Dining", ...],   // sorted ascending, index == row index
      "intercept": [nClasses floats],
      "shape": [nClasses, 65543],
      "coefB64": "<base64 of float32 little-endian, row-major>"
    },
    "moment": { /* same shape */ }
  }
}
```

`coefB64` decodes to exactly `shape[0] * shape[1]` float32 values.

## 4. `ml/model/parity_fixture.json`

```jsonc
{
  "generatedFrom": "ml/data/transactions.csv",
  "nBuckets": 65536,
  "rows": [
    {
      "merchantRaw": "RESTAURANT BLAUE ENTE",
      "amount": 148.5,
      "whenISO": "2026-03-14T20:15",
      "expected": {/* exactly a ClassifyResult, see §5 */},
    },
    // 60 rows
  ],
}
```

---

## 5. Classifier TypeScript API — `srv/lib/classifier/index.ts`

```ts
export interface Scored {
  label: string
  p: number
}

export interface ClassifyResult {
  category: string // one of §1.1
  categoryConfidence: number // 0..1, probability of the winning label
  categoryTop3: Scored[] // descending p, length min(3, nClasses)
  moment: string // one of §1.2
  momentConfidence: number
  momentTop3: Scored[]
  engine: 'local' | 'remote' // 'remote' when CLASSIFIER_URL was used
}

export function classify(
  merchantRaw: string,
  amount: number,
  whenISO: string,
): Promise<ClassifyResult>

/** Drops the cached weights so the next classify() reloads from disk. */
export function reloadModel(): void
```

Behaviour:

- Weights are read **once** and cached (`Float32Array`); `reloadModel()` clears the cache.
- If `process.env.CLASSIFIER_URL` is set, POST `{merchantRaw, amount, whenISO}` as JSON
  to that URL and return the parsed `ClassifyResult` with `engine: 'remote'`.
  Send `Authorization: Bearer ${CLASSIFIER_TOKEN}` and
  `AI-Resource-Group: ${CLASSIFIER_RESOURCE_GROUP}` when those env vars are set.
  On any remote failure, fall back to local inference (and log a warning, never the payload).
- Probabilities are rounded to 6 decimals before returning, in **both** languages,
  so the parity test compares like with like.
- `ml/predict.py` prints exactly this JSON shape (camelCase keys included).

---

## 6. Document AI — `srv/lib/documentai/mapper.ts`

```ts
export interface ReceiptLineItem {
  description: string
  quantity: number | null
  netAmount: number | null
}

export interface ExtractedReceipt {
  merchantRaw: string | null
  date: string | null // YYYY-MM-DD
  time: string | null // HH:MM, or null
  amount: number | null // gross total
  currency: string // ISO-4217, defaults to 'CHF'
  place: string | null
  lineItems: ReceiptLineItem[]
  confidence: Record<string, number> // per header field, 0..1
  rawFields: Record<string, unknown>
}
```

Number parsing must handle `1'234.50` (CH), `1.234,50` (DE/IT) and `1 234,50` (FR).

Client surface — `srv/lib/documentai/client.ts`:

```ts
export interface DocAiClient {
  submitJob(image: Buffer, mimeType: string, fileName: string): Promise<string> // jobId
  getJob(jobId: string): Promise<unknown>
  pollJob(jobId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<unknown>
  readonly mode: 'live' | 'mock'
}
export function getDocAiClient(): DocAiClient
```

Mock mode is active when `MOCK_DOCAI=1` **or** any of `DOCAI_URL`,
`DOCAI_UAA_URL`, `DOCAI_CLIENT_ID`, `DOCAI_CLIENT_SECRET` is missing.
Mock picks a fixture by filename keyword (`migros` → grocery, `hotel` → hotel invoice,
anything else → restaurant) and waits 800 ms.

---

## 7. LLM provider — `srv/lib/llm/index.ts`

```ts
export interface LlmRequest {
  system: string
  prompt: string
  maxTokens?: number // default 8000
}

export interface LlmProvider {
  readonly name: string // 'anthropic' | 'openai-compatible' | 'sap-ai-core' | 'template'
  generate(req: LlmRequest): Promise<string>
}

export function getProvider(): LlmProvider
```

Selection order (first that is configured wins):

1. `ANTHROPIC_API_KEY` → native `@anthropic-ai/sdk`, model `LLM_MODEL ?? 'claude-opus-5'`
2. `LLM_BASE_URL` **and** `LLM_API_KEY` → OpenAI-compatible `POST {base}/chat/completions`
3. `AICORE_SERVICE_KEY` → SAP generative AI hub (documented, best-effort)
4. otherwise → `template` provider, which never fails

The `template` provider is not a stub: it renders a complete, warm, deterministic
statement from the aggregates. The feature must work with **no** credentials at all.

---

## 8. Statement aggregates — `srv/lib/statement.ts`

```ts
export interface StatementFacts {
  year: number
  partners: { a: string; b: string }
  currency: string
  totals: {
    overall: number
    byCategory: Record<string, number>
    byPartner: Record<string, number>
    byMoment: Record<string, number>
  }
  counts: {
    expenses: number
    dateNights: number
    trips: number
    giftsAToB: number
    giftsBToA: number
  }
  topMerchants: Array<{ merchant: string; total: number; visits: number }>
  longestDateNightStreakWeeks: number
  placesVisited: string[]
  firstMemory: { title: string; date: string } | null
  lastMemory: { title: string; date: string } | null
  quarters: Array<{ quarter: 1 | 2 | 3 | 4; total: number; highlight: string | null }>
}

export function aggregateYear(year: number, db?: unknown): Promise<StatementFacts>
export function renderTemplateStatement(f: StatementFacts): string // markdown
```

A **trip cluster** = expenses with `moment='trip'` grouped so that consecutive
expenses within **3 days** of each other belong to the same trip.
The date-night streak counts consecutive ISO weeks containing ≥1 `date_night` expense.

---

## 9. Totals & periods — `srv/lib/settlement.ts`

**There is no debt in this app.** Nobody owes anybody. An expense records who paid it
and, optionally, which event it belongs to. Everything downstream is a _sum_, never a
_balance_. The words "owes", "balance", "net", "owedByA" and "owedByB" must not appear
in the domain, the API, or the UI.

```ts
/** One expense row, reduced to only what the arithmetic needs. */
export interface TotalsInput {
  amount: number
  paidById: string // People.ID
  eventId: string | null // Events.ID, or null for everyday spending
  date: string // YYYY-MM-DD
}

export interface PersonTotal {
  personId: string
  name: string
  paid: number // what this person actually paid out
  count: number // how many postings
  share: number // paid / grandTotal, 0..1 — a proportion, NOT a debt
}

export interface PeriodTotals {
  period: string // 'YYYY-MM'
  grandTotal: number
  byPerson: PersonTotal[] // descending by paid, then name
  count: number
}

export interface EventTotals {
  eventId: string
  name: string
  grandTotal: number
  perHead: number // grandTotal / participantCount, for information only
  participantCount: number
  byPerson: PersonTotal[]
  count: number
}

export function summarisePeriod(
  rows: TotalsInput[],
  period: string,
  people: Array<{ ID: string; name: string }>,
): PeriodTotals
export function summariseEvent(
  rows: TotalsInput[],
  event: { ID: string; name: string },
  participants: Array<{ ID: string; name: string }>,
): EventTotals
```

Rules:

- A person who paid nothing in the period still appears, with `paid: 0` — a roster, not
  only the spenders.
- `share` is a **proportion of the total spend**, for the bar in the UI. It is not a
  claim on anyone. When `grandTotal` is 0 every `share` is 0, never `NaN`.
- `perHead` is `grandTotal / participantCount`, shown as context ("CHF 540 each") and
  never as an amount owed. With zero participants it is 0.
- Money rounds half-up to 2 decimals **once, at the end**, via `srv/lib/money.ts`.
  Never round an intermediate.
- A **payment run** is now a _period close_: it stamps a `Settlements` row recording the
  period's totals so the month can be marked done and reported on later. It moves no
  money and computes no debt. `clearingDocument` stays `CLR-<period>` and `approvedBy`
  stays `'CEO of the household'` — the joke survives; the arithmetic changes.

## 10. People, events, and placeholders

`Partners` is replaced by **`People`**. There is no longer a hard limit of two, no
`shortName` of `'A'`/`'B'` carrying meaning, and no `shareA` anywhere.

```
People:  ID, name, colour, email, isDefault Boolean
Events:  ID, name, startsOn Date, endsOn Date null, place, note,
         participants : Composition of many EventParticipants { person : Association to People }
Expenses.event : Association to Events null      // null = everyday spending
Expenses.paidBy : Association to People          // unchanged in spirit, renamed target
```

- **Seed two People** so the app is usable immediately, marked `isDefault: true`. More can
  be added at runtime from Settings. Nothing in the code may assume there are exactly two.
- `colour` replaces `avatarColor`; every person gets one and the UI never hardcodes a hue.
- An expense with `event = null` is ordinary spending. An expense on an event is counted
  toward that event's totals as well as the period's.
- Deleting a person who has postings must be refused with a clear message; deleting an
  event detaches its expenses rather than deleting them.

Placeholders — grep for these to replace with real values:

| Placeholder               | Seed value                                                    |
| ------------------------- | ------------------------------------------------------------- |
| `<NAME_A>`                | `Partner A` (colour `#0070F2`, isDefault)                     |
| `<NAME_B>`                | `Partner B` (colour `#F31DED`, isDefault)                     |
| `<FIRST_DATE_YYYY-MM-DD>` | `2024-06-15`                                                  |
| `<FIRST_DATE_PLACE>`      | `The place where it started`                                  |
| `<ONE_SENTENCE_FOR_HER>`  | `Document #1. Everything since has been a follow-up posting.` |

Document #1 is `Expenses.documentNumber = 1`, `source='manual'`, `status='confirmed'`,
`category='Dining'`, `moment='date_night'`, and is **read-only except for `note`**.

---

## 11. Event photos, reminders, and surprises

Three additions to `Events`, all additive — nothing in §9 or §10 changes.

### 11.1 Photos

```
EventPhotos : { key ID; event : Association to Events;
                image : LargeBinary @Core.MediaType; mediaType; caption; takenOn : Date }
Events.photos : Composition of many EventPhotos on photos.event = $self
```

Reuse the existing upload path exactly: `srv/lib/images.ts processReceiptImage` strips EXIF,
auto-rotates, downscales to 2000 px and re-encodes JPEG q85. Do **not** write a second
image pipeline. `Memories.photos` already works this way; follow it.

An event is **past** when `endsOn ?? startsOn` is before today. Past events are the ones
that invite photos, but uploading to any event is allowed — a photo taken on day one of a
trip should not have to wait.

### 11.2 Reminders

```
Reminders : { key ID; event : Association to Events; leadDays : Integer default 1;
              note : String(200); done : Boolean default false }
```

A reminder fires `leadDays` before the event's `startsOn`. `dueOn = startsOn - leadDays`.
The **existing** date helpers in `srv/lib/dates.ts` do this arithmetic — reuse
`addDays`/`daysBetween`; do not write new date maths. Browser notifications are opt-in and
requested only on an explicit tap, never on page load (this rule already exists for
anniversaries in the Memories page — follow that implementation).

### 11.3 Surprises

```
Events.isSurprise : Boolean default false
Events.createdBy  : Association to People
Events.revealedAt : Timestamp null
```

A surprise is **visible only to `createdBy`** until `revealedAt` is set, or until
`startsOn` has passed — whichever comes first. After either, it is an ordinary event.

Rules, in priority order:

1. `LedgerService` filters hidden surprises out of `Events`, `eventTotals`, the calendar,
   and the yearly statement, for every viewer except `createdBy`.
2. **Their expenses still count.** A hidden surprise's postings appear in `periodTotals`,
   `monthlyTotals` and the Ledger exactly as normal spending, simply without the event
   chip. This is the whole point: if a surprise's spending vanished from the month total,
   the gap itself would give it away. Never exclude the money, only the label.
3. The creator sees the event marked with a discreet "Only you can see this" badge and a
   **Reveal** action that stamps `revealedAt`.
4. Deleting a surprise deletes only the event; its expenses detach as usual (§10).

Identity in dev comes from CAP's mocked user; map it to a `People` row by name and fall
back to the first `isDefault` person so the app never breaks when the mapping misses.

---

## 12. Groups, accounts, and chat (TWM-ADR-002)

Normative for the platform change. The full reasoning is in `docs/ARCHITECTURE.md`
(the ADR); this section is the part code is held to.

### 12.1 Tenancy

- Every household entity carries `group : Association to Groups` via the `tenant` aspect.
  `Categories` is the one shared vocabulary and has no group.
- **Phase 0 (shipped with this section):** the column is nullable and every seeded row
  is backfilled to the default group `g0000000-0000-4000-8000-000000000001`.
- **Phase 1:** the session carries `groupId`; `LedgerService` registers ONE handler,
  `scopeToGroup`, on every tenant entity and action:
  - `before READ` → `query.where({ group_ID: g })` (narrow the query; never sieve rows)
  - `before CREATE/UPDATE/DELETE` → stamp `group_ID = g`; refuse a payload naming another group
  - an id that belongs to another group answers **404**, never 403
- Composite index `(group_ID, date)` on `Expenses`; `(group_ID, startsOn)` on `Events`.

### 12.2 Identity

```
Users        email, passwordHash (bcrypt), displayName, gender (optional free text)
Memberships  user → group → person, role: owner | member
Groups       name, kind: couple|household|friends|family|other, currency, inviteCode
```

- `Users` ≠ `People`. A User is a login; a Person is a seat in one group's roster.
- Session cookie payload gains `groupId` and `userId`. `/api/auth/me` returns
  `{ authenticated, userId, groupId, groupName, personId, personName, role }`.
- Registration: `POST /api/auth/register {email, password, displayName}` → User.
  `POST /api/groups/create {name, kind}` → Group + owner Membership + Person.
  `POST /api/groups/join {code}` → member Membership + Person. Codes: 8 chars, 72 h, single use.
- Dev with `AUTH_ALLOW_ANY`: the viewer resolves to the default group; nothing is locked out.

### 12.3 Chat

```
Conversations  group, kind: group|direct, title, messages (composition)
Messages       conversation, author(People), kind: text|audio|image,
               body ≤ 4000, media (LargeBinary), mediaType, durationMs ≤ 120000, peaks (JSON)
```

- `POST /api/ledger/sendMessage(conversationId, kind, body?, media?, mediaType?, durationMs?, peaks?)`
  — audio: mime ∈ {audio/webm, audio/mp4, audio/ogg}, ≤ 5 MB. Rate limit 60/min per user.
- `GET /api/ledger/Messages(id)/media` streams with `Range` support; cookie + group check on every request.
- `GET /api/chat/stream` — Server-Sent Events. Event payload is ALWAYS a notification,
  never data: `{ "entity": "Messages", "id": "...", "conversationId": "...", "v": n }`.
  Reconnect replays from `Last-Event-ID`. Polling fallback every 15 s uses the same endpoints.
- Every device write carries `Idempotency-Key` (client UUID); the server keeps 24 h of keys per group.

### 12.4 What is NOT stored

No orientation label, no "couple type" enum on People or Users. `Groups.kind` is a preset
that sets roster size and copy. `Users.gender` is optional free text a person writes
about themself and is never used for logic. This is a GDPR Art. 9 / FADP decision, not a
style choice — see ADR-002 §6.

## 13. Touch maps — `BodyMaps` / `BodyZones`

A private, first-person map of where somebody likes being touched, drawn on a rotatable
3D mannequin. Two people in a household each keep one and can read the other's; that
reading is the entire point of the feature.

### 13.1 Zone codes

Shared by CDS, the service guard, and `app/src/pages/intimacy/zones.ts`. Every vertex of
the figure carries exactly one of these, so a code that is not on this list can never be
picked, and a code removed from it orphans stored rows. **Additive changes only.**

The figure itself is MakeHuman's `hm08` base mesh (CC0), morphed to the three forms and
labelled region-by-region at build time by `app/scripts/bake-figure.ts`, which writes
`figureData.ts`. Provenance and licence: `app/scripts/NOTICE.md`. Adding a code means
re-running that script, because the labels are baked, not computed on the phone.

| code        | region                       | code          | region                  |
| ----------- | ---------------------------- | ------------- | ----------------------- |
| `hair`      | back and top of the head     | `lowerBack`   | lower back              |
| `face`      | front of the head            | `hips`        | hips, sides             |
| `lips`      | mouth                        | `glutes`      | behind, below the waist |
| `ears`      | both ears                    | `arms`        | upper arms and forearms |
| `neck`      | throat and nape              | `hands`       | hands                   |
| `shoulders` | both shoulders               | `thighs`      | outer and front thigh   |
| `chest`     | chest, front above the waist | `innerThighs` | inward-facing thigh     |
| `stomach`   | belly, front below the chest | `calves`      | below the knee          |
| `upperBack` | back above the waist         | `feet`        | feet                    |
|             |                              | `intimate`    | pelvis, front           |

Nineteen codes. `intimate` is one zone deliberately: finer anatomy would be drawn detail
this figure does not have and does not need, and the note field carries anything more
specific a person wants to say.

### 13.2 Levels

| value | meaning    |
| ----- | ---------- |
| `-1`  | rather not |
| `1`   | gently     |
| `2`   | yes        |
| `3`   | favourite  |

There is no `0`. A region somebody has no opinion about carries **no row**, which is a
different state from one marked `-1`, and the service rejects a write of `0` rather than
storing an ambiguous one. The negative end exists because "not here" is the more
important half of what a map like this is for.

### 13.3 Who may read and who may write

Read is household-wide: a map only its author could see would have no reader. Write is
first-person only — `guardBodyMapWrite` refuses any CREATE, UPDATE or DELETE that lands
on another roster member's map, checking the **stored** owner rather than the payload, so
re-pointing `person` at yourself on the way past does not help. Filtered updates are
covered too, via `readSubjectRows`.

### 13.4 What never happens to these rows

They are Art. 9 / FADP special-category data, and they are the only rows in the database
that would embarrass somebody if they leaked.

- **Never sent to a model.** `srv/lib/statement.ts` reads a hard allowlist of five tables
  (`Expenses`, `Memories`, `People`, `Events`, `EventParticipants`). Touch maps are not on
  it and must not be added; nothing here reaches an LLM prompt, a generated statement, or
  the retraining export.
- **Never on a shared surface.** No home-tile figure, no statement line, no memory, no
  notification body.
- Tenant-scoped like every other household entity, and included in "Export everything"
  because it is the person's own data.

### 13.5 `form`

`feminine` | `masculine` | `neutral` — which mannequin to draw, chosen per person for
their own map. The pairing anybody sees (two women, two men, a man and a woman) is the
two individual choices side by side. This is **not** an orientation field and must not be
turned into one; see §12.4 and ADR-002 §6.

---

## 14. The commons — places, ratings and cards (TWM-ADR-003)

Normative for the shared corpus. The reasoning is in `docs/ADR-003-COMMONS.md`; this section
is what code is held to. **The commons is the only data in this app that is not a single
household's.** Every rule below exists to keep that exception narrow.

### 14.1 The island rule

```
Places  PlaceRatings  PlaceRatingTags  PlaceStats  PlaceTagCounts  Ideas
```

- These entities carry **neither the `tenant` aspect nor `managed`.** No `group` column, so
  `scopeToGroup` has nothing to narrow and is never registered on them; no `createdBy`, which
  would otherwise put a login name on an anonymous review.
- **No association crosses the line**, in either direction. A rating cannot be joined to an
  expense, an event, a memory or a person, because there is no column to join on.
- Served from `/api/commons` by `CommonsService`, which projects **no entity that holds an
  author**. `PlaceRatings` is not exposed in any shape, `@readonly` included.
- **k = 3** (`ANONYMITY_THRESHOLD`). A place shows no stars, no chips, no cost band and no
  tips until three distinct households have rated it, and appears in no list or card before
  then. Below the threshold those fields are **null, never zero** — a client must not be able
  to render `0.0 ★` for a place nobody has judged.
- The threshold is applied **on read, never on write**: a place below it still accumulates
  ratings, or it could never reach three.

### 14.2 Vocabulary (exact strings, ASCII, additive-only)

Shared by CDS, `srv/lib/commons/vocabulary.ts` and the frontend, exactly like §1.1.

```
tags   quiet lively outdoor view easy_to_talk book_ahead no_booking_needed late_open
       step_free dog_ok great_food good_value walk_after first_date big_group rainy_day
       special_occasion surprise_worked

kinds  restaurant cafe bar activity outdoors culture shop other

cost   free under_15 c15_30 c30_60 c60_120 over_120
```

- At most **6 tags** per rating; unknown codes are dropped, not stored.
- **Cost bands are per _person_**, never per couple. Nothing in this app may assume a
  household is two people, and this is the place that would most easily forget it.
- **No tag may describe the people rather than the place.** No group size, no couple type, no
  orientation — ADR-002 §6 and ADR-003 §5. `test/commons-lib.test.ts` fails if one appears.
- Tips: at most **240 characters**, no URL, no `@handle`, refused with a sentence rather than
  silently stripped.

### 14.3 Ranking

Displayed and ordered by different numbers, on purpose:

|         |                                                  |
| ------- | ------------------------------------------------ |
| shown   | the plain mean, two decimals                     |
| ordered | `score = (v·R + m·C) / (v + m)`, rounded to 4 dp |

`v` ratings with mean `R`, global mean `C = 3.9`, prior weight `m = 8`. Rounding to four
decimals is required, not cosmetic: `score` is a `Decimal(6,4)` and keyset pagination can skip
or repeat a row at a page boundary if two ties do not tie identically on every engine.

One household is **one voice**: `(place, authorKey)` is unique, and rating again amends.

### 14.4 Geography

`geohash6` (≈1.2 × 0.6 km) on both `Places` and `PlaceStats`. "Near me" is
`geohash6 IN (<cell + 8 neighbours>)` — nine equalities against one index, identical on SQLite
and Postgres, no PostGIS. The nine cells over-select; callers filter the returned page by true
haversine distance. Index: `(geohash6, kind, score DESC)`.

Pagination is **keyset, never offset**: the cursor carries `score|place_ID`, base64url.

### 14.5 Authorship

`PlaceRatings.authorKey = HMAC-SHA256(COMMONS_AUTHOR_SECRET, "twm:commons:author:v1:" + groupId)`,
hex. Opaque, stable, unique, and not a foreign key to anything.

- **It never crosses the wire.** No response contains it; no request may supply one. A handler
  that needs "whose rating is this" derives it again from the session.
- The server refuses to start in production without a secret of at least 32 characters, the
  same posture as the `AUTH_*` variables.
- **Rotating the secret orphans every rating** — the rows stay, anonymous, and no household
  can amend or withdraw its own. Re-key in the same migration or abandon deliberately; see
  `RUNBOOK.md`.

### 14.6 Cards

`tonight` deals **at most three** evenings, each a place to eat plus either a place to go or an
`Ideas` card, with the two cost bands combined. Fewer than three is a valid answer; padding the
deck to reach three is not.

- The deal is a **seeded weighted sample** from the top of the ranking, seeded by
  `date + authorKey` — stable for the household for the day, different between households, and
  reaching about twelve deep so the same evening is not proposed all week.
- Places a household has already rated are **down-weighted, never hidden**.
- The line under a card names the corpus (`"worked for 12 households"`) and **never a rank**.
- Google and Apple are **destinations, not stores**: every card carries keyless universal
  links out. Nothing is ever written back to either — neither platform permits it.

### 14.7 Finding a place

`search(q, lat?, lon?)` proxies OpenStreetMap's Nominatim from the **server**
(`srv/lib/commons/places.ts`). It used to run in the browser and was correct there; it is
wrong there now for one reason — **a queue in a browser tab is a queue per tab.** One
household with a phone and a laptop is two queues; a hundred households is a hundred, and the
policy asks for one request a second from an _application_.

Held here, and required to stay: at most one request per second process-wide, a `User-Agent`
naming the app (`COMMONS_CONTACT` for an address somebody reads), a 10-minute cache keyed on
the query and a coordinate rounded to about a kilometre, and no bulk endpoint. Nothing about
the caller goes upstream — a typed string and, if they allowed it, roughly where they are; no
cookie, no session, no id.

Failure returns `[]` and never throws: a search that threw would take down the sheet somebody
is typing into, and typing a name by hand is a perfectly good way to add a place.

Nominatim's public instance is explicitly not for heavy use. The cutover — self-hosted
Nominatim, Photon, Pelias — is this one file.

---

## 14A. The commons on screen (FRONTEND-CONTRACT §10)

- `/tonight`, `/places`, `/ideas`, behind **one** launcher tile. Places and Ideas answer the
  question Tonight asks rather than three separate questions, and fourteen tiles is a wall.
- **Below the threshold a card shows no rating at all** — not `0.0`, not five empty outlines,
  both of which read as "everybody hated it". It shows how many more households are needed.
  `stars` stays `null` from the wire to the component; the obvious `stars ?? 0` is one
  character and is the bug this rule exists to prevent.
- **No surface may filter or label by who rated a place.** Not a chip, not a filter, not a
  tag label. ADR-002 §6 and ADR-003 §5; `app/src/pages/places/commons.test.tsx` fails if a
  label ever describes people rather than places.
- **Cost is always per person.** Every band label ends in "each"; "for two" is a bug.
- The base map is Leaflet on OpenStreetMap tiles. Google's would cost `script-src 'self'`,
  the offline map and the promise that nothing about where a household goes leaves the app —
  and buys nothing, because the pins, stars and cards are ours either way. Swapping it is
  `PlacesMap.tsx` alone; everything around it takes `PlaceCard[]`.
- Map links carry no key, no token and `rel="noreferrer"`.

---

## 15. The database — SQLite or Postgres (TWM-ADR-002, TWM-ADR-003)

### 15.1 Which one, and how it is chosen

**`DATABASE_URL` decides, and nothing else does.** Set → Postgres; unset → SQLite. There is no
third setting and no half-configured state: a malformed `DATABASE_URL` is a startup failure,
never a silent fall back to a SQLite file that would then quietly accumulate rows nobody
meant to keep. `srv/lib/database.ts` is the only place that reads it.

The dialect is **configuration, never a fork in application code**. Every query in the repo is
CQN, which CAP compiles for whichever store is configured. Exactly two things cannot be
dialect-blind, and both branch once, in the open, in `srv/lib/migrate.ts`:

|                 | SQLite                                        | Postgres                                        |
| --------------- | --------------------------------------------- | ----------------------------------------------- |
| read the schema | `sqlite_master`, `PRAGMA table_info`          | `information_schema.columns`                    |
| create a table  | generated from the model, `dialect: 'sqlite'` | generated from the model, `dialect: 'postgres'` |

**The dialect is passed to `cds.compile.to.sql`, never inherited.** Left to ambient
configuration it emits SQLite spellings — `NVARCHAR`, `TIMESTAMP_TEXT` — for a Postgres
database, and that DDL runs at boot against the real store. `test/database.test.ts` fails if
any SQLite-only spelling can reach Postgres.

Postgres folds unquoted identifiers to lower case and CAP creates its tables unquoted, so all
schema comparison is case-insensitive (`hasTable` / `hasColumn`). Matched case-sensitively,
`twowaymatch_BodyMaps` looks absent and the migration tries to create a table that already
holds somebody's answers.

### 15.2 Migrations

Additive, idempotent, applied at boot, recorded once per database in `twm_migrations`. Never
drops a table, never drops a column, never rewrites a row that has a value. `cds deploy` is
for development and tests only — **it must never be run against a live store**, because it
drops every table first.

Portable by construction, and required to stay so: `CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`, `VARCHAR`, `TIMESTAMP`.

Indexes live in `COMMONS_INDEXES` and `TENANT_INDEXES` and are re-applied on every new
migration id, so appending one is a one-line change. One of them is not an optimisation:

```
UNIQUE (place_ID, authorKey) on twowaymatch_PlaceRatings
```

§14.3's "one household, one voice" is enforced in the service by reading before writing,
which is a check-then-act and therefore a race. Two taps on a slow connection can interleave
and give one household two votes on one place, silently doubling its weight in the ranking.
The index is the only place that race can actually be closed.

### 15.3 Moving from SQLite to Postgres

One-way, one-shot, offline. `scripts/migrate-to-postgres.ts` copies rows and **does not
create the schema** — start the app once against the empty database and let `migrate()` build
it from the model, so that the mechanism which runs at every boot is the one that is right.

Three differences it exists to handle:

1. **Booleans.** SQLite has none; CAP stores `0`/`1`, and Postgres rejects an integer for a
   `boolean` column. Every value is coerced against the **target column's** declared type read
   from `information_schema`, never guessed from the value — `0` is a good integer and a good
   `false`, and only the target knows which was meant.
2. **Binaries.** `BLOB` → `BYTEA`. `node:sqlite` returns `Uint8Array`; it is wrapped as a
   `Buffer`, without which a photograph is stored as the text `[object Uint8Array]`.
3. **Identifier case**, as in §15.1.

It refuses to write on top of a non-empty table without `--force`, and verifies every table
row-for-row afterwards by reading back. A mismatch fails: everything downstream — a statement,
a payment run, a year of memories — is a sum over these rows.

### 15.4 Backups

`scripts/backup.ts` snapshots the SQLite **file** through SQLite's online backup API. It
refuses to run when `DATABASE_URL` is set (`backupIsExternal()`), because against Postgres it
would produce a reassuring empty tarball every night until the night somebody needed it.
Managed Postgres backs itself up; the nightly workflow must be turned off at the same time as
the cutover, not after.
