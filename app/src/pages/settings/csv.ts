/**
 * Bank CSV import: the parsing half.
 *
 * Swiss bank exports are not one format. They are semicolon-delimited or comma-delimited,
 * they quote some fields and not others, their amounts are `1'234.50` or `1.234,50` or
 * `1 234,50`, their dates are `31.12.2026` or `2026-12-31`, and debits are sometimes
 * negative and sometimes in a column of their own. None of that is guesswork the user
 * should have to do by hand, so this module guesses and then shows its work: everything
 * here is a pure function over strings, and `BankImport.tsx` renders the result as a
 * preview the human confirms before a single row is posted.
 *
 * No dependency does this for us and none is going to be added, which is fine — RFC 4180
 * is a small specification and the interesting part was never the quoting anyway.
 */

export type DateOrder = 'dmy' | 'mdy'

export interface CsvTable {
  delimiter: string
  /** Column titles; synthesised as `Column 1…` when the file has no header row. */
  header: string[]
  /** True when the first line looked like data rather than titles. */
  headerless: boolean
  rows: string[][]
}

/** Index of the CSV column feeding each expense field. `-1` means "not mapped". */
export interface ColumnMapping {
  date: number
  merchant: number
  amount: number
  payer: number
}

export const UNMAPPED = -1

const CANDIDATE_DELIMITERS = [';', ',', '\t', '|']

/**
 * Which delimiter this file uses.
 *
 * Counted outside quoted sections over the first few lines, because a description field
 * such as `"COOP, ZUERICH HB"` carries commas that are not delimiters at all.
 */
export function sniffDelimiter(text: string): string {
  const sample = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .slice(0, 5)
    .join('\n')
  let best = ','
  let bestCount = 0
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(sample, candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function countOutsideQuotes(text: string, delimiter: string): number {
  let quoted = false
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (!quoted && char === delimiter) count += 1
  }
  return count
}

/** RFC 4180 with the delimiter left open: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  const clean = text.replace(/^\uFEFF/, '')
  const delim = delimiter ?? sniffDelimiter(clean)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i]

    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i += 1
          continue
        }
        quoted = false
        continue
      }
      field += char
      continue
    }

    if (char === '"' && field.trim() === '') {
      quoted = true
      field = ''
      continue
    }
    if (char === delim) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\r') continue
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }

  row.push(field)
  rows.push(row)

  while (rows.length > 0 && rows[rows.length - 1].every(cell => cell.trim() === '')) rows.pop()
  if (rows.length === 0) return { delimiter: delim, header: [], headerless: false, rows: [] }

  const first = rows[0].map(cell => cell.trim())
  if (looksLikeData(first)) {
    return {
      delimiter: delim,
      header: first.map((_, index) => `Column ${index + 1}`),
      headerless: true,
      rows: rows.map(cells => cells.map(cell => cell.trim())),
    }
  }

  return {
    delimiter: delim,
    header: first.map((cell, index) => (cell === '' ? `Column ${index + 1}` : cell)),
    headerless: false,
    rows: rows.slice(1).map(cells => cells.map(cell => cell.trim())),
  }
}

/** A row is data, not titles, when something in it is a date and something else is money. */
function looksLikeData(cells: string[]): boolean {
  const hasDate = cells.some(cell => parseCsvDate(cell, 'dmy') !== null)
  const hasAmount = cells.some(cell => parseAmount(cell) !== null)
  return hasDate && hasAmount
}

/* ------------------------------------------------------------------ *
 *  Amounts
 * ------------------------------------------------------------------ */

const AMOUNT_SHAPE = /[0-9]/

/**
 * `"1'234.50"`, `"1.234,50"`, `"1 234,50"`, `"CHF 12.50"`, `"(12.50)"`, `"-12,50"`.
 *
 * Apostrophes and spaces are always grouping. When both `.` and `,` appear, the **last**
 * one is the decimal separator and the other is grouping. When only one appears, it is a
 * decimal separator unless exactly three digits follow it, which is grouping — money has
 * two decimals, so `1.234` is one thousand two hundred and thirty-four.
 */
export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || !AMOUNT_SHAPE.test(trimmed)) return null

  const parenthesised = /^\(.*\)$/.test(trimmed)
  // Currency codes, symbols and stray letters go first; then Swiss apostrophes and every
  // flavour of grouping space, none of which is ever a decimal separator.
  let body = trimmed
    .replace(/^\(|\)$/g, '')
    .replace(/[^\d.,'\u2019\s\u00a0\u202f\u2009+-]/g, '')
    .replace(/['\u2019]/g, '')
    .replace(/[\s\u00a0\u202f\u2009]/g, '')

  const negative = parenthesised || body.startsWith('-')
  body = body.replace(/[+-]/g, '')
  if (body === '') return null

  const lastDot = body.lastIndexOf('.')
  const lastComma = body.lastIndexOf(',')
  let normalised: string

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma)
    normalised = `${body.slice(0, decimalAt).replace(/[.,]/g, '')}.${body.slice(decimalAt + 1)}`
  } else if (lastDot >= 0 || lastComma >= 0) {
    const at = Math.max(lastDot, lastComma)
    const decimals = body.length - at - 1
    normalised =
      decimals === 3
        ? body.replace(/[.,]/g, '')
        : `${body.slice(0, at).replace(/[.,]/g, '')}.${body.slice(at + 1)}`
  } else {
    normalised = body
  }

  if (!/^\d*(\.\d+)?$/.test(normalised) || normalised === '' || normalised === '.') return null
  const value = Number.parseFloat(normalised)
  if (!Number.isFinite(value)) return null
  return negative ? -round2(value) : round2(value)
}

function round2(value: number): number {
  return Math.round(value * 100 + 1e-9) / 100
}

/* ------------------------------------------------------------------ *
 *  Dates
 * ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/
const SEPARATED_DATE = /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})(?:[T ].*)?$/

/**
 * A CSV date as `YYYY-MM-DD`, or `null` when it is not a date at all.
 *
 * `order` decides `03/04/2026`: Swiss and German exports mean 3 April, American ones mean
 * 4 March. Everything unambiguous — an ISO date, or a first component above 12 — ignores it.
 */
export function parseCsvDate(raw: string, order: DateOrder = 'dmy'): string | null {
  const value = raw.trim()
  if (value === '') return null

  const iso = ISO_DATE.exec(value)
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const parts = SEPARATED_DATE.exec(value)
  if (!parts) return null

  const first = Number(parts[1])
  const second = Number(parts[2])
  const year = expandYear(Number(parts[3]))

  // `2026.12.31` — a four-digit leading component is the year whatever the order says.
  if (parts[1].length === 4) return build(first, second, year)

  const useMdy = order === 'mdy' && first <= 12
  const day = useMdy ? second : first
  const month = useMdy ? first : second
  return build(year, month, day)
}

function expandYear(year: number): number {
  if (year >= 1000) return year
  return year < 70 ? 2000 + year : 1900 + year
}

function build(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 1900 || year > 2999) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  const check = new Date(year, month - 1, day)
  if (check.getMonth() !== month - 1 || check.getDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ *
 *  Column guessing
 * ------------------------------------------------------------------ */

const HEADER_HINTS: Record<keyof ColumnMapping, RegExp> = {
  date: /\b(date|datum|buchung|valuta|booking|transaction date|trade date)\b/i,
  merchant: /\b(merchant|description|beschreibung|buchungstext|verwendungszweck|payee|details)\b/i,
  amount: /\b(amount|betrag|belastung|debit|value|umsatz|soll)\b/i,
  payer: /\b(payer|paid by|card|karte|konto|account|owner|inhaber|name)\b/i,
}

/**
 * A first guess at which column is which, from the header titles and then from the data.
 *
 * The header is the strong signal; when it says nothing useful (or there is no header at
 * all) the first column that parses as a date and the last one that parses as money are
 * far better than nothing, and the user can override either in the mapping UI.
 */
export function guessMapping(table: CsvTable): ColumnMapping {
  const mapping: ColumnMapping = {
    date: UNMAPPED,
    merchant: UNMAPPED,
    amount: UNMAPPED,
    payer: UNMAPPED,
  }

  const taken = new Set<number>()
  for (const field of ['date', 'amount', 'merchant', 'payer'] as const) {
    const index = table.header.findIndex(
      (title, position) => !taken.has(position) && HEADER_HINTS[field].test(title),
    )
    if (index >= 0) {
      mapping[field] = index
      taken.add(index)
    }
  }

  const sample = table.rows.slice(0, 20)
  const columnCount = Math.max(table.header.length, ...sample.map(row => row.length), 0)

  if (mapping.date === UNMAPPED) {
    for (let column = 0; column < columnCount; column += 1) {
      if (taken.has(column)) continue
      if (majority(sample, column, cell => parseCsvDate(cell) !== null)) {
        mapping.date = column
        taken.add(column)
        break
      }
    }
  }

  if (mapping.amount === UNMAPPED) {
    for (let column = columnCount - 1; column >= 0; column -= 1) {
      if (taken.has(column)) continue
      if (majority(sample, column, cell => parseAmount(cell) !== null)) {
        mapping.amount = column
        taken.add(column)
        break
      }
    }
  }

  if (mapping.merchant === UNMAPPED) {
    // The widest remaining text column is the description, in every export ever written.
    let best = UNMAPPED
    let bestLength = 0
    for (let column = 0; column < columnCount; column += 1) {
      if (taken.has(column)) continue
      const length = averageLength(sample, column)
      if (length > bestLength && !majority(sample, column, cell => parseAmount(cell) !== null)) {
        best = column
        bestLength = length
      }
    }
    if (best !== UNMAPPED) {
      mapping.merchant = best
      taken.add(best)
    }
  }

  return mapping
}

function majority(rows: string[][], column: number, test: (cell: string) => boolean): boolean {
  const cells = rows.map(row => row[column] ?? '').filter(cell => cell.trim() !== '')
  if (cells.length === 0) return false
  const hits = cells.filter(test).length
  return hits / cells.length >= 0.8
}

function averageLength(rows: string[][], column: number): number {
  const cells = rows.map(row => row[column] ?? '')
  if (cells.length === 0) return 0
  return cells.reduce((sum, cell) => sum + cell.trim().length, 0) / cells.length
}

/* ------------------------------------------------------------------ *
 *  Mapping rows onto expenses
 * ------------------------------------------------------------------ */

export interface PreparedRow {
  /** Line number in the file, header included, so an error message can point at it. */
  line: number
  date: string | null
  merchant: string
  /** Signed exactly as the file had it; the sign decides debit or credit. */
  rawAmount: number | null
  /** Absolute value, which is what an expense stores. */
  amount: number | null
  payerRaw: string
  payerId: string | null
  /** Empty when the row is postable. */
  issues: string[]
  include: boolean
}

export interface PrepareOptions {
  mapping: ColumnMapping
  dateOrder: DateOrder
  /** Bank exports usually write spending as a negative number. */
  negativeIsSpending: boolean
  /** Resolves the payer cell (a name, an email) to a `People.ID`. */
  resolvePayer: (raw: string) => string | null
  /** Used when the file has no payer column, or the cell matched nobody. */
  defaultPayerId: string | null
}

/**
 * Turn parsed cells into rows ready to post, each carrying its own list of reasons not to.
 *
 * Nothing is silently dropped: a credit, an unreadable date and a missing merchant all end
 * up in the preview with an explanation, and the import posts only the rows that survive.
 */
export function prepareRows(table: CsvTable, options: PrepareOptions): PreparedRow[] {
  const { mapping } = options
  const firstDataLine = table.headerless ? 1 : 2

  return table.rows.map((cells, index) => {
    const cell = (column: number): string =>
      column === UNMAPPED ? '' : (cells[column] ?? '').trim()

    const merchant = cell(mapping.merchant)
    const rawAmount = parseAmount(cell(mapping.amount))
    const date = parseCsvDate(cell(mapping.date), options.dateOrder)
    const payerRaw = cell(mapping.payer)
    const matched = payerRaw === '' ? null : options.resolvePayer(payerRaw)
    const payerId = matched ?? options.defaultPayerId

    const issues: string[] = []
    if (date === null) issues.push('no readable date')
    if (rawAmount === null) issues.push('no readable amount')
    if (merchant === '') issues.push('no merchant text')

    const spending = rawAmount === null ? null : options.negativeIsSpending ? -rawAmount : rawAmount
    if (spending !== null && spending <= 0) {
      issues.push(spending === 0 ? 'amount is zero' : 'looks like money coming in')
    }
    if (payerId === null) issues.push('nobody to post it against')

    return {
      line: firstDataLine + index,
      date,
      merchant,
      rawAmount,
      amount: spending === null ? null : Math.abs(round2(spending)),
      payerRaw,
      payerId,
      issues,
      include: issues.length === 0,
    }
  })
}

/**
 * Whether spending is written as a negative number in this file.
 *
 * Bank exports overwhelmingly do; a hand-written CSV of expenses overwhelmingly does not.
 * Counting is more reliable than assuming either.
 */
export function detectNegativeIsSpending(table: CsvTable, amountColumn: number): boolean {
  if (amountColumn === UNMAPPED) return false
  let negatives = 0
  let positives = 0
  for (const row of table.rows) {
    const value = parseAmount(row[amountColumn] ?? '')
    if (value === null || value === 0) continue
    if (value < 0) negatives += 1
    else positives += 1
  }
  return negatives > positives
}
