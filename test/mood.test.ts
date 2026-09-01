/*
 * The mood tracker, at the two layers that can be tested without an Anthropic key.
 *
 * The camera-to-model round trip itself is not exercised — it needs a live key, and the
 * receipt reader's tests explain why a mocked SDK would prove nothing. What is worth
 * pinning is the contract either side of it:
 *
 *  1. **`detectMood` without a key is a 501 with a sentence, never a stub reading.** A
 *     made-up mood presented like a detected one is the same silent fabrication the
 *     receipt scanner had to be cured of.
 *  2. **`detectMood` stores nothing.** The action's whole privacy promise is that the
 *     photograph is analysed and discarded; the row count proves it.
 *  3. **The `Moods` entity round-trips** — a tapped-in reading saves and lists.
 *  4. **`clampReading` cannot be widened by a schema edit** — it is the last line before a
 *     database write, and it holds the 1..5 and 0..1 bounds on its own.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import LedgerServiceImpl from '../srv/ledger-service'
import { clampReading, detectMood, moodDetectionConfigured } from '../srv/lib/mood'

// Only the model call is replaced; the configuration check and the clamp stay real. The
// tests below are about what the *handler* does with an answer, not about the model.
vi.mock('../srv/lib/mood', async importOriginal => ({
  ...(await importOriginal<typeof import('../srv/lib/mood')>()),
  detectMood: vi.fn(),
}))

const { SELECT } = cds.ql

const MOODS = 'LedgerService.Moods'

interface CdsBootstrap {
  deploy(model: cds.csn.CSN): {
    to(target: unknown, options?: { silent?: boolean }): Promise<Service>
  }
  serve(name: string): {
    from(model: ReturnType<typeof cds.compile.for.nodejs>): {
      with(impl: unknown): Promise<Service>
    }
  }
}

const bootstrap = cds as unknown as CdsBootstrap

let ledger: Service
let db: Service
let csn: cds.csn.CSN

beforeAll(async () => {
  cds.root = process.cwd()
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }

  csn = await cds.load(['db', 'srv'])
  const compiled = cds.compile.for.nodejs(csn)
  cds.model = compiled
  db = await bootstrap.deploy(csn).to('db', { silent: true })
  ledger = await bootstrap.serve('LedgerService').from(compiled).with(LedgerServiceImpl)
})

beforeEach(async () => {
  await bootstrap.deploy(csn).to(db, { silent: true })
})

describe('moodDetectionConfigured', () => {
  const saved = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  it('is false with no key or a blank one, true with one', () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(moodDetectionConfigured()).toBe(false)
    process.env.ANTHROPIC_API_KEY = '  '
    expect(moodDetectionConfigured()).toBe(false)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key'
    expect(moodDetectionConfigured()).toBe(true)
  })
})

describe('clampReading', () => {
  it('holds the bounds on its own, whatever the schema said', () => {
    const wild = clampReading({
      faceFound: true,
      level: 11,
      label: 'x'.repeat(200),
      confidence: 3.7,
      observation: 'y'.repeat(500),
    })
    expect(wild.level).toBe(5)
    expect(wild.confidence).toBe(1)
    expect(wild.label).toHaveLength(60)
    expect(wild.observation).toHaveLength(280)

    const low = clampReading({
      faceFound: true,
      level: 0,
      label: 'flat',
      confidence: -1,
      observation: 'ok',
    })
    expect(low.level).toBe(1)
    expect(low.confidence).toBe(0)
  })
})

describe('the Moods entity', () => {
  it('refuses a level off the 1..5 scale, and a source it has no word for', async () => {
    const base = { at: new Date().toISOString(), note: null }
    await expect(ledger.create(MOODS).entries({ ...base, level: 0 })).rejects.toMatchObject({
      code: 'ASSERT_RANGE',
      status: 400,
    })
    await expect(ledger.create(MOODS).entries({ ...base, level: 9 })).rejects.toMatchObject({
      code: 'ASSERT_RANGE',
      status: 400,
    })
    await expect(ledger.create(MOODS).entries({ ...base })).rejects.toMatchObject({
      code: 'ASSERT_MANDATORY',
      status: 400,
    })
    await expect(
      ledger.create(MOODS).entries({ ...base, level: 3, source: 'guess' }),
    ).rejects.toMatchObject({ code: 'ASSERT_ENUM', status: 400 })

    const rows = (await ledger.run(SELECT.from(MOODS))) as unknown[]
    expect(rows).toHaveLength(0)
  })

  it('round-trips a tapped-in reading', async () => {
    await ledger.create(MOODS).entries({
      at: new Date().toISOString(),
      level: 4,
      note: 'good coffee, better company',
      source: 'manual',
    })

    const rows = (await ledger.run(SELECT.from(MOODS))) as {
      ID?: string
      level?: number
      note?: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].ID).toBeTruthy()
    expect(rows[0].level).toBe(4)
    expect(rows[0].note).toBe('good coffee, better company')
  })
})

describe('detectMood without a key', () => {
  const saved = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  it('answers 501 with a sentence, and never a stub reading', async () => {
    delete process.env.ANTHROPIC_API_KEY

    await expect(
      ledger.send('detectMood', { image: Buffer.from('x').toString('base64'), mediaType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 501 })
  })

  it('stores nothing, even on the failure path', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await ledger
      .send('detectMood', { image: Buffer.from('x').toString('base64'), mediaType: 'image/jpeg' })
      .catch(() => {
        /* the rejection is the previous test's concern */
      })

    const rows = (await ledger.run(SELECT.from(MOODS))) as unknown[]
    expect(rows).toHaveLength(0)
  })
})

describe('detectMood with a key', () => {
  const saved = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key'
    vi.mocked(detectMood).mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  /** A small, real JPEG — the handler decodes and re-encodes before the model sees it. */
  async function selfie(): Promise<string> {
    const bytes = await sharp({
      create: { width: 320, height: 400, channels: 3, background: { r: 230, g: 200, b: 180 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer()
    return bytes.toString('base64')
  }

  it('answers "no face" as a 422, not as a 502 about the model', async () => {
    vi.mocked(detectMood).mockResolvedValueOnce({
      faceFound: false,
      level: 3,
      label: '',
      confidence: 0,
      observation: '',
    })

    await expect(
      ledger.send('detectMood', { image: await selfie(), mediaType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 422, message: expect.stringMatching(/No face/) })
  })

  it('hands a reading through unchanged, and still stores nothing', async () => {
    vi.mocked(detectMood).mockResolvedValueOnce({
      faceFound: true,
      level: 4,
      label: 'content',
      confidence: 0.8,
      observation: 'A calm, easy look.',
    })

    const reading = (await ledger.send('detectMood', {
      image: await selfie(),
      mediaType: 'image/jpeg',
    })) as Record<string, unknown>
    expect(reading).toMatchObject({ level: 4, label: 'content', confidence: 0.8 })

    const rows = (await ledger.run(SELECT.from(MOODS))) as unknown[]
    expect(rows).toHaveLength(0)
  })

  it('turns a model failure into a 502 with the reason', async () => {
    vi.mocked(detectMood).mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      ledger.send('detectMood', { image: await selfie(), mediaType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 502, message: expect.stringMatching(/rate limited/) })
  })
})
