/**
 * Maps a SAP Document AI job result onto the receipt shape the ledger works with
 * (CONTRACTS.md §6).
 *
 * Everything below is deliberately defensive. Extraction quality depends on a
 * phone photo taken in a dim restaurant, so half of the fields can be missing,
 * mistyped or written in a locale we did not expect. A bad scan must still come
 * out as a draft expense the user can fix by hand — never as an exception.
 */
import type { ExtractedReceipt, ReceiptLineItem } from './types'

export type { ExtractedReceipt, ReceiptLineItem } from './types'

/** Contract default: everything we cannot identify is booked in Swiss francs. */
const DEFAULT_CURRENCY = 'CHF'

/* Accepted source field names per target, most specific first. Document AI's
   standard invoice schema uses the first entry of each list; the others cover
   custom receipt schemas built in the Document AI UI. */
const MERCHANT_FIELDS = ['senderName', 'vendorName', 'supplierName', 'merchantName', 'storeName']
const DATE_FIELDS = ['documentDate', 'invoiceDate', 'receiptDate', 'transactionDate', 'date']
const TIME_FIELDS = ['documentTime', 'receiptTime', 'transactionTime', 'time']
const GROSS_FIELDS = ['grossAmount', 'totalAmount', 'total', 'amountDue', 'invoiceAmount']
const NET_FIELDS = ['netAmount', 'netTotal']
const CURRENCY_FIELDS = ['currencyCode', 'currency']
const CITY_FIELDS = ['senderCity', 'city', 'place', 'location']
const ADDRESS_FIELDS = ['senderAddress', 'vendorAddress', 'supplierAddress', 'address']
const LINE_DESCRIPTION_FIELDS = ['description', 'itemDescription', 'text', 'name']
const LINE_QUANTITY_FIELDS = ['quantity', 'qty']
const LINE_AMOUNT_FIELDS = ['netAmount', 'grossAmount', 'lineAmount', 'amount', 'totalAmount']

/** Symbols that show up instead of an ISO code on till receipts. */
const CURRENCY_BY_SYMBOL: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  '¥': 'JPY',
  '₣': 'CHF',
  '₤': 'ITL',
}

/** Written month names in the languages this household actually shops in. */
const MONTHS_BY_NAME: Record<string, number> = {
  jan: 1,
  januar: 1,
  january: 1,
  janvier: 1,
  gennaio: 1,
  jaenner: 1,
  feb: 2,
  februar: 2,
  february: 2,
  fevrier: 2,
  febbraio: 2,
  mar: 3,
  mrz: 3,
  maerz: 3,
  march: 3,
  mars: 3,
  marzo: 3,
  apr: 4,
  april: 4,
  avril: 4,
  aprile: 4,
  mai: 5,
  may: 5,
  maggio: 5,
  jun: 6,
  juni: 6,
  june: 6,
  juin: 6,
  giugno: 6,
  jul: 7,
  juli: 7,
  july: 7,
  juillet: 7,
  luglio: 7,
  aug: 8,
  august: 8,
  aout: 8,
  agosto: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septembre: 9,
  settembre: 9,
  okt: 10,
  oct: 10,
  oktober: 10,
  october: 10,
  octobre: 10,
  ottobre: 10,
  nov: 11,
  november: 11,
  novembre: 11,
  dez: 12,
  dec: 12,
  dic: 12,
  dezember: 12,
  december: 12,
  decembre: 12,
  dicembre: 12,
}

type FieldValue = string | number | boolean | null

/** The only part of a Document AI field we care about, once narrowed. */
interface NormalisedField {
  name: string
  value: FieldValue
  confidence: number | null
}

/* --------------------------------------------------------------- guards */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Field values arrive as strings, numbers or nulls depending on the model, so
 * every consumer here works from one flat text representation.
 */
function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/* --------------------------------------------------------------- amounts */

/** Digit-group noise: ordinary, non-breaking, narrow and thin spaces. */
const SPACE_LIKE = /[\s\u00a0\u202f\u2009\u2007]+/
/** The Swiss thousands apostrophe in every shape a keyboard or an OCR pass produces. */
const APOSTROPHES = /[\u0027\u2018\u2019\u0060\u00b4]/g
const LETTERS = /[a-zA-ZÀ-ɏ]+/g
const CURRENCY_MARKS = /[€$£¥₣₤₹¢]/g

function hasDigit(text: string): boolean {
  return /\d/.test(text)
}

/**
 * A space between digits is a thousands separator only when the groups line up.
 * Without this check the `2 x 4.50` a till receipt prints in a quantity field
 * would quietly become 24.50 — an invented amount is worse than no amount.
 */
function isSpaceGrouped(chunks: string[]): boolean {
  if (!/^\d{1,3}$/.test(chunks[0])) return false
  for (let i = 1; i < chunks.length - 1; i += 1) {
    if (!/^\d{3}$/.test(chunks[i])) return false
  }
  return /^\d{3}(?:[.,]\d+)?$/.test(chunks[chunks.length - 1])
}

/**
 * Validates the integer part of a grouped number and returns it without the
 * separators. Rejecting `1.2345,50` here is what lets `parseAmount` answer
 * `null` for OCR noise instead of inventing an amount.
 */
function ungroup(intPart: string, separator: string | null): string | null {
  if (separator === null || !intPart.includes(separator)) {
    return /^\d+$/.test(intPart) ? intPart : null
  }
  const escaped = separator === '.' ? '\\.' : separator
  const grouped = new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`)
  if (!grouped.test(intPart)) return null
  return intPart.split(separator).join('')
}

/**
 * Decides whether a lone separator is a decimal point or a thousands separator.
 *
 * The asymmetry is intentional and locale-driven: in CH/DE/FR a comma decimal is
 * written with two digits (`12,30`), so `1,234` is the English thousands form;
 * a dot followed by three digits, however, is far more often a weighed quantity
 * (`1.235 kg`) or a unit price (`0.125`) than a German thousands group, because
 * German prices carry their comma decimals along (`1.234,50`).
 */
function classifySoleSeparator(text: string, separator: '.' | ','): '.' | ',' | null {
  const index = text.indexOf(separator)
  const intPart = text.slice(0, index)
  const digitsAfter = text.length - index - 1
  if (digitsAfter !== 3) return separator
  if (separator === ',' && /^[1-9]\d{0,2}$/.test(intPart)) return null
  return separator
}

/**
 * Parses money and quantities out of whatever the receipt printed:
 * `1'234.50` (CH), `1.234,50` (DE/IT), `1 234,50` (FR), `1234.50`,
 * `CHF 1'234.50`, `-12,30`, `12,30-` and `(12.30)`. Returns `null` when the
 * input is not a number at all — the caller then flags the field for review.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null

  let text = raw.trim()
  if (text === '') return null

  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true
    text = text.slice(1, -1)
  }

  // Currency words and symbols go first, and they leave a space behind: the sign
  // sits between them and the digits ("CHF -12.30"), and the leftover space is
  // what tells the abbreviation dot of "Fr. 5.60" apart from a decimal point.
  text = text.replace(LETTERS, ' ').replace(CURRENCY_MARKS, ' ').trim()

  if (/^[-−+]/.test(text)) {
    if (!text.startsWith('+')) negative = !negative
    text = text.slice(1)
  }
  if (/[-−+]$/.test(text)) {
    if (!text.endsWith('+')) negative = !negative
    text = text.slice(0, -1)
  }

  // Spaces are thousands separators, so the chunks are concatenated — but only
  // once they line up as digit groups. Chunks without a digit are punctuation
  // left over above and drop out first.
  const chunks = text.replace(APOSTROPHES, '').split(SPACE_LIKE).filter(hasDigit)
  if (chunks.length === 0) return null
  if (chunks.length > 1 && !isSpaceGrouped(chunks)) return null
  text = chunks.join('').replace(/[.,]+$/, '')
  if (/^[.,]/.test(text)) {
    // A single separator is the decimal point of ".50"; a second one means the
    // first is trailing punctuation we could not attribute ("Fr.5.60").
    const separators = text.match(/[.,]/g)
    text = separators !== null && separators.length > 1 ? text.slice(1) : `0.${text.slice(1)}`
  }
  if (text === '' || !/^[0-9.,]+$/.test(text) || !/\d/.test(text)) return null

  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  let decimalSeparator: '.' | ',' | null
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastDot > lastComma ? '.' : ','
  } else if (lastDot >= 0) {
    decimalSeparator = text.indexOf('.') === lastDot ? classifySoleSeparator(text, '.') : null
  } else if (lastComma >= 0) {
    decimalSeparator = text.indexOf(',') === lastComma ? classifySoleSeparator(text, ',') : null
  } else {
    decimalSeparator = null
  }

  let digits: string
  let fraction = ''
  if (decimalSeparator === null) {
    const groupSeparator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null
    const ungrouped = ungroup(text, groupSeparator)
    if (ungrouped === null) return null
    digits = ungrouped
  } else {
    const cut = text.lastIndexOf(decimalSeparator)
    if (text.indexOf(decimalSeparator) !== cut) return null
    const groupSeparator = decimalSeparator === '.' ? ',' : '.'
    const ungrouped = ungroup(
      text.slice(0, cut),
      text.includes(groupSeparator) ? groupSeparator : null,
    )
    if (ungrouped === null) return null
    digits = ungrouped
    fraction = text.slice(cut + 1)
    if (!/^\d+$/.test(fraction)) return null
  }

  const value = Number(fraction === '' ? digits : `${digits}.${fraction}`)
  if (!Number.isFinite(value)) return null
  return negative && value !== 0 ? -value : value
}

/* ----------------------------------------------------------------- dates */

/**
 * Folds a written month name onto a lookup key: German umlauts first (so `März`
 * and `Maerz` land on the same key), then accents, exactly like the merchant
 * normaliser in the classifier.
 */
function foldWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^a-z]/g, '')
}

/** Two-digit years use the usual 70 pivot; a 19xx receipt is not something this ledger sees. */
function expandYear(token: string): number | null {
  if (token.length === 4) return Number(token)
  if (token.length === 2) {
    const year = Number(token)
    return year < 70 ? 2000 + year : 1900 + year
  }
  return null
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Rejects impossible calendars (31.02.) instead of silently rolling over. */
function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year) return null
  if (probe.getUTCMonth() !== month - 1) return null
  if (probe.getUTCDate() !== day) return null
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Handles `14. März 2026`, `14-Mar-2026` and `March 14, 2026` by anchoring on
 * the month word: the number in front of it is the day, the one behind it the
 * year, which is what every one of those layouts has in common.
 */
function parseWordyDate(text: string): string | null {
  const tokens = text.toLowerCase().match(/\p{L}+|\d+/gu)
  if (!tokens) return null

  let monthIndex = -1
  let month = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const candidate = MONTHS_BY_NAME[foldWord(tokens[i])]
    if (candidate !== undefined) {
      monthIndex = i
      month = candidate
      break
    }
  }
  if (monthIndex < 0) return null

  const numbersBefore = tokens.slice(0, monthIndex).filter(token => /^\d+$/.test(token))
  const numbersAfter = tokens.slice(monthIndex + 1).filter(token => /^\d+$/.test(token))

  let dayToken: string | undefined
  let yearToken: string | undefined
  if (numbersBefore.length > 0 && numbersAfter.length > 0) {
    dayToken = numbersBefore[numbersBefore.length - 1]
    yearToken = numbersAfter[0]
  } else if (numbersAfter.length > 1) {
    dayToken = numbersAfter[0]
    yearToken = numbersAfter[1]
  }
  if (dayToken === undefined || yearToken === undefined) return null

  // "2026 März 14" reads the other way round; only a four-digit token can be the year.
  if (dayToken.length === 4 && yearToken.length <= 2) {
    const swap = dayToken
    dayToken = yearToken
    yearToken = swap
  }

  const year = expandYear(yearToken)
  if (year === null) return null
  return isoDate(year, month, Number(dayToken))
}

/**
 * Normalises a printed date to `YYYY-MM-DD`, or `null` when it cannot be read.
 *
 * Day-before-month is the default for the ambiguous `04/03/26` shape: this is a
 * Swiss household, and guessing wrong there is far less damaging than dropping
 * the date of every European receipt.
 */
export function parseDate(raw: unknown): string | null {
  const text = toText(raw)
  if (text === null) return null

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/.exec(text)
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const ymd = /^(\d{4})[./](\d{1,2})[./](\d{1,2})(?:\D|$)/.exec(text)
  if (ymd) return isoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))

  const compact = /^(19|20)(\d{2})(\d{2})(\d{2})$/.exec(text)
  if (compact) {
    return isoDate(Number(`${compact[1]}${compact[2]}`), Number(compact[3]), Number(compact[4]))
  }

  const numeric = /^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2,4})(?:\D|$)/.exec(text)
  if (numeric) {
    const first = Number(numeric[1])
    const second = Number(numeric[2])
    const year = expandYear(numeric[3])
    if (year === null) return null
    if (first > 12 && second > 12) return null
    if (first <= 12 && second > 12) return isoDate(year, first, second)
    return isoDate(year, second, first)
  }

  return parseWordyDate(text)
}

/* ----------------------------------------------------------------- times */

function isoTime(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${pad(hour, 2)}:${pad(minute, 2)}`
}

/** French `18h42` and `12 h 30`, German `18 Uhr 42` — the word itself is the separator. */
const HOUR_WORD_TIME = /(?:^|\D)(\d{1,2})\s*(?:h|uhr)\s*(\d{2})(?!\d)/i
/** German `20.15 Uhr` — a dot only separates hours from minutes when "Uhr" follows them. */
const UHR_SUFFIX_TIME = /(?:^|\D)(\d{1,2})[.:]\s*(\d{2})\s*uhr\b/i

/**
 * Pulls `HH:MM` out of a time field or an ISO timestamp. Only colon-, `h`- and
 * "Uhr"-separated forms count, because `14.03.2026` would otherwise read as a
 * perfectly plausible 14:03 — so the `h`/`Uhr` marker has to sit between the two
 * numbers of the match itself, never merely somewhere else in the string.
 */
export function parseTime(raw: unknown): string | null {
  const text = toText(raw)
  if (text === null) return null

  const meridiem = /(?:^|\D)(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s?m\.?\b/i.exec(text)
  if (meridiem) {
    const hour12 = Number(meridiem[1])
    if (hour12 < 1 || hour12 > 12) return null
    const pm = meridiem[3].toLowerCase() === 'p'
    const hour = pm ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12
    return isoTime(hour, Number(meridiem[2]))
  }

  const colon = /(?:^|[^\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?!\d)/.exec(text)
  if (colon) return isoTime(Number(colon[1]), Number(colon[2]))

  const spoken = HOUR_WORD_TIME.exec(text) ?? UHR_SUFFIX_TIME.exec(text)
  if (spoken) return isoTime(Number(spoken[1]), Number(spoken[2]))

  return null
}

/* ---------------------------------------------------------------- fields */

function toNormalisedField(raw: unknown): NormalisedField | null {
  if (!isRecord(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') return null
  const rawValue = raw.value
  const value: FieldValue =
    typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean'
      ? rawValue
      : null
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? clamp01(raw.confidence)
      : null
  return { name, value, confidence }
}

function readExtraction(job: unknown): Record<string, unknown> | null {
  if (!isRecord(job)) return null
  if (isRecord(job.extraction)) return job.extraction
  // Some callers hand us the extraction block itself rather than the whole job.
  if (Array.isArray(job.headerFields) || Array.isArray(job.lineItems)) return job
  return null
}

function readHeaderFields(job: unknown): NormalisedField[] {
  const extraction = readExtraction(job)
  if (!extraction || !Array.isArray(extraction.headerFields)) return []
  const fields: NormalisedField[] = []
  for (const entry of extraction.headerFields) {
    const field = toNormalisedField(entry)
    if (field) fields.push(field)
  }
  return fields
}

function readLineItemGroups(job: unknown): NormalisedField[][] {
  const extraction = readExtraction(job)
  if (!extraction || !Array.isArray(extraction.lineItems)) return []
  const groups: NormalisedField[][] = []
  for (const entry of extraction.lineItems) {
    if (!Array.isArray(entry)) continue
    const group: NormalisedField[] = []
    for (const raw of entry) {
      const field = toNormalisedField(raw)
      if (field) group.push(field)
    }
    if (group.length > 0) groups.push(group)
  }
  return groups
}

function hasValue(field: NormalisedField): boolean {
  if (field.value === null) return false
  return typeof field.value !== 'string' || field.value.trim() !== ''
}

/** First candidate name that is actually filled in wins — order encodes priority. */
function pick(fields: NormalisedField[], names: string[]): NormalisedField | null {
  for (const name of names) {
    const wanted = name.toLowerCase()
    for (const field of fields) {
      if (field.name.toLowerCase() === wanted && hasValue(field)) return field
    }
  }
  return null
}

/**
 * Receipts carry the shop's full postal address, but the ledger only wants the
 * town — that is what ends up on the memories map and in the yearly statement.
 */
function extractPlace(address: string): string | null {
  const segments = address
    .split(/[\n\r,]+/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
  if (segments.length === 0) return null
  for (const segment of segments) {
    const postal = /^(?:[A-Z]{1,2}-)?\d{4,5}\s+(.+)$/.exec(segment)
    if (postal) return postal[1].trim()
  }
  const last = segments[segments.length - 1]
  return /\d/.test(last) ? null : last
}

/** ISO-4217 if we can prove it, otherwise the household default. */
function normaliseCurrency(value: FieldValue): string | null {
  const text = toText(value)
  if (text === null) return null
  const symbol = CURRENCY_BY_SYMBOL[text.trim()]
  if (symbol) return symbol
  const letters = text.toUpperCase().replace(/[^A-Z]/g, '')
  // The franc aliases must be tested BEFORE the generic three-letter ISO check:
  // 'sFr.' reduces to 'SFR', which looks like a valid ISO code but is not one.
  // Swiss receipts print francs as 'Fr.', 'sFr.', 'SFr.' and 'Frs' far more often
  // than they print 'CHF', so letting the ISO branch win here silently stored a
  // currency that no downstream lookup can resolve.
  if (letters === 'FR' || letters === 'SFR' || letters === 'FRS') return 'CHF'
  if (/^[A-Z]{3}$/.test(letters)) return letters
  return null
}

function mapLineItem(group: NormalisedField[]): ReceiptLineItem | null {
  const descriptionField = pick(group, LINE_DESCRIPTION_FIELDS)
  const quantityField = pick(group, LINE_QUANTITY_FIELDS)
  const amountField = pick(group, LINE_AMOUNT_FIELDS)
  const description = descriptionField ? (toText(descriptionField.value) ?? '') : ''
  const quantity = quantityField ? parseAmount(quantityField.value) : null
  const netAmount = amountField ? parseAmount(amountField.value) : null
  // A row with neither a name nor a price is extraction noise, not a purchase.
  if (description === '' && netAmount === null) return null
  return { description, quantity, netAmount }
}

/* ------------------------------------------------------------------- map */

/**
 * Turns a Document AI job result (or just its `extraction` block) into the
 * receipt the scan flow drafts an expense from. Never throws: unknown input
 * yields an empty receipt with the default currency.
 */
export function mapJobResult(job: unknown): ExtractedReceipt {
  const fields = readHeaderFields(job)
  const confidence: Record<string, number> = {}

  /* Only fields the model actually scored are reported, so a consumer taking the
     minimum confidence never trips over a field that simply has no score. */
  const note = (key: string, field: NormalisedField | null): void => {
    if (field && field.confidence !== null) confidence[key] = field.confidence
  }

  const merchantField = pick(fields, MERCHANT_FIELDS)
  const merchantRaw = merchantField ? toText(merchantField.value) : null
  if (merchantRaw !== null) note('merchantRaw', merchantField)

  const dateField = pick(fields, DATE_FIELDS)
  const date = dateField ? parseDate(dateField.value) : null
  if (date !== null) note('date', dateField)

  const timeField = pick(fields, TIME_FIELDS)
  let time = timeField ? parseTime(timeField.value) : null
  if (time !== null) {
    note('time', timeField)
  } else if (dateField) {
    // Till receipts often stamp date and time into one field.
    time = parseTime(dateField.value)
    if (time !== null) note('time', dateField)
  }

  const grossField = pick(fields, GROSS_FIELDS)
  let amountField = grossField
  let amount = grossField ? parseAmount(grossField.value) : null
  if (amount === null) {
    // A total the model could not read is still worth a draft; the net total is
    // the closest honest stand-in and the user corrects it in the confirm card.
    const netField = pick(fields, NET_FIELDS)
    const net = netField ? parseAmount(netField.value) : null
    if (net !== null) {
      amount = net
      amountField = netField
    }
  }
  if (amount !== null) note('amount', amountField)

  const currencyField = pick(fields, CURRENCY_FIELDS)
  const currency =
    (currencyField ? normaliseCurrency(currencyField.value) : null) ?? DEFAULT_CURRENCY
  if (currencyField && normaliseCurrency(currencyField.value) !== null)
    note('currency', currencyField)

  const cityField = pick(fields, CITY_FIELDS)
  const addressField = pick(fields, ADDRESS_FIELDS)
  let placeField = cityField
  let place = cityField ? toText(cityField.value) : null
  if (place === null && addressField) {
    const address = toText(addressField.value)
    place = address === null ? null : extractPlace(address)
    placeField = addressField
  }
  if (place !== null) note('place', placeField)

  const lineItems: ReceiptLineItem[] = []
  for (const group of readLineItemGroups(job)) {
    const item = mapLineItem(group)
    if (item) lineItems.push(item)
  }

  const rawFields: Record<string, unknown> = {}
  if (isRecord(job)) {
    for (const key of ['id', 'status', 'documentType', 'fileName', 'schemaName']) {
      if (job[key] !== undefined) rawFields[key] = job[key]
    }
  }
  for (const field of fields) rawFields[field.name] = field.value

  return { merchantRaw, date, time, amount, currency, place, lineItems, confidence, rawFields }
}

/** Alias for callers that read better with the service name spelled out. */
export const mapDocAiResult = mapJobResult
