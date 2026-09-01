/**
 * The load-bearing test of the whole ML story: proof that the TypeScript
 * inference port agrees with the Python trainer.
 *
 * `ml/model/parity_fixture.json` is 60 rows sampled from the training CSV, each
 * carrying the merchant string, amount, timestamp and the **full `ClassifyResult`
 * that `ml/predict.py` produced** from the exported `weights.json` (CONTRACTS §4).
 * This file runs the TypeScript pipeline over all 60 and compares.
 *
 * Why a fixture and not "we wrote tests for both sides": the failure mode here is
 * not a crash, it is *drift*. Two implementations of the same maths agree on the
 * easy cases and part company on the ones nobody thought of — a scikit-learn
 * loop quirk, a signed CRC, a UTF-16 index, a UTC-shifted hour. Any of those
 * moves probabilities without moving anything visible. The fixture is 60 chances
 * to notice.
 *
 * The tolerance is 1e-4 and stays 1e-4. If a row fails, the fix is in the port —
 * never in the tolerance, never in the fixture.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  N_NUMERIC,
  charWbNgrams,
  classify,
  crc32,
  crc32Utf8,
  hashedNgramIds,
  loadModel,
  normaliseMerchant,
  numericFeatures,
  reloadModel,
  round6,
  scoreHead,
  topScored,
} from '../srv/lib/classifier'
import type { ClassifyResult, Head, Scored } from '../srv/lib/classifier'

/** Python and TypeScript must agree to this. It is not negotiable. */
const TOLERANCE = 1e-4

const REPO_ROOT = dirname(__dirname)
const FIXTURE_PATH = join(REPO_ROOT, 'ml', 'model', 'parity_fixture.json')

interface FixtureRow {
  merchantRaw: string
  amount: number
  whenISO: string
  expected: ClassifyResult
}

interface Fixture {
  generatedFrom: string
  nBuckets: number
  rows: FixtureRow[]
}

function loadFixture(): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${FIXTURE_PATH} is not a JSON object`)
  }
  const fixture = parsed as Fixture
  if (!Array.isArray(fixture.rows) || fixture.rows.length === 0) {
    throw new Error(`${FIXTURE_PATH} has no rows — run "npm run ml:export"`)
  }
  return fixture
}

const fixture = loadFixture()

/**
 * Human-readable label for a row, so a failure names the transaction rather than
 * an index. Amounts and merchants are already in the committed fixture, so this
 * leaks nothing a reader of the repo cannot see.
 */
function rowName(row: FixtureRow, index: number): string {
  return `#${index + 1} ${row.merchantRaw} / ${row.amount} / ${row.whenISO}`
}

function expectTopMatches(actual: Scored[], expected: Scored[], where: string): void {
  expect(
    actual.map(entry => entry.label),
    `${where}: labels`,
  ).toEqual(expected.map(entry => entry.label))
  for (let index = 0; index < expected.length; index += 1) {
    expect(
      Math.abs(actual[index].p - expected[index].p),
      `${where}[${index}] '${expected[index].label}': ts ${actual[index].p} vs py ${expected[index].p}`,
    ).toBeLessThanOrEqual(TOLERANCE)
  }
}

describe('classifier parity with ml/predict.py', () => {
  // The fixture is scored locally by definition. A CLASSIFIER_URL left over in a
  // developer's shell would otherwise send all 60 rows to a sidecar and silently
  // test that instead of the port this suite exists to check.
  const savedUrl = process.env.CLASSIFIER_URL

  beforeAll(() => {
    delete process.env.CLASSIFIER_URL
    reloadModel()
  })

  afterAll(() => {
    if (savedUrl === undefined) delete process.env.CLASSIFIER_URL
    else process.env.CLASSIFIER_URL = savedUrl
  })

  it('has the 60 rows CONTRACTS §4 promises, generated at the model’s bucket count', () => {
    expect(fixture.rows).toHaveLength(60)
    expect(fixture.nBuckets).toBe(loadModel().nBuckets)
  })

  it.each(fixture.rows.map((row, index) => [rowName(row, index), row] as const))(
    'matches Python on %s',
    async (_name, row) => {
      const actual = await classify(row.merchantRaw, row.amount, row.whenISO)

      expect(actual.engine).toBe('local')
      expect(actual.category).toBe(row.expected.category)
      expect(actual.moment).toBe(row.expected.moment)
      expect(
        Math.abs(actual.categoryConfidence - row.expected.categoryConfidence),
      ).toBeLessThanOrEqual(TOLERANCE)
      expect(Math.abs(actual.momentConfidence - row.expected.momentConfidence)).toBeLessThanOrEqual(
        TOLERANCE,
      )

      // The confidence must be the winner's probability, not merely close to it.
      expect(actual.categoryConfidence).toBe(actual.categoryTop3[0].p)
      expect(actual.momentConfidence).toBe(actual.momentTop3[0].p)

      expectTopMatches(actual.categoryTop3, row.expected.categoryTop3, 'categoryTop3')
      expectTopMatches(actual.momentTop3, row.expected.momentTop3, 'momentTop3')
    },
  )

  it('returns descending top-3 lists of the contracted length', async () => {
    const model = loadModel()
    const row = fixture.rows[0]
    const result = await classify(row.merchantRaw, row.amount, row.whenISO)

    expect(result.categoryTop3).toHaveLength(Math.min(3, model.heads.category.labels.length))
    expect(result.momentTop3).toHaveLength(Math.min(3, model.heads.moment.labels.length))
    for (const top of [result.categoryTop3, result.momentTop3]) {
      for (let index = 1; index < top.length; index += 1) {
        expect(top[index].p).toBeLessThanOrEqual(top[index - 1].p)
      }
      for (const scored of top) {
        // Rounded to 6 decimals on both sides (CONTRACTS §5).
        expect(scored.p).toBe(round6(scored.p))
      }
    }
    expect(model.heads.category.labels).toContain(result.category)
    expect(model.heads.moment.labels).toContain(result.moment)
  })

  it('survives reloadModel() with identical answers', async () => {
    const row = fixture.rows[0]
    const before = await classify(row.merchantRaw, row.amount, row.whenISO)
    reloadModel()
    const after = await classify(row.merchantRaw, row.amount, row.whenISO)
    expect(after).toEqual(before)
  })
})

describe('charWbNgrams reproduces scikit-learn char_wb', () => {
  // The three reference outputs written into CONTRACTS §2.2. The one-letter case
  // is the whole point: `_char_wb_ngrams` emits the padded word once and breaks,
  // so ' a ' appears exactly once even though n runs to 4.
  it("emits three grams for 'a', not four", () => {
    expect(charWbNgrams('a')).toEqual([' a', 'a ', ' a '])
  })

  it("emits the contract's grams for 'ab'", () => {
    expect(charWbNgrams('ab')).toEqual([' a', 'ab', 'b ', ' ab', 'ab ', ' ab '])
  })

  it("emits the contract's grams for 'abc'", () => {
    expect(charWbNgrams('abc')).toEqual([
      ' a',
      'ab',
      'bc',
      'c ',
      ' ab',
      'abc',
      'bc ',
      ' abc',
      'abc ',
    ])
  })

  it('pads each word separately and keeps duplicates as counts', () => {
    expect(charWbNgrams('ab ab')).toEqual([
      ' a',
      'ab',
      'b ',
      ' ab',
      'ab ',
      ' ab ',
      ' a',
      'ab',
      'b ',
      ' ab',
      'ab ',
      ' ab ',
    ])
    expect(charWbNgrams('')).toEqual([])
  })
})

describe('normaliseMerchant', () => {
  it('transliterates German umlauts before stripping accents', () => {
    // "zürich" must become "zuerich", not "zurich": half the statements already
    // spell it out, and stripping first would lose that match.
    expect(normaliseMerchant('MIGROS MM ZÜRICH HB')).toBe('migros mm zuerich hb')
    expect(normaliseMerchant('BÄCKEREI SCHÖN & GROSS')).toBe('baeckerei schoen gross')
  })

  it('drops combining accents left by NFKD', () => {
    expect(normaliseMerchant('Café Sprüngli')).toBe('cafe spruengli')
    expect(normaliseMerchant('CRÈME & CIE — BÜLACH')).toBe('creme cie buelach')
  })

  it('deletes dates, times, reference ids and long digit runs', () => {
    expect(normaliseMerchant('Café Sprüngli 12.03.2026')).toBe('cafe spruengli')
    expect(normaliseMerchant('Zürich HB, 14:05 Kd:99')).toBe('zuerich hb')
    expect(normaliseMerchant('COOP PRONTO NR. 4471 8829')).toBe('coop pronto')
    // Short digit runs are not ids and stay: "coop 2000" is a shop, not a card.
    expect(normaliseMerchant('COOP 200')).toBe('coop 200')
  })

  it('collapses everything else to single-space-separated tokens', () => {
    expect(normaliseMerchant('  SBB   CFF/FFS  ')).toBe('sbb cff ffs')
    expect(normaliseMerchant('')).toBe('')
  })
})

describe('crc32 matches zlib.crc32', () => {
  it('reproduces the published check values', () => {
    expect(crc32(Buffer.from('', 'utf8'))).toBe(0)
    // The CRC-32 "check" value from the IEEE 802.3 / zlib test vector.
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926)
    expect(crc32Utf8('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339)
  })

  it('returns unsigned values for inputs whose high bit is set', () => {
    // Python 2 returned this as a negative number; Python 3 does not, and neither
    // may we — a signed result would land in a different bucket.
    expect(crc32Utf8('a')).toBe(0xe8b7be43)
    expect(crc32Utf8(' a ')).toBeGreaterThan(0)
    expect(crc32Utf8('zuerich')).toBeGreaterThanOrEqual(0)
  })

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // 'ü' is one code unit in UTF-16 and two bytes in UTF-8; a charCodeAt-based
    // implementation would produce the checksum of 0xFC instead of 0xC3 0xBC.
    expect(crc32Utf8('ü')).toBe(crc32(Buffer.from([0xc3, 0xbc])))
    expect(crc32Utf8('ü')).not.toBe(crc32(Buffer.from([0xfc])))
  })
})

describe('hashedNgramIds', () => {
  it('L2-normalises the counts', () => {
    const vector = hashedNgramIds(charWbNgrams(normaliseMerchant('migros')), 65_536)
    let sumOfSquares = 0
    for (const value of vector.values()) sumOfSquares += value * value
    expect(sumOfSquares).toBeCloseTo(1, 12)
  })

  it('returns an empty vector rather than NaNs when there is nothing to hash', () => {
    expect(hashedNgramIds([], 65_536).size).toBe(0)
  })
})

describe('numericFeatures', () => {
  it('reads whenISO as local wall-clock in the contracted order', () => {
    // 2026-03-14 is a Saturday, so dow = 5, is_weekend = 1; 20:15 is evening.
    const [logAmount, isWeekend, isEvening, hourSin, hourCos, dowSin, dowCos] = numericFeatures(
      148.5,
      '2026-03-14T20:15',
    )
    expect(logAmount).toBeCloseTo(Math.log1p(148.5), 12)
    expect(isWeekend).toBe(1)
    expect(isEvening).toBe(1)
    expect(hourSin).toBeCloseTo(Math.sin((2 * Math.PI * 20.25) / 24), 12)
    expect(hourCos).toBeCloseTo(Math.cos((2 * Math.PI * 20.25) / 24), 12)
    expect(dowSin).toBeCloseTo(Math.sin((2 * Math.PI * 5) / 7), 12)
    expect(dowCos).toBeCloseTo(Math.cos((2 * Math.PI * 5) / 7), 12)
  })

  it('treats a missing time as 12:00 and a negative amount as zero', () => {
    expect(numericFeatures(-5, '2026-03-16')).toEqual(numericFeatures(0, '2026-03-16T12:00'))
    const [, isWeekend, isEvening] = numericFeatures(10, '2026-03-16')
    expect(isWeekend).toBe(0)
    expect(isEvening).toBe(0)
  })
})

describe('scoring and ranking (CONTRACTS §2.5)', () => {
  /**
   * A head whose coefficients are all zero, so the logits are exactly the
   * intercepts. Everything below is about what `scoreHead` and `topScored` do
   * with a given set of logits, which the 60 fixture rows cannot pin down: they
   * only ever produce the well-behaved, untied logits of a trained model.
   */
  function headOf(intercepts: number[]): Head {
    const columns = 1 + N_NUMERIC
    return {
      labels: intercepts.map((_, index) => `L${index}`),
      intercept: Float64Array.from(intercepts),
      coef: new Float32Array(intercepts.length * columns),
      rows: intercepts.length,
      columns,
    }
  }

  const noBuckets = new Map<number, number>()
  const noNumeric = new Float64Array(N_NUMERIC)

  it('subtracts the max before exp, so a confident head does not come back NaN', () => {
    // Without the subtraction this is exp(900) / (exp(900) + …) = Infinity /
    // Infinity = NaN, and every probability in the distribution is lost.
    const probabilities = scoreHead(headOf([900, 100, -900]), noBuckets, noNumeric, 1)

    expect(probabilities.every(Number.isFinite)).toBe(true)
    expect(probabilities.reduce((total, value) => total + value, 0)).toBeCloseTo(1, 12)
    expect(probabilities[0]).toBeCloseTo(1, 12)
  })

  it('reproduces sklearn’s binary predict_proba from the [0, w] expansion', () => {
    // The dormant path of §2.5. `export_ts.py` expands a two-class head into rows
    // [0, w], and softmax([0, z]) must therefore be [1 - sigmoid(z), sigmoid(z)].
    // The symmetric-looking [-w, +w] would score sigmoid(2z) instead — the right
    // label with the wrong confidence — and no shipped head is binary today, so
    // the parity fixture cannot notice.
    for (const z of [-3, -0.5, 0, 0.5, 3, 20]) {
      const [pZero, pOne] = scoreHead(headOf([0, z]), noBuckets, noNumeric, 1)
      const sigmoid = 1 / (1 + Math.exp(-z))

      expect(pOne).toBeCloseTo(sigmoid, 12)
      expect(pZero).toBeCloseTo(1 - sigmoid, 12)
    }
  })

  it('breaks probability ties on the label ascending, exactly as _top does', () => {
    // `_top` in ml/predict.py sorts on `(-p, label)`. Without the label half, two
    // labels on the same probability could come back in either order and the
    // fixture would be flaky rather than wrong.
    expect(topScored(['Travel', 'Cafes', 'Dining', 'Gifts'], [0.25, 0.25, 0.25, 0.25])).toEqual([
      { label: 'Cafes', p: 0.25 },
      { label: 'Dining', p: 0.25 },
      { label: 'Gifts', p: 0.25 },
    ])
  })

  it('ranks on unrounded probabilities, so round6 can never reorder the list', () => {
    // Both round to 0.123456, but 'b' is genuinely ahead. Sorting after rounding
    // would call it a tie and hand the win to 'a' on the label tie-break.
    const top = topScored(['a', 'b'], [0.1234561, 0.1234562])

    expect(top.map(entry => entry.label)).toEqual(['b', 'a'])
    expect(top.map(entry => entry.p)).toEqual([0.123456, 0.123456])
  })

  it('returns min(3, nClasses) entries for a head with fewer than three labels', () => {
    expect(topScored(['everyday', 'trip'], [0.4, 0.6])).toEqual([
      { label: 'trip', p: 0.6 },
      { label: 'everyday', p: 0.4 },
    ])
  })
})

describe('the CLASSIFIER_URL escape hatch (CONTRACTS §5)', () => {
  interface Capture {
    headers: Record<string, string | string[] | undefined>
    body: string
  }

  let server: Server
  let url = ''
  let captured: Capture | null = null
  let status = 200
  let responseBody = ''

  const savedEnv = {
    url: process.env.CLASSIFIER_URL,
    token: process.env.CLASSIFIER_TOKEN,
    group: process.env.CLASSIFIER_RESOURCE_GROUP,
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        captured = { headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(responseBody)
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')
    url = `http://127.0.0.1:${address.port}/classify`
  })

  afterAll(async () => {
    await new Promise<void>((done, fail) => {
      server.close(error => (error === undefined ? done() : fail(error)))
    })
    restore('CLASSIFIER_URL', savedEnv.url)
    restore('CLASSIFIER_TOKEN', savedEnv.token)
    restore('CLASSIFIER_RESOURCE_GROUP', savedEnv.group)
  })

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  /** The request the stub server last received, or a failure saying it got none. */
  function lastRequest(): Capture {
    if (captured === null) throw new Error('the stub classifier received no request')
    return captured
  }

  beforeEach(() => {
    captured = null
    status = 200
    responseBody = ''
    process.env.CLASSIFIER_URL = url
    process.env.CLASSIFIER_TOKEN = 'test-token'
    process.env.CLASSIFIER_RESOURCE_GROUP = 'twoway'
  })

  it('posts the contracted body with both headers and reports engine remote', async () => {
    const remote: ClassifyResult = {
      category: 'Travel',
      categoryConfidence: 0.812345,
      categoryTop3: [
        { label: 'Travel', p: 0.812345 },
        { label: 'Transport', p: 0.1 },
        { label: 'Dining', p: 0.087655 },
      ],
      moment: 'trip',
      momentConfidence: 0.7,
      momentTop3: [
        { label: 'trip', p: 0.7 },
        { label: 'everyday', p: 0.2 },
        { label: 'date_night', p: 0.1 },
      ],
      // The sidecar has no way of knowing it was called remotely, so it reports
      // 'local'; `classify` must overwrite that with where *this* process got
      // its answer.
      engine: 'local',
    }
    responseBody = JSON.stringify(remote)

    const result = await classify('HOTEL SEEBLICK', 240, '2026-07-02T15:00')

    expect(result).toEqual({ ...remote, engine: 'remote' })
    const request = lastRequest()
    expect(JSON.parse(request.body)).toEqual({
      merchantRaw: 'HOTEL SEEBLICK',
      amount: 240,
      whenISO: '2026-07-02T15:00',
    })
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['ai-resource-group']).toBe('twoway')
  })

  it('omits the optional headers when their env vars are unset', async () => {
    delete process.env.CLASSIFIER_TOKEN
    delete process.env.CLASSIFIER_RESOURCE_GROUP
    responseBody = JSON.stringify(await withLocalClassifier())

    await classify('SBB CFF FFS', 32.87, '2026-07-02T15:00')

    const request = lastRequest()
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['ai-resource-group']).toBeUndefined()
  })

  it.each([
    ['an error status', 503, ''],
    ['a non-JSON body', 200, 'not json at all'],
    ['a response missing required fields', 200, '{"category":"Travel"}'],
    ['a probability outside 0..1', 200, '{"category":"Travel","categoryConfidence":4}'],
  ])('falls back to local inference on %s', async (_case, code, body) => {
    status = code
    responseBody = body
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(message => {
      warnings.push(String(message))
    })

    const row = fixture.rows[0]
    const result = await classify(row.merchantRaw, row.amount, row.whenISO)

    warn.mockRestore()
    expect(result.engine).toBe('local')
    expect(result.category).toBe(row.expected.category)
    expect(warnings).toHaveLength(1)
    // The warning explains itself without quoting the payload: a classify body is
    // a merchant name, an amount and a timestamp, i.e. where the people who live here
    // were and what they spent.
    expect(warnings[0]).toContain('remote classify failed')
    expect(warnings[0]).not.toContain(row.merchantRaw)
    expect(warnings[0]).not.toContain(String(row.amount))
  })

  it('never contacts the remote when CLASSIFIER_URL is blank', async () => {
    process.env.CLASSIFIER_URL = '   '
    const row = fixture.rows[0]

    const result = await classify(row.merchantRaw, row.amount, row.whenISO)

    expect(result.engine).toBe('local')
    expect(captured).toBeNull()
  })

  /** A real local answer, reused as a plausible remote payload. */
  async function withLocalClassifier(): Promise<ClassifyResult> {
    const saved = process.env.CLASSIFIER_URL
    delete process.env.CLASSIFIER_URL
    try {
      return await classify('SBB CFF FFS', 32.87, '2026-07-02T15:00')
    } finally {
      if (saved !== undefined) process.env.CLASSIFIER_URL = saved
    }
  }
})

describe('weights are read lazily and cached', () => {
  /**
   * `require`-ing the classifier happens as a side effect of loading a CAP
   * handler, long before anything is classified. Reading and decoding 4.7 MiB of
   * base64 at that moment would show up as startup latency on every process that
   * merely *might* classify something. Proven with a fresh module registry and a
   * counting `readFileSync`, because the assertion is about *when* the read
   * happens, not about what it returns.
   */
  it('reads weights.json on first use, once, and again after reloadModel()', async () => {
    const reads: string[] = []
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
          reads.push(String(args[0]))
          return actual.readFileSync(...args)
        },
      }
    })
    try {
      const classifier = await import('../srv/lib/classifier/index.js')
      expect(weightsReads(reads)).toBe(0)

      classifier.classifyLocal('MIGROS MM ZUERICH HB', 42, '2026-03-14T20:15')
      expect(weightsReads(reads)).toBe(1)

      classifier.classifyLocal('SBB CFF FFS', 12, '2026-03-15T09:00')
      expect(weightsReads(reads)).toBe(1)

      classifier.reloadModel()
      classifier.classifyLocal('SBB CFF FFS', 12, '2026-03-15T09:00')
      expect(weightsReads(reads)).toBe(2)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  function weightsReads(reads: readonly string[]): number {
    return reads.filter(path => path.endsWith('weights.json')).length
  }
})
