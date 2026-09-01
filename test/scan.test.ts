/// <reference types="@cap-js/cds-types" />
/**
 * `scanReceipt` — the whole pipeline, end to end, with no BTP account.
 *
 * `MOCK_DOCAI=1` puts `srv/lib/documentai` into mock mode, where it replays the
 * bundled fixtures and picks one by file-name keyword (CONTRACTS §6): `migros`,
 * `hotel`, or the restaurant receipt for anything else. Everything else in the
 * chain is real — a real JPEG through `sharp`, a real row in a real database, a
 * real run of the trained classifier — so what these tests exercise is the
 * handler's own wiring rather than a set of stubs agreeing with each other.
 *
 * The bootstrap mirrors `test/ledger-service.test.ts`: in-process service,
 * throwaway in-memory SQLite, seed reloaded before every test.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import LedgerServiceImpl from '../srv/ledger-service'
import { CATEGORY_CODES, NEEDS_REVIEW_THRESHOLD } from '../srv/lib/constants'
import { MAX_UPLOAD_BYTES } from '../srv/lib/images'

// Set before anything reads it: `getDocAiClient()` resolves its mode from the
// environment on every call, and mock mode is what makes this file runnable.
process.env.MOCK_DOCAI = '1'

const { SELECT } = cds.ql

const EXPENSES = 'LedgerService.Expenses'
const RECEIPTS = 'LedgerService.Receipts'

/** The seed stops at document 19, so a scanned draft posts as 20. */
const NEXT_DOCUMENT_NUMBER = 20

interface DraftRow {
  ID?: string
  date?: string | null
  time?: string | null
  merchantRaw?: string | null
  merchantNorm?: string | null
  amount?: number | string | null
  currency?: string | null
  category_code?: string | null
  categoryConfidence?: number | string | null
  moment?: string | null
  momentConfidence?: number | string | null
  place?: string | null
  status?: string | null
  source?: string | null
  documentNumber?: number | null
  receipt_ID?: string | null
  paidBy_ID?: string | null
  event_ID?: string | null
  needsReview?: boolean
}

interface ReceiptRow {
  ID?: string
  fileName?: string | null
  mediaType?: string | null
  docaiJobId?: string | null
  extraction?: string | null
  extractionStatus?: string | null
}

/**
 * `cds.deploy(...)` and `cds.serve(...).with(<service class>)` are both real,
 * documented API, but neither is declared by `@cap-js/cds-types` 0.19. Rather
 * than reach for `any`, the two calls are typed here with the exact shape this
 * file uses, and nothing more.
 */
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

/** A small, real, EXIF-free photo of nothing in particular. */
async function makeImage(format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const canvas = sharp({
    create: { width: 800, height: 1200, channels: 3, background: { r: 250, g: 250, b: 246 } },
  })
  return format === 'jpeg' ? canvas.jpeg({ quality: 90 }).toBuffer() : canvas.png().toBuffer()
}

async function scan(
  fileName: string,
  options: { mediaType?: string; image?: unknown; format?: 'jpeg' | 'png' } = {},
): Promise<DraftRow> {
  const image = 'image' in options ? options.image : await makeImage(options.format ?? 'jpeg')
  return (await ledger.send('scanReceipt', {
    image,
    mediaType: options.mediaType ?? (options.format === 'png' ? 'image/png' : 'image/jpeg'),
    fileName,
  })) as DraftRow
}

async function readReceipt(ID: string): Promise<ReceiptRow> {
  return (await db.run(
    SELECT.one
      .from(RECEIPTS)
      .columns('ID', 'fileName', 'mediaType', 'docaiJobId', 'extraction', 'extractionStatus')
      .where({ ID }),
  )) as ReceiptRow
}

beforeAll(async () => {
  cds.root = process.cwd()
  // Point the *configured* database at memory before anything can connect to
  // it. `package.json` names `db.sqlite`, and a test that so much as opens the
  // developer's dev database is a test with a loaded gun in it.
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

describe('scanReceipt() in mock mode', () => {
  it('turns a photo into a classified draft expense', async () => {
    const draft = await scan('dinner-2026-03-14.jpg')

    // Everything the restaurant fixture carries, mapped onto the ledger.
    expect(draft.merchantRaw).toBe('RESTAURANT BLAUE ENTE')
    expect(Number(draft.amount)).toBe(148.5)
    expect(draft.currency).toBe('CHF')
    expect(draft.date).toBe('2026-03-14')
    expect(draft.time).toBe('20:15:00')
    expect(draft.place).toBe('Zürich')

    // It is a draft: unposted, no document number, sourced from a scan.
    expect(draft.status).toBe('draft')
    expect(draft.source).toBe('scan')
    expect(draft.documentNumber).toBeNull()

    // And it has been classified, not left blank for the human.
    expect(draft.category_code).toBe('Dining')
    expect(CATEGORY_CODES).toContain(draft.category_code)
    expect(draft.merchantNorm).toBe('restaurant blaue ente')
    expect(draft.moment).toBeTruthy()
    expect(Number(draft.categoryConfidence)).toBeGreaterThan(NEEDS_REVIEW_THRESHOLD)
  })

  it('leaves the draft attributed to nobody and attached to nothing', async () => {
    const draft = await scan('dinner-2026-03-14.jpg')

    // A receipt says what was bought, never who paid for it or what it was part
    // of (CONTRACTS §10). Both are the human's to fill in on the review screen,
    // so the scan leaves them empty rather than guessing at a person or a trip.
    expect(draft.paidBy_ID).toBeNull()
    expect(draft.event_ID).toBeNull()
  })

  it('keeps the receipt, its job id and the raw extraction', async () => {
    const draft = await scan('dinner-2026-03-14.jpg')
    expect(draft.receipt_ID).toBeTruthy()

    const receipt = await readReceipt(String(draft.receipt_ID))
    expect(receipt.fileName).toBe('dinner-2026-03-14.jpg')
    expect(receipt.extractionStatus).toBe('mock')
    expect(receipt.docaiJobId).toMatch(/^mock-/)

    // Verbatim, so a mapper fix can be replayed without re-uploading anything.
    const raw: unknown = JSON.parse(String(receipt.extraction))
    expect(raw).toMatchObject({ status: 'DONE', documentType: 'invoice' })
  })

  it('re-encodes whatever was uploaded into a stripped JPEG', async () => {
    // A PNG in, a JPEG out: the stored media type proves the image went through
    // `processReceiptImage`, which is the step that drops EXIF (GPS, device
    // serial, capture time) before anything reaches the database.
    const draft = await scan('dinner.png', { format: 'png' })
    const receipt = await readReceipt(String(draft.receipt_ID))

    expect(receipt.mediaType).toBe('image/jpeg')
  })

  it('accepts the base64 an OData client sends', async () => {
    const image = await makeImage()
    const draft = await scan('dinner.jpg', { image: image.toString('base64') })

    expect(draft.merchantRaw).toBe('RESTAURANT BLAUE ENTE')
  })

  it('picks its fixture by file name, as the mock contract promises', async () => {
    const groceries = await scan('migros-2026-03-07.jpg')

    expect(groceries.merchantRaw).toBe('MIGROS Zürich Löwenstrasse')
    expect(Number(groceries.amount)).toBe(47.85)
    expect(groceries.category_code).toBe('Groceries')
  })

  it('posts the draft it produced, with the next document number', async () => {
    const draft = await scan('dinner-2026-03-14.jpg')

    const posted = (await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: draft.category_code ?? '',
      predictedMoment: draft.moment ?? '',
    })) as DraftRow

    expect(posted.status).toBe('confirmed')
    expect(posted.documentNumber).toBe(NEXT_DOCUMENT_NUMBER)
  })
})

describe('scanReceipt() and the needsReview flag', () => {
  it('flags a receipt whose extraction is not confident enough', async () => {
    // The hotel invoice has no city field, so `place` is read out of
    // `senderAddress` — which the fixture scored at 0.571, below the 0.6
    // threshold of CONTRACTS §1.4. That is the whole point of the flag.
    const draft = await scan('hotel-konstanz.jpg')

    expect(draft.merchantRaw).toBe('Hotel Rheinblick Konstanz GmbH')
    expect(Number(draft.amount)).toBe(1234.5)
    expect(draft.currency).toBe('EUR')
    expect(draft.date).toBe('2026-02-12')
    expect(draft.needsReview).toBe(true)
  })

  it('does not flag a receipt every model was sure about', async () => {
    const draft = await scan('migros-2026-03-07.jpg')

    // Every scored field on the Migros fixture is ≥ 0.774, and both classifier
    // heads clear the bar for a supermarket on a Saturday evening.
    expect(draft.needsReview).toBe(false)
  })

  it('always returns the flag, so the UI never has to guess', async () => {
    const draft = await scan('dinner-2026-03-14.jpg')

    expect(typeof draft.needsReview).toBe('boolean')
  })
})

describe('scanReceipt() rejections', () => {
  it('refuses an upload larger than 10 MB rather than shrinking it', async () => {
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x4a)

    await expect(scan('huge.jpg', { image: tooBig })).rejects.toThrow(/the limit is/)
  })

  it('refuses something that is not an image', async () => {
    await expect(
      scan('receipt.pdf', { image: Buffer.from('%PDF-1.7'), mediaType: 'application/pdf' }),
    ).rejects.toThrow(/is not an image/)
  })

  it('refuses bytes it cannot decode', async () => {
    await expect(
      scan('broken.jpg', { image: Buffer.from('this is not a JPEG at all') }),
    ).rejects.toThrow(/could not read this image/)
  })

  it('refuses a call with no image at all', async () => {
    await expect(scan('nothing.jpg', { image: null })).rejects.toThrow(/needs the receipt image/)
  })

  it('names the parameter a caller forgot instead of blaming the image', async () => {
    // Without this guard the message comes back from `processReceiptImage` as
    // the sentence " is not an image", which tells someone who simply left
    // `mediaType` out of the payload nothing about what to send instead.
    await expect(scan('untyped.jpg', { mediaType: '' })).rejects.toThrow(
      /needs the media type of the image in the "mediaType" parameter/,
    )
    await expect(scan('untyped.jpg', { mediaType: '   ' })).rejects.toThrow(
      /needs the media type of the image/,
    )
  })

  it('leaves no half-scanned expense behind when it refuses', async () => {
    const before = (await db.run(SELECT.from(EXPENSES))) as DraftRow[]

    await expect(
      scan('receipt.pdf', { image: Buffer.from('%PDF'), mediaType: 'application/pdf' }),
    ).rejects.toThrow()

    const after = (await db.run(SELECT.from(EXPENSES))) as DraftRow[]
    expect(after).toHaveLength(before.length)
  })
})
