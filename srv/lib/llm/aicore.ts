import {
  DEFAULT_MAX_TOKENS,
  LlmError,
  describeError,
  isRecord,
  openAiChoiceText,
  publicUrl,
  redactSecrets,
  truncate,
  type LlmProvider,
  type LlmRequest,
} from './types'

/**
 * SAP generative AI hub (orchestration service on SAP AI Core).
 *
 * Implemented over plain `fetch` on purpose: the `@sap-ai-sdk/*` packages are a
 * large dependency tree for one optional code path, and the protocol is three
 * ordinary HTTP calls — OAuth2 client credentials, resolve the orchestration
 * deployment, POST the completion.
 *
 * This is the least exercised provider in the app (it needs a BTP trial to test
 * at all), so every step below fails with a message that names the env var or
 * the BTP artefact to check. It must never degrade into returning junk that ends
 * up stored as the year's statement.
 */

/** A Claude model the hub exposes; overridable with AICORE_MODEL / LLM_MODEL. */
export const DEFAULT_AICORE_MODEL = 'anthropic--claude-4-sonnet'

/** Resource groups partition an AI Core tenant; a trial account only has this one. */
export const DEFAULT_RESOURCE_GROUP = 'default'

const TOKEN_TIMEOUT_MS = 30_000
const LOOKUP_TIMEOUT_MS = 30_000
const COMPLETION_TIMEOUT_MS = 120_000

/** Refresh a little before the real expiry so a request never starts on a dead token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000

/** The fields of an AI Core service key this provider actually needs. */
export interface AiCoreServiceKey {
  clientId: string
  clientSecret: string
  /** XSUAA base URL, e.g. https://<subaccount>.authentication.eu10.hana.ondemand.com */
  authUrl: string
  /** AI API base URL, e.g. https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com */
  aiApiUrl: string
}

export interface AiCoreConfig {
  serviceKey: AiCoreServiceKey
  model: string
  resourceGroup: string
  /** Skips deployment discovery when the id is already known (AICORE_DEPLOYMENT_ID). */
  deploymentId?: string
}

/**
 * Parses `AICORE_SERVICE_KEY` (the whole service-key JSON, pasted into one env
 * var) and returns null whenever it is absent, not JSON, or missing a field.
 *
 * Returning null rather than throwing is what makes `getProvider()` able to use
 * "parses as valid JSON with the fields we need" as its selection test, so a
 * half-pasted key falls through to the template provider instead of breaking the
 * feature.
 */
export function parseAiCoreServiceKey(raw: string | undefined): AiCoreServiceKey | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const clientId = stringField(parsed, 'clientid')
  const clientSecret = stringField(parsed, 'clientsecret')
  const authUrl = stringField(parsed, 'url')
  const serviceUrls = parsed.serviceurls
  const aiApiUrl = isRecord(serviceUrls) ? stringField(serviceUrls, 'AI_API_URL') : null

  if (clientId === null || clientSecret === null || authUrl === null || aiApiUrl === null) {
    return null
  }
  return {
    clientId,
    clientSecret,
    authUrl: authUrl.replace(/\/+$/, ''),
    aiApiUrl: aiApiUrl.replace(/\/+$/, ''),
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
}

/**
 * Third choice in the selection order. The returned provider keeps its OAuth
 * token and the resolved deployment URL in its closure, because a statement
 * regeneration would otherwise pay for two extra round trips every time.
 */
export function createAiCoreProvider(config: AiCoreConfig): LlmProvider {
  const { serviceKey } = config
  const secrets = [serviceKey.clientSecret, serviceKey.clientId]
  const safe = (text: string): string => redactSecrets(text, secrets)

  let cachedToken: CachedToken | null = null
  let cachedCompletionUrl: string | null = null

  /**
   * A cached token can be rejected long before `expires_in` says it should be —
   * the binding is deleted, the secret is rotated, or the two clocks disagree.
   * Without this, one 401 would poison every later call for the rest of the hour.
   */
  function forgetTokenIfRejected(status: number): void {
    if (status === 401 || status === 403) cachedToken = null
  }

  /** XSUAA client-credentials grant; the secret travels only in the Basic header. */
  async function getToken(): Promise<string> {
    const now = Date.now()
    if (cachedToken !== null && cachedToken.expiresAtMs > now) return cachedToken.accessToken

    const tokenUrl = `${serviceKey.authUrl}/oauth/token`
    const basic = Buffer.from(`${serviceKey.clientId}:${serviceKey.clientSecret}`).toString(
      'base64',
    )

    let response: Response
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      })
    } catch (error) {
      throw new LlmError(
        'sap-ai-core',
        `could not reach the XSUAA token endpoint ${publicUrl(tokenUrl)} — check the "url" field of AICORE_SERVICE_KEY (${safe(describeError(error))})`,
        { cause: error },
      )
    }

    if (!response.ok) {
      throw new LlmError(
        'sap-ai-core',
        `XSUAA rejected the client credentials (${response.status}) — the clientid/clientsecret in AICORE_SERVICE_KEY are wrong or the binding was deleted: ${safe(await readBodySafely(response))}`,
        { status: response.status },
      )
    }

    const payload: unknown = await response.json().catch(() => null)
    if (!isRecord(payload) || typeof payload.access_token !== 'string') {
      throw new LlmError('sap-ai-core', 'XSUAA returned no access_token in its response body')
    }
    const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
    cachedToken = {
      accessToken: payload.access_token,
      expiresAtMs: now + expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS,
    }
    return cachedToken.accessToken
  }

  /**
   * Finds the URL to POST the completion to. An explicit AICORE_DEPLOYMENT_ID
   * wins; otherwise the running deployments of the `orchestration` scenario are
   * listed and the lowest id is taken, so repeated runs stay on one deployment.
   */
  async function getCompletionUrl(token: string): Promise<string> {
    if (cachedCompletionUrl !== null) return cachedCompletionUrl

    if (config.deploymentId !== undefined && config.deploymentId.length > 0) {
      cachedCompletionUrl = `${serviceKey.aiApiUrl}/v2/inference/deployments/${config.deploymentId}/completion`
      return cachedCompletionUrl
    }

    const listUrl = `${serviceKey.aiApiUrl}/v2/lm/deployments?scenarioId=orchestration&status=RUNNING`
    let response: Response
    try {
      response = await fetch(listUrl, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'AI-Resource-Group': config.resourceGroup,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      })
    } catch (error) {
      throw new LlmError(
        'sap-ai-core',
        `could not reach the AI API at ${publicUrl(serviceKey.aiApiUrl)} — check serviceurls.AI_API_URL in AICORE_SERVICE_KEY (${safe(describeError(error))})`,
        { cause: error },
      )
    }

    if (!response.ok) {
      forgetTokenIfRejected(response.status)
      throw new LlmError(
        'sap-ai-core',
        `listing orchestration deployments failed (${response.status}) — is resource group '${config.resourceGroup}' correct? ${safe(await readBodySafely(response))}`,
        { status: response.status },
      )
    }

    const deploymentUrl = pickDeploymentUrl(await response.json().catch(() => null))
    if (deploymentUrl === null) {
      throw new LlmError(
        'sap-ai-core',
        `no RUNNING orchestration deployment in resource group '${config.resourceGroup}' — create one in SAP AI Launchpad (generative AI hub → orchestration) or set AICORE_DEPLOYMENT_ID`,
      )
    }
    cachedCompletionUrl = `${deploymentUrl.replace(/\/+$/, '')}/completion`
    return cachedCompletionUrl
  }

  return {
    name: 'sap-ai-core',
    async generate(req: LlmRequest): Promise<string> {
      const token = await getToken()
      const url = await getCompletionUrl(token)
      const body = JSON.stringify(buildOrchestrationBody(config.model, req))

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'AI-Resource-Group': config.resourceGroup,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
        })
      } catch (error) {
        throw new LlmError(
          'sap-ai-core',
          `orchestration completion request failed to reach ${publicUrl(url)} (${safe(describeError(error))})`,
          { cause: error },
        )
      }

      if (!response.ok) {
        // A 404 here is nearly always a deployment that was scaled down since we
        // cached it, so drop the cache and let the next call rediscover it.
        cachedCompletionUrl = null
        forgetTokenIfRejected(response.status)
        throw new LlmError(
          'sap-ai-core',
          `orchestration completion returned ${response.status} for model '${config.model}': ${safe(await readBodySafely(response))}`,
          { status: response.status },
        )
      }

      const text = extractOrchestrationText(await response.json().catch(() => null))
      if (text === null) {
        throw new LlmError(
          'sap-ai-core',
          `orchestration completion returned no message content — is model '${config.model}' deployed in this hub?`,
        )
      }
      return text
    },
  }
}

/**
 * Builds the orchestration payload. The system and user turns go in as a literal
 * template with no placeholders, so nothing in the prompt (which contains a JSON
 * block of facts) can be mistaken for a templating variable.
 */
function buildOrchestrationBody(model: string, req: LlmRequest): Record<string, unknown> {
  return {
    orchestration_config: {
      module_configurations: {
        templating_module_config: {
          template: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          defaults: {},
        },
        llm_module_config: {
          model_name: model,
          // 'latest' is the documented default; sending it explicitly keeps the
          // request valid on the orchestration versions that require the field.
          model_version: 'latest',
          model_params: { max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS },
        },
      },
    },
    // The template above has no placeholders, but the field is part of the
    // documented request shape and some deployments reject a body without it.
    input_params: {},
  }
}

/** `{ count, resources: [{ id, deploymentUrl, ... }] }` — lowest id wins, for stability. */
function pickDeploymentUrl(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const resources = payload.resources
  if (!Array.isArray(resources)) return null

  const candidates: Array<{ id: string; url: string }> = []
  for (const entry of resources) {
    if (!isRecord(entry)) continue
    const url = entry.deploymentUrl
    const id = entry.id
    if (typeof url !== 'string' || url.length === 0) continue
    candidates.push({ id: typeof id === 'string' ? id : '', url })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return candidates[0].url
}

/**
 * The orchestration response wraps an OpenAI-shaped result in
 * `orchestration_result`; older/partial responses only carry it under
 * `module_results.llm`, so both are accepted before giving up.
 */
function extractOrchestrationText(payload: unknown): string | null {
  if (!isRecord(payload)) return null

  const direct = openAiChoiceText(payload.orchestration_result)
  if (direct !== null) return direct

  const moduleResults = payload.module_results
  if (isRecord(moduleResults)) {
    const viaModule = openAiChoiceText(moduleResults.llm)
    if (viaModule !== null) return viaModule
  }
  return null
}

async function readBodySafely(response: Response): Promise<string> {
  try {
    return truncate(await response.text())
  } catch {
    return '<no body>'
  }
}
