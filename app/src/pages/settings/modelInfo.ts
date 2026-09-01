/**
 * The deployed classifier, in one line.
 *
 * `/health` (FRONTEND-CONTRACT §3, `api.health`) knows *when* the model was trained, plus
 * the Document AI mode and the LLM provider — it reads only the `trainedAt` field out of
 * `weights.json`, because that file is five megabytes of base64 and a health probe has no
 * business parsing it per request.
 *
 * The rest of the line — how many rows it was trained on, and the two metrics — comes from
 * `AdminService.modelInfo` (`srv/admin-service.cds`), which is behind `@requires: 'admin'`.
 * In production both logins carry that role; in development, signed in as nobody, the call
 * comes back 403. That is not an error worth showing: the status line simply says what it
 * knows, which is why this returns `null` rather than throwing.
 */

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'

export interface ModelInfo {
  present: boolean
  trainedAt: string | null
  trainedRows: number | null
  categoryAccuracy: number | null
  momentF1: number | null
}

const ADMIN_MODEL_INFO = '/api/admin/modelInfo()'

/** `null` when the endpoint is not reachable or not permitted for this user. */
export async function fetchModelInfo(signal?: AbortSignal): Promise<ModelInfo | null> {
  let response: Response
  try {
    response = await fetch(ADMIN_MODEL_INFO, {
      headers: { accept: 'application/json' },
      signal,
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null

  const row = body as Record<string, unknown>
  const metrics =
    typeof row.metrics === 'object' && row.metrics !== null
      ? (row.metrics as Record<string, unknown>)
      : {}

  return {
    present: row.present === true,
    trainedAt: asString(row.trainedAt),
    trainedRows: asNumber(row.trainedRows),
    categoryAccuracy: asNumber(metrics.categoryAccuracy),
    momentF1: asNumber(metrics.momentF1),
  }
}

/** OData serialises `Decimal` as a string; both forms arrive here. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function useModelInfo(): UseQueryResult<ModelInfo | null> {
  return useQuery<ModelInfo | null>({
    queryKey: ['modelInfo'],
    queryFn: ({ signal }) => fetchModelInfo(signal),
    // The weights change once a retrain, and a 403 will keep being a 403.
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/**
 * `Model: trained 1 Sep 2026 on 4'200 rows · category acc 99% · moment F1 0.85`
 *
 * Degrades a field at a time: with no admin access it stops after the date, and with no
 * model deployed at all it says so instead of printing a line of dashes.
 */
export function describeModel(
  trainedAt: string | null | undefined,
  info: ModelInfo | null | undefined,
  formatDate: (value: string | null | undefined) => string,
): string {
  const stamp = trainedAt ?? info?.trainedAt ?? null
  if (stamp === null && (info === null || info === undefined || !info.present)) {
    return 'Model: not deployed — the classifier falls back to its priors until a retrain'
  }

  const parts: string[] = [`Model: trained ${formatDate(stamp)}`]
  if (info?.trainedRows != null) parts.push(`on ${groupDigits(info.trainedRows)} rows`)

  const metrics: string[] = []
  if (info?.categoryAccuracy != null) {
    metrics.push(`category acc ${(info.categoryAccuracy * 100).toFixed(1)}%`)
  }
  if (info?.momentF1 != null) metrics.push(`moment F1 ${info.momentF1.toFixed(2)}`)

  const head = parts.join(' ')
  return metrics.length > 0 ? `${head} · ${metrics.join(' · ')}` : head
}

/** Swiss grouping, for a row count rather than money. */
function groupDigits(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'")
}
