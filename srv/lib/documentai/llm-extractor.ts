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
 *  - **Nothing here trusts the model.** The answer arrives through structured outputs, so
 *    the SDK has already validated it against the zod schema; `tidy()` then handles content
 *    hygiene (blank strings, empty line items). A mis-shapen answer degrades to a failed or
 *    partial read the flow already handles, never to a crash or a silently wrong posting.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
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

const SCHEMA = z.object({
  merchant: z.string().optional().describe('The business that was paid, as printed.'),
  documentDate: z.string().optional().describe('Date on the receipt, as YYYY-MM-DD.'),
  total: z
    .string()
    .describe('The final amount charged, copied exactly as printed (e.g. "47.85", "3.-").'),
  currency: z.string().optional().describe('ISO 4217 code, e.g. CHF or EUR.'),
  lineItems: z
    .array(
      z.object({
        description: z.string().optional(),
        amount: z.string().optional().describe('Line amount, exactly as printed.'),
      }),
    )
    .optional()
    .describe('Individual purchased lines, if the receipt itemises them.'),
})

/** What the model returned, after zod has already thrown out anything mis-shapen. */
type ExtractedReceipt = z.infer<typeof SCHEMA>

/** True when an `ANTHROPIC_API_KEY` is available to read receipts with. */
export function llmExtractionConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== ''
}

function chosenEffort(): Effort {
  const raw = (process.env.ANTHROPIC_EXTRACT_EFFORT ?? '').trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(raw) ? (raw as Effort) : DEFAULT_EFFORT
}

/** A trimmed non-empty string, or undefined. Blank strings degrade to "not reported". */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * The parsed output, tidied. zod already enforced the *shape*; what is left is content
 * hygiene — blank strings become omissions, and a line item carrying neither a description
 * nor an amount is dropped rather than rendered as an empty row someone has to delete.
 */
function tidy(raw: ExtractedReceipt): ExtractedReceipt {
  const lineItems = (raw.lineItems ?? [])
    .map(item => ({ description: text(item.description), amount: text(item.amount) }))
    .filter(item => item.description !== undefined || item.amount !== undefined)

  return {
    merchant: text(raw.merchant),
    documentDate: text(raw.documentDate),
    total: text(raw.total) ?? '',
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
 * Structured outputs (`messages.parse` with a zod schema) rather than a forced tool call:
 * it is the documented recommended way to get a typed answer, the SDK validates the JSON
 * against {@link SCHEMA} before this function ever sees it, and it composes with the
 * adaptive thinking this model runs by default instead of raising questions about forced
 * tool choice. `effort` is what decides how long the model spends — low by default, see
 * {@link DEFAULT_EFFORT}.
 */
async function extract(image: Buffer, mimeType: string, model: string): Promise<ExtractedReceipt> {
  const client = new Anthropic()

  const response = await client.messages.parse({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { effort: chosenEffort(), format: zodOutputFormat(SCHEMA) },
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

  // Null when the model's answer did not validate against the schema. Treated as a failed
  // read rather than an empty one: the scan handler tells the caller and rolls back, and
  // the photo is still on the phone that took it.
  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error(
      `Claude returned no parsable receipt (stop_reason=${response.stop_reason ?? 'unknown'})`,
    )
  }

  return tidy(response.parsed_output)
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
