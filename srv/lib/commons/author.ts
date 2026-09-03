/**
 * Who wrote a rating, in the only form the commons is allowed to know it —
 * CONTRACTS.md §14.5.
 *
 * ## The problem
 *
 * Two things need a household's identity on a published rating, and nothing else does:
 * enforcing one rating per household per place, and letting that household take it back.
 * Both are satisfied by *any* stable, unique token. Neither needs the group id.
 *
 * Storing `group_ID` would satisfy them too, and would also make `JOIN Groups` a thing
 * somebody could write — in a query, in a report, in a debugging session six months from
 * now — and turn the anonymous corpus into an attributed one by accident. ADR-003 §4 says
 * no association crosses the line between the commons and a household. This is how that is
 * made structurally true rather than a rule people have to remember.
 *
 * ## The token
 *
 * `HMAC-SHA256(secret, "twm:commons:author:v1:" + groupId)`, hex, truncated to 32 bytes.
 *
 * - **Stable**, so uniqueness and withdrawal work across sessions and deploys.
 * - **Opaque**, so a row says nothing about who wrote it.
 * - **Not reversible or enumerable without the secret** — which matters more than it looks,
 *   because group ids are UUIDs but a *guessable* keyspace would let anybody with the table
 *   confirm a guess. An HMAC, unlike a bare hash, cannot be brute-forced from a candidate
 *   id list without also having the key.
 * - **Not a join key.** There is no column anywhere else in the database holding this value.
 *
 * ## The secret
 *
 * `COMMONS_AUTHOR_SECRET`, from the environment, exactly like the `AUTH_*` variables — and
 * like them, the server refuses to start in production without it rather than falling back
 * to something weaker. It has one operational property worth stating plainly, because it is
 * a genuine cost and not a detail: **rotating it orphans every existing rating.** The rows
 * survive and stay anonymous, and no household can withdraw or amend its own any more,
 * because the key that identified them no longer derives. So this secret is not rotated on
 * a schedule with the others. If it must be rotated, the ratings are re-keyed in the same
 * migration or they are abandoned deliberately; there is no third option, and `RUNBOOK.md`
 * says so where the rotation procedure lives.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Namespaced and versioned, so the same secret can key something else later without the two
 * ever colliding, and so a future scheme can be told apart from this one.
 */
const DOMAIN = 'twm:commons:author:v1:'

/**
 * The development fallback.
 *
 * Present so the app keeps its founding property — it runs with an empty `.env` — and
 * loud enough that nobody mistakes it for a secret. `requireAuthorSecret` refuses it in
 * production, which is where that guarantee actually matters.
 */
const DEVELOPMENT_SECRET = 'twm-development-author-secret-not-for-production'

export function authorSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COMMONS_AUTHOR_SECRET?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return DEVELOPMENT_SECRET
}

/**
 * Fails fast when the commons is served in production without its own secret.
 *
 * The same posture as `srv/lib/auth.ts`: a missing variable must never quietly degrade into
 * a weaker system. Here the degradation would be silent and permanent — every deployment
 * sharing the development secret would derive the same author keys, so two unrelated
 * installations could tell whether they had rated the same place.
 */
export function requireAuthorSecret(env: NodeJS.ProcessEnv = process.env): void {
  const production = env.NODE_ENV === 'production'
  const configured = env.COMMONS_AUTHOR_SECRET?.trim()
  if (production && (configured === undefined || configured.length < 32)) {
    throw new Error(
      'COMMONS_AUTHOR_SECRET must be set to at least 32 characters in production. ' +
        'Generate one with `openssl rand -hex 32`. Note that changing it later orphans ' +
        'every published rating — see docs/RUNBOOK.md.',
    )
  }
}

/**
 * The author key for a group.
 *
 * Truncated to 32 bytes of the 32-byte digest — that is, not truncated at all; the length is
 * stated so the `String(64)` column and this function cannot drift apart.
 */
export function authorKey(groupId: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac('sha256', authorSecret(env)).update(DOMAIN + groupId).digest('hex')
}

/**
 * Constant-time comparison of two author keys.
 *
 * Overkill for a value that is never sent to a client, and used anyway: the one place a
 * timing difference could matter is a withdrawal endpoint that is asked, over and over,
 * whether some key owns some rating. Costing nothing to do right, it is done right.
 */
export function sameAuthor(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
