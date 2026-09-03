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

| code | name | icon | colour | sortOrder |
|---|---|---|---|---|
| Groceries | Groceries | `cart` | `#0070F2` | 10 |
| Dining | Dining | `meal` | `#E76500` | 20 |
| Cafes | Cafés | `cup` | `#A45D00` | 30 |
| Transport | Transport | `bus-public-transport` | `#7858FF` | 40 |
| Travel | Travel | `flight` | `#049F9A` | 50 |
| Gifts | Gifts | `gift` | `#F31DED` | 60 |
| Home | Home | `home` | `#5B738B` | 70 |
| Health | Health | `heartbeat` | `#D20A0A` | 80 |
| Entertainment | Entertainment | `video` | `#C87200` | 90 |
| Subscriptions | Subscriptions | `subscription` | `#256F3A` | 100 |

### 1.2 Moment codes

```
everyday  date_night  trip  gift
```

### 1.3 Other enums

- `Expenses.split`: **REMOVED.** Debt tracking is gone (see §9), so a per-expense
  split had no consumer left. An expense records who *paid*, not who owes.
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
   - `\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b`   (dates)
   - `\b\d{1,2}:\d{2}(:\d{2})?\b`            (times)
   - `\b(nr|no|ref|trx|tid|kd)[.:]?\s*\d+\b` (reference ids)
   - `\b\d{4,}\b`                            (long digit runs)
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

| # | name | formula |
|---|---|---|
| 0 | `log_amount` | `log1p(max(amount, 0))` |
| 1 | `is_weekend`  | `1.0` if ISO weekday is Sat/Sun else `0.0` |
| 2 | `is_evening`  | `1.0` if `hour >= 18` else `0.0` |
| 3 | `hour_sin`    | `sin(2π · (hour + minute/60) / 24)` |
| 4 | `hour_cos`    | `cos(2π · (hour + minute/60) / 24)` |
| 5 | `dow_sin`     | `sin(2π · dow / 7)`, `dow` = Monday 0 … Sunday 6 |
| 6 | `dow_cos`     | `cos(2π · dow / 7)` |

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
      "expected": { /* exactly a ClassifyResult, see §5 */ }
    }
    // 60 rows
  ]
}
```

---

## 5. Classifier TypeScript API — `srv/lib/classifier/index.ts`

```ts
export interface Scored { label: string; p: number }

export interface ClassifyResult {
  category: string            // one of §1.1
  categoryConfidence: number  // 0..1, probability of the winning label
  categoryTop3: Scored[]      // descending p, length min(3, nClasses)
  moment: string              // one of §1.2
  momentConfidence: number
  momentTop3: Scored[]
  engine: 'local' | 'remote'  // 'remote' when CLASSIFIER_URL was used
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
  date: string | null        // YYYY-MM-DD
  time: string | null        // HH:MM, or null
  amount: number | null      // gross total
  currency: string           // ISO-4217, defaults to 'CHF'
  place: string | null
  lineItems: ReceiptLineItem[]
  confidence: Record<string, number>   // per header field, 0..1
  rawFields: Record<string, unknown>
}
```

Number parsing must handle `1'234.50` (CH), `1.234,50` (DE/IT) and `1 234,50` (FR).

Client surface — `srv/lib/documentai/client.ts`:

```ts
export interface DocAiClient {
  submitJob(image: Buffer, mimeType: string, fileName: string): Promise<string>  // jobId
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
  maxTokens?: number   // default 8000
}

export interface LlmProvider {
  readonly name: string   // 'anthropic' | 'openai-compatible' | 'sap-ai-core' | 'template'
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
  totals: { overall: number; byCategory: Record<string, number>; byPartner: Record<string, number>
            byMoment: Record<string, number> }
  counts: { expenses: number; dateNights: number; trips: number
            giftsAToB: number; giftsBToA: number }
  topMerchants: Array<{ merchant: string; total: number; visits: number }>
  longestDateNightStreakWeeks: number
  placesVisited: string[]
  firstMemory: { title: string; date: string } | null
  lastMemory:  { title: string; date: string } | null
  quarters: Array<{ quarter: 1|2|3|4; total: number; highlight: string | null }>
}

export function aggregateYear(year: number, db?: unknown): Promise<StatementFacts>
export function renderTemplateStatement(f: StatementFacts): string   // markdown
```

A **trip cluster** = expenses with `moment='trip'` grouped so that consecutive
expenses within **3 days** of each other belong to the same trip.
The date-night streak counts consecutive ISO weeks containing ≥1 `date_night` expense.

---

## 9. Totals & periods — `srv/lib/settlement.ts`

**There is no debt in this app.** Nobody owes anybody. An expense records who paid it
and, optionally, which event it belongs to. Everything downstream is a *sum*, never a
*balance*. The words "owes", "balance", "net", "owedByA" and "owedByB" must not appear
in the domain, the API, or the UI.

```ts
/** One expense row, reduced to only what the arithmetic needs. */
export interface TotalsInput {
  amount: number
  paidById: string        // People.ID
  eventId: string | null  // Events.ID, or null for everyday spending
  date: string            // YYYY-MM-DD
}

export interface PersonTotal {
  personId: string
  name: string
  paid: number     // what this person actually paid out
  count: number    // how many postings
  share: number    // paid / grandTotal, 0..1 — a proportion, NOT a debt
}

export interface PeriodTotals {
  period: string          // 'YYYY-MM'
  grandTotal: number
  byPerson: PersonTotal[] // descending by paid, then name
  count: number
}

export interface EventTotals {
  eventId: string
  name: string
  grandTotal: number
  perHead: number         // grandTotal / participantCount, for information only
  participantCount: number
  byPerson: PersonTotal[]
  count: number
}

export function summarisePeriod(rows: TotalsInput[], period: string,
                                people: Array<{ ID: string; name: string }>): PeriodTotals
export function summariseEvent(rows: TotalsInput[],
                               event: { ID: string; name: string },
                               participants: Array<{ ID: string; name: string }>): EventTotals
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
- A **payment run** is now a *period close*: it stamps a `Settlements` row recording the
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

| Placeholder | Seed value |
|---|---|
| `<NAME_A>` | `Partner A` (colour `#0070F2`, isDefault) |
| `<NAME_B>` | `Partner B` (colour `#F31DED`, isDefault) |
| `<FIRST_DATE_YYYY-MM-DD>` | `2024-06-15` |
| `<FIRST_DATE_PLACE>` | `The place where it started` |
| `<ONE_SENTENCE_FOR_HER>` | `Document #1. Everything since has been a follow-up posting.` |

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
  - `before READ`  → `query.where({ group_ID: g })` (narrow the query; never sieve rows)
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

| code | region | code | region |
|---|---|---|---|
| `hair` | back and top of the head | `lowerBack` | lower back |
| `face` | front of the head | `hips` | hips, sides |
| `lips` | mouth | `glutes` | behind, below the waist |
| `ears` | both ears | `arms` | upper arms and forearms |
| `neck` | throat and nape | `hands` | hands |
| `shoulders` | both shoulders | `thighs` | outer and front thigh |
| `chest` | chest, front above the waist | `innerThighs` | inward-facing thigh |
| `stomach` | belly, front below the chest | `calves` | below the knee |
| `upperBack` | back above the waist | `feet` | feet |
| | | `intimate` | pelvis, front |

Nineteen codes. `intimate` is one zone deliberately: finer anatomy would be drawn detail
this figure does not have and does not need, and the note field carries anything more
specific a person wants to say.

### 13.2 Levels

| value | meaning |
|---|---|
| `-1` | rather not |
| `1` | gently |
| `2` | yes |
| `3` | favourite |

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
