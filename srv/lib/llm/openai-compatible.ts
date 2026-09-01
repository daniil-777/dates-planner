import {
  DEFAULT_MAX_TOKENS,
  LlmError,
  describeError,
  openAiChoiceText,
  redactSecrets,
  publicUrl,
  truncate,
  type LlmProvider,
  type LlmRequest,
} from './types'

/** Ollama, vLLM, LM Studio, OpenRouter and friends all answer on this path. */
const COMPLETIONS_PATH = '/chat/completions'

/** Local models on a laptop are slow but not infinitely slow. */
const REQUEST_TIMEOUT_MS = 120_000

export interface OpenAiCompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * Second choice in the selection order: any endpoint that speaks the OpenAI
 * chat-completions dialect (`LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`).
 *
 * Deliberately non-streaming and written against global `fetch`: the whole point
 * of this provider is to work against an unknown server without pulling in an
 * SDK, so it asks for the smallest thing every implementation supports.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${COMPLETIONS_PATH}`
  // LLM_BASE_URL may carry credentials in its userinfo; only this form is printed.
  const shown = publicUrl(endpoint)

  return {
    name: 'openai-compatible',
    async generate(req: LlmRequest): Promise<string> {
      // Guessing a model name against an unknown server produces a confusing 404
      // three calls later, so say it plainly here instead.
      if (config.model.length === 0) {
        throw new LlmError(
          'openai-compatible',
          `LLM_MODEL is not set — ${shown} needs an explicit model name (e.g. 'llama3.1' for Ollama)`,
        )
      }

      const body = JSON.stringify({
        model: config.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      })

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        throw new LlmError(
          'openai-compatible',
          `could not reach ${shown} (${safe(describeError(error), config.apiKey)})`,
          { cause: error },
        )
      }

      if (!response.ok) {
        const detail = await readBodySafely(response)
        throw new LlmError(
          'openai-compatible',
          `${shown} returned ${response.status}: ${safe(detail, config.apiKey)}`,
          { status: response.status },
        )
      }

      const payload: unknown = await response.json().catch(() => null)
      const text = openAiChoiceText(payload)
      if (text === null) {
        throw new LlmError(
          'openai-compatible',
          `${shown} returned no choices[0].message.content — is LLM_MODEL='${config.model}' served there?`,
        )
      }
      return text
    },
  }
}

/** Reads an error body without letting a hung stream outlive the request. */
async function readBodySafely(response: Response): Promise<string> {
  try {
    return truncate(await response.text())
  } catch {
    return '<no body>'
  }
}

function safe(text: string, apiKey: string): string {
  return redactSecrets(text, [apiKey])
}
