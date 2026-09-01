/**
 * Deleting a reminder.
 *
 * Everything else the calendar writes goes through `api` in `app/src/api/client.ts`:
 * `createReminder` and `completeReminder` are service actions with hooks of their own.
 * Deleting one is the exception — `srv/ledger-service.cds` exposes `Reminders` as a
 * plain projection and no `deleteReminder` action beside it, so the delete is the
 * entity's own `DELETE /api/ledger/Reminders(<id>)` (verified against the running
 * service: 204, and the row is gone).
 *
 * That one call lives here rather than in `api/client.ts` because `api/` belongs to the
 * shell agent (FRONTEND-CONTRACT §1) and this page may not edit it. It is deliberately
 * the *only* transport in this folder, it re-uses the shell's `ApiError` so a failure
 * renders through `ErrorState` and `describeError` like every other one, and it should
 * move into `api/client.ts` as `api.deleteReminder` the moment that file's owner will
 * have it.
 */

import { ApiError } from '@/api/client'

const REMINDERS_PATH = '/api/ledger/Reminders'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * `Reminders(<uuid>)` — the same key segment `api/client.ts` builds: an `Edm.Guid`
 * literal is bare in OData V4, and anything that is not a UUID is quoted as a string.
 */
function keySegment(id: string): string {
  const key = UUID_RE.test(id) ? id : `'${id.replace(/'/g, "''")}'`
  return `(${encodeURIComponent(key)})`
}

/** CAP writes its `{ error: { message } }` for humans; keep the text, drop the envelope. */
async function messageOf(response: Response): Promise<{ message: string; detail: string }> {
  const fallback = response.statusText || `HTTP ${response.status}`
  let body = ''
  try {
    body = await response.text()
  } catch {
    return { message: fallback, detail: '' }
  }
  if (!body) return { message: fallback, detail: '' }
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { message?: unknown; code?: unknown } }).error
    const message = typeof error?.message === 'string' ? error.message : fallback
    const detail = typeof error?.code === 'string' ? error.code : ''
    return { message, detail }
  } catch {
    return { message: fallback, detail: body.slice(0, 200) }
  }
}

/** Removes one reminder. The event it hung off, and every posting on it, are untouched. */
export async function deleteReminder(id: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${REMINDERS_PATH}${keySegment(id)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    // A dead network is a status of 0, exactly as `api/client.ts` reports one.
    throw new ApiError(0, error instanceof Error ? error.message : 'The ledger is unreachable.')
  }
  if (!response.ok) {
    const { message, detail } = await messageOf(response)
    throw new ApiError(response.status, message, detail)
  }
}
