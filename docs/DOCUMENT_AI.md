# SAP Document AI — setup, wiring, and what breaks

This is the operator guide for the receipt extraction path. It assumes a **free
SAP BTP trial account** (the kind you get with an email address and no credit
card) and it assumes you would rather not spend an afternoon guessing which of
the six URLs in a service key is the one the code wants.

Nothing here is required to run the app. With no credentials the client runs in
**mock mode** and the whole scan flow works end to end against bundled fixtures.
Set the credentials when you want a real photo of a real receipt to turn into a
real draft expense.

The service was called **Document Information Extraction** (DOX) until SAP
renamed it **SAP Document AI**. Both names are still visible in the cockpit, the
API paths, and the role collections — `document-information-extraction` in a URL
is not a stale copy-paste, it is the current path.

---

## 1. Provision it: the Booster route

The booster does in four minutes what takes forty by hand (entitlement →
subaccount → service instance → service key → UI subscription → role
collections). Use it.

1. Log in to the BTP cockpit: <https://cockpit.btp.cloud.sap/> (trial landing
   page: <https://account.hanatrial.ondemand.com/>).
2. Make sure you are in your **global account**, not inside a subaccount — the
   left-hand nav must show _Account Explorer / Boosters / Entitlements_. The
   Boosters entry does not exist inside a subaccount.
3. Left nav → **Boosters**.
4. Search for `Document AI`. Pick **"Set up account for SAP Document AI"**.
   (If you only see "Set up account for Document Information Extraction", that
   is the same booster under the old name.)
5. **Start** → the booster runs its prerequisite check. It will tell you if the
   trial subaccount is missing entitlements and offer to add them.
6. On the _Configure Service_ step choose:
   - **Subaccount**: your trial subaccount (usually `trial`).
   - **Service plan**: `default` on a trial, `free` if you are on a
     pay-as-you-go account that offers the free tier. Both are metered by
     document count; both are enough for a household's receipts.
   - **Instance name**: `twoway-docai` (anything, but you will type it again).
7. On the _Assign Role Collections_ step, tick your own user. The booster
   assigns the `Document_Information_Extraction_UI_*` role collections. Without
   them the Document AI UI application loads but shows empty lists everywhere —
   a symptom that looks like a broken tenant and is really a missing role.
8. **Finish**. The booster shows a summary with links to the service instance
   and to the UI application. Bookmark the UI application link.

If the booster fails on entitlements: cockpit → your subaccount →
**Entitlements** → _Configure Entitlements_ → _Add Service Plans_ → search
`Document`, add the plan, **Save**, then re-run the booster.

---

## 2. The service key, field by field

Cockpit → your subaccount → **Services → Instances and Subscriptions** →
_Instances_ tab → your `twoway-docai` instance → the **⋮** menu → **Create
Service Key** (name it `twoway-docai-key`) → then the key's **⋮** → **View**.

You get JSON shaped like this (values shortened, and obviously not real):

```jsonc
{
  "url": "https://aiservices-dox.cfapps.eu10.hana.ondemand.com",
  "swagger": "/document-information-extraction/v1/",
  "uaa": {
    "url": "https://example-trial.authentication.eu10.hana.ondemand.com",
    "clientid": "sb-example-dox!b1|dox-xsuaa-service!b2",
    "clientsecret": "•••••••••••••••••••••",
    "identityzone": "example-trial",
    "tenantmode": "shared",
  },
  "html5-apps-repo": { "app_host_id": "…" },
}
```

Map it into `.env` exactly like this — four lines, no cleverness:

| Service-key field  | `.env` variable       | Notes                                                                                                                                                                  |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `DOCAI_URL`           | API **host only** — the client appends `/document-information-extraction/v1/…` itself. A trailing slash is stripped for you; a pasted path is not, and produces a 404. |
| `uaa.url`          | `DOCAI_UAA_URL`       | Token host. The client POSTs to `{DOCAI_UAA_URL}/oauth/token`.                                                                                                         |
| `uaa.clientid`     | `DOCAI_CLIENT_ID`     | Contains an exclamation mark and a vertical bar (`sb-…!b1` `dox-…!b2`, joined by a pipe). Do not trim them; quote the whole value in a shell.                          |
| `uaa.clientsecret` | `DOCAI_CLIENT_SECRET` | Never logged, never printed, never in a prompt.                                                                                                                        |

The other fields (`swagger`, `identityzone`, `html5-apps-repo`) are not used by
this app.

Two more knobs, both optional:

| Variable              | Default   | Meaning                                                                         |
| --------------------- | --------- | ------------------------------------------------------------------------------- |
| `DOCAI_SCHEMA_NAME`   | _(empty)_ | Name of a custom schema you created in the UI. Empty = built-in `invoice` type. |
| `DOCAI_DOCUMENT_TYPE` | `invoice` | Document type sent with the job when no custom schema is configured.            |

**The two hosts look almost identical and are not interchangeable.** `uaa.url`
ends in `.authentication.<region>.hana.ondemand.com`; `url` starts with
`aiservices-dox`. Putting the API host in `DOCAI_UAA_URL` gives you a 404 on the
token call, which the client reports as "could not authenticate" — see §7.

Rotating the secret = delete the service key and create a new one. The instance,
its clientId and its extracted documents survive; only the credentials change.

---

## 3. The call flow

Three steps, all in `srv/lib/documentai/client.ts`, all behind the
`DocAiClient` interface in `docs/CONTRACTS.md` §6.

### 3.1 OAuth2 client credentials

```bash
curl -s -u "$DOCAI_CLIENT_ID:$DOCAI_CLIENT_SECRET" \
     -d grant_type=client_credentials \
     "$DOCAI_UAA_URL/oauth/token"
```

```jsonc
{ "access_token": "eyJhbGciOi…", "token_type": "bearer", "expires_in": 43199 }
```

The client caches the token and renews it **60 s before** `expires_in` elapses,
rather than reacting to the first 401: a token that expires mid-poll turns a
successful extraction into a 401 on the last GET, which is the most annoying
possible failure — the work was already done, and paid for.

### 3.2 Submit the job

`POST {DOCAI_URL}/document-information-extraction/v1/document/jobs`,
`multipart/form-data`, two parts: the binary `file` and an `options` JSON string.

```bash
curl -s -X POST "$DOCAI_URL/document-information-extraction/v1/document/jobs" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@receipt.jpg;type=image/jpeg" \
  -F 'options={
        "clientId": "default",
        "documentType": "invoice",
        "extraction": {
          "headerFields": ["documentDate","grossAmount","currencyCode",
                           "senderName","senderAddress","netAmount"],
          "lineItemFields": ["description","quantity","netAmount"]
        }
      };type=application/json'
```

Response: `{ "id": "8b6c…-…", "status": "PENDING" }`. That `id` is the `jobId`
returned by `submitJob()` and stored on `Receipts.docaiJobId`.

That `options` object is exactly what `buildSubmitOptions()` sends — the six
header fields, the three line-item fields, `clientId: 'default'` and
`documentType` from `DOCAI_DOCUMENT_TYPE` — plus `schemaName` once
`DOCAI_SCHEMA_NAME` is set (§5). So this curl is a faithful reproduction of what
the app does, which makes it the right thing to run when the app misbehaves.

Two things about `options` that cost people an hour each:

- The `options` part **must** carry `Content-Type: application/json`
  (`;type=application/json` in curl, an explicit part header with `fetch` and a
  `Blob`). Without it the service reads it as a plain string field and answers
  `400 options is not a valid JSON`.
- `clientId` must exist in the tenant. The client hard-codes `default`, which
  exists out of the box in current tenants and is unrelated to the OAuth
  `clientid` from the service key — two different things with almost the same
  name. If you get `400 client not found`, create it once:
  `POST /document-information-extraction/v1/clients` with
  `{"value":[{"clientId":"default","clientName":"Two-Way Match"}]}`.

The app never sends the original phone photo. `scanReceipt` strips EXIF,
downscales to 2000 px on the long edge and re-encodes JPEG q85 first, which
takes a 4 MB photo to roughly 300–600 KB. That is a privacy decision and a
quota decision at the same time.

### 3.3 Poll

`GET {DOCAI_URL}/document-information-extraction/v1/document/jobs/{id}`

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$DOCAI_URL/document-information-extraction/v1/document/jobs/$JOB_ID"
# add ?returnNullValues=false while exploring by hand, to hide unfilled fields
```

`status` walks `PENDING → RUNNING → DONE` (or `FAILED`). `pollJob(jobId, {
timeoutMs, intervalMs })` re-`GET`s every `intervalMs` (**default 1 500 ms**)
until the job is `DONE`/`FAILED` or `timeoutMs` (**default 60 000 ms**) runs out,
then resolves with the whole payload — deliberately typed as `unknown`, because
parsing it is the mapper's job, not the client's. A `FAILED` job throws with the
service's own reason; a timeout throws naming the last status it saw, which is
the difference between "the document was rejected" and "the queue is slow".

A `DONE` payload:

```jsonc
{
  "status": "DONE",
  "extraction": {
    "headerFields": [
      { "name": "senderName", "value": "Restaurant Blaue Ente", "confidence": 0.94 },
      { "name": "documentDate", "value": "2026-03-14", "confidence": 0.98 },
      { "name": "grossAmount", "value": "148.50", "confidence": 0.97 },
      { "name": "currencyCode", "value": "CHF", "confidence": 0.99 },
    ],
    "lineItems": [
      [
        { "name": "description", "value": "Zweierlei vom Zander", "confidence": 0.88 },
        { "name": "quantity", "value": "2", "confidence": 0.95 },
        { "name": "netAmount", "value": "64.00", "confidence": 0.91 },
      ],
    ],
  },
}
```

Note that `lineItems` is an **array of arrays** — one inner array of
name/value/confidence objects per line. Treating it as a flat array is the
classic mapper bug.

### 3.4 Mapping to `ExtractedReceipt`

`srv/lib/documentai/mapper.ts` turns the payload into the `ExtractedReceipt`
shape fixed by `docs/CONTRACTS.md` §6:

| Document AI field                           | `ExtractedReceipt`                                                                   | Notes                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `senderName`                                | `merchantRaw`                                                                        | Fed to the classifier verbatim; normalisation happens there.                                                                                                                                                                                                                                                                          |
| `documentDate`                              | `date`                                                                               | Normalised to `YYYY-MM-DD`.                                                                                                                                                                                                                                                                                                           |
| _(custom)_ `documentTime`                   | `time`                                                                               | `HH:MM` or `null`. The standard `invoice` type has no time field — this is one reason to make a custom schema.                                                                                                                                                                                                                        |
| `grossAmount`                               | `amount`                                                                             | Gross total, not net.                                                                                                                                                                                                                                                                                                                 |
| `currencyCode`                              | `currency`                                                                           | Defaults to `CHF` when absent.                                                                                                                                                                                                                                                                                                        |
| `senderAddress`                             | `place`                                                                              | First line / city, whatever survives.                                                                                                                                                                                                                                                                                                 |
| `lineItems[][]`                             | `lineItems[]`                                                                        | `description`, `quantity`, `netAmount`.                                                                                                                                                                                                                                                                                               |
| the winning field's `confidence`            | `confidence['merchantRaw' \| 'date' \| 'time' \| 'amount' \| 'currency' \| 'place']` | Keyed by the **domain** name, not the Document AI name, and present only when the field was both found and parsed.                                                                                                                                                                                                                    |
| every extracted **header** field, flattened | `rawFields`                                                                          | `name → value` for every header field, plus `id`, `status`, `documentType`, `fileName`, `schemaName` when the job carries them. Line items are _not_ flattened in here — they are already structured in `lineItems`, and the whole payload is stored verbatim on `Receipts.extraction` anyway, so a mapper fix never needs a re-scan. |

The mapper does not insist on those exact names — each row above is really an
alias list (`senderName | vendorName | supplierName | merchantName | storeName`
for the merchant, `grossAmount | totalAmount | total | amountDue |
invoiceAmount` for the total, `documentTime | receiptTime | transactionTime |
time` for the time), so a custom schema with slightly different field names
still maps. Three further behaviours are worth knowing before you go debugging
one:

- `place` prefers a dedicated city field (`senderCity`, `city`, `place`,
  `location`) and only falls back to parsing a city line out of `senderAddress`.
- An unreadable `grossAmount` falls back to `netAmount`. A draft with a slightly
  wrong total that the confirm card asks you about beats a draft with no total.
- If the schema has no time field at all, the mapper tries to read a time out of
  the **date** field, because till receipts routinely stamp both into one string.

Amount parsing has to survive three conventions on receipts you will actually
photograph in Switzerland: `1'234.50` (CH), `1.234,50` (DE/IT) and `1 234,50`
(FR). What `parseAmount` does, in order:

1. Surrounding parentheses mark the value negative and are stripped:
   `(12.30)` → −12.30.
2. Currency **words** and symbols are replaced by a space. This happens _before_
   the sign is read, which is how `CHF -12.30` finds its minus, and the leftover
   space is what keeps the abbreviation dot of `Fr. 5.60` from being taken for a
   decimal point.
3. A leading or trailing `-` (or the Unicode minus `−`) flips the sign, so
   `12,30-` is −12.30. A `+` on either end is consumed and means nothing.
4. Apostrophes in all their shapes (`'` `‘` `’` `` ` `` `´`) are dropped, then the
   remainder is split on whitespace of every width (NBSP, narrow and thin spaces
   included). Chunks with no digit fall away. If more than one chunk is left they
   are glued together only when they line up as digit groups — 1–3 digits, then
   blocks of exactly 3. That guard is why the `2 x 4.50` a till receipt prints in
   a quantity field returns `null` instead of becoming `24.50`.
5. Then the decimal separator is picked. Both `.` and `,` present → the
   **rightmost** one is the decimal. Only one kind present, occurring once → it
   is the decimal, with one deliberate exception: a **comma** with exactly three
   digits behind it and 1–3 in front (`1,234`) is the English thousands form.
   The mirror case is _not_ symmetric — a lone dot with three digits behind it
   stays a decimal, because `1.235` on a receipt is a weighed quantity far more
   often than a German thousands group (German prices bring their comma decimal
   along: `1.234,50`).
6. A separator that occurs more than once is grouping, and the grouping has to be
   well-formed: `1.234.567,50` and `1,234,567.50` parse, `1.2345,50` returns
   `null`.

So `1'234.50`, `1.234,50`, `1 234,50`, `1 234.50`, `CHF 1'234.50`, `Fr. 5.60`,
`.50`, `12,30-` and `(12.30)` all parse, and anything genuinely unparseable
returns `null` so the field is flagged for review instead of guessed.

Anything below the review threshold of **0.6** (`NEEDS_REVIEW_THRESHOLD`,
`docs/CONTRACTS.md` §1.4), or a missing amount or date, opens the confirm card in
review state instead of silently posting a wrong number.

---

## 4. Mock mode

Mock mode exists so the app is fully developable on a plane, and so that CI
never spends a document from the trial quota.

**It engages when:**

```
MOCK_DOCAI is one of 1 / true / yes / on   (case-insensitive)
  OR any of DOCAI_URL, DOCAI_UAA_URL, DOCAI_CLIENT_ID, DOCAI_CLIENT_SECRET is missing
```

Blank counts as missing, so a commented-out or empty line behaves the way you
expect rather than configuring an empty credential.

That is the normative rule from `docs/CONTRACTS.md` §6, and it is a deliberate
_or_: half-configured credentials fall back to mock rather than failing at
runtime. `getDocAiClient()` reports which one you got via `client.mode`
(`'live' | 'mock'`), and the resulting `Receipts.extractionStatus` is `mock`
rather than `done`, so mock-derived rows stay identifiable in the database
forever.

**What it does:** picks one of three fixtures in
`srv/lib/documentai/fixtures/` by keyword in the file name, then waits 800 ms so
the UI's "Extracting… (Document AI)" busy card is actually visible and you can
tell whether it looks right.

| File name contains | Fixture                                   |
| ------------------ | ----------------------------------------- |
| `migros`           | Swiss grocery receipt, several line items |
| `hotel`            | Hotel invoice, multi-night, higher amount |
| anything else      | Restaurant receipt (the default)          |

So `migros-2026-03-14.jpg` gives you a Groceries draft and `dinner.jpg` gives
you a restaurant one. Renaming the file is the whole test harness.

To go live: fill in the four `DOCAI_*` variables **and** set `MOCK_DOCAI=0` (or
delete the line — anything that is not `1`/`true`/`yes`/`on` means live). Leaving `MOCK_DOCAI=1` next to perfectly good credentials is
the most common "why is it still returning Blaue Ente" moment.

---

## 5. A custom `receipt` schema

The built-in `invoice` document type is trained on invoices: it is good at
sender, date, gross amount and currency, and it has no concept of the _time_ on
a till receipt — which this app cares about, because the hour of day is a
feature of the classifier (`docs/CONTRACTS.md` §2.4). A custom schema fixes
that, and lets you add fields the standard type will never have.

1. Open the Document AI UI: cockpit → your subaccount → **Services → Instances
   and Subscriptions** → _Subscriptions_ tab → **SAP Document AI** (or
   _Document Information Extraction_) → **Go to Application**.
2. In the app, open **Schema Configuration** (older builds: _Schemas_).
3. **Create**. Fill in:
   - **Schema Name**: `receipt` — this exact string goes into
     `DOCAI_SCHEMA_NAME`.
   - **Document Type**: `custom`.
   - **Base Schema / Predefined Fields**: start from the invoice fields if
     offered; it saves typing.
4. Add **header fields**. Keep the standard names where a standard name exists —
   the mapper keys off these strings, so reusing them means the mapper needs no
   change at all:

   | Field name      | Data type | Setup type | Why                               |
   | --------------- | --------- | ---------- | --------------------------------- |
   | `senderName`    | string    | auto       | Merchant → `merchantRaw`          |
   | `documentDate`  | date      | auto       | → `date`                          |
   | `documentTime`  | string    | manual     | → `time`, the reason you are here |
   | `grossAmount`   | number    | auto       | → `amount`                        |
   | `currencyCode`  | string    | auto       | → `currency`                      |
   | `senderAddress` | string    | auto       | → `place`                         |

5. Add **line item fields**: `description` (string), `quantity` (number),
   `netAmount` (number).
6. **Save**, then **Activate**. An inactive schema is invisible to the API. Once
   active the schema is read-only; to change it, deactivate it or create
   version 2 — activating always produces a new version number. `.env` holds the
   schema **name** and nothing else: the client never sends a version, so the
   tenant resolves the active one, and publishing version 2 changes what your
   scans extract with no code or config change. That is convenient and it is also
   the reason a suddenly-different extraction is worth checking against the
   schema's version history before you go looking in the mapper.
7. Optional but worth it: in **Template Configuration**, create a template bound
   to this schema and upload three or four of your own receipts, annotating the
   fields. Templates teach the service what _your_ Migros receipt looks like and
   noticeably lift confidence on the fields that keep landing under 0.6.
8. Put the name in `.env`:

   ```
   DOCAI_SCHEMA_NAME=receipt
   ```

   The client puts that string straight into the job's `options` as
   `schemaName`, next to `clientId` and `documentType` (see `DocAiSubmitOptions`
   in `srv/lib/documentai/types.ts`). Schemas are scoped per client id, so a
   schema created under a different `clientId` than the job uses is simply not
   found — and the failure mode is an **empty extraction, not an error**. If your
   tenant's API wants a `schemaId` instead, list the schemas with
   `GET /document-information-extraction/v1/schemas` and map the name to its id
   there; the environment variable stays the human-readable name either way.

Verify with one scan: the resulting `Receipts.extraction` JSON should contain
`documentTime`, and the draft expense should come back with a time instead of
the 12:00 default.

---

## 6. Quotas, and being a good tenant

The trial and free plans are metered per document. Three habits keep you inside
them:

- `MOCK_DOCAI=1` in dev and in CI. Always.
- Do not re-scan to "try again" — the raw payload is on `Receipts.extraction`,
  so a mapper fix can be re-applied offline.
- Batch scanning uploads one job per image. Ten receipts is ten documents.

---

## 7. Troubleshooting

| Symptom                                                               | Cause                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` on `/oauth/token`                                  | `DOCAI_CLIENT_ID` / `DOCAI_CLIENT_SECRET` truncated on copy — the client id contains `!` and `\|` and shells eat them.                                                                                            | Re-copy from the service key, single-quote in the shell, no trailing whitespace in `.env`.                                                                                                                                                                                                                                                |
| `404` on `/oauth/token`, client logs "could not authenticate"         | `DOCAI_UAA_URL` holds the API host.                                                                                                                                                                               | `DOCAI_UAA_URL` = `uaa.url` (`…authentication.<region>.hana.ondemand.com`); `DOCAI_URL` = `url` (`aiservices-dox…`).                                                                                                                                                                                                                      |
| `401 Unauthorized` on `/document/jobs` although the token call worked | Token expired mid-flight, or the token was fetched from a _different_ subaccount's UAA than the instance lives in.                                                                                                | Confirm both values come from the **same** service key. The client's refresh margin handles genuine expiry.                                                                                                                                                                                                                               |
| `403 Forbidden` on `/document/jobs`                                   | Wrong resource group / client scope: the `clientId` in `options` does not belong to this instance, or (on AI-Core-hosted tenants) the `AI-Resource-Group` header is missing or names a group your key cannot see. | Use `clientId: "default"`, or the id you created via `POST /clients`. If your tenant needs the header, send `AI-Resource-Group: default`. A 403 is never a credentials problem — the token was accepted.                                                                                                                                  |
| `413 Payload Too Large`                                               | The uploaded file is bigger than the platform router allows.                                                                                                                                                      | The app already rejects > 10 MB and downscales to 2000 px / JPEG q85 before upload; a 413 means something bypassed `scanReceipt` (curl with the original photo, usually). Downscale first. PDFs: split, do not upload a 40-page scan.                                                                                                     |
| Job stuck in `PENDING` past the timeout                               | Usually a real queue on a trial tenant; occasionally a document the service cannot open (HEIC from an iPhone, a 1-bit fax TIFF, a password-protected PDF).                                                        | Re-`GET` the job by hand — `PENDING` after a few minutes means it is stuck, not slow. Check the Document AI UI's _Document Jobs_ list for the real error. Convert HEIC to JPEG before upload. `pollJob()` gives up on `timeoutMs` and the receipt is marked `failed`, which is recoverable: re-submit later, the image is already stored. |
| `400 options is not a valid JSON`                                     | The `options` part was sent without `Content-Type: application/json`.                                                                                                                                             | Add `;type=application/json` (curl) or an explicit part content type.                                                                                                                                                                                                                                                                     |
| `400 client not found`                                                | `clientId` does not exist in this tenant.                                                                                                                                                                         | `POST /document-information-extraction/v1/clients` with `{"value":[{"clientId":"default","clientName":"Two-Way Match"}]}`.                                                                                                                                                                                                                |
| `429 Too Many Requests`                                               | Monthly document quota, or polling too aggressively.                                                                                                                                                              | Back off the poll interval; check consumption in the cockpit under the instance. Switch to `MOCK_DOCAI=1` until the quota resets.                                                                                                                                                                                                         |
| Extraction returns but every field is `null`                          | Custom schema not **activated**, or a schema name that exists under a different `clientId`.                                                                                                                       | Activate the schema; confirm the name matches `DOCAI_SCHEMA_NAME` exactly (case-sensitive).                                                                                                                                                                                                                                               |
| It keeps returning "Restaurant Blaue Ente"                            | You are in mock mode.                                                                                                                                                                                             | `client.mode` says `mock`. Check `MOCK_DOCAI` and that all four `DOCAI_*` credentials are non-empty.                                                                                                                                                                                                                                      |

Whatever you do, never paste a service key into a chat window, a prompt, or an
issue. It is a bearer credential for your whole subaccount's Document AI
instance, and rotating it means deleting the key.
