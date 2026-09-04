/**
 * Which card vault this environment selects.
 *
 * The same shape as `srv/lib/llm/index.ts` — resolution separate from construction, so the
 * Settings page can render a line about the provider without opening a client or touching
 * the network — with one deliberate difference in the *policy*.
 *
 * The LLM falls back cheerfully: no key, use the template provider, nobody is worse off. A
 * payment provider must not do that. Falling back to a mock vault because a key was
 * misspelled would mean a production deployment quietly accepting cards that go nowhere and
 * telling people they were saved. So:
 *
 *   - Development: mock unless Stripe is fully configured.
 *   - Production: **the mock is refused outright.** `NODE_ENV=production` with no Stripe key
 *     is a startup-time error, in the same spirit as `COMMONS_AUTHOR_SECRET`.
 *
 * A half-configured Stripe — one of the two keys present — is an error in every environment,
 * because it is always a mistake and never a choice.
 */
import { createMockProvider } from './mock'
import { createStripeProvider } from './stripe'
import { PaymentError, type PaymentProvider, type PaymentProviderName } from './types'

export { MOCK_SCENARIOS, chooseMockScenario, resetMockVault } from './mock'
export type { MockScenarioId } from './mock'
export { assertNoPan, looksLikePan, passesLuhn, redactPan, PanRejected } from './pan'
export {
  BRAND_LABEL,
  PaymentError,
  isExpired,
  toBrand,
  type CardBrand,
  type CardSetup,
  type CardSetupOutcome,
  type CardSetupRequest,
  type PaymentProvider,
  type PaymentProviderName,
  type SavedCard,
} from './types'

type Resolution =
  { kind: 'stripe'; secretKey: string; publishableKey: string } | { kind: 'mock'; reason: string }

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

function inProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim() === 'production'
}

function resolve(): Resolution {
  const secretKey = env('STRIPE_SECRET_KEY')
  const publishableKey = env('STRIPE_PUBLISHABLE_KEY')

  if (secretKey !== '' && publishableKey !== '') {
    return { kind: 'stripe', secretKey, publishableKey }
  }

  // Exactly one of the pair. Always a typo or a half-finished deploy, never an intention.
  if (secretKey !== '' || publishableKey !== '') {
    throw new PaymentError(
      'Stripe is half-configured: set both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY, or ' +
        'neither. One without the other cannot save a card and will fail in the browser.',
      { safeMessage: 'Card payments are not configured correctly on this server.' },
    )
  }

  if (inProduction()) {
    throw new PaymentError(
      'No card provider is configured and the mock vault is refused in production. Set ' +
        'STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY, or leave the payments feature off.',
      { safeMessage: 'Card payments are not available on this server.' },
    )
  }

  return { kind: 'mock', reason: 'no STRIPE_* credentials' }
}

/** True when cards can be added at all. The UI hides the feature rather than failing at it. */
export function paymentsConfigured(): boolean {
  try {
    resolve()
    return true
  } catch {
    return false
  }
}

/** Which provider is active, without constructing it. */
export function providerName(): PaymentProviderName | null {
  try {
    return resolve().kind
  } catch {
    return null
  }
}

export function getPaymentProvider(): PaymentProvider {
  const resolution = resolve()
  return resolution.kind === 'stripe'
    ? createStripeProvider({
        secretKey: resolution.secretKey,
        publishableKey: resolution.publishableKey,
      })
    : createMockProvider()
}

/** One line for Settings and `/health`. Never contains a credential. */
export function describePaymentProvider(): string {
  try {
    const resolution = resolve()
    return resolution.kind === 'stripe'
      ? getPaymentProvider().describe()
      : `Mock vault (${resolution.reason}) · development only`
  } catch (error) {
    return error instanceof PaymentError ? `Not configured — ${error.message}` : 'Not configured'
  }
}
