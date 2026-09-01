import Anthropic from '@anthropic-ai/sdk'
import {
  DEFAULT_MAX_TOKENS,
  LlmError,
  describeError,
  redactSecrets,
  type LlmProvider,
  type LlmRequest,
} from './types'

/** The model id is exact and carries no date suffix — see CONTRACTS.md §7. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5'

/**
 * A whole statement is a few thousand tokens of prose written after adaptive
 * thinking, so the request can legitimately run for minutes. Four minutes is
 * generous enough to finish and short enough that a stuck HTTP action still
 * returns to the browser.
 */
const REQUEST_TIMEOUT_MS = 240_000

export interface AnthropicConfig {
  apiKey: string
  model?: string
  /** Only for gateways that speak the Anthropic API; normally undefined. */
  baseUrl?: string
}

/**
 * Native Anthropic provider — the first choice in the selection order.
 *
 * Streams rather than using a single `create` call: with a large `max_tokens`
 * the non-streaming endpoint is rejected outright by the API, and streaming also
 * keeps the connection warm while the model thinks. `finalMessage()` reassembles
 * the whole message for us, so nothing here has to hand-roll delta accumulation.
 */
export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  })

  return {
    name: 'anthropic',
    async generate(req: LlmRequest): Promise<string> {
      let message: Anthropic.Message
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          // Adaptive thinking is the only supported form on this model; sending
          // `budget_tokens` here is a 400.
          thinking: { type: 'adaptive' },
          messages: [{ role: 'user', content: req.prompt }],
        })
        message = await stream.finalMessage()
      } catch (error) {
        throw toLlmError(error, config.apiKey)
      }

      const text = collectText(message)
      if (text.length > 0) return text

      // An empty body is always worth an explicit error: silently returning ''
      // would be stored as the year's statement.
      const reason = message.stop_reason ?? 'unknown'
      const detail =
        message.stop_reason === 'refusal'
          ? ' — the model declined to write this statement'
          : message.stop_reason === 'max_tokens'
            ? ' — raise maxTokens'
            : ''
      throw new LlmError(
        'anthropic',
        `model ${model} returned no text (stop_reason=${reason})${detail}`,
      )
    },
  }
}

/** Concatenates the text blocks; thinking blocks are present but are not output. */
function collectText(message: Anthropic.Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('').trim()
}

/**
 * Maps SDK exceptions onto LlmError using the SDK's typed classes rather than
 * string matching, and redacts the key before the message is ever shown: the
 * 401 body from a gateway sometimes echoes the credential it rejected.
 */
function toLlmError(error: unknown, apiKey: string): LlmError {
  const safe = (message: string): string => redactSecrets(message, [apiKey])

  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError('anthropic', 'ANTHROPIC_API_KEY was rejected (401)', {
      status: error.status,
      cause: error,
    })
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError('anthropic', 'rate limited (429) — try again shortly', {
      status: error.status,
      cause: error,
    })
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new LlmError('anthropic', `request rejected (400): ${safe(error.message)}`, {
      status: error.status,
      cause: error,
    })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('anthropic', 'could not reach the Anthropic API', { cause: error })
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError('anthropic', `API error ${error.status ?? '?'}: ${safe(error.message)}`, {
      status: error.status,
      cause: error,
    })
  }
  return new LlmError('anthropic', safe(describeError(error)), { cause: error })
}
