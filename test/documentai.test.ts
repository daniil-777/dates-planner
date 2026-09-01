/**
 * Document AI mapper and mock-client tests (docs/CONTRACTS.md §6).
 *
 * The mapper is the piece that decides what a scan becomes, so it is exercised
 * two ways: against the three bundled fixtures (which are what the mock client
 * actually replays, so a fixture edit that breaks the scan flow fails here), and
 * against hand-written payloads that are deliberately worse than the fixtures —
 * the CH/DE/FR number formats, half a dozen printed date layouts, missing
 * fields, and outright malformed JSON.
 *
 * Nothing here touches the network. The live client is only ever inspected for
 * its `mode`; every request path in this file runs against the mock.
 */
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  mapDocAiResult,
  mapJobResult,
  parseAmount,
  parseDate,
  parseTime,
} from '../srv/lib/documentai/mapper'
import { DocAiError, MOCK_DELAY_MS, getDocAiClient } from '../srv/lib/documentai/client'
import { fixtures, pickFixture } from '../srv/lib/documentai/fixtures'
import type { DocAiField, DocAiJobResult } from '../srv/lib/documentai/types'

/** A header field in the shape Document AI sends it. */
function header(name: string, value: DocAiField['value'], confidence?: number): DocAiField {
  const field: DocAiField = { name, value, category: 'header', type: 'string', page: 1 }
  if (confidence !== undefined) field.confidence = confidence
  return field
}

/** A minimal job result carrying just the header fields under test. */
function job(fields: DocAiField[], lineItems: DocAiField[][] = []): DocAiJobResult {
  return {
    id: 'test-job',
    status: 'DONE',
    documentType: 'invoice',
    extraction: { headerFields: fields, lineItems },
  }
}

/* ---------------------------------------------------------------- amounts */

describe('mapper — parseAmount across CH/DE/FR number formats (CONTRACTS §6)', () => {
  /**
   * `3.-` is three francs, not minus three.
   *
   * On a Swiss receipt the dash stands in for the two rappen digits, and it is everywhere:
   * price tags, restaurant bills, the round-number lines on a Migros slip. The trailing-sign
   * rule below it — which reads `12,30-` as negative, the way accounting prints it — used to
   * claim that same dash and flip the sign, so a CHF 3.00 coffee posted as CHF -3.00 and
   * the month totalled short. The two notations are told apart by what sits before the
   * dash: a digit means accounting, a decimal separator means rappen.
   */
  it('reads the Swiss round-francs dash as .00, not as a minus sign', () => {
    expect(parseAmount('3.-')).toBe(3)
    expect(parseAmount('3,-')).toBe(3)
    expect(parseAmount('12.–')).toBe(12)
    expect(parseAmount('48.—')).toBe(48)
    expect(parseAmount('7.−')).toBe(7)
    expect(parseAmount("1'234.–")).toBe(1234)
    expect(parseAmount('CHF 5.-')).toBe(5)
    expect(parseAmount('Fr. 5.-')).toBe(5)
  })

  it('still reads accounting\'s trailing minus as negative', () => {
    expect(parseAmount('12,30-')).toBe(-12.3)
    expect(parseAmount('12.30-')).toBe(-12.3)
    expect(parseAmount('-12,30')).toBe(-12.3)
    expect(parseAmount('(12.30)')).toBe(-12.3)
  })

  it('does not invent a zero out of a bare separator and dash', () => {
    // A silent 0.00 in an amount column is worse than the review flag null raises.
    expect(parseAmount('.-')).toBeNull()
    expect(parseAmount('-')).toBeNull()
  })

  it("reads the Swiss apostrophe form 1'234.50", () => {
    expect(parseAmount("1'234.50")).toBe(1234.5)
    expect(parseAmount("1'234'567.89")).toBe(1234567.89)
    expect(parseAmount("CHF 1'234.50")).toBe(1234.5)
    expect(parseAmount("1'234")).toBe(1234)
    // OCR renders the apostrophe as a typographic quote or a backtick just as often.
    expect(parseAmount('1’234.50')).toBe(1234.5)
    expect(parseAmount('1´234.50')).toBe(1234.5)
  })

  it('reads the German/Italian dotted form 1.234,50', () => {
    expect(parseAmount('1.234,50')).toBe(1234.5)
    expect(parseAmount('1.234.567,89')).toBe(1234567.89)
    expect(parseAmount('EUR 1.234,50')).toBe(1234.5)
    expect(parseAmount('0,00')).toBe(0)
    expect(parseAmount('1,50')).toBe(1.5)
  })

  it('reads the French spaced form 1 234,50, including exotic spaces', () => {
    expect(parseAmount('1 234,50')).toBe(1234.5)
    expect(parseAmount('1 234 567,89')).toBe(1234567.89)
    // Non-breaking and narrow no-break spaces are what a PDF actually contains.
    expect(parseAmount('1 234,50')).toBe(1234.5)
    expect(parseAmount('1 234,50')).toBe(1234.5)
  })

  it('reads the plain and symbol-prefixed forms', () => {
    expect(parseAmount('1234.50')).toBe(1234.5)
    expect(parseAmount('47.85')).toBe(47.85)
    expect(parseAmount('€12,30')).toBe(12.3)
    expect(parseAmount('12.30 CHF')).toBe(12.3)
    expect(parseAmount('Fr. 5.60')).toBe(5.6)
    expect(parseAmount('.50')).toBe(0.5)
    expect(parseAmount('+5.00')).toBe(5)
  })

  it('reads the three ways a receipt prints a negative', () => {
    expect(parseAmount('-12,30')).toBe(-12.3)
    expect(parseAmount('12,30-')).toBe(-12.3)
    expect(parseAmount('(12.30)')).toBe(-12.3)
    // Minus zero is still zero.
    expect(Object.is(parseAmount('-0.00'), 0)).toBe(true)
  })

  it('keeps a three-decimal weighed quantity as a quantity', () => {
    // 0.485 kg of tomatoes must not become 485 g of thousands separator.
    expect(parseAmount('0.485')).toBe(0.485)
    expect(parseAmount('1.235')).toBe(1.235)
  })

  it('treats a comma before three digits as an English thousands group', () => {
    expect(parseAmount('1,234')).toBe(1234)
    expect(parseAmount('12,345')).toBe(12345)
  })

  it('answers null rather than inventing an amount', () => {
    // "2 x 4.50" in a quantity field must not become 24.50.
    expect(parseAmount('2 x 4.50')).toBeNull()
    expect(parseAmount('1.2345,50')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(undefined)).toBeNull()
    expect(parseAmount(true)).toBeNull()
    expect(parseAmount({})).toBeNull()
    expect(parseAmount(Number.NaN)).toBeNull()
    expect(parseAmount(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('passes a number through untouched', () => {
    expect(parseAmount(12.5)).toBe(12.5)
    expect(parseAmount(0)).toBe(0)
    expect(parseAmount(-3)).toBe(-3)
  })
})

/* ------------------------------------------------------------------ dates */

describe('mapper — parseDate normalisations', () => {
  it('passes an ISO date through', () => {
    expect(parseDate('2026-03-07')).toBe('2026-03-07')
    expect(parseDate('2026-03-14T20:15:00Z')).toBe('2026-03-14')
    expect(parseDate('2026/03/07')).toBe('2026-03-07')
    expect(parseDate('20260307')).toBe('2026-03-07')
  })

  it('reads the European day-first numeric forms', () => {
    expect(parseDate('14.03.2026')).toBe('2026-03-14')
    expect(parseDate('07/03/2026')).toBe('2026-03-07')
    expect(parseDate('7.3.26')).toBe('2026-03-07')
    expect(parseDate('07 03 2026')).toBe('2026-03-07')
  })

  it('resolves the ambiguous shape day-first, but yields to an impossible day', () => {
    // 03/14 cannot be a 14th month, so it has to be March the 14th.
    expect(parseDate('03/14/2026')).toBe('2026-03-14')
    // 04/03 is genuinely ambiguous; a Swiss household writes 4 March.
    expect(parseDate('04/03/2026')).toBe('2026-03-04')
    expect(parseDate('13/13/2026')).toBeNull()
  })

  it('reads written month names in de/en/fr/it', () => {
    expect(parseDate('12. Februar 2026')).toBe('2026-02-12')
    expect(parseDate('14. März 2026')).toBe('2026-03-14')
    expect(parseDate('14. Maerz 2026')).toBe('2026-03-14')
    expect(parseDate('14-Mar-2026')).toBe('2026-03-14')
    expect(parseDate('March 14, 2026')).toBe('2026-03-14')
    expect(parseDate('5 mai 2026')).toBe('2026-05-05')
    expect(parseDate('7 settembre 2026')).toBe('2026-09-07')
    expect(parseDate('1. Jänner 2027')).toBe('2027-01-01')
  })

  it('expands a two-digit year on the usual 70 pivot', () => {
    expect(parseDate('14. März 26')).toBe('2026-03-14')
    expect(parseDate('14.03.69')).toBe('2069-03-14')
    expect(parseDate('14.03.70')).toBe('1970-03-14')
  })

  it('rejects an impossible calendar instead of rolling it over', () => {
    expect(parseDate('31.02.2026')).toBeNull()
    expect(parseDate('29.02.2026')).toBeNull()
    expect(parseDate('29.02.2024')).toBe('2024-02-29')
    expect(parseDate('00.03.2026')).toBeNull()
  })

  it('answers null for anything unreadable', () => {
    expect(parseDate('not a date')).toBeNull()
    expect(parseDate('')).toBeNull()
    expect(parseDate('   ')).toBeNull()
    expect(parseDate(null)).toBeNull()
    expect(parseDate(undefined)).toBeNull()
    expect(parseDate({})).toBeNull()
  })
})

/* ------------------------------------------------------------------ times */

describe('mapper — parseTime normalisations', () => {
  it('reads a colon-separated time', () => {
    expect(parseTime('18:42')).toBe('18:42')
    expect(parseTime('20:15')).toBe('20:15')
    expect(parseTime('8:05')).toBe('08:05')
    expect(parseTime('23:59:59')).toBe('23:59')
    expect(parseTime('2026-03-14T20:15:00')).toBe('20:15')
  })

  it('reads a 12-hour clock', () => {
    expect(parseTime('8:05 PM')).toBe('20:05')
    expect(parseTime('12:30 pm')).toBe('12:30')
    expect(parseTime('12:00 AM')).toBe('00:00')
    expect(parseTime('7:15 a.m.')).toBe('07:15')
  })

  it('reads the spoken French and German separators', () => {
    expect(parseTime('18h42')).toBe('18:42')
    expect(parseTime('12 h 30')).toBe('12:30')
    expect(parseTime('18 Uhr 42')).toBe('18:42')
    expect(parseTime('20.15 Uhr')).toBe('20:15')
  })

  it('refuses to read a date as a time', () => {
    // 14.03.2026 is a date, not 14:03 — the "Uhr" marker is what licenses a dot.
    expect(parseTime('14.03.2026')).toBeNull()
    expect(parseTime('07.03')).toBeNull()
  })

  it('answers null for an out-of-range or unreadable time', () => {
    expect(parseTime('25:00')).toBeNull()
    expect(parseTime('12:75')).toBeNull()
    expect(parseTime('13:00 PM')).toBeNull()
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('')).toBeNull()
    expect(parseTime(null)).toBeNull()
  })
})

/* --------------------------------------------------------------- fixtures */

describe('mapper — bundled fixtures', () => {
  it('maps the Migros till receipt (CH numbers, ISO date, separate time field)', () => {
    const receipt = mapJobResult(fixtures.migros)
    expect(receipt.merchantRaw).toBe('MIGROS Zürich Löwenstrasse')
    expect(receipt.date).toBe('2026-03-07')
    expect(receipt.time).toBe('18:42')
    expect(receipt.amount).toBe(47.85)
    expect(receipt.currency).toBe('CHF')
    expect(receipt.place).toBe('Zürich')
    expect(receipt.lineItems).toHaveLength(10)
  })

  it('keeps weighed quantities on the Migros receipt intact', () => {
    const receipt = mapJobResult(fixtures.migros)
    const tomatoes = receipt.lineItems.find(item => item.description.startsWith('Rispentomaten'))
    expect(tomatoes).toEqual({
      description: 'Rispentomaten CH kg',
      quantity: 0.485,
      netAmount: 4.75,
    })
    const bananas = receipt.lineItems.find(item => item.description.startsWith('Bio Bananen'))
    expect(bananas?.quantity).toBe(1.235)
  })

  it('maps the restaurant receipt (dotted date, evening time)', () => {
    const receipt = mapJobResult(fixtures.restaurant)
    expect(receipt.merchantRaw).toBe('RESTAURANT BLAUE ENTE')
    expect(receipt.date).toBe('2026-03-14')
    expect(receipt.time).toBe('20:15')
    expect(receipt.amount).toBe(148.5)
    expect(receipt.currency).toBe('CHF')
    expect(receipt.place).toBe('Zürich')
    expect(receipt.lineItems).toHaveLength(6)
    expect(receipt.lineItems[0]).toEqual({
      description: 'Blattsalat mit gerösteten Kernen',
      quantity: 2,
      netAmount: 19,
    })
  })

  it('maps the German hotel invoice (DE numbers, written month, no time)', () => {
    const receipt = mapJobResult(fixtures.hotel)
    expect(receipt.merchantRaw).toBe('Hotel Rheinblick Konstanz GmbH')
    expect(receipt.date).toBe('2026-02-12')
    expect(receipt.time).toBeNull()
    expect(receipt.amount).toBe(1234.5)
    expect(receipt.currency).toBe('EUR')
    expect(receipt.place).toBe('Konstanz')
    expect(receipt.lineItems).toHaveLength(6)
    expect(receipt.lineItems[0].netAmount).toBe(867)
  })

  it('carries the per-field confidences straight through', () => {
    expect(mapJobResult(fixtures.restaurant).confidence).toEqual({
      merchantRaw: 0.978,
      date: 0.957,
      time: 0.889,
      amount: 0.974,
      currency: 0.988,
      place: 0.916,
    })
    expect(mapJobResult(fixtures.migros).confidence).toEqual({
      merchantRaw: 0.964,
      date: 0.971,
      time: 0.913,
      amount: 0.983,
      currency: 0.991,
      place: 0.887,
    })
    // The hotel invoice carries no time field, so 'time' is simply absent — a
    // consumer taking min(confidence) must not see a zero for a missing field.
    const hotel = mapJobResult(fixtures.hotel).confidence
    expect(hotel).toEqual({
      merchantRaw: 0.942,
      date: 0.786,
      amount: 0.968,
      currency: 0.973,
      place: 0.571,
    })
    expect('time' in hotel).toBe(false)
  })

  it('keeps the raw fields for replay, including ones it does not map', () => {
    const raw = mapJobResult(fixtures.migros).rawFields
    expect(raw.id).toBe('5c9e6b6a-2f6e-4f6b-9a12-6f0f0a2f3d41')
    expect(raw.status).toBe('DONE')
    expect(raw.fileName).toBe('migros-loewenstrasse-2026-03-07.jpg')
    expect(raw.schemaName).toBe('twowaymatch_receipt_v1')
    expect(raw.taxRate).toBe('7.7')
    expect(raw.paymentTerms).toBe('TWINT Kontaktlos')
  })

  it('exposes the same function under its spelled-out alias', () => {
    expect(mapDocAiResult(fixtures.restaurant)).toEqual(mapJobResult(fixtures.restaurant))
  })
})

/* ------------------------------------------------------- crafted payloads */

describe('mapper — hand-written payloads', () => {
  it('maps a Swiss till receipt end to end', () => {
    const receipt = mapJobResult(
      job([
        header('senderName', 'Coop Pronto Bahnhof', 0.912),
        header('documentDate', '07.03.2026', 0.884),
        header('documentTime', '18:42', 0.701),
        header('grossAmount', "1'234.50", 0.953),
        header('currencyCode', 'CHF', 0.991),
        header('senderAddress', 'Bahnhofplatz 15\n3011 Bern', 0.604),
      ]),
    )
    expect(receipt).toMatchObject({
      merchantRaw: 'Coop Pronto Bahnhof',
      date: '2026-03-07',
      time: '18:42',
      amount: 1234.5,
      currency: 'CHF',
      place: 'Bern',
    })
    expect(receipt.confidence).toEqual({
      merchantRaw: 0.912,
      date: 0.884,
      time: 0.701,
      amount: 0.953,
      currency: 0.991,
      place: 0.604,
    })
  })

  it('maps a German invoice end to end', () => {
    const receipt = mapJobResult(
      job([
        header('senderName', 'Bäckerei Müller GmbH', 0.87),
        header('documentDate', '12. Februar 2026', 0.79),
        header('documentTime', '20.15 Uhr', 0.62),
        header('grossAmount', '1.234,50', 0.96),
        header('currencyCode', 'EUR', 0.97),
        header('senderAddress', 'Marktplatz 3\n78462 Konstanz\nDeutschland', 0.55),
      ]),
    )
    expect(receipt).toMatchObject({
      merchantRaw: 'Bäckerei Müller GmbH',
      date: '2026-02-12',
      time: '20:15',
      amount: 1234.5,
      currency: 'EUR',
      place: 'Konstanz',
    })
  })

  it('maps a French receipt end to end, currency from the symbol', () => {
    const receipt = mapJobResult(
      job([
        header('senderName', 'Boulangerie du Marché', 0.9),
        header('documentDate', '5 mai 2026', 0.81),
        header('documentTime', '18h42', 0.58),
        header('grossAmount', '1 234,50', 0.94),
        header('currencyCode', '€', 0.88),
        header('senderAddress', 'Rue du Marché 12\n1204 Genève', 0.66),
      ]),
    )
    expect(receipt).toMatchObject({
      merchantRaw: 'Boulangerie du Marché',
      date: '2026-05-05',
      time: '18:42',
      amount: 1234.5,
      currency: 'EUR',
      place: 'Genève',
    })
  })

  it('falls back to the net total when the gross is unreadable', () => {
    const receipt = mapJobResult(
      job([header('grossAmount', 'TOTAL', 0.4), header('netAmount', '44.43', 0.82)]),
    )
    expect(receipt.amount).toBe(44.43)
    // The confidence reported is the field the amount actually came from.
    expect(receipt.confidence.amount).toBe(0.82)
  })

  it('reads the time out of a combined date-and-time field', () => {
    const receipt = mapJobResult(job([header('documentDate', '14.03.2026 20:15', 0.9)]))
    expect(receipt.date).toBe('2026-03-14')
    expect(receipt.time).toBe('20:15')
    expect(receipt.confidence).toEqual({ date: 0.9, time: 0.9 })
  })

  it('prefers a city field over digging a town out of the address', () => {
    const receipt = mapJobResult(
      job([
        header('senderCity', 'Winterthur', 0.77),
        header('senderAddress', 'Technikumstrasse 9\n8400 Winterthur', 0.5),
      ]),
    )
    expect(receipt.place).toBe('Winterthur')
    expect(receipt.confidence.place).toBe(0.77)
  })

  it('finds the town behind a country-prefixed postcode on one line', () => {
    expect(
      mapJobResult(job([header('senderAddress', 'Löwenstrasse 31, CH-8001 Zürich')])).place,
    ).toBe('Zürich')
    expect(mapJobResult(job([header('address', 'Hauptstrasse')])).place).toBe('Hauptstrasse')
    // A trailing line that is really a house number is not a town.
    expect(mapJobResult(job([header('address', 'Building 4')])).place).toBeNull()
  })

  it('clamps a confidence outside 0..1', () => {
    const receipt = mapJobResult(
      job([header('senderName', 'A', 1.4), header('grossAmount', '1.00', -0.2)]),
    )
    expect(receipt.confidence.merchantRaw).toBe(1)
    expect(receipt.confidence.amount).toBe(0)
  })

  it('omits fields the model did not score', () => {
    const receipt = mapJobResult(job([header('senderName', 'X'), header('grossAmount', '10.00')]))
    expect(receipt.merchantRaw).toBe('X')
    expect(receipt.amount).toBe(10)
    expect(receipt.confidence).toEqual({})
  })

  it('accepts numeric field values, not just strings', () => {
    const receipt = mapJobResult(
      job([header('grossAmount', 47.85, 0.99), header('documentDate', 20260307, 0.5)]),
    )
    expect(receipt.amount).toBe(47.85)
    expect(receipt.date).toBe('2026-03-07')
  })

  it('accepts an extraction block handed over on its own', () => {
    const receipt = mapJobResult({ headerFields: [header('senderName', 'Direct', 0.5)] })
    expect(receipt.merchantRaw).toBe('Direct')
    expect(receipt.rawFields).toEqual({ senderName: 'Direct' })
  })
})

describe('mapper — line items', () => {
  it('maps description, quantity and amount, and drops extraction noise', () => {
    const receipt = mapJobResult(
      job(
        [],
        [
          [
            header('description', 'Espresso', 0.9),
            header('quantity', '2'),
            header('netAmount', '9.60'),
          ],
          [header('itemDescription', 'Trinkgeld'), header('amount', "1'000.00")],
          // Neither a name nor a price: noise, not a purchase.
          [header('quantity', '3')],
          [],
          // No description but a real price: still a line on the bill.
          [header('description', ''), header('netAmount', '2,50')],
        ],
      ),
    )
    expect(receipt.lineItems).toEqual([
      { description: 'Espresso', quantity: 2, netAmount: 9.6 },
      { description: 'Trinkgeld', quantity: null, netAmount: 1000 },
      { description: '', quantity: null, netAmount: 2.5 },
    ])
  })

  it('ignores a line-item group that is not an array', () => {
    const malformed: unknown = {
      extraction: { lineItems: ['nope', 42, null, [header('description', 'Kaffee')]] },
    }
    expect(mapJobResult(malformed).lineItems).toEqual([
      { description: 'Kaffee', quantity: null, netAmount: null },
    ])
  })
})

describe('mapper — missing and malformed input', () => {
  it('returns nulls and the default currency for an empty extraction', () => {
    const empty = {
      merchantRaw: null,
      date: null,
      time: null,
      amount: null,
      currency: 'CHF',
      place: null,
      lineItems: [],
      confidence: {},
      rawFields: {},
    }
    expect(mapJobResult({ extraction: { headerFields: [], lineItems: [] } })).toEqual(empty)
    expect(mapJobResult({})).toEqual(empty)
  })

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 42, 'a string', [], true, { extraction: 'nope' }]) {
      const receipt = mapJobResult(input)
      expect(receipt.currency).toBe('CHF')
      expect(receipt.merchantRaw).toBeNull()
      expect(receipt.amount).toBeNull()
      expect(receipt.lineItems).toEqual([])
    }
  })

  it('skips header entries that are not usable fields', () => {
    const malformed: unknown = {
      extraction: {
        headerFields: [
          'oops',
          42,
          null,
          { value: 'no name at all' },
          { name: '   ', value: 'blank name' },
          { name: 'senderName', value: { nested: true } },
          { name: 'grossAmount', value: ['array'] },
          { name: 'documentDate', value: '2026-03-14', confidence: 'high' },
        ],
      },
    }
    const receipt = mapJobResult(malformed)
    expect(receipt.merchantRaw).toBeNull()
    expect(receipt.amount).toBeNull()
    expect(receipt.date).toBe('2026-03-14')
    // A non-numeric confidence is dropped, not coerced.
    expect(receipt.confidence).toEqual({})
  })

  it('falls back to CHF when the currency is missing or unrecognisable', () => {
    expect(mapJobResult(job([header('grossAmount', '10.00')])).currency).toBe('CHF')
    const unknown = mapJobResult(
      job([header('currencyCode', '???', 0.3), header('grossAmount', '10.00', 0.9)]),
    )
    expect(unknown.currency).toBe('CHF')
    expect('currency' in unknown.confidence).toBe(false)
  })

  it('recognises the franc written as an ISO code or a two-letter abbreviation', () => {
    for (const spelling of ['CHF', 'chf', ' chf ', 'Fr.', 'FR', '₣']) {
      expect(mapJobResult(job([header('currencyCode', spelling)])).currency).toBe('CHF')
    }
  })

  it('normalises the other currency symbols a receipt prints', () => {
    expect(mapJobResult(job([header('currencyCode', '€')])).currency).toBe('EUR')
    expect(mapJobResult(job([header('currencyCode', '$')])).currency).toBe('USD')
    expect(mapJobResult(job([header('currencyCode', '£')])).currency).toBe('GBP')
    expect(mapJobResult(job([header('currencyCode', 'usd')])).currency).toBe('USD')
  })

  /**
   * REGRESSION GUARD — this caught a real defect and must keep its teeth.
   *
   * `normaliseCurrency` used to run `if (/^[A-Z]{3}$/.test(letters)) return
   * letters` *before* its franc branch, so every three-letter franc spelling
   * returned verbatim: 'sFr' → 'SFR', 'SFr.' → 'SFR', 'Frs' → 'FRS'. Only the
   * two-letter 'Fr.' ever reached the branch that names them. An
   * ExtractedReceipt then escaped carrying a currency that is not ISO-4217,
   * which CONTRACTS §6 requires, and the scan drafted an expense in "SFR" that
   * matches neither Expenses.currency's CHF default nor any FX lookup — and the
   * service's own ISO_4217_PATTERN, which accepts any three letters, would not
   * catch it on write either.
   *
   * The order in the mapper is the fix. If someone reinstates the ISO guard
   * first, this goes red again — which is the point. Do not relax it.
   */
  it('recognises the Swiss franc written as francs', () => {
    expect(mapJobResult(job([header('currencyCode', 'sFr')])).currency).toBe('CHF')
    expect(mapJobResult(job([header('currencyCode', 'SFr.')])).currency).toBe('CHF')
    expect(mapJobResult(job([header('currencyCode', 'Frs')])).currency).toBe('CHF')
  })
})

/* ----------------------------------------------------------- mock client */

const DOCAI_ENV_KEYS = [
  'MOCK_DOCAI',
  'DOCAI_URL',
  'DOCAI_UAA_URL',
  'DOCAI_CLIENT_ID',
  'DOCAI_CLIENT_SECRET',
  'DOCAI_SCHEMA_NAME',
  'DOCAI_DOCUMENT_TYPE',
] as const

/** Plausible-looking non-secrets; nothing in this file ever calls out to them. */
const FAKE_LIVE_ENV: Record<string, string> = {
  DOCAI_URL: 'https://dox.example.invalid',
  DOCAI_UAA_URL: 'https://uaa.example.invalid',
  DOCAI_CLIENT_ID: 'test-client-id',
  DOCAI_CLIENT_SECRET: 'test-client-secret',
}

/** Four bytes of JPEG header — the mock never decodes it. */
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xdb])

describe('documentai client — mode selection (CONTRACTS §6)', () => {
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const key of DOCAI_ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of DOCAI_ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('engages mock mode when the credentials are absent', () => {
    expect(getDocAiClient().mode).toBe('mock')
  })

  it('engages mock mode when any single credential is missing', () => {
    for (const missing of [
      'DOCAI_URL',
      'DOCAI_UAA_URL',
      'DOCAI_CLIENT_ID',
      'DOCAI_CLIENT_SECRET',
    ]) {
      Object.assign(process.env, FAKE_LIVE_ENV)
      delete process.env[missing]
      expect(getDocAiClient().mode).toBe('mock')
    }
  })

  it('treats a blank credential as a missing one', () => {
    Object.assign(process.env, FAKE_LIVE_ENV)
    process.env.DOCAI_CLIENT_SECRET = '   '
    expect(getDocAiClient().mode).toBe('mock')
  })

  it('engages mock mode on MOCK_DOCAI even with full credentials', () => {
    Object.assign(process.env, FAKE_LIVE_ENV)
    for (const flag of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.MOCK_DOCAI = flag
      expect(getDocAiClient().mode).toBe('mock')
    }
  })

  it('goes live only when every credential is present and MOCK_DOCAI is not set', () => {
    Object.assign(process.env, FAKE_LIVE_ENV)
    expect(getDocAiClient().mode).toBe('live')
    // A falsy flag is not a request for the mock.
    process.env.MOCK_DOCAI = 'no'
    expect(getDocAiClient().mode).toBe('live')
  })

  it('caches the client until the Document AI environment changes', () => {
    const first = getDocAiClient()
    expect(getDocAiClient()).toBe(first)
    process.env.MOCK_DOCAI = '1'
    const second = getDocAiClient()
    expect(second).not.toBe(first)
    expect(getDocAiClient()).toBe(second)
  })
})

describe('documentai client — mock jobs', () => {
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const key of DOCAI_ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MOCK_DOCAI = '1'
  })

  afterEach(() => {
    for (const key of DOCAI_ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('picks the fixture by filename keyword', () => {
    expect(pickFixture('IMG_migros_2026-03-07.jpg')).toBe(fixtures.migros)
    expect(pickFixture('MIGROS-Loewenstrasse.HEIC')).toBe(fixtures.migros)
    expect(pickFixture('hotel-rheinblick.pdf')).toBe(fixtures.hotel)
    expect(pickFixture('Hotel-Rechnung.PDF')).toBe(fixtures.hotel)
    // Anything else is the restaurant receipt.
    expect(pickFixture('whatever.jpg')).toBe(fixtures.restaurant)
    expect(pickFixture('')).toBe(fixtures.restaurant)
  })

  it('replays the migros fixture for a file named after it', async () => {
    const client = getDocAiClient()
    const jobId = await client.submitJob(IMAGE, 'image/jpeg', 'IMG_migros_2026-03-07.jpg')
    expect(jobId.startsWith('mock-')).toBe(true)
    const result = await client.pollJob(jobId)
    expect(mapJobResult(result).merchantRaw).toBe('MIGROS Zürich Löwenstrasse')
    // The job id the caller was given is the id it gets back.
    expect((result as DocAiJobResult).id).toBe(jobId)
    expect((result as DocAiJobResult).status).toBe('DONE')
  })

  it('replays the hotel fixture for a hotel file name, whatever its case', async () => {
    const client = getDocAiClient()
    const jobId = await client.submitJob(IMAGE, 'application/pdf', 'Hotel-Rechnung.PDF')
    expect(mapJobResult(await client.pollJob(jobId)).merchantRaw).toBe(
      'Hotel Rheinblick Konstanz GmbH',
    )
  })

  it('falls back to the restaurant fixture for anything else', async () => {
    const client = getDocAiClient()
    const jobId = await client.submitJob(IMAGE, 'image/jpeg', 'IMG_4711.jpg')
    const receipt = mapJobResult(await client.pollJob(jobId))
    expect(receipt.merchantRaw).toBe('RESTAURANT BLAUE ENTE')
    expect(receipt.amount).toBe(148.5)
    expect(receipt.date).toBe('2026-03-14')
  })

  it('waits the 800 ms CONTRACTS §6 specifies', () => {
    expect(MOCK_DELAY_MS).toBe(800)
  })

  it('reports PENDING until the artificial delay has elapsed', async () => {
    const client = getDocAiClient()
    const jobId = await client.submitJob(IMAGE, 'image/jpeg', 'migros.jpg')
    expect(await client.getJob(jobId)).toEqual({ id: jobId, status: 'PENDING' })

    const startedAt = Date.now()
    await client.pollJob(jobId)
    // 20 ms of slack for timer granularity.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(MOCK_DELAY_MS - 20)

    // Once ready, a plain getJob returns the fixture too.
    expect((await client.getJob(jobId)) as DocAiJobResult).toMatchObject({
      id: jobId,
      status: 'DONE',
    })
  })

  it('fails a poll whose timeout is shorter than the delay', async () => {
    const client = getDocAiClient()
    const jobId = await client.submitJob(IMAGE, 'image/jpeg', 'migros.jpg')
    const error = await client
      .pollJob(jobId, { timeoutMs: 10 })
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DocAiError)
    expect((error as DocAiError).jobId).toBe(jobId)
    expect((error as Error).message).toContain('did not finish within 10 ms')
  })

  it('rejects a job id it never issued', async () => {
    const client = getDocAiClient()
    await expect(client.getJob('mock-does-not-exist')).rejects.toBeInstanceOf(DocAiError)
    await expect(client.pollJob('mock-does-not-exist')).rejects.toThrow(/does not know job/)
  })

  it('gives every submission its own job id', async () => {
    const client = getDocAiClient()
    const ids = await Promise.all([
      client.submitJob(IMAGE, 'image/jpeg', 'a.jpg'),
      client.submitJob(IMAGE, 'image/jpeg', 'b.jpg'),
      client.submitJob(IMAGE, 'image/jpeg', 'c.jpg'),
    ])
    expect(new Set(ids).size).toBe(3)
  })
})
