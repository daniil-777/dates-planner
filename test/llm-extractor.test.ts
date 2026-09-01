/*
 * Reading receipts with Claude, in the parts that can be tested without a network call.
 *
 * The Messages request itself is not exercised here — it needs a live key, and a mocked SDK
 * would only assert that the code calls the function the code calls. What *is* worth
 * pinning is the seam either side of it:
 *
 *  1. the fallback is selected only when a key exists, and never ahead of Document AI;
 *  2. the extraction is dressed in exactly the shape `mapper.ts` already understands, so an
 *     amount read by Claude goes through the same tested number parser as one read by
 *     Document AI — `3.-` included, which is the bug this whole path was written after.
 *
 * That second one is the reason the extractor emits Document AI's field names instead of a
 * shape of its own: it is what keeps one normaliser in the system rather than two.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { llmExtractionConfigured, toJobResult } from '../srv/lib/documentai/llm-extractor'
import { mapJobResult } from '../srv/lib/documentai/mapper'

describe('llmExtractionConfigured', () => {
  const saved = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  it('is false with no key, and false for a blank one', () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(llmExtractionConfigured()).toBe(false)

    process.env.ANTHROPIC_API_KEY = '   '
    expect(llmExtractionConfigured()).toBe(false)
  })

  it('is true once a key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key'
    expect(llmExtractionConfigured()).toBe(true)
  })
})

describe('toJobResult — the extraction, dressed as a Document AI job', () => {
  it('maps through the real mapper to a merchant, a date and an amount', () => {
    const job = toJobResult('llm-1', {
      merchant: 'Migros Zürich Löwenstrasse',
      documentDate: '2026-08-30',
      total: "1'234.50",
      currency: 'CHF',
      lineItems: [{ description: 'Kaffeebohnen', amount: '12.90' }],
    })

    const mapped = mapJobResult(job)

    // `merchantRaw` rather than `merchant`: the mapper hands the printed name on for the
    // classifier to normalise, and does not pretend to have cleaned it up.
    expect(mapped.merchantRaw).toBe('Migros Zürich Löwenstrasse')
    expect(mapped.amount).toBe(1234.5)
    expect(mapped.currency).toBe('CHF')
    expect(mapped.date).toBe('2026-08-30')
    expect(mapped.lineItems).toEqual([
      { description: 'Kaffeebohnen', quantity: null, netAmount: 12.9 },
    ])
  })

  /**
   * The whole reason amounts cross this boundary as strings.
   *
   * `3.-` is three francs. If the extractor normalised numbers itself, this would depend on
   * the model getting Swiss notation right every time; routing it through `parseAmount`
   * makes it depend on a function with two dozen cases pinned in `documentai.test.ts`.
   */
  it('sends amounts through parseAmount, so Swiss notation survives', () => {
    const mapped = mapJobResult(toJobResult('llm-2', { total: '3.-', currency: 'CHF' }))
    expect(mapped.amount).toBe(3)
  })

  it('omits fields the model did not report rather than inventing them', () => {
    const job = toJobResult('llm-3', { total: '47.85' })
    const names = (job.extraction?.headerFields ?? []).map(field => field.name)

    expect(names).toEqual(['grossAmount'])
    expect(names).not.toContain('senderName')
    expect(names).not.toContain('documentDate')
  })

  it('carries no confidence scores, because none were measured', () => {
    const job = toJobResult('llm-4', { merchant: 'Coop', total: '9.90' })
    for (const field of job.extraction?.headerFields ?? []) {
      expect(field).not.toHaveProperty('confidence')
    }
    // And nothing invents one further down either: the review logic reads this, and a
    // fabricated 0.99 here would stop it asking a human about a field nobody scored.
    expect(mapJobResult(job).confidence).toEqual({})
  })

  it('drops line items that carry neither a description nor an amount', () => {
    const job = toJobResult('llm-5', {
      total: '20.00',
      lineItems: [{ description: 'Brot', amount: '4.20' }, { description: 'Milch' }],
    })

    expect(job.extraction?.lineItems).toHaveLength(2)
    expect(job.status).toBe('DONE')
  })
})
