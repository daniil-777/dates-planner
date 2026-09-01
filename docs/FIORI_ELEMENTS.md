# The Fiori elements back office — why a second UI is worth it

`/app` is the app you actually use: React 19 + UI5 Web Components, mobile-first,
installable as a PWA called _2WM_, built around a camera button.

`/app-fe` is a second UI over the **same** `LedgerService`: a Fiori elements
**List Report + Object Page**, generated entirely from CDS annotations, with no
application JavaScript at all. It is read/edit only — no scanning, no memories,
no statement. It is served under `/backoffice` behind the same authentication.

This document is about why that second UI is worth the two hundred lines of CDS
it costs.

---

## 1. The claim

**The React app proves the product works. The Fiori elements app proves the
backend is right.**

A Fiori elements template is not a UI you write — it is a UI that a runtime
_derives_ from your service's `$metadata`. If the OData V4 service is
well-formed and properly annotated, a complete, personalisable, accessible
enterprise UI appears. If it is not, the template renders a table of raw
technical field names, no filter bar, no value helps, and an Object Page with one
unlabelled section. There is no middle ground and nothing to fake.

That makes it an unusually honest test. Everything the template needs is
something a good service should have declared anyway:

| The template needs             | Which forces you to declare                                     |
| ------------------------------ | --------------------------------------------------------------- |
| column headers                 | `@title` / `@Common.Label` on every field                       |
| a filter bar                   | which fields are actually selective (`UI.SelectionFields`)      |
| dropdowns instead of free text | value helps on `category`, `paidBy`, `moment`                   |
| readable foreign keys          | `Common.Text` + `TextArrangement` so `Cafes` shows as "Cafés"   |
| a coloured status              | `Criticality` — a _semantic_ status, not a CSS class            |
| a sensible detail page         | `UI.Facets`: which fields belong together and in what order     |
| correct create/edit            | `@Capabilities.*Restrictions`, draft handling, mandatory fields |

Every one of those is a modelling decision that the hand-written React UI can
get away with hard-coding. Annotating the service moves the decision into the
model where both UIs read it, and the second UI is what catches you when you
forget.

---

## 2. What a customer-facing SAP person recognises instantly

Hand a Fiori elements List Report to someone who has spent five years in S/4HANA
or Ariba or Concur and they will not read the code. They will do this, in about
fifteen seconds, and every one of these is free:

- **The filter bar with variant management.** The `Standard` variant dropdown at
  the top left, _Adapt Filters_ for the fields that are not shown, filters that
  persist. This is the single most recognisable object in the SAP UI canon.
- **The table title with a live count** — _Expenses (247)_ — updating as filters
  change, because the template issues `$count`.
- **Table personalisation**: the gear icon, column show/hide/reorder, sort and
  group menus, all stored per user.
- **Export to Spreadsheet.** Nobody wrote it. It is in the template, and it is
  the first button an SAP person looks for.
- **The Object Page**: the anchor bar down the side, header facets carrying a
  `DataPoint` KPI, sections that scroll and jump, a footer bar with
  _Edit / Save / Cancel_.
- **Draft handling** — if `@odata.draft.enabled` is on, the _Draft_ indicator,
  the "you have unsaved changes" dialog, and resuming an edit on another device.
  This is the piece that is genuinely hard to build by hand and is one annotation.
- **The message popover** in the shell, showing OData error messages with
  severity and a link to the offending field, because CAP returns proper
  `sap-messages` and the template knows what to do with them.
- **Semantic colouring** (once `Criticality` is annotated, see §3): `status`
  rendered as an `ObjectStatus` in the right colour because the model said 1/2/3,
  not because someone picked a hex code.
- **`sap_horizon`**, pixel-identical to the theme of whatever they had open in
  the other tab.

And then the punchline: **it is the same service.** No second backend, no BFF,
no mapping layer. `/ledger/Expenses` serves both UIs, `@requires: 'Partner'`
protects both, and one of them was written and the other was declared.

---

## 3. The annotations that do it

They already exist, in **`db/annotations.cds`** — deliberately not in
`db/schema.cds`, because the schema is the contract and this file is taste. They
annotate the _domain_ entities (`twm.Expenses`, `twm.Categories`, …), so every
projection that `LedgerService` exposes inherits them without a second copy.

Abridged, in the file's own style:

```cds
using { twowaymatch as twm } from './schema';

annotate twm.Expenses with @(
  title             : 'Expense',
  Common.Label      : 'Expense',

  UI.HeaderInfo     : {
    $Type          : 'UI.HeaderInfoType',
    TypeName       : 'Expense',
    TypeNamePlural : 'Expenses',
    Title          : { $Type: 'UI.DataField', Value: merchantRaw },
    Description    : { $Type: 'UI.DataField', Value: documentNumber },
    ImageUrl       : receipt.image,      // the receipt photo, as the object's avatar
  },

  UI.SelectionFields: [ date, category_code, moment, paidBy_ID, status ],

  UI.LineItem       : [
    { $Type: 'UI.DataField', Value: documentNumber, ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: date,           ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: merchantRaw,    ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: category_code,  ![@UI.Importance]: #High },
    // … amount, moment, paidBy, status
  ],

  UI.Facets         : [
    { $Type: 'UI.ReferenceFacet', ID: 'PostingFacet',
      Label: 'Posting',        Target: '@UI.FieldGroup#Posting' },
    { $Type: 'UI.ReferenceFacet', ID: 'ClassificationFacet',
      Label: 'Two-Way Match',  Target: '@UI.FieldGroup#Classification' },
    { $Type: 'UI.ReferenceFacet', ID: 'SharingFacet',
      Label: 'Sharing',        Target: '@UI.FieldGroup#Sharing' },
    { $Type: 'UI.ReferenceFacet', ID: 'ContextFacet',
      Label: 'Context',        Target: '@UI.FieldGroup#Context' },
  ],
);
```

`![@UI.Importance]: #High` is what tells the responsive table which columns to
keep when the window narrows — the template does the reflow, you only say what
matters.

The value helps are written out in full rather than with the
`@cds.odata.valuelist` shortcut, because the extra lines buy two things the
shortcut does not:

```cds
category @(
  Common: {
    Text                    : category.name,
    TextArrangement         : #TextOnly,        // show "Cafés", not "Cafes"
    ValueListWithFixedValues: true,             // a dropdown, not a dialog
    ValueList               : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'Categories',
      Parameters    : [
        { $Type: 'Common.ValueListParameterInOut',
          LocalDataProperty: category_code, ValueListProperty: 'code' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'icon' },
      ],
    },
  }
);
```

`TextArrangement: #TextOnly` is where the ASCII/display split from
`docs/CONTRACTS.md` §1.1 finally pays off: the key stays `Cafes`, the user reads
_Cafés_, and neither UI hard-codes the mapping. `ValueListWithFixedValues: true`
is the difference between a dropdown of ten categories and a full value-help
dialog with its own filter bar — correct for ten rows, wrong for ten thousand.

**The one annotation still worth adding** is `Criticality` on `status`, so the
List Report renders it as a coloured `ObjectStatus` (draft → 2, warning;
confirmed → 3, positive) instead of plain text. Criticality is a _semantic_
value, so it belongs on a calculated element in the model, not in a UI: put it
there and the React status chips and the Fiori `ObjectStatus` agree by
construction rather than by coincidence.

## 4. Generating and serving it

The fastest honest route is the SAP Fiori tools generator, which reads your
running CAP project's metadata:

1. In VS Code with **SAP Fiori tools** installed: Command Palette →
   **Fiori: Open Application Generator**.
2. Template: **List Report Object Page**.
3. Data source: **Use a Local CAP Project** → this project → service
   `LedgerService`.
4. Main entity: `Expenses`. Navigation entity: none (or `Receipts`).
5. Module name `backoffice`, target folder `app-fe`.

It writes a `manifest.json`, an empty `Component.js`, and nothing else of
substance — the `manifest.json` is the app:

```jsonc
{
  "sap.app": {
    "id": "backoffice",
    "dataSources": {
      "mainService": { "uri": "/ledger/", "type": "OData", "settings": { "odataVersion": "4.0" } },
    },
  },
  "sap.ui5": {
    "dependencies": { "libs": { "sap.fe.templates": {} } },
    "routing": {
      "routes": [
        { "name": "ExpensesList", "pattern": ":?query:", "target": "ExpensesList" },
        {
          "name": "ExpensesDetail",
          "pattern": "Expenses({key}):?query:",
          "target": "ExpensesDetail",
        },
      ],
      "targets": {
        "ExpensesList": {
          "type": "Component",
          "name": "sap.fe.templates.ListReport",
          "options": { "settings": { "entitySet": "Expenses" } },
        },
        "ExpensesDetail": {
          "type": "Component",
          "name": "sap.fe.templates.ObjectPage",
          "options": { "settings": { "entitySet": "Expenses" } },
        },
      },
    },
  },
}
```

That is the entire application. There is no controller, no view, no XML.

**Serving.** CAP serves static content from the CDS `app` folder, and the React
build already owns `/`. Mount the Fiori app on its own path — `/backoffice` — as
a static route in `srv/server.ts`, behind the same auth middleware as everything
else.

Worth being explicit about, because it is where people get security backwards:
**the UI is not the security boundary.** Hiding `/backoffice` protects nothing.
`@requires: 'Partner'` on `LedgerService` is what protects the data, and it
applies identically whether the request came from React, from Fiori elements, or
from curl. The static mount is behind auth for tidiness, not for safety.

---

## 5. What it deliberately does not do

- **No scanning.** Camera capture, client-side downscaling and the
  extract → classify → confirm choreography are the product. A template cannot
  express them and should not try.
- **No memories, no statement.** Those are the parts with feelings in them.
- **Not the mobile UI.** SAPUI5 bootstraps a large framework before the first
  paint; the React PWA is a fraction of that and works offline. On a phone, in a
  restaurant, the PWA wins by an order of magnitude, and that is the whole reason
  it exists.
- **No second copy of the business logic.** `confirmExpense`, `runSettlement`,
  `periodTotals` stay in the service. If the back office needs an action, annotate
  the existing one with `@Common.SideEffects` and let the template call it.

The division is clean: the React app is for _using_ the ledger, the Fiori
elements app is for _inspecting and correcting_ it — fixing a mis-typed merchant,
finding every `draft` from March, exporting a year to a spreadsheet because
someone asked.

---

## 6. Honest caveats

- **`@odata.draft.enabled` changes the service.** It splits every entity into
  active and draft instances and adds `IsActiveEntity` to every key. That is what
  makes the Object Page's edit flow work, and it is visible to the React client
  too. Decide once, early. The lighter alternative is a non-draft editable Object
  Page (`@Capabilities.UpdateRestrictions.Updatable: true`, no draft), which
  loses the resume-elsewhere behaviour and keeps the keys simple.
- **`Receipts.image` is a `LargeBinary`.** Never put it in a `UI.LineItem`; the
  list would fetch every image. Reference it via `@Core.MediaType` on the Object
  Page only, where the template renders a proper media link.
- **`UI.HeaderInfo.ImageUrl: receipt.image` is the one annotation to check first
  when you generate the app.** `ImageUrl` is declared as an `Edm.String` — a URL
  — and `receipt.image` is a stream property; it renders because CAP serialises a
  `@Core.MediaType` property as a read link, not because the template understands
  binaries. Two consequences: confirm on the first run that the avatar actually
  appears (if it does not, point `ImageUrl` at a plain `String` holding the media
  path instead), and remember that the header avatar is fetched per visible row in
  floorplans that show it, which is the same "fetch every image" cost the previous
  bullet warns about, arriving through a different door.
- **The template issues the queries, not you.** A missing index behind a
  `SelectionField` shows up as a slow filter bar. With a household's worth of rows
  this is theoretical; it is worth knowing that it stops being theoretical at a
  scale this app will never reach.
- **Version skew is real.** `sap.fe.templates` follows the SAPUI5 version in the
  bootstrap. Pin it; do not point at "latest" and be surprised in six months.
- **Annotations are a public API.** Renaming a `FieldGroup` qualifier or a
  `ReferenceFacet` ID breaks any personalisation variant that referenced it.

---

## 7. The reveal

Show the React PWA first: the camera, the receipt turning into a draft
expense with a category already chosen, _"Posted as document #248"_.

Then open `/backoffice` on the laptop. Same data, filter bar, _Adapt Filters_,
_Export to Spreadsheet_, an Object Page with header facets, in Horizon.

The point lands without a word: this is not a toy with an SAP-coloured skin. It
is a properly modelled OData V4 service with a domain model, annotations,
semantics and value helps — and the enterprise UI is what falls out of doing
that correctly.
