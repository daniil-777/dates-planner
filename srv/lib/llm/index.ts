import {
  DEFAULT_AICORE_MODEL,
  DEFAULT_RESOURCE_GROUP,
  createAiCoreProvider,
  parseAiCoreServiceKey,
  type AiCoreServiceKey,
} from './aicore'
import { DEFAULT_ANTHROPIC_MODEL, createAnthropicProvider } from './anthropic'
import { createOpenAiCompatibleProvider } from './openai-compatible'
import { createTemplateProvider, renderStatementFromFacts } from './template'
import { DEFAULT_MAX_TOKENS, LlmError, publicUrl } from './types'
import type { LlmProvider, LlmProviderName, LlmRequest, StatementFacts } from './types'

export { DEFAULT_MAX_TOKENS, LlmError, renderStatementFromFacts }
export type { LlmProvider, LlmProviderName, LlmRequest, StatementFacts }

/**
 * Which provider the current environment selects, resolved without constructing
 * anything. Keeping resolution separate from construction is what lets
 * `describeProvider()` render a Settings line without opening an SDK client or
 * touching the network.
 */
type Resolution =
  | { kind: 'anthropic'; apiKey: string; model: string; baseUrl: string | undefined }
  | { kind: 'openai-compatible'; apiKey: string; model: string; baseUrl: string }
  | {
      kind: 'sap-ai-core'
      serviceKey: AiCoreServiceKey
      model: string
      resourceGroup: string
      deploymentId: string | undefined
    }
  | { kind: 'template'; reason: string }

/**
 * Selection order from CONTRACTS.md §7, first configured wins:
 * ANTHROPIC_API_KEY → LLM_BASE_URL + LLM_API_KEY → AICORE_SERVICE_KEY → template.
 *
 * Resolved on every call rather than cached, because the two env-driven paths
 * can be reconfigured between requests (and tests set env per case); building a
 * provider is cheap, and nothing here opens a socket until `generate()` runs.
 */
export function getProvider(): LlmProvider {
  const resolution = resolve()
  switch (resolution.kind) {
    case 'anthropic':
      return createAnthropicProvider({
        apiKey: resolution.apiKey,
        model: resolution.model,
        ...(resolution.baseUrl === undefined ? {} : { baseUrl: resolution.baseUrl }),
      })
    case 'openai-compatible':
      return createOpenAiCompatibleProvider({
        baseUrl: resolution.baseUrl,
        apiKey: resolution.apiKey,
        model: resolution.model,
      })
    case 'sap-ai-core':
      return createAiCoreProvider({
        serviceKey: resolution.serviceKey,
        model: resolution.model,
        resourceGroup: resolution.resourceGroup,
        ...(resolution.deploymentId === undefined ? {} : { deploymentId: resolution.deploymentId }),
      })
    case 'template':
      return createTemplateProvider()
  }
}

/**
 * One human-readable line for the Settings page, e.g.
 * `Anthropic (native SDK) · model claude-opus-5 · key from ANTHROPIC_API_KEY`.
 *
 * Never contains a credential: the API keys are only ever reported as the name
 * of the variable they came from, and the endpoint URL is stripped of any
 * userinfo and query string before it is shown.
 */
export function describeProvider(): string {
  const resolution = resolve()
  switch (resolution.kind) {
    case 'anthropic':
      return `Anthropic (native SDK) · model ${resolution.model} · key from ANTHROPIC_API_KEY`
    case 'openai-compatible': {
      const model = resolution.model.length > 0 ? resolution.model : 'not set (LLM_MODEL)'
      return `OpenAI-compatible endpoint · model ${model} · ${publicUrl(resolution.baseUrl)}`
    }
    case 'sap-ai-core':
      return (
        `SAP generative AI hub (AI Core orchestration) · model ${resolution.model} · ` +
        `resource group '${resolution.resourceGroup}'`
      )
    case 'template':
      return `Deterministic template · ${resolution.reason}`
  }
}

/** Selection order lives in exactly one place. */
function resolve(): Resolution {
  const anthropicKey = env('ANTHROPIC_API_KEY')
  if (anthropicKey !== undefined) {
    return {
      kind: 'anthropic',
      apiKey: anthropicKey,
      model: env('ANTHROPIC_MODEL') ?? env('LLM_MODEL') ?? DEFAULT_ANTHROPIC_MODEL,
      baseUrl: env('ANTHROPIC_BASE_URL'),
    }
  }

  const baseUrl = env('LLM_BASE_URL')
  const llmKey = env('LLM_API_KEY')
  if (baseUrl !== undefined && llmKey !== undefined) {
    return {
      kind: 'openai-compatible',
      apiKey: llmKey,
      baseUrl,
      // Empty means "not configured"; the provider turns that into a clear error
      // rather than guessing a model name that the endpoint has never heard of.
      model: env('LLM_MODEL') ?? '',
    }
  }

  const rawServiceKey = env('AICORE_SERVICE_KEY')
  const serviceKey = parseAiCoreServiceKey(rawServiceKey)
  if (serviceKey !== null) {
    return {
      kind: 'sap-ai-core',
      serviceKey,
      model: env('AICORE_MODEL') ?? env('LLM_MODEL') ?? DEFAULT_AICORE_MODEL,
      resourceGroup: env('AICORE_RESOURCE_GROUP') ?? DEFAULT_RESOURCE_GROUP,
      deploymentId: env('AICORE_DEPLOYMENT_ID'),
    }
  }

  return { kind: 'template', reason: templateReason(rawServiceKey, baseUrl, llmKey) }
}

/** Explains on the Settings page why no real model was picked. */
function templateReason(
  rawServiceKey: string | undefined,
  baseUrl: string | undefined,
  llmKey: string | undefined,
): string {
  if (rawServiceKey !== undefined) {
    return (
      'AICORE_SERVICE_KEY is set but is not JSON with clientid, clientsecret, url and ' +
      'serviceurls.AI_API_URL — falling back'
    )
  }
  if (baseUrl !== undefined) return 'LLM_BASE_URL is set but LLM_API_KEY is missing — falling back'
  if (llmKey !== undefined) return 'LLM_API_KEY is set but LLM_BASE_URL is missing — falling back'
  return 'no LLM credentials configured (set ANTHROPIC_API_KEY, LLM_BASE_URL + LLM_API_KEY, or AICORE_SERVICE_KEY)'
}

/** Treats blank env vars as unset, which is how a commented-out .env line behaves. */
function env(name: string): string | undefined {
  const value = process.env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
