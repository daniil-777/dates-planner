# API — `LedgerService`

`LedgerService` is the only service this app exposes. It is OData V4, served at
**`/api/ledger`**, declared in `srv/ledger-service.cds` and implemented in
`srv/ledger-service.ts`.

**Nobody owes anybody.** An expense records who _paid_ it and, optionally, which
_event_ it belongs to; everything this API returns downstream of that is a sum,
never a balance (`CONTRACTS.md` §9). There is no `balance()`, no `net`, and no
number here that says one person should pay another.

Everything below was exercised against a freshly seeded dev server
(`cds-tsx serve --in-memory`, 19 expenses, 5 people, 2 events, 10 categories,
1 memory). Response bodies are real unless a line explicitly says _abridged_.
The examples use the default dev port:

```bash
export LEDGER=http://localhost:4004/api/ledger
```

---

## 1. Conventions

### Service document and metadata

```bash
curl -s "$LEDGER/"
```

```json
{
  "@odata.context": "$metadata",
  "@odata.metadataEtag": "W/\"…\"",
  "value": [
    { "name": "Expenses", "url": "Expenses" },
    { "name": "Categories", "url": "Categories" },
    { "name": "People", "url": "People" },
    { "name": "Events", "url": "Events" },
    { "name": "EventParticipants", "url": "EventParticipants" },
    { "name": "Receipts", "url": "Receipts" },
    { "name": "Settlements", "url": "Settlements" },
    { "name": "Memories", "url": "Memories" },
    { "name": "Photos", "url": "Photos" },
    { "name": "Corrections", "url": "Corrections" },
    { "name": "Statements", "url": "Statements" }
  ]
}
```

`GET $LEDGER/$metadata` returns the EDMX, including every action and function
signature in §3. It is the machine-readable version of this document; when the
two disagree, `$metadata` is right.

### Decimals come back as strings

`Decimal(10,2)` and `Decimal(5,4)` are serialised as JSON **strings**
(`"148.50"`, `"0.9871"`), not numbers — that is OData V4 preserving scale.
`srv/lib/money.ts::toAmount` accepts both forms for exactly this reason; do the
same in any client you write. The **structured return types** of the functions in
§3.2 and §3.3 come back as JSON numbers instead — including `share`, which is a
proportion carried at full double precision (`0.9780047132757266`) and meant to be
formatted, not stored.

### Query options

Standard OData V4, all supported by the CAP runtime:

```bash
curl -s "$LEDGER/Expenses?\$count=true&\$filter=status eq 'confirmed'&\$top=0"
```

```json
{ "@odata.context": "$metadata#Expenses", "@odata.count": 19, "value": [] }
```

`$select`, `$expand`, `$orderby`, `$top`, `$skip`, `$search` and `$apply` all
work. Associations expand by their element name:

```bash
curl -s "$LEDGER/Expenses?\$top=1&\$select=ID,merchantRaw,amount&\$expand=category(\$select=name,icon)"
```

```json
{
  "@odata.context": "$metadata#Expenses",
  "value": [
    {
      "ID": "e0000000-0000-4000-8000-000000000001",
      "merchantRaw": "The place where it started",
      "amount": "0.00",
      "category": { "name": "Dining", "icon": "meal", "code": "Dining" }
    }
  ]
}
```

The key of the expanded association comes back whether you asked for it or not —
that is OData, not CAP being helpful.

### The error envelope

Every failure — validation, not-found, upstream — comes back in CAP's OData
error shape, with the HTTP status repeated in `code`:

```json
{
  "error": {
    "message": "amount must be greater than 0, got 0.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

Two `code` values are not numeric: CDS's own type assertions report
`ASSERT_DATA_TYPE` and add a `target` naming the offending element. Those fire
_before_ the service's handlers, so a value that cannot even be a `Decimal(10,2)`
never reaches the amount rule in §4.

---

## 2. Entities

All eleven are plain projections on `db/schema.cds`, so they support the full CRUD
surface unless a rule in §4 says otherwise. Keys are `ID` (UUID) everywhere
except `Categories`, keyed by `code`, and `EventParticipants`, keyed by the pair
`(event_ID, person_ID)`.

### `Expenses`

The centre of the model. Two association fields carry the whole of what used to be
the splitting machinery: `paidBy_ID` says who paid, and `event_ID` says which trip,
dinner or party it belonged to — `null` for the everyday case, which is most of
them. Neither field says anybody owes anything.

`needsReview` is a **virtual** element: it is part of the API, has no column, is
ignored on writes, and is only ever populated on the draft returned by
`scanReceipt` (§3.9). It is absent from ordinary reads.

```bash
curl -s "$LEDGER/Expenses?\$top=1&\$orderby=documentNumber"
```

```json
{
  "@odata.context": "$metadata#Expenses",
  "value": [
    {
      "ID": "e0000000-0000-4000-8000-000000000001",
      "createdAt": "2026-09-01T10:39:04.819Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T10:39:04.819Z",
      "modifiedBy": "anonymous",
      "date": "2024-06-15",
      "time": "19:30:00",
      "merchantRaw": "The place where it started",
      "merchantNorm": "the place where it started",
      "amount": "0.00",
      "currency": "CHF",
      "category_code": "Dining",
      "categoryConfidence": "1.0000",
      "moment": "date_night",
      "momentConfidence": "1.0000",
      "paidBy_ID": "a0000000-0000-4000-8000-000000000001",
      "event_ID": null,
      "status": "confirmed",
      "source": "manual",
      "note": "Document #1. Everything since has been a follow-up posting.",
      "place": "The place where it started",
      "lat": null,
      "lon": null,
      "receipt_ID": null,
      "documentNumber": 1,
      "settlement_ID": null
    }
  ]
}
```

**Creating one classifies it.** A `POST` with a `merchantRaw` and no
`category_code` runs both classifier heads before the insert, and always
recomputes `merchantNorm` from `merchantRaw` (it is derived data, never trusted
from the caller):

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' -d '{
  "merchantRaw": "COOP PRONTO BAHNHOF",
  "amount": "12.50",
  "date": "2026-03-14",
  "time": "18:42:00",
  "paidBy_ID": "a0000000-0000-4000-8000-000000000001",
  "source": "manual"
}'
```

```
HTTP 201
```

```json
{
  "@odata.context": "$metadata#Expenses/$entity",
  "ID": "0652d52a-18a5-4d6e-b234-86ade44f2bea",
  "createdAt": "2026-09-01T10:41:01.597Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T10:41:01.597Z",
  "modifiedBy": "anonymous",
  "date": "2026-03-14",
  "time": "18:42:00",
  "merchantRaw": "COOP PRONTO BAHNHOF",
  "merchantNorm": "coop pronto bahnhof",
  "amount": "12.50",
  "currency": "CHF",
  "category_code": "Groceries",
  "categoryConfidence": "0.9820",
  "moment": "everyday",
  "momentConfidence": "0.8055",
  "paidBy_ID": "a0000000-0000-4000-8000-000000000001",
  "event_ID": null,
  "status": "draft",
  "source": "manual",
  "note": null,
  "place": null,
  "lat": null,
  "lon": null,
  "receipt_ID": null,
  "documentNumber": null,
  "settlement_ID": null
}
```

Send a `category_code` yourself and the classifier is skipped entirely — a human
who picked a category is not second-guessed by a model.

```bash
# update: merchantNorm is recomputed whenever merchantRaw changes
curl -s -X PATCH "$LEDGER/Expenses(0652d52a-18a5-4d6e-b234-86ade44f2bea)" \
  -H 'Content-Type: application/json' -d '{"merchantRaw":"COOP PRONTO BAHNHOF SBB"}'

# delete: allowed for any expense except Document #1
curl -s -X DELETE "$LEDGER/Expenses(0652d52a-18a5-4d6e-b234-86ade44f2bea)"
```

```
HTTP 204
```

### `Categories`

Code list, keyed by the ASCII `code` shared with the Python trainer
(`CONTRACTS.md` §1.1). Display metadata only — editing `name` or `colour` is
safe; editing `code` breaks the model.

```bash
curl -s "$LEDGER/Categories?\$top=2&\$orderby=sortOrder"
```

```json
{
  "@odata.context": "$metadata#Categories",
  "value": [
    {
      "code": "Groceries",
      "name": "Groceries",
      "icon": "cart",
      "colour": "#0070F2",
      "sortOrder": 10
    },
    { "code": "Dining", "name": "Dining", "icon": "meal", "colour": "#E76500", "sortOrder": 20 }
  ]
}
```

### `People`

Everybody who can pay for something. Any number of rows; the two seeded with
`isDefault: true` are the household, the rest are whoever came along
(`CONTRACTS.md` §10). There is no `shortName`, no `A`/`B`, and nothing in the
model that assumes a particular count. `colour` is the avatar hue the UI uses; it
is per row, never hardcoded.

```bash
curl -s "$LEDGER/People?\$orderby=name"
```

```json
{
  "@odata.context": "$metadata#People",
  "value": [
    {
      "ID": "c0000000-0000-4000-8000-000000000005",
      "createdAt": "2026-09-01T13:35:04.978Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T13:35:04.978Z",
      "modifiedBy": "anonymous",
      "name": "Ines Almeida",
      "colour": "#C87200",
      "email": "ines.almeida@example.com",
      "isDefault": false
    },
    {
      "ID": "a0000000-0000-4000-8000-000000000001",
      "createdAt": "2026-09-01T13:35:04.978Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T13:35:04.978Z",
      "modifiedBy": "anonymous",
      "name": "Partner A",
      "colour": "#0070F2",
      "email": "partner-a@example.com",
      "isDefault": true
    }
  ]
}
```

_(abridged: five rows in the seed.)_ `PATCH /People(<id>)` with
`{"name":"...","email":"..."}` is how onboarding replaces the placeholders from
`CONTRACTS.md` §10, and `POST /People` adds a sixth, seventh or eighth person:

```bash
curl -s -X POST "$LEDGER/People" -H 'Content-Type: application/json' \
  -d '{"name":"Sofia Marti","colour":"#256F3A","email":"sofia@example.com"}'
```

Deleting somebody who has paid for something is refused — see §4.

### `Events`

A trip, a dinner, a party. `participants` is a composition of `EventParticipants`,
so the guest list travels with the event in one payload, and `$expand` reaches
through the link table to the person:

```bash
curl -s "$LEDGER/Events?\$expand=participants(\$expand=person(\$select=name,colour))"
```

```json
{
  "@odata.context": "$metadata#Events",
  "value": [
    {
      "ID": "f0000000-0000-4000-8000-000000000001",
      "createdAt": "2026-09-01T13:35:04.985Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T13:35:04.985Z",
      "modifiedBy": "anonymous",
      "name": "Lisbon Weekend",
      "startsOn": "2026-04-10",
      "endsOn": "2026-04-13",
      "place": "Lisboa",
      "note": "Four of us, one long weekend, an indefensible number of pastéis.",
      "participants": [
        {
          "event_ID": "f0000000-0000-4000-8000-000000000001",
          "person_ID": "a0000000-0000-4000-8000-000000000001",
          "person": {
            "name": "Partner A",
            "colour": "#0070F2",
            "ID": "a0000000-0000-4000-8000-000000000001"
          }
        },
        {
          "event_ID": "f0000000-0000-4000-8000-000000000001",
          "person_ID": "c0000000-0000-4000-8000-000000000004",
          "person": {
            "name": "Luca Ferrari",
            "colour": "#7858FF",
            "ID": "c0000000-0000-4000-8000-000000000004"
          }
        }
      ]
    }
  ]
}
```

_(abridged: two events, four participants on this one.)_ `endsOn` is null for a
single-day event.

**Creating one with its guest list is a single deep insert:**

```bash
curl -s -X POST "$LEDGER/Events" -H 'Content-Type: application/json' -d '{
  "name": "Sunday lunch",
  "startsOn": "2026-10-04",
  "place": "Zürich",
  "participants": [
    { "person_ID": "a0000000-0000-4000-8000-000000000001" },
    { "person_ID": "b0000000-0000-4000-8000-000000000002" },
    { "person_ID": "c0000000-0000-4000-8000-000000000005" }
  ]
}'
```

```
HTTP 201
```

```json
{
  "@odata.context": "$metadata#Events/$entity",
  "ID": "88f02b72-a19a-4a99-bfe0-0d910f2d63b6",
  "createdAt": "2026-09-01T13:36:05.985Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T13:36:05.985Z",
  "modifiedBy": "anonymous",
  "name": "Sunday lunch",
  "startsOn": "2026-10-04",
  "endsOn": null,
  "place": "Zürich",
  "note": null,
  "participants": [
    {
      "event_ID": "88f02b72-a19a-4a99-bfe0-0d910f2d63b6",
      "person_ID": "a0000000-0000-4000-8000-000000000001"
    },
    {
      "event_ID": "88f02b72-a19a-4a99-bfe0-0d910f2d63b6",
      "person_ID": "b0000000-0000-4000-8000-000000000002"
    },
    {
      "event_ID": "88f02b72-a19a-4a99-bfe0-0d910f2d63b6",
      "person_ID": "c0000000-0000-4000-8000-000000000005"
    }
  ]
}
```

Every `person_ID` has to name a row in `People`, and nobody may appear twice —
both rules, and what deleting an event does to its expenses, are in §4.

A `PATCH` carrying `participants` **replaces** the guest list rather than adding
to it, and is validated the same way:

```bash
curl -s -X PATCH "$LEDGER/Events(f0000000-0000-4000-8000-000000000002)" \
  -H 'Content-Type: application/json' \
  -d '{"participants":[{"person_ID":"a0000000-0000-4000-8000-000000000001"},{"person_ID":"c0000000-0000-4000-8000-000000000004"}]}'
```

```
HTTP 200
```

The response is the event's own fields; read the new list back with `$expand`, or
from `eventTotals` (§3.3), which now reports `participantCount: 2`. To add or
remove one person without restating the list, use `EventParticipants` below.

### `EventParticipants`

The link table, keyed by the pair. It is exposed next to `Events` because adding
one person to an event that already exists is one row, not a rewrite of the
event:

```bash
curl -s -X POST "$LEDGER/EventParticipants" -H 'Content-Type: application/json' \
  -d '{"event_ID":"f0000000-0000-4000-8000-000000000002","person_ID":"c0000000-0000-4000-8000-000000000004"}'
```

```json
{
  "@odata.context": "$metadata#EventParticipants/$entity",
  "event_ID": "f0000000-0000-4000-8000-000000000002",
  "person_ID": "c0000000-0000-4000-8000-000000000004"
}
```

Removing somebody from an event is the mirror image, addressed by the pair:

```bash
curl -s -X DELETE \
  "$LEDGER/EventParticipants(event_ID=f0000000-0000-4000-8000-000000000002,person_ID=c0000000-0000-4000-8000-000000000004)"
```

```
HTTP 204
```

### `Receipts` — with a media stream

`image` carries `@Core.MediaType: mediaType`, which makes it a real OData media
stream rather than a base64 blob in the JSON. The metadata comes from the entity
URL, the bytes from `/image`:

```bash
curl -s "$LEDGER/Receipts"
curl -s "$LEDGER/Receipts(<id>)"                      # JSON, no image bytes
curl -s "$LEDGER/Receipts(<id>)/image" -o receipt.jpg # the JPEG itself
```

```json
{
  "@odata.context": "$metadata#Receipts",
  "value": [
    {
      "ID": "a96793c4-8367-4acd-84cf-55296d08bdc7",
      "createdAt": "2026-09-01T10:47:40.118Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T10:47:40.118Z",
      "modifiedBy": "anonymous",
      "mediaType": "image/jpeg",
      "fileName": "blaue-ente-2026-03-14.jpg",
      "docaiJobId": "mock-7fa984ca-edda-4260-aa9a-bdd3b55eeaf5",
      "extraction": "{\"id\":\"mock-7fa984ca-edda-4260-aa9a-bdd3b55eeaf5\",\"status\":\"DONE\",\"fileName\":\"blaue-ente-2026-03-14.jpg\",\"documentType\":\"invoice\",\"schemaName\":\"twowaymatch_receipt_v1\",\"extraction\":{...}}",
      "extractionStatus": "mock"
    }
  ]
}
```

_(abridged: `extraction` is the whole Document AI job result, stored verbatim so
a mapper fix can be replayed without re-uploading anything.)_ Receipts are
normally created by `scanReceipt`, not by a direct `POST`; every stored image has
been through `processReceiptImage`, so it is always a metadata-free JPEG of at
most 2000 px on the long edge, whatever was uploaded.

`extractionStatus` is `pending` while the job is in flight, then `done` (live
Document AI), `mock` (bundled fixture) or `failed`.

### `Memories` and `Photos`

`Photos` is a **composition** of `Memories`, so deleting a memory deletes its
photos. `Photos.image` is a media stream exactly like `Receipts.image`.

```bash
curl -s "$LEDGER/Memories?\$top=1&\$expand=photos"
```

```json
{
  "@odata.context": "$metadata#Memories",
  "value": [
    {
      "ID": "d0000000-0000-4000-8000-000000000001",
      "createdAt": "2026-09-01T10:40:46.811Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T10:40:46.811Z",
      "modifiedBy": "anonymous",
      "expense_ID": "e0000000-0000-4000-8000-000000000001",
      "title": "Document #1",
      "note": "The first posting in a ledger we have been keeping ever since. Booked manually, approved unanimously, never reversed.",
      "occurredOn": "2024-06-15",
      "kind": "anniversary",
      "pinned": true,
      "place": null,
      "lat": null,
      "lon": null,
      "photos": []
    }
  ]
}
```

```bash
curl -s -X POST "$LEDGER/Memories" -H 'Content-Type: application/json' -d '{
  "title": "Pastéis, six of them",
  "note": "No regrets.",
  "occurredOn": "2026-04-13",
  "kind": "trip",
  "place": "Lisboa",
  "expense_ID": "e0000000-0000-4000-8000-000000000010"
}'
```

`kind` is one of `date_night | trip | gift | anniversary | other`.

### `Settlements`

One closed period. Written by `runSettlement` (§3.4); read-only in practice. It
records what the month came to so it can be marked done and reported on later —
it moves no money and it carries no claim on anybody.

```bash
curl -s "$LEDGER/Settlements?\$expand=expenses(\$select=documentNumber,merchantRaw,amount)"
```

```json
{
  "@odata.context": "$metadata#Settlements",
  "value": [
    {
      "ID": "e810fe6e-f921-4de8-800a-8a5957881ec3",
      "createdAt": "2026-09-01T13:35:49.009Z",
      "createdBy": "anonymous",
      "modifiedAt": "2026-09-01T13:35:49.009Z",
      "modifiedBy": "anonymous",
      "period": "2026-01",
      "grandTotal": "235.95",
      "status": "open",
      "settledAt": null,
      "clearingDocument": "CLR-2026-01",
      "approvedBy": "CEO of the household",
      "expenses": [
        {
          "documentNumber": 2,
          "merchantRaw": "MIGROS ZÜRICH HB",
          "amount": "87.45",
          "ID": "e0000000-0000-4000-8000-000000000002"
        },
        {
          "documentNumber": 3,
          "merchantRaw": "RESTAURANT BLAUE ENTE",
          "amount": "148.50",
          "ID": "e0000000-0000-4000-8000-000000000003"
        }
      ]
    }
  ]
}
```

`expenses` is a backlink association: `?$expand=expenses` gives the covered line
items, which is the clearing-document view.

### `Statements` and `Corrections`

`Statements` holds the generated yearly "Statement of Us", one row per year,
overwritten in place by `generateStatement` (§3.10).

`Corrections` is the training-data log. It is written by `confirmExpense` (§3.1)
and is otherwise read-only in spirit — every row is an input to the next
training round.

```bash
curl -s "$LEDGER/Corrections?\$expand=expense(\$select=merchantRaw)"
```

```json
{
  "@odata.context": "$metadata#Corrections",
  "value": [
    {
      "ID": "b9f1d0c4-2a7e-4b56-8c30-1f5e9a6d7c02",
      "expense_ID": "0652d52a-18a5-4d6e-b234-86ade44f2bea",
      "field": "category",
      "predicted": "Groceries",
      "corrected": "Cafes",
      "createdAt": "2026-09-01T10:47:31.008Z",
      "expense": {
        "merchantRaw": "COOP PRONTO BAHNHOF",
        "ID": "0652d52a-18a5-4d6e-b234-86ade44f2bea"
      }
    }
  ]
}
```

---

## 3. Actions and functions

All are **unbound**: functions are `GET /api/ledger/<name>(args)`, actions are
`POST /api/ledger/<name>` with a JSON body. The exact signatures are in `$metadata`.

### 3.1 `confirmExpense` — post a draft

```
action confirmExpense(ID: UUID, predictedCategory: String, predictedMoment: String) returns Expenses
```

Flips `status` to `confirmed` and assigns the next `documentNumber`
(`max + 1`). `predictedCategory` / `predictedMoment` are what the _model_
proposed before the human touched the row; when either differs from what is
finally stored, a `Corrections` row is written. Pass empty strings when there was
no prediction.

```bash
curl -s -X POST "$LEDGER/confirmExpense" -H 'Content-Type: application/json' -d '{
  "ID": "0652d52a-18a5-4d6e-b234-86ade44f2bea",
  "predictedCategory": "Groceries",
  "predictedMoment": "everyday"
}'
```

```json
{
  "@odata.context": "$metadata#Expenses/$entity",
  "ID": "0652d52a-18a5-4d6e-b234-86ade44f2bea",
  "date": "2026-03-14",
  "time": "18:42:00",
  "merchantRaw": "COOP PRONTO BAHNHOF",
  "merchantNorm": "coop pronto bahnhof",
  "amount": "12.50",
  "currency": "CHF",
  "category_code": "Groceries",
  "categoryConfidence": "0.9820",
  "moment": "everyday",
  "momentConfidence": "0.8055",
  "paidBy_ID": "a0000000-0000-4000-8000-000000000001",
  "event_ID": null,
  "status": "confirmed",
  "source": "manual",
  "documentNumber": 20,
  "settlement_ID": null
}
```

_(abridged: the managed and null-valued elements are omitted above.)_

Errors:

| Status | `message`                                                             |
| ------ | --------------------------------------------------------------------- |
| 400    | `confirmExpense needs the ID of the expense to post.`                 |
| 404    | `there is no expense with ID <id>.`                                   |
| 400    | `Document #1 is read-only except for its note; it is already posted.` |

Confirming an already-confirmed expense is idempotent: it keeps the
`documentNumber` it already has.

### 3.2 `periodTotals` — what a month came to

```
function periodTotals(period: String) returns {
  period: String; grandTotal: Decimal; count: Integer;
  byPerson: array of { personId: UUID; name: String; paid: Decimal; count: Integer; share: Decimal }
}
```

`paid` and `grandTotal` are money, rounded once to two decimals; `share` is
scale-free on purpose — see §1.

Every `status='confirmed'` posting dated in the period, summed and filed under
whoever paid for it. Closed months are included: a report that emptied itself the
moment somebody pressed "Payment run" would be a strange kind of report.

```bash
curl -s "$LEDGER/periodTotals(period='2026-04')"
```

```json
{
  "@odata.context": "$metadata#LedgerService.return_LedgerService_periodTotals",
  "period": "2026-04",
  "grandTotal": 1018.4,
  "byPerson": [
    {
      "personId": "b0000000-0000-4000-8000-000000000002",
      "name": "Partner B",
      "paid": 996,
      "count": 2,
      "share": 0.9780047132757266
    },
    {
      "personId": "a0000000-0000-4000-8000-000000000001",
      "name": "Partner A",
      "paid": 22.4,
      "count": 1,
      "share": 0.02199528672427337
    },
    {
      "personId": "c0000000-0000-4000-8000-000000000005",
      "name": "Ines Almeida",
      "paid": 0,
      "count": 0,
      "share": 0
    },
    {
      "personId": "c0000000-0000-4000-8000-000000000004",
      "name": "Luca Ferrari",
      "paid": 0,
      "count": 0,
      "share": 0
    },
    {
      "personId": "c0000000-0000-4000-8000-000000000003",
      "name": "Noemi Berger",
      "paid": 0,
      "count": 0,
      "share": 0
    }
  ],
  "count": 3
}
```

Three things to read off that answer:

- **It is a roster, not a leaderboard.** All five people are there; the three who
  paid for nothing in April are on it at `0`. That is what lets a client render a
  stable list of bars instead of one that changes length every month.
- **`share` is a proportion**, `paid / grandTotal`, for the width of those bars.
  It is not a claim on anybody, and with an empty month it is `0` rather than
  `NaN`.
- **The order is descending `paid`, then name**, so the answer is stable and needs
  no sorting client-side.

Drafts are not spending yet, so they are not in it. A confirmed posting with no
`paidBy_ID` is: the money was spent, so it counts toward `grandTotal` and `count`
and lands on nobody's line — which is also what keeps this answer agreeing with
`monthlyTotals` (§3.6) for the same month.

Errors: 400 `period must be a period of the form YYYY-MM, got "April".`

### 3.3 `eventTotals` — what a trip, dinner or party came to

```
function eventTotals(eventId: UUID) returns {
  eventId: UUID; name: String; grandTotal: Decimal; perHead: Decimal;
  participantCount: Integer; count: Integer;
  byPerson: array of { personId: UUID; name: String; paid: Decimal; count: Integer; share: Decimal }
}
```

The same sum over one event's postings, with the event's own participants as the
roster. `perHead` is `grandTotal / participantCount` — context for the screen
("CHF 254.60 each"), never an amount anybody is being asked for.

```bash
curl -s "$LEDGER/eventTotals(eventId=f0000000-0000-4000-8000-000000000001)"
```

```json
{
  "@odata.context": "$metadata#LedgerService.return_LedgerService_eventTotals",
  "eventId": "f0000000-0000-4000-8000-000000000001",
  "name": "Lisbon Weekend",
  "grandTotal": 1018.4,
  "perHead": 254.6,
  "participantCount": 4,
  "byPerson": [
    {
      "personId": "b0000000-0000-4000-8000-000000000002",
      "name": "Partner B",
      "paid": 996,
      "count": 2,
      "share": 0.9780047132757266
    },
    {
      "personId": "a0000000-0000-4000-8000-000000000001",
      "name": "Partner A",
      "paid": 22.4,
      "count": 1,
      "share": 0.02199528672427337
    },
    {
      "personId": "c0000000-0000-4000-8000-000000000004",
      "name": "Luca Ferrari",
      "paid": 0,
      "count": 0,
      "share": 0
    },
    {
      "personId": "c0000000-0000-4000-8000-000000000003",
      "name": "Noemi Berger",
      "paid": 0,
      "count": 0,
      "share": 0
    }
  ],
  "count": 3
}
```

An expense on an event counts toward that event **and** toward its period — an
event is a second way of looking at the same money, not a second ledger. An event
nobody is on yet reports `perHead: 0` rather than infinity.

Errors:

| Status | `message`                                            |
| ------ | ---------------------------------------------------- |
| 400    | `eventTotals needs the ID of the event to total up.` |
| 404    | `there is no event with ID <id>.`                    |

### 3.4 `runSettlement` — the monthly payment run, which closes a period

```
action runSettlement(period: String) returns Settlements
```

Records what the period came to, stamps a clearing document, and links every line
it covered with `settlement_ID`. **No money moves and nothing is owed** — this is
a period close (`CONTRACTS.md` §9). `CLR-<period>` and "CEO of the household"
survive from the days when it pretended otherwise; the arithmetic does not.

```bash
curl -s -X POST "$LEDGER/runSettlement" -H 'Content-Type: application/json' \
  -d '{"period":"2026-01"}'
```

```json
{
  "@odata.context": "$metadata#Settlements/$entity",
  "ID": "e810fe6e-f921-4de8-800a-8a5957881ec3",
  "createdAt": "2026-09-01T13:35:49.009Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T13:35:49.009Z",
  "modifiedBy": "anonymous",
  "period": "2026-01",
  "grandTotal": "235.95",
  "status": "open",
  "settledAt": null,
  "clearingDocument": "CLR-2026-01",
  "approvedBy": "CEO of the household"
}
```

Reading that: January held two confirmed postings, CHF 87.45 and CHF 148.50, so
the month closed at CHF 235.95. The sum is rounded once, at the end
(`CONTRACTS.md` §9), in `srv/lib/settlement.ts` — never per row.

Two kinds of row are deliberately left out of a run:

- anything already covered by an earlier clearing document (`settlement_ID` is not
  null), so no posting is closed twice;
- **Document #1**, which is read-only except for its note (`CONTRACTS.md` §10). It
  is a CHF 0.00 posting, so leaving it out changes no total — but closing June
  2024 would otherwise write a `settlement_ID` onto the one row nothing may write
  to. `runSettlement` over `2024-06` is therefore refused, while
  `periodTotals(period='2024-06')` still reports it.

`periodTotals` for a closed month keeps answering exactly what it answered before
the close: closing a period reports on it, it does not empty it.

Errors:

| Status | `message`                                                            |
| ------ | -------------------------------------------------------------------- |
| 400    | `period must be a period of the form YYYY-MM, got "2026-13".`        |
| 400    | `period 2026-01 has already been closed by CLR-2026-01.`             |
| 400    | `there is nothing to close in 2026-10: no confirmed, open expenses.` |

### 3.5 `markSettled` — the month is done

```
action markSettled(ID: UUID) returns Settlements
```

Flips a clearing document from `open` to `settled` and stamps `settledAt`. It is
the "we have looked at this month and we are finished with it" button; no money
changes hands here either.

```bash
curl -s -X POST "$LEDGER/markSettled" -H 'Content-Type: application/json' \
  -d '{"ID":"e810fe6e-f921-4de8-800a-8a5957881ec3"}'
```

```json
{
  "@odata.context": "$metadata#Settlements/$entity",
  "ID": "e810fe6e-f921-4de8-800a-8a5957881ec3",
  "createdAt": "2026-09-01T13:35:49.009Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T13:35:56.543Z",
  "modifiedBy": "anonymous",
  "period": "2026-01",
  "grandTotal": "235.95",
  "status": "settled",
  "settledAt": "2026-09-01T13:35:56.542Z",
  "clearingDocument": "CLR-2026-01",
  "approvedBy": "CEO of the household"
}
```

Errors:

| Status | `message`                                            |
| ------ | ---------------------------------------------------- |
| 400    | `markSettled needs the ID of the clearing document.` |
| 404    | `there is no clearing document with ID <id>.`        |
| 400    | `CLR-2026-01 is already settled.`                    |

### 3.6 `monthlyTotals` — period × category, for the charts

```
function monthlyTotals(fromPeriod: String, toPeriod: String) returns array of { period; category; total }
```

Both bounds are inclusive `YYYY-MM`, over `status='confirmed'` expenses only.
Totals are summed in exact cents and rounded once (`CONTRACTS.md` §9), which is
why this is bucketed in TypeScript rather than with SQL `SUM()`. Sorted by
period, then category. An expense confirmed but never classified is reported
under the empty category `""`.

```bash
curl -s "$LEDGER/monthlyTotals(fromPeriod='2026-01',toPeriod='2026-03')"
```

```json
{
  "@odata.context": "$metadata#Collection(LedgerService.return_LedgerService_monthlyTotals)",
  "value": [
    { "period": "2026-01", "category": "Dining", "total": 148.5 },
    { "period": "2026-01", "category": "Groceries", "total": 87.45 },
    { "period": "2026-02", "category": "Gifts", "total": 96 },
    { "period": "2026-02", "category": "Transport", "total": 42 },
    { "period": "2026-03", "category": "Entertainment", "total": 44 },
    { "period": "2026-03", "category": "Subscriptions", "total": 24.9 }
  ]
}
```

Errors:

| Status | `message`                                                      |
| ------ | -------------------------------------------------------------- |
| 400    | `fromPeriod must be a period of the form YYYY-MM, got "2026".` |
| 400    | `toPeriod must be a period of the form YYYY-MM, got null.`     |
| 400    | `fromPeriod 2026-06 is after toPeriod 2026-01.`                |

### 3.7 `duplicates` — the same purchase, booked twice

```
function duplicates(ID: UUID) returns array of Expenses
```

An expense is a duplicate candidate when it has the **same `merchantNorm`** (an
exact match — that is what normalising is for), an amount within **±0.05**
compared in integer cents, and a date within **±2 calendar days**. The expense
itself is never in its own result.

```bash
curl -s "$LEDGER/duplicates(ID=e0000000-0000-4000-8000-000000000002)"
```

```json
{
  "@odata.context": "$metadata#Expenses",
  "value": []
}
```

With an actual duplicate present, the array holds the full `Expenses` rows.
An expense with no `merchantNorm`, no `date` or no readable `amount` returns `[]`
rather than an error — there is nothing to compare.

Errors:

| Status | `message`                                            |
| ------ | ---------------------------------------------------- |
| 400    | `duplicates needs the ID of the expense to compare.` |
| 404    | `there is no expense with ID <id>.`                  |

### 3.8 `classify` — re-run both heads over one expense

```
action classify(ID: UUID) returns Expenses
```

Recomputes `merchantNorm`, `category`, `categoryConfidence`, `moment` and
`momentConfidence` and stores them. Useful after a retrain.

```bash
curl -s -X POST "$LEDGER/classify" -H 'Content-Type: application/json' \
  -d '{"ID":"e0000000-0000-4000-8000-000000000002"}'
```

```json
{
  "@odata.context": "$metadata#Expenses/$entity",
  "ID": "e0000000-0000-4000-8000-000000000002",
  "date": "2026-01-11",
  "time": "11:20:00",
  "merchantRaw": "MIGROS ZÜRICH HB",
  "merchantNorm": "migros zuerich hb",
  "amount": "87.45",
  "currency": "CHF",
  "category_code": "Groceries",
  "categoryConfidence": "0.9854",
  "moment": "everyday",
  "momentConfidence": "0.8947",
  "status": "confirmed",
  "source": "scan",
  "documentNumber": 2
}
```

_(abridged.)_ Note that this writes the model's verdict straight over whatever a
human previously chose, and writes **no** `Corrections` row — it is a
recomputation, not a disagreement.

Errors:

| Status | `message`                                                                    |
| ------ | ---------------------------------------------------------------------------- |
| 400    | `classify needs the ID of the expense to classify.`                          |
| 404    | `there is no expense with ID <id>.`                                          |
| 400    | `Document #1 is read-only except for its note; it will not be reclassified.` |
| 400    | `expense <id> has no merchant name, so there is nothing to classify.`        |

### 3.9 `scanReceipt` — the whole pipeline in one call

```
action scanReceipt(image: LargeBinary, mediaType: String, fileName: String) returns Expenses
```

In order: normalise the image (rotate by EXIF, strip all metadata, cap the long
edge at 2000 px, re-encode as JPEG q85) → insert the `Receipts` row → submit to
Document AI and poll → map the job result → classify → insert a **draft**
`Expenses` row → return it with the virtual `needsReview`.

The receipt row is written _before_ extraction on purpose, so a failing job
leaves evidence behind rather than nothing.

`image` is `Edm.Binary`, so over HTTP it is base64:

```bash
curl -s -X POST "$LEDGER/scanReceipt" -H 'Content-Type: application/json' -d "{
  \"image\": \"$(base64 -i ~/Desktop/blaue-ente.jpg | tr -d '\n')\",
  \"mediaType\": \"image/jpeg\",
  \"fileName\": \"blaue-ente-2026-03-14.jpg\"
}"
```

Response, from the bundled mock (no Document AI credentials, so the restaurant
fixture answered):

```json
{
  "@odata.context": "$metadata#Expenses/$entity",
  "ID": "5005d751-a9b5-4d66-9c74-f3e9fce8d0a3",
  "createdAt": "2026-09-01T10:47:40.118Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T10:47:40.118Z",
  "modifiedBy": "anonymous",
  "date": "2026-03-14",
  "time": "20:15:00",
  "merchantRaw": "RESTAURANT BLAUE ENTE",
  "merchantNorm": "restaurant blaue ente",
  "amount": "148.50",
  "currency": "CHF",
  "category_code": "Dining",
  "categoryConfidence": "0.9984",
  "moment": "date_night",
  "momentConfidence": "0.8482",
  "paidBy_ID": null,
  "event_ID": null,
  "status": "draft",
  "source": "scan",
  "note": null,
  "place": "Zürich",
  "lat": null,
  "lon": null,
  "receipt_ID": "a96793c4-8367-4acd-84cf-55296d08bdc7",
  "documentNumber": null,
  "settlement_ID": null,
  "needsReview": false
}
```

Note what is _not_ filled in: `paidBy_ID` is null, because a receipt does not say
whose card it was. The confirm card asks. `needsReview` is `true` when the
extraction produced no amount or
no date, when there was no merchant name to classify, or when **any** score —
the per-field extraction confidences _and_ both classifier confidences — is
below `NEEDS_REVIEW_THRESHOLD` (0.6, `srv/lib/constants.ts`).

Mock mode picks its fixture by filename keyword: `migros` → grocery receipt,
`hotel` → hotel invoice, anything else → the restaurant receipt.

Errors:

| Status | `message`                                                       |
| ------ | --------------------------------------------------------------- |
| 400    | `scanReceipt needs the receipt image in the "image" parameter.` |
| 400    | `image is 11534337 bytes, the limit is 10485760 (10 MB)`        |
| 400    | `application/pdf is not an image`                               |
| 400    | `could not read this image: <libvips reason>`                   |
| 400    | `the uploaded file is empty`                                    |
| 502    | `Document AI could not read this receipt: <reason>`             |

The three `ImageError` messages come straight from `srv/lib/images.ts` and carry
no image bytes. On a 502 the `Receipts` row survives with
`extractionStatus: 'failed'`, so the image is not lost.

### 3.10 `generateStatement` — the yearly "Statement of Us"

```
action generateStatement(year: Integer) returns Statements
```

Aggregates the year locally (`srv/lib/statement.ts`), hands the facts to
whichever LLM provider the environment selected (`CONTRACTS.md` §7), and stores
the Markdown. With no credentials at all that provider is `template`, which is
deterministic and never fails — the feature does not depend on a network.
Regenerating a year overwrites the existing row rather than adding one.

```bash
curl -s -X POST "$LEDGER/generateStatement" -H 'Content-Type: application/json' \
  -d '{"year":2026}'
```

```json
{
  "@odata.context": "$metadata#Statements/$entity",
  "ID": "1691aaff-fe89-45c3-97a4-435d17bcfaa6",
  "createdAt": "2026-09-01T10:47:13.214Z",
  "createdBy": "anonymous",
  "modifiedAt": "2026-09-01T10:47:13.214Z",
  "modifiedBy": "anonymous",
  "year": 2026,
  "contentMarkdown": "# Statement of Us — FY2026\n\n*Joint Venture \"Partner A & Partner B\", audited internal figures, all amounts in CHF.*\n\n## Executive Summary\n\nThe joint venture closed FY2026 with a total recognised spend of CHF 2,290.30 across 19 posted expenses. …",
  "generatedAt": "2026-09-01T10:47:13.211Z",
  "engine": "anthropic"
}
```

_(abridged: `contentMarkdown` is the full statement, six level-2 sections plus a
quarter table.)_ `engine` is one of `anthropic`, `openai-compatible`,
`sap-ai-core` or `template`, so the Settings page can say which one wrote it —
the example above ran with `ANTHROPIC_API_KEY` set. With no credentials at all
the same call returns `"engine": "template"` and a statement rendered
deterministically from the same aggregates.

This is the slowest call in the API by an order of magnitude: about 26 s against
a real LLM, sub-second against the template provider. Do not put it behind a
30-second gateway timeout.

Errors:

| Status                 | `message`                                               |
| ---------------------- | ------------------------------------------------------- |
| 400                    | `year must be a four-digit calendar year, got 26.`      |
| 400 `ASSERT_DATA_TYPE` | `Value twenty-six is not a valid Integer`               |
| 502                    | `the statement for 2026 could not be written: <reason>` |

`year` is an `Integer` parameter, so a non-numeric one is stopped by CDS's own
type assertion (`code: "ASSERT_DATA_TYPE"`, `target: "year"`) before the handler
ever runs. The handler's own message is what a _number_ outside 1000…9999 gets.

---

## 4. Validation rules and their error shapes

These run as `before` handlers on `Expenses`, `Events`, `EventParticipants` and
`People`, so they apply to direct OData writes as well as to anything the UI does.
Every one of the field rules is conditional on the field being **present in the
payload** — this is validation of what the caller asked for, never a constraint on
what is already stored. That is exactly why Document #1 may keep its amount of
`0.00` while nobody is allowed to write a zero amount today.

### Document #1 is read-only except for `note`

```bash
curl -s -X PATCH "$LEDGER/Expenses(e0000000-0000-4000-8000-000000000001)" \
  -H 'Content-Type: application/json' -d '{"amount":"10.00"}'
```

```
HTTP 400
```

```json
{
  "error": {
    "message": "Document #1 is read-only except for its note; cannot change amount.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

The message names every rejected field, comma-separated. Editing the note
succeeds:

```bash
curl -s -X PATCH "$LEDGER/Expenses(e0000000-0000-4000-8000-000000000001)" \
  -H 'Content-Type: application/json' -d '{"note":"Still the first."}'
```

```
HTTP 200
```

Deleting it does not:

```bash
curl -s -X DELETE "$LEDGER/Expenses(e0000000-0000-4000-8000-000000000001)"
```

```json
{
  "error": {
    "message": "Document #1 is read-only and cannot be deleted.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

### `amount` must be greater than zero

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"COOP","amount":"0.00","date":"2026-03-14"}'
```

```json
{
  "error": {
    "message": "amount must be greater than 0, got 0.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

An amount that is not a decimal at all is stopped one layer earlier by CDS:

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"COOP","amount":"1,50","date":"2026-03-14"}'
```

```json
{
  "error": {
    "message": "Value 1,50 is not a valid Decimal(10,2)",
    "code": "ASSERT_DATA_TYPE",
    "target": "amount",
    "@Common.numericSeverity": 4
  }
}
```

### `currency` must be a three-letter ISO-4217 code

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"COOP","amount":"12.50","date":"2026-03-14","currency":"1 2"}'
```

```json
{
  "error": {
    "message": "currency must be a three-letter ISO-4217 code, got \"1 2\".",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

More than three characters is caught by the `String(3)` type first:

```json
{
  "error": {
    "message": "Value CHFX is not a valid String(3)",
    "code": "ASSERT_DATA_TYPE",
    "target": "currency",
    "@Common.numericSeverity": 4
  }
}
```

### An expense may only point at an event that exists

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"COOP","amount":"12.50","date":"2026-03-14","event_ID":"00000000-0000-4000-8000-000000000999"}'
```

```json
{
  "error": {
    "message": "there is no event with ID 00000000-0000-4000-8000-000000000999; create the event first.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

`event_ID: null` is not an error — it is the normal case, and it means everyday
spending. A dangling id would be the damaging one: the posting would fall out of
`eventTotals` (no such event) _and_ out of any view that filters on the field
being null. Money in the ledger and in no report.

### An event's participants must all be people the ledger knows

```bash
curl -s -X POST "$LEDGER/Events" -H 'Content-Type: application/json' \
  -d '{"name":"Imaginary","startsOn":"2026-10-04","participants":[{"person_ID":"00000000-0000-4000-8000-000000000999"}]}'
```

```json
{
  "error": {
    "message": "there is nobody in the ledger with ID 00000000-0000-4000-8000-000000000999 — add the person first.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

Nobody may be on the same event twice, either. The composite key of
`EventParticipants` would refuse the second row by itself, but as a constraint
violation from the driver — this says it in words instead:

```json
{
  "error": {
    "message": "person a0000000-0000-4000-8000-000000000001 is on this event twice; each person joins once.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

Adding one person to an event that does not exist is a 404 rather than a 400 —
the request names a row that is not here:

```json
{
  "error": {
    "message": "there is no event with ID 00000000-0000-4000-8000-000000000999.",
    "code": "404",
    "@Common.numericSeverity": 4
  }
}
```

### Somebody who has paid for something cannot be deleted

```bash
curl -s -X DELETE "$LEDGER/People(a0000000-0000-4000-8000-000000000001)"
```

```json
{
  "error": {
    "message": "Partner A (9 postings) cannot be removed while those postings are in the ledger — move them to somebody else first.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

The message counts the postings, per person, so a filtered delete says which of
the people it would have taken are the problem. Somebody who has never paid for
anything is deleted normally — and their event memberships go with them, because a
membership is a fact about a pairing rather than a record of anything that
happened:

```bash
curl -s -X DELETE "$LEDGER/People(c0000000-0000-4000-8000-000000000003)"
```

```
HTTP 204
```

### Deleting an event detaches its expenses; it never deletes them

```bash
curl -s -X DELETE "$LEDGER/Events(f0000000-0000-4000-8000-000000000001)"
```

```
HTTP 204
```

```bash
curl -s "$LEDGER/Expenses?\$filter=documentNumber%20eq%208&\$select=documentNumber,merchantRaw,amount,event_ID"
```

```json
{
  "@odata.context": "$metadata#Expenses",
  "value": [
    {
      "documentNumber": 8,
      "merchantRaw": "SWISS INTERNATIONAL AIR LINES",
      "amount": "612.00",
      "event_ID": null,
      "ID": "e0000000-0000-4000-8000-000000000008"
    }
  ]
}
```

The trip was cancelled, or entered twice, or turned out to be two trips — none of
which is a reason to lose what was spent. Those postings become everyday spending
again and go on counting toward their period exactly as before: April 2026 still
totals CHF 1018.40 afterwards. The participants _are_ deleted with the event; they
are a composition, and a guest list without an event is not a fact about anybody.

### A draft cannot be closed

Setting `settlement_ID` on a row that is not `confirmed`:

```json
{
  "error": {
    "message": "a draft cannot be closed — confirm the expense before adding it to a clearing document.",
    "code": "400",
    "@Common.numericSeverity": 4
  }
}
```

### Enum values are NOT enforced on write

`status`, `source`, `moment`, `kind` and `extractionStatus` are declared as CDS
enums over `String(20)` in `db/schema.cds`. The CAP runtime does **not**
range-check them, so an unknown symbol is stored verbatim:

```bash
curl -s -X POST "$LEDGER/Expenses" -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"COOP","amount":"12.50","date":"2026-03-14","category_code":"Groceries","moment":"honeymoon"}'
```

```
HTTP 201
```

```json
{
  "ID": "0a5a58c0-94dc-4d31-a041-5276a5c28090",
  "merchantNorm": "coop",
  "category_code": "Groceries",
  "moment": "honeymoon",
  "status": "draft"
}
```

_(abridged.)_ The permitted strings are in `CONTRACTS.md` §1.2 and §1.3, and it is
the **client's** job to send one of them. Nothing downstream throws over it any
more — the totals only ever add up amounts, and the charts group by whatever
string they find — so the cost is quieter and slower: a `moment` nobody recognises
is a row that never appears under any filter, and a `category_code` that is not in
`Categories` is a bar on a chart with no colour and no name. Validate on the way
in; the arithmetic will not catch it for you.

### Not found

```bash
curl -s "$LEDGER/Expenses(00000000-0000-4000-8000-000000000999)"
```

```
HTTP 404
```

```json
{
  "error": { "message": "Not Found", "code": "404", "@Common.numericSeverity": 4 }
}
```

---

## 5. Authentication

### Development — CAP's mocked auth

`package.json` configures `cds.requires.auth.kind = "mocked"`. The service
carries no `@requires` or `@restrict` annotations, so in dev **every request is
allowed**, with or without credentials. What the credentials change is _who CAP
thinks you are_, which is what lands in `createdBy` / `modifiedBy`:

```bash
# no header at all -> user "anonymous"
curl -s "$LEDGER/Expenses?\$top=1"

# HTTP basic with a mocked user -> user "alice"
curl -s -u alice: "$LEDGER/Memories" -X POST -H 'Content-Type: application/json' \
  -d '{"title":"x","occurredOn":"2026-01-01","kind":"other"}' | grep createdBy
```

```json
{ "createdBy": "alice" }
```

The password is ignored in mocked mode; `-u alice:` with an empty password is
enough. CAP's default mock users (`alice`, `bob`, `carol`, …) are described in
the CAP docs; you can add your own under `cds.requires.auth.users`.

**Do not read anything into a 200 in dev.** Because nothing is restricted, an
unknown user also gets a 200 — mocked auth is an identity source, not a gate.

### Production — HTTP basic, one login per person

With `NODE_ENV=production` the app switches to real HTTP basic auth against bcrypt
hashes in the environment. Each login is a **slot**: a pair of variables sharing a
suffix. `A` and `B` are the two the seed and every deployment doc use, and a third
person is a third pair, with no code change anywhere:

```
AUTH_USER_A=partner-a@example.com
AUTH_HASH_A='$2b$12$...'
AUTH_USER_B=partner-b@example.com
AUTH_HASH_B='$2b$12$...'
AUTH_USER_C=guest@example.com          # optional, and so is D, E, …
AUTH_HASH_C='$2b$12$...'
```

The server refuses to start if a slot is half-configured, if a hash is not a
bcrypt hash, if two slots share one login, or if no slot is configured at all —
CAP's mocked auth strategy accepts any username with any password, so a missing
variable must never be able to fall back to it.

Generate a hash with `npx tsx scripts/hash-password.ts 'the password you chose'`
(not `npm run hash` — that alias is wired as `cds-tsx run scripts/hash-password.ts`,
and `cds run` reads the path as a project folder, so it fails). Three details
bite people:

- **Single-quote the hash.** bcrypt hashes contain `$`, and some dotenv parsers
  will try to expand `$2b` as a shell variable.
- **The username should match a `People` row by `email`.** Nothing rejects a login
  that matches nobody — the app works either way — but the server logs a warning
  at startup, and whoever signs in with it is not somebody the ledger can offer to
  attribute a posting to.
- **The password is on the command line**, so it lands in `ps` and in your shell
  history. The script says so itself; prefix the command with a space, or clear
  the history entry afterwards.

```bash
curl -s -u 'partner-a@example.com:the-password' \
  "https://twm.example.com/api/ledger/periodTotals(period='2026-04')"
```

A missing or wrong credential gets a `401` with a `WWW-Authenticate` header,
which is what makes the browser show its own login box — the PWA relies on that
rather than shipping a login screen:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="Two-Way Match", charset="UTF-8"
```

```json
{ "error": { "code": "unauthenticated", "message": "this ledger is private" } }
```

Note that this error body is **not** the OData envelope from §1: the check runs
in `srv/server.ts` at express bootstrap, before CAP's routers, so it guards the
SPA and the static assets too, not only `/api/ledger`.

A successful login produces a `cds.User` with the role `admin` — the only role
anything in this app checks (`srv/admin-service.cds`) — and an attribute `slot`
naming the credential slot it came from. `slot` is what the request log prints, so
two sessions can be told apart without an email address in the log; it identifies
a configuration entry, never a person.

### Not covered here

`AdminService` at **`/admin`** (`srv/admin-service.cds`) is a separate service
carrying `@requires: 'admin'` — `modelInfo`, `reloadModel`, `retrain`. It exposes
no entities and is out of scope for this document.

---

## 6. Quick reference

| Method                | Path                                                       | Purpose                                     |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| GET                   | `/api/ledger/`                                             | service document                            |
| GET                   | `/api/ledger/$metadata`                                    | EDMX, the authoritative signatures          |
| GET/POST/PATCH/DELETE | `/api/ledger/Expenses`                                     | postings; CREATE classifies, §4 validates   |
| GET/POST/PATCH/DELETE | `/api/ledger/People`                                       | the roster; DELETE refused if they paid     |
| GET/POST/PATCH/DELETE | `/api/ledger/Events`                                       | trips and dinners; DELETE detaches expenses |
| POST/DELETE           | `/api/ledger/EventParticipants`                            | one person on one event                     |
| GET                   | `/api/ledger/Categories`                                   | the ten codes plus display metadata         |
| GET                   | `/api/ledger/Receipts`, `/api/ledger/Receipts(<id>)/image` | scans and their JPEG stream                 |
| GET/POST/PATCH/DELETE | `/api/ledger/Memories`, `/api/ledger/Photos`               | the timeline                                |
| GET                   | `/api/ledger/Settlements`                                  | closed periods                              |
| GET                   | `/api/ledger/Statements`, `/api/ledger/Corrections`        | yearly statement, training log              |
| POST                  | `/api/ledger/confirmExpense`                               | post a draft, log corrections               |
| GET                   | `/api/ledger/periodTotals(period=…)`                       | what a month came to, and who paid          |
| GET                   | `/api/ledger/eventTotals(eventId=…)`                       | what an event came to, and who paid         |
| POST                  | `/api/ledger/runSettlement`                                | the payment run: close a period             |
| POST                  | `/api/ledger/markSettled`                                  | mark a closed period done                   |
| GET                   | `/api/ledger/monthlyTotals(fromPeriod=…,toPeriod=…)`       | chart data                                  |
| GET                   | `/api/ledger/duplicates(ID=…)`                             | same purchase twice                         |
| POST                  | `/api/ledger/classify`                                     | re-run both heads                           |
| POST                  | `/api/ledger/scanReceipt`                                  | photo → draft expense                       |
| POST                  | `/api/ledger/generateStatement`                            | write the Statement of Us                   |
