/**
 * The live card vault, over Stripe's REST API — CONTRACTS.md §16.2.
 *
 * Written against `fetch` rather than the SDK, for the same reason
 * `llm/openai-compatible.ts` is: four endpoints do not justify a dependency in the
 * production image, and a dependency that handles money is one you then have to keep
 * patched forever. The four are `/v1/customers`, `/v1/customers/search`,
 * `/v1/setup_intents` and `/v1/payment_methods/:id/detach`. Nothing here is clever; the
 * care is all in what is *not* sent.
 *
 * ## SetupIntents, not charges
 *
 * A SetupIntent is Stripe's name for "verify this card and keep it, do not take money". It
 * exists because of PSD2: a card stored today and charged next month must have been
 * authenticated by its owner *at the time it was stored*, or the later charge has no
 * exemption to rely on and the issuer is entitled to refuse it. `usage: 'off_session'` is
 * the flag that records the intent to charge later, and getting it wrong is the classic
 * production surprise — everything works in testing, and real charges start failing weeks
 * afterwards with no code change in between.
 *
 * ## Where the card number goes
 *
 * Nowhere near this file. The browser mounts Stripe's Payment Element, which is an iframe on
 * Stripe's own origin; the fields inside it are not reachable from our JavaScript, and the
 * number goes from the iframe straight to Stripe. What comes back to us is a
 * `payment_method` id. Every value this module reads off that object — brand, last four,
 * expiry, fingerprint — is metadata Stripe chose to expose precisely because it is safe to
 * hold.
 *
 * The two obligations that do *not* go away with a hosted field are ours to keep, and they
 * are worth naming because they are the ones people miss: an inventory of the scripts on the
 * page that mounts the Element, and tamper detection on it. Both are documented in
 * ADR-004 §6; neither is code in this file.
 *
 * ## Idempotency
 *
 * Every POST carries an `Idempotency-Key`. Payment APIs are the place where a retried
 * request is not a harmless duplicate, and the network layer will retry — a proxy timeout, a
 * user's second tap, a container restart mid-flight. The key makes the second attempt
 * *return the first result* rather than perform a second action.
 */
import { randomUUID } from 'node:crypto'

import {
  PaymentError,
  toBrand,
  type CardSetup,
  type CardSetupOutcome,
  type CardSetupRequest,
  type PaymentProvider,
  type SavedCard,
} from './types'

const API = 'https://api.stripe.com'

/** Stripe's own recommendation, and long enough to survive an issuer challenge round trip. */
const TIMEOUT_MS = 20_000

export interface StripeConfig {
  secretKey: string
  publishableKey: string
}

/** Stripe wants `application/x-www-form-urlencoded` with bracketed nesting. */
function form(fields: Record<string, string | number | boolean | undefined>): string {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, String(value))
  }
  return body.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function createStripeProvider(config: StripeConfig): PaymentProvider {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.secretKey}`,
      // Pinned so a Stripe API upgrade is a deliberate edit here rather than a field that
      // silently changes shape one morning.
      'Stripe-Version': '2025-08-27.basil',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey

    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      })
    } catch (cause) {
      throw new PaymentError(`Stripe ${method} ${path} failed: ${String(cause)}`, {
        safeMessage: 'We could not reach the card service. Please try again.',
        retryable: true,
      })
    } finally {
      clearTimeout(timer)
    }

    const payload: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {}
      // Stripe writes `message` for the cardholder and `code` for us. Passing the message
      // through is right here and almost nowhere else: "your card has insufficient funds" is
      // information only the person can act on.
      const safeMessage = str(error.message) ?? 'That card could not be saved.'
      throw new PaymentError(
        `Stripe ${method} ${path} -> ${response.status} ${str(error.code) ?? 'unknown'}`,
        { safeMessage, retryable: response.status >= 500 || response.status === 429 },
      )
    }

    return isRecord(payload) ? payload : {}
  }

  /** Turns Stripe's `payment_method` object into the little we are allowed to keep. */
  function toCard(paymentMethod: unknown, authenticated: boolean): SavedCard | null {
    if (!isRecord(paymentMethod)) return null
    const token = str(paymentMethod.id)
    const card = isRecord(paymentMethod.card) ? paymentMethod.card : null
    if (token === null || card === null) return null

    const last4 = str(card.last4)
    const expMonth = num(card.exp_month)
    const expYear = num(card.exp_year)
    if (last4 === null || expMonth === null || expYear === null) return null

    return {
      token,
      brand: toBrand(card.brand),
      last4,
      expMonth,
      expYear,
      fingerprint: str(card.fingerprint),
      issuer: str(card.issuer),
      country: str(card.country),
      authenticated,
    }
  }

  return {
    name: 'stripe',

    async customerFor(groupId: string): Promise<string> {
      // Search first, so a restarted process or a lost row does not strand a household with
      // two customers and half its cards under each.
      const query = `metadata['twmGroup']:'${groupId}'`
      const found = await call('GET', `/v1/customers/search?query=${encodeURIComponent(query)}`)
      const data = Array.isArray(found.data) ? found.data : []
      const first = data[0]
      const existing = isRecord(first) ? str(first.id) : null
      if (existing !== null) return existing

      // The group id is the idempotency key: two simultaneous first-card attempts from the
      // same household create one customer, not two.
      const created = await call(
        'POST',
        '/v1/customers',
        form({ 'metadata[twmGroup]': groupId }),
        `twm-customer-${groupId}`,
      )
      const id = str(created.id)
      if (id === null) throw new PaymentError('Stripe returned a customer with no id')
      return id
    },

    async startCardSetup(request: CardSetupRequest): Promise<CardSetup> {
      const intent = await call(
        'POST',
        '/v1/setup_intents',
        form({
          customer: request.customerRef,
          // The flag that makes later charges legal without the cardholder present.
          usage: 'off_session',
          'automatic_payment_methods[enabled]': true,
          description: request.statementLabel,
        }),
        // A fresh key each time: two taps of "add a card" are two genuine intents, unlike
        // two deliveries of one tap.
        `twm-setup-${randomUUID()}`,
      )

      const ref = str(intent.id)
      const clientSecret = str(intent.client_secret)
      if (ref === null || clientSecret === null) {
        throw new PaymentError('Stripe returned a setup intent with no id or client secret')
      }

      return { ref, clientSecret, provider: 'stripe', publishableKey: config.publishableKey }
    },

    async finishCardSetup(ref: string): Promise<CardSetupOutcome> {
      const intent = await call(
        'GET',
        `/v1/setup_intents/${encodeURIComponent(ref)}?expand[]=payment_method`,
      )
      const status = str(intent.status)

      if (status === 'succeeded') {
        // `next_action` having been used at any point means the issuer challenged and the
        // cardholder passed — which is exactly the SCA evidence worth recording.
        const authenticated = isRecord(intent.latest_attempt) || intent.next_action !== null
        const card = toCard(intent.payment_method, authenticated === true)
        if (card === null) {
          throw new PaymentError('Stripe reported success with no usable payment method')
        }
        return { status: 'succeeded', card }
      }

      if (status === 'canceled') {
        const error = isRecord(intent.last_setup_error) ? intent.last_setup_error : {}
        return {
          status: 'declined',
          reason: str(error.message) ?? 'That card was not saved. Please try another.',
        }
      }

      // requires_payment_method / requires_confirmation / requires_action / processing all
      // mean the browser has more to do. Reporting them as failures is the bug that makes
      // 3-D Secure look broken.
      return { status: 'pending' }
    },

    async forgetCard(token: string): Promise<void> {
      try {
        await call('POST', `/v1/payment_methods/${encodeURIComponent(token)}/detach`)
      } catch (error) {
        // Already detached is success: the caller asked for the card to be gone and it is.
        if (error instanceof PaymentError && /resource_missing|404/.test(error.message)) return
        throw error
      }
    },

    describe(): string {
      const tail = config.secretKey.slice(-4)
      const mode = config.secretKey.startsWith('sk_live') ? 'live' : 'test'
      return `Stripe (${mode}) · key from STRIPE_SECRET_KEY ending ${tail} · card fields hosted by Stripe`
    },
  }
}
