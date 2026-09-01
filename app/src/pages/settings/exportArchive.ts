/**
 * "Export everything" — the whole ledger, in one file, in formats that outlive this app.
 *
 * The archive holds the entities as JSON exactly as the API returned them, the expenses
 * again as a spreadsheet, and every yearly statement as its own Markdown file. That is the
 * point of an export: it has to be readable by something that is not Two-Way Match, on a
 * day when Two-Way Match is not running.
 *
 * What it does **not** hold is the receipt and photo images — they are media streams behind
 * their own URLs and would turn a 200 KB download into a 200 MB one. `scripts/backup.ts`
 * on the server takes the archive that includes them; the README in the zip says so rather
 * than letting anyone find out later.
 */

import { api } from '@/api/client'
import type { Category, Event, Expense, Memory, Person, Settlement, Statement } from '@/api/types'
import { createZip, type ZipEntry } from './zip'

export const ARCHIVE_FORMAT_VERSION = 1

export interface ArchiveData {
  people: Person[]
  events: Event[]
  categories: Category[]
  expenses: Expense[]
  memories: Memory[]
  settlements: Settlement[]
  statements: Statement[]
}

/** Everything the LedgerService will hand over, fetched in parallel. */
export async function collectArchive(): Promise<ArchiveData> {
  const [people, events, categories, expenses, memories, settlements, statements] =
    await Promise.all([
      api.listPeople(),
      api.listEvents(),
      api.listCategories(),
      api.listExpenses(),
      api.listMemories(),
      api.listSettlements(),
      api.listStatements(),
    ])

  return { people, events, categories, expenses, memories, settlements, statements }
}

/** The files that go into the zip, in the order they appear in the archive. */
export function buildEntries(data: ArchiveData, exportedAt: Date = new Date()): ZipEntry[] {
  const stamp = exportedAt.toISOString()
  const manifest = {
    app: 'Two-Way Match',
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: stamp,
    source: '/ledger (OData V4, LedgerService)',
    counts: {
      people: data.people.length,
      events: data.events.length,
      categories: data.categories.length,
      expenses: data.expenses.length,
      memories: data.memories.length,
      settlements: data.settlements.length,
      statements: data.statements.length,
    },
    includesImages: false,
  }

  const entries: ZipEntry[] = [
    { name: 'README.txt', content: readme(data, stamp) },
    { name: 'manifest.json', content: json(manifest) },
    { name: 'data/people.json', content: json(data.people) },
    { name: 'data/events.json', content: json(data.events) },
    { name: 'data/categories.json', content: json(data.categories) },
    { name: 'data/expenses.json', content: json(data.expenses) },
    { name: 'data/memories.json', content: json(data.memories) },
    { name: 'data/settlements.json', content: json(data.settlements) },
    { name: 'data/statements.json', content: json(data.statements) },
    { name: 'data/expenses.csv', content: expensesCsv(data) },
    { name: 'data/memories.csv', content: memoriesCsv(data.memories) },
  ]

  for (const statement of [...data.statements].sort((a, b) => a.year - b.year)) {
    entries.push({
      name: `statements/FY${statement.year}.md`,
      content: statement.contentMarkdown,
    })
  }

  return entries
}

/** Collect, zip, and hand the browser a file to save. Returns what was written. */
export async function exportEverything(
  now: Date = new Date(),
): Promise<{ fileName: string; entries: number; bytes: number }> {
  const data = await collectArchive()
  const entries = buildEntries(data, now)
  const blob = createZip(entries, now)
  const fileName = `two-way-match-${isoDate(now)}.zip`
  downloadBlob(blob, fileName)
  return { fileName, entries: entries.length, bytes: blob.size }
}

/** The one browser-side side effect in this module, kept where it can be seen. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoked late: Safari has been known to cancel a download whose URL disappeared first.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/* ------------------------------------------------------------------ *
 *  Serialisation
 * ------------------------------------------------------------------ */

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

const EXPENSE_COLUMNS = [
  'ID',
  'documentNumber',
  'date',
  'time',
  'merchantRaw',
  'merchantNorm',
  'amount',
  'currency',
  'category',
  'categoryConfidence',
  'moment',
  'momentConfidence',
  'paidBy',
  'event',
  'status',
  'source',
  'place',
  'note',
  'settlement',
] as const

function expensesCsv(data: ArchiveData): string {
  const personName = new Map(data.people.map(person => [person.ID, person.name]))
  const eventName = new Map(data.events.map(event => [event.ID, event.name]))
  const clearing = new Map(data.settlements.map(row => [row.ID, row.clearingDocument]))

  const lines = [EXPENSE_COLUMNS.join(';')]
  for (const expense of data.expenses) {
    lines.push(
      [
        expense.ID,
        expense.documentNumber ?? '',
        expense.date,
        expense.time ?? '',
        expense.merchantRaw,
        expense.merchantNorm ?? '',
        // Machine-readable on purpose: a dot decimal and no grouping, so a spreadsheet
        // reads it as a number. Screen formatting is `MoneyText`'s job, not a file's.
        expense.amount.toFixed(2),
        expense.currency,
        expense.category_code ?? '',
        expense.categoryConfidence ?? '',
        expense.moment ?? '',
        expense.momentConfidence ?? '',
        expense.paidBy_ID === null ? '' : (personName.get(expense.paidBy_ID) ?? expense.paidBy_ID),
        expense.event_ID === null ? '' : (eventName.get(expense.event_ID) ?? expense.event_ID),
        expense.status,
        expense.source,
        expense.place ?? '',
        expense.note ?? '',
        expense.settlement_ID === null ? '' : (clearing.get(expense.settlement_ID) ?? ''),
      ]
        .map(csvCell)
        .join(';'),
    )
  }
  return `${lines.join('\n')}\n`
}

function memoriesCsv(memories: Memory[]): string {
  const lines = ['occurredOn;kind;title;place;pinned;note']
  for (const memory of memories) {
    lines.push(
      [
        memory.occurredOn,
        memory.kind,
        memory.title,
        memory.place ?? '',
        memory.pinned ? 'yes' : 'no',
        memory.note ?? '',
      ]
        .map(csvCell)
        .join(';'),
    )
  }
  return `${lines.join('\n')}\n`
}

/** RFC 4180 quoting, with the semicolon this file uses as its delimiter. */
function csvCell(value: string | number): string {
  const text = String(value)
  if (!/[;"\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function isoDate(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${when.getFullYear()}-${month}-${day}`
}

function readme(data: ArchiveData, stamp: string): string {
  return [
    'Two-Way Match — full export',
    `Taken ${stamp}`,
    '',
    'What is in here',
    '---------------',
    '  manifest.json        what this archive is, and how many of each thing it holds',
    '  data/*.json          the entities exactly as /ledger returned them',
    '  data/expenses.csv    every posting as a semicolon-delimited spreadsheet',
    '  data/memories.csv    the timeline, same format',
    '  statements/*.md      each yearly Statement of Us, as Markdown',
    '',
    'Counts',
    '------',
    `  expenses     ${data.expenses.length}`,
    `  memories     ${data.memories.length}`,
    `  settlements  ${data.settlements.length}`,
    `  statements   ${data.statements.length}`,
    `  people       ${data.people.length}`,
    `  events       ${data.events.length}`,
    '',
    'What is NOT in here',
    '-------------------',
    'Receipt scans and memory photos. They are media streams served from',
    '/ledger/Receipts(<id>)/image and /ledger/Photos(<id>)/image, and including them would',
    'turn this download into hundreds of megabytes. The server-side backup',
    '(scripts/backup.ts) writes a tarball that does contain them.',
    '',
    'Amounts are plain decimal numbers with a dot, so a spreadsheet reads them as numbers.',
    'The app shows them Swiss-style (CHF 1’234.50); that is presentation, not data.',
    '',
  ].join('\n')
}
