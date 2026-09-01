/*
 * Reading a receipt with Claude, when there is no BTP account to read it with.
 *
 * This is the third implementation of {@link DocAiClient}, alongside the live SAP Document
 * AI client and the fixture mock. It exists because the mock is not an extractor: it
 * replays a bundled sample chosen by *file name*, so a photo off a phone camera always
 * comes back with the same merchant and the same total no matter what was photographed.
 * That is fine for developing the flow and useless for actually keeping a ledger.
 *
 * The shape of the answer is deliberately the *same shape Document AI returns* — header
 * fields with `name`/`value`, line items with `description`/`netAmount` — so everything
 * downstream is untouched: `mapper.ts` normalises it, `parseAmount` handles the Swiss and
 * German number formats (including `3.-`, which means three francs), and the scan handler,
 * the classifier and the UI never learn that a different engine read the picture.
 *
 * Two consequences of that choice worth stating plainly:
 *
 *  - **Amounts come back as the receipt printed them**, as a string, not as a number the
 *    model normalised. `parseAmount` is tested against two dozen real-world formats and the
 *    model is not; asking the model to also be a number parser would move a solved problem
 *    into the part of the system that cannot be unit-tested.
 *  - **Nothing here trusts the model.** The tool call is forced, but the arguments that come
 *    back are still validated field by field before they are turned into a job result. A
 *    hallucinated shape degrades to a missing field, which the mapper already flags for
 *    review, rather than to a crash or a silently wrong posting.
 */
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import type { DocAiClient, DocAiJobResult } from './types'

/** Exact, and carries no date suffix — the same rule CONTRACTS.md §7 states for the LLM. */
const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Reasoning effort.
 *
 * `low` on purpose. This is a bounded extraction from one image, not a problem that repays
 * deliberation, and the latency is spent standing at a till with a receipt in one hand —
 * the case the whole scan flow is designed around. `ANTHROPIC_EXTRACT_EFFORT` raises it for
 * anyone who would rather wait than re-key a total.
 */
const DEFAULT_EFFORT = 'low'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

/** Enough for a long supermarket receipt's line items and nothing like enough to run away. */
const MAX_TOKENS = 4096

const TOOL_NAME = 'record_receipt'

const SYSTEM = [
  'You read photographs of receipts and invoices and report exactly what is printed on them.',
  '',
  'Rules:',
  '- Report the amount actually charged: the final total, after discounts and including tax.',
  '  Not the subtotal, not the tax line, not a single item, not the cash tendered or change.',
  '- Copy every amount EXACTLY as printed, as a string, including the separators the receipt',
  "  uses. Swiss receipts write 1'234.50 and often write whole francs as 3.- — keep both",
  '  forms verbatim. Do not convert, round, or reformat anything.',
  '- The date must be ISO 8601, YYYY-MM-DD. If the receipt shows a two-digit year, expand it',
  '  to the most recent plausible year, never a future one.',
  '- The merchant is the business that was paid, as printed — not a branch number, not a',
  '  slogan, not the payment terminal or acquirer.',
  '- If a field is genuinely not legible or not present, omit it. An omitted field is',
  '  flagged for a human; a guessed one is a wrong ledger entry that nobody notices.',
].join('\n')

/** The schema the model fills in. Mirrors the header fields the mapper already looks for. */
const TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    merchant: { type: 'string', description: 'The business that was paid, as printed.' },
    documentDate: { type: 'string', description: 'Date on the receipt, as YYYY-MM-DD.' },
    total: {
      type: 'string',
      description: 'The final amount charged, copied exactly as printed (e.g. "47.85", "3.-").',
    },
    currency: { type: 'string', description: 'ISO 4217 code, e.g. CHF or EUR.' },
    lineItems: {
      type: 'array',
      description: 'Individual purchased lines, if the receipt itemises them.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'string', description: 'Line amount, exactly as printed.' },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  },
  required: ['total'],
  additionalProperties: false,
}

/** What the model is asked to return, before any of it has been believed. */
interface ExtractedReceipt {
  merchant?: string
  documentDate?: string
  total?: string
  currency?: string
  lineItems?: { description?: string; amount?: string }[]
}

/** True when an `ANTHROPIC_API_KEY` is available to read receipts with. */
export function llmExtractionConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== ''
}

function chosenEffort(): Effort {
  const raw = (process.env.ANTHROPIC_EXTRACT_EFFORT ?? '').trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(raw) ? (raw as Effort) : DEFAULT_EFFORT
}

/** A trimmed non-empty string, or undefined. Anything else the model sent is discarded. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The model's arguments, validated into the narrow shape the rest of this file uses.
 *
 * Field by field rather than with a cast: a forced tool call constrains the *name* of what
 * comes back, not its contents, and this is the boundary where an unverified value stops
 * being unverified.
 */
function validate(input: unknown): ExtractedReceipt {
  if (typeof input !== 'object' || input === null) return {}
  const raw = input as Record<string, unknown>

  const items = Array.isArray(raw.lineItems) ? raw.lineItems : []
  const lineItems = items
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({ description: text(item.description), amount: text(item.amount) }))
    .filter(item => item.description !== undefined || item.amount !== undefined)

  return {
    merchant: text(raw.merchant),
    documentDate: text(raw.documentDate),
    total: text(raw.total),
    currency: text(raw.currency),
    lineItems: lineItems.length > 0 ? lineItems : undefined,
  }
}

/**
 * Dress the extraction as a Document AI job result.
 *
 * The field names are the ones `mapper.ts` already searches for (`senderName`,
 * `documentDate`, `grossAmount`, `currencyCode`, `netAmount`), so the mapper needs no
 * branch for where the values came from.
 *
 * `confidence` is deliberately absent rather than invented. The mapper treats a missing
 * confidence as "unknown" and the review logic errs toward asking; a number made up here
 * would be a fabricated measurement, and it would be believed.
 */
export function toJobResult(jobId: string, extracted: ExtractedReceipt): DocAiJobResult {
  const headerFields = [
    { name: 'senderName', value: extracted.merchant },
    { name: 'documentDate', value: extracted.documentDate },
    { name: 'grossAmount', value: extracted.total },
    { name: 'currencyCode', value: extracted.currency },
  ].filter((field): field is { name: string; value: string } => field.value !== undefined)

  const lineItems = (extracted.lineItems ?? []).map(item =>
    [
      { name: 'description', value: item.description },
      { name: 'netAmount', value: item.amount },
    ].filter((field): field is { name: string; value: string } => field.value !== undefined),
  )

  return {
    id: jobId,
    status: 'DONE',
    documentType: 'receipt',
    extraction: { headerFields, lineItems },
  }
}

interface PendingJob {
  result: DocAiJobResult
}

/**
 * Ask Claude to read one receipt.
 *
 * The tool call is forced, so the model answers in the schema or not at all — there is no
 * prose to parse and no JSON to fish out of a code fence. Thinking is left adaptive, which
 * is the only supported form on this model; `effort` is what actually decides how long it
 * spends, and it is low by default. See {@link DEFAULT_EFFORT}.
 */
async function extract(image: Buffer, mimeType: string, model: string): Promise<ExtractedReceipt> {
  const client = new Anthropic()

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { effort: chosenEffort() },
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the fields printed on this receipt.',
        input_schema: TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              // The scan handler normalises every upload to JPEG before this is reached;
              // the parameter is honoured anyway so the client is usable on its own.
              media_type: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
              data: image.toString('base64'),
            },
          },
          { type: 'text', text: 'Read this receipt.' },
        ],
      },
    ],
  })

  const call = response.content.find(block => block.type === 'tool_use' && block.name === TOOL_NAME)
  if (call === undefined || call.type !== 'tool_use') {
    throw new Error(
      `Claude returned no ${TOOL_NAME} call (stop_reason=${response.stop_reason ?? 'unknown'})`,
    )
  }

  return validate(call.input)
}

/**
 * A {@link DocAiClient} backed by Claude.
 *
 * The job lifecycle is synchronous underneath — the extraction happens during `submitJob`
 * and `pollJob` merely hands back what it produced — because the Messages API answers in
 * one call and there is nothing to poll. The interface is kept because the scan handler,
 * the live client and the mock all speak it.
 */
export function createLlmClient(model = DEFAULT_MODEL): DocAiClient {
  const jobs = new Map<string, PendingJob>()

  const submitJob = async (image: Buffer, mimeType: string, _fileName: string): Promise<string> => {
    const jobId = `llm-${randomUUID()}`
    jobs.set(jobId, { result: toJobResult(jobId, await extract(image, mimeType, model)) })
    return jobId
  }

  const requireJob = (jobId: string): PendingJob => {
    const job = jobs.get(jobId)
    if (job === undefined) throw new Error(`no LLM extraction job ${jobId}`)
    // One read per job: the scan handler polls exactly once, and holding every receipt
    // this process has ever read would be an unbounded cache of other people's shopping.
    jobs.delete(jobId)
    return job
  }

  const getJob = async (jobId: string): Promise<unknown> => requireJob(jobId).result
  const pollJob = async (jobId: string): Promise<unknown> => requireJob(jobId).result

  return { submitJob, getJob, pollJob, mode: 'llm' }
}
