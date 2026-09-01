/**
 * Shared vocabulary for the LLM provider abstraction (CONTRACTS.md §7).
 *
 * Lives in its own module so that a provider never has to import a sibling
 * provider (and drag its SDK into the process) just to satisfy a type: every
 * provider imports from here, and only `index.ts` knows all four of them.
 */

/** Request shape every provider accepts. `maxTokens` defaults to {@link DEFAULT_MAX_TOKENS}. */
export interface LlmRequest {
  system: string
  prompt: string
  maxTokens?: number
}

export interface LlmProvider {
  readonly name: string // 'anthropic' | 'openai-compatible' | 'sap-ai-core' | 'template'
  generate(req: LlmRequest): Promise<string>
}

/** The four names `LlmProvider.name` may take, per CONTRACTS.md §7. */
export type LlmProviderName = 'anthropic' | 'openai-compatible' | 'sap-ai-core' | 'template'

/** A "Statement of Us" is long prose; 8000 tokens is roughly three printed pages. */
export const DEFAULT_MAX_TOKENS = 8000

/**
 * The single error type that escapes this package.
 *
 * Callers (LedgerService.generateStatement) need to distinguish "the model
 * refused / the endpoint is down" from a programming error, and they need to be
 * able to put the message in an OData error without leaking a credential — so
 * every provider funnels its failures through here after redaction.
 */
export class LlmError extends Error {
  readonly provider: LlmProviderName
  readonly status?: number

  constructor(
    provider: LlmProviderName,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(`[llm:${provider}] ${message}`, { cause: options.cause })
    this.name = 'LlmError'
    this.provider = provider
    this.status = options.status
  }
}

/** What one grouped occasion — a trip, a dinner, a party — came to. */
export interface EventFacts {
  name: string
  total: number
  /** How many people were on it. Context for the prose, never an amount owed. */
  participantCount: number
}

/**
 * Aggregates the statement is written from (CONTRACTS.md §8).
 *
 * Deliberately re-declared here rather than imported from `srv/lib/statement.ts`:
 * the template provider only ever sees this shape as JSON embedded in a prompt,
 * so it must not take a compile-time dependency on the aggregation module. The
 * declaration is structurally identical, so values flow between the two freely.
 *
 * There is no debt in it (CONTRACTS.md §9): `totals.byPerson` is what each
 * person *paid*, over however many people the household has, and that is a
 * contribution rather than a claim.
 */
export interface StatementFacts {
  year: number
  /** Everyone who could pay for something. Two of them, or ten. */
  people: string[]
  currency: string
  totals: {
    overall: number
    byCategory: Record<string, number>
    /** What each person paid, keyed by name. A contribution, not a debt. */
    byPerson: Record<string, number>
    byMoment: Record<string, number>
  }
  counts: {
    expenses: number
    dateNights: number
    trips: number
    /** Gift postings in the year. Who gave what to whom is nobody's ledger. */
    gifts: number
  }
  /** The year's events that cost something, largest first. */
  events: EventFacts[]
  topMerchants: Array<{ merchant: string; total: number; visits: number }>
  longestDateNightStreakWeeks: number
  placesVisited: string[]
  firstMemory: { title: string; date: string } | null
  lastMemory: { title: string; date: string } | null
  quarters: Array<{ quarter: 1 | 2 | 3 | 4; total: number; highlight: string | null }>
}

/** Narrowing helper used by every hand-rolled response parser in this package. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads `choices[0].message.content` out of an OpenAI-shaped completion body.
 *
 * Walked by hand rather than cast, so a server that half-implements the dialect
 * produces a clear error instead of a crash three frames away in the caller.
 * `content` is a plain string in the spec, but enough gateways answer with the
 * multi-part array form (`[{ type: 'text', text: '…' }]`) that refusing it would
 * turn a working endpoint into "returned no content". Shared by the
 * OpenAI-compatible provider and the AI Core orchestration provider, whose
 * response envelope wraps this exact shape.
 */
export function openAiChoiceText(value: unknown): string | null {
  if (!isRecord(value)) return null
  const choices = value.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first: unknown = choices[0]
  if (!isRecord(first)) return null
  const message = first.message
  if (!isRecord(message)) return null

  const content = message.content
  const text = typeof content === 'string' ? content : joinContentParts(content)
  if (text === null) return null
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** The multi-part form: keep the text parts, in order, and ignore the rest. */
function joinContentParts(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('') : null
}

/**
 * Removes credentials from any text that is about to become an error message.
 *
 * Upstream error bodies happily echo back the Authorization header, so this runs
 * on every string that leaves a provider. Plain `split`/`join` avoids having to
 * regex-escape a secret we must never inspect.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    out = out.split(secret).join('«redacted»')
  }
  return out
}

/** Keeps upstream error bodies from turning a 5 KB HTML page into an OData message. */
export function truncate(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * A URL that is safe to show — in an error message or on the Settings page.
 *
 * Both `LLM_BASE_URL` and an XSUAA url may legitimately carry credentials in
 * their userinfo or query string, and those end up in operator-visible text, so
 * every URL leaving this package goes through here first.
 */
export function publicUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split('?')[0]
  }
}

/**
 * Turns an unknown thrown value into a message safe to embed in an LlmError.
 * Never returns the stack: the stack of a fetch failure can contain the URL,
 * and a URL can carry credentials in its userinfo component.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  return 'unknown error'
}
