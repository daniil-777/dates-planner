/// <reference types="@cap-js/cds-types" />
/**
 * Export the live ledger as classifier training data.
 *
 * `npm run ml:export-data` — and therefore `npm run ml:retrain` — starts here. It turns
 * the rows the household actually confirmed into `ml/data/live_transactions.csv`, with
 * exactly the columns `ml/train.py` validates, in exactly that order:
 *
 *     date,time,merchant_raw,amount_chf,payer,category,moment
 *
 * Two rules make this worth reading twice.
 *
 * 1. **A correction beats the stored label.** `Expenses.category` / `.moment` hold
 *    whatever survived the last edit, but `Corrections` is the log of every time a human
 *    overruled the model, and that log is the entire point of the continuous-learning
 *    loop. Training on the model's own output would only teach it its own mistakes, so
 *    the newest correction per (expense, field) replaces the stored label here.
 * 2. **Nothing personal leaves the database.** No ids, no notes, no images, no places,
 *    no `createdBy`. Those seven columns are the whole contract; anything else would be
 *    a privacy leak dressed up as a feature.
 *
 * Only `status = 'confirmed'` rows are exported: a draft is a guess nobody has agreed
 * with yet, and feeding guesses back in is how a classifier learns to be confidently
 * wrong.
 */
import cds from '@sap/cds'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
// Relative rather than '#cds-models/twowaymatch': package.json carries no "imports"
// mapping for that subpath, so the alias resolves at neither compile nor run time.
import { Corrections, Expenses, People } from '../@cds-models/twowaymatch'

/** The header `ml/train.py` checks against. The order is part of the contract. */
const HEADER = 'date,time,merchant_raw,amount_chf,payer,category,moment'

const OUTPUT_PATH = join(cds.root, 'ml', 'data', 'live_transactions.csv')

/** A receipt with no printed time means midday — the same fill-in `ml/train.py` does. */
const DEFAULT_TIME = '12:00'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^(\d{2}):(\d{2})/

/**
 * Shapes of the three reads. They are declared rather than inferred because the query
 * builder types resolve to the full entity, and being explicit here is what documents
 * that this script reads seven columns and not the whole ledger.
 */
interface ExpenseRow {
  ID: string
  date: string | null
  time: string | null
  merchantRaw: string | null
  /** `Decimal(10,2)`: the SQLite driver hands it back as a formatted string. */
  amount: string | number | null
  category_code: string | null
  moment: string | null
  paidBy_ID: string | null
}

interface CorrectionRow {
  expense_ID: string | null
  field: string | null
  corrected: string | null
}

interface PersonRow {
  ID: string
}

/** One finished CSV line, still as fields, so the writer stays the only place that quotes. */
type ExportRow = readonly [
  date: string,
  time: string,
  merchantRaw: string,
  amountChf: string,
  payer: string,
  category: string,
  moment: string,
]

async function main(): Promise<void> {
  await connect()

  const [expenses, corrections, people] = await Promise.all([
    SELECT.from(Expenses)
      .columns(
        'ID',
        'date',
        'time',
        'merchantRaw',
        'amount',
        'category_code',
        'moment',
        'paidBy_ID',
      )
      .where({ status: 'confirmed' })
      .orderBy('date', 'time') as unknown as Promise<ExpenseRow[]>,
    // Ascending, so a later correction simply overwrites an earlier one in the map below.
    SELECT.from(Corrections)
      .columns('expense_ID', 'field', 'corrected')
      .orderBy('createdAt') as unknown as Promise<CorrectionRow[]>,
    SELECT.from(People).columns('ID') as unknown as Promise<PersonRow[]>,
  ])

  const corrected = indexCorrections(corrections)
  const payers = pseudonymise(people)

  const rows: ExportRow[] = []
  let skipped = 0
  let relabelled = 0

  for (const expense of expenses) {
    const category = corrected.get(key(expense.ID, 'category')) ?? expense.category_code
    const moment = corrected.get(key(expense.ID, 'moment')) ?? expense.moment
    const date = expense.date
    const merchantRaw = (expense.merchantRaw ?? '').trim()
    const amount = toAmount(expense.amount)

    // The same five fields `ml/train.py` drops rows on. Anything it would throw away we
    // throw away here, so "exported N rows" and "trained on N rows" mean the same number.
    if (
      date === null ||
      !DATE_PATTERN.test(date) ||
      merchantRaw.length === 0 ||
      amount === null ||
      !isLabel(category) ||
      !isLabel(moment)
    ) {
      skipped += 1
      continue
    }

    if (category !== expense.category_code || moment !== expense.moment) relabelled += 1

    rows.push([
      date,
      toTime(expense.time),
      merchantRaw,
      amount,
      payers.get(expense.paidBy_ID ?? '') ?? '',
      category,
      moment,
    ])
  }

  write(rows)

  console.log(`wrote ${rows.length} rows to ${relative(cds.root, OUTPUT_PATH)}`)
  console.log(`  ${relabelled} row(s) relabelled from Corrections`)
  if (skipped > 0) {
    console.log(
      `  ${skipped} confirmed row(s) skipped for a missing date, merchant, amount or label`,
    )
  }
  if (rows.length === 0) {
    console.log('  nothing to train on yet — keep confirming expenses and run this again')
  }
}

/**
 * Query against `db` alone — the services are not this script's business.
 *
 * `cds.load('db')` gives exactly the three entities read below, so a half-finished handler
 * under `srv/` cannot break the retraining pipeline.
 */
async function connect(): Promise<cds.DatabaseService> {
  cds.model = cds.compile.for.nodejs(await cds.load('db'))
  const db = await cds.connect.to('db')

  try {
    await SELECT.one.from(Expenses).columns('ID')
  } catch {
    // A missing table means nobody has run `cds deploy` against this file yet — normal on
    // a fresh clone. Deploying is safe *only* here, in the branch where the read failed:
    // it drops and recreates tables, so it must never run against a populated database.
    console.log('no ledger tables found — deploying the model and db/data/*.csv first')
    await deployTo(db)
  }

  return db
}

/**
 * `cds.deploy(model).to(db)`, which `@cap-js/cds-types` does not describe.
 * Narrowed to the two calls used rather than reached for with `any`.
 */
async function deployTo(db: cds.DatabaseService): Promise<void> {
  const facade = cds as unknown as {
    deploy(model: unknown): { to(target: unknown): Promise<unknown> }
  }
  // '*', not 'db': a database belongs to the whole application, and a `db`-only deploy
  // creates the tables but none of the `LedgerService_*` views the OData adapter reads —
  // leaving a file that looks fine here and answers every ledger request with
  // "no such table: LedgerService_Expenses". A path rather than `cds.model`, because the
  // linked model has already been through `compile.for.nodejs` and running the SQL backend
  // over its generated foreign keys fails with "category_code conflicts with existing
  // element".
  await facade.deploy('*').to(db)
}

/**
 * `People.ID` → a stable pseudonym (`person-1`, `person-2`, …).
 *
 * The `payer` column is part of the header `ml/train.py` validates, but no head is
 * trained on it — who paid says nothing about what was bought. Exporting the roster's
 * real names would put the household on disk for no modelling benefit at all, so the
 * column carries a position in the roster instead. Ordered by id, which never changes,
 * so re-exporting the same ledger produces the same file.
 */
function pseudonymise(people: PersonRow[]): Map<string, string> {
  const ordered = [...people].sort((left, right) => (left.ID < right.ID ? -1 : 1))
  return new Map(ordered.map((person, index) => [person.ID, `person-${index + 1}`] as const))
}

/** `expenseId + field` → the newest corrected label for that pair. */
function indexCorrections(corrections: CorrectionRow[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const correction of corrections) {
    const label = (correction.corrected ?? '').trim()
    if (correction.expense_ID === null || correction.field === null || label.length === 0) continue
    if (correction.field !== 'category' && correction.field !== 'moment') continue
    index.set(key(correction.expense_ID, correction.field), label)
  }
  return index
}

const key = (expenseId: string, field: 'category' | 'moment'): string => `${expenseId} ${field}`

const isLabel = (value: string | null): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** `Decimal(10,2)` arrives as a string; the CSV wants a plain, two-decimal number. */
function toAmount(value: string | number | null): string | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null
}

/** SQLite returns `HH:MM:SS`; the training CSV has always been `HH:MM`. */
function toTime(value: string | null): string {
  const match = value === null ? null : TIME_PATTERN.exec(value.trim())
  return match === null ? DEFAULT_TIME : `${match[1]}:${match[2]}`
}

function write(rows: readonly ExportRow[]): void {
  const lines = [HEADER, ...rows.map(row => row.map(cell).join(','))]
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  // A trailing newline: pandas does not care, `tail -1` and `wc -l` very much do.
  writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8')
}

/** Minimal RFC 4180 quoting — merchant names contain commas and the odd inch mark. */
function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
