/**
 * The payments boundary — CONTRACTS.md §16.
 *
 * One interface, three implementations, exactly like `srv/lib/llm` and
 * `srv/lib/documentai`: a live provider, and a mock that makes the whole flow developable
 * with no account anywhere. The shape below is not "Stripe, abstracted" — it is the shape
 * every card vault has had since 3-D Secure 2 made the customer's *presence* part of the
 * protocol, and Adyen or Checkout.com drop into it with the same three calls.
 *
 * ## The one rule the interface exists to enforce
 *
 * **No method takes a card number.** Not optionally, not as a string, not nested in a
 * config object. There is nowhere in this file to put one, which is the difference between a
 * rule and a convention: a future provider that wants raw fields cannot implement this
 * interface without changing it, and changing it is a reviewable act.
 *
 * What flows instead is a *setup* — a short-lived, single-use permission slip the browser
 * redeems directly with the provider. The server hands out the slip and later asks what came
 * of it. The number goes browser → provider and is never in between.
 *
 * ## Why setup-then-confirm, rather than one call
 *
 * Because the customer has to authenticate. Under PSD2 strong customer authentication a card
 * being stored for later use is verified *now*, while its owner is present to approve it —
 * a bank app prompt, a passkey, a code. That is a round trip through the issuer's domain,
 * which means the flow has a gap in the middle by construction, and an interface that
 * pretends otherwise ("saveCard(details) → card") can only work by skipping the step that
 * makes later charges legal without the customer.
 *
 * So: `startCardSetup` opens it, the browser and the issuer do the middle, `finishCardSetup`
 * closes it. The gap is where the interesting failures live, and naming it means they can be
 * handled rather than discovered.
 */

/** The schemes a card face is drawn for. `unknown` renders a plain card rather than failing. */
export type CardBrand =
  'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'unknown'

/**
 * A card as this app is permitted to know it.
 *
 * Everything here is either non-identifying (brand, expiry) or truncated past the point of
 * use (`last4`). This is precisely the set a bank app shows you on its cards screen, and
 * that is not a coincidence — it is the set you can show somebody without holding anything
 * an attacker wants.
 */
export interface SavedCard {
  /** The provider's handle. Opaque; useless without our API key; the only thing we store. */
  token: string
  brand: CardBrand
  /** Four digits. Enough to tell two cards apart, not enough to be a card. */
  last4: string
  expMonth: number
  expYear: number
  /**
   * The provider's stable hash of the underlying card, where it offers one.
   *
   * Two tokens for the same physical card share a fingerprint, which is what lets us say
   * "that card is already here" instead of silently keeping a duplicate. It is not derived
   * from the PAN by us and cannot be reversed into one.
   */
  fingerprint: string | null
  /** Set when the provider knows it, e.g. from the issuer BIN table. Cosmetic. */
  issuer: string | null
  /** ISO-3166-1 alpha-2, when known. Used to warn about foreign-currency fees, nothing else. */
  country: string | null
  /** True when the issuer authenticated the cardholder during setup. */
  authenticated: boolean
}

/** Opening a setup. */
export interface CardSetupRequest {
  /**
   * A stable per-household handle at the provider, so a second card joins the first rather
   * than creating a stranger. Created on demand by the provider implementation.
   */
  customerRef: string
  /** Shown in the issuer's authentication prompt. Never anything private. */
  statementLabel: string
}

/** What the browser needs to redeem the setup, and nothing else. */
export interface CardSetup {
  /** Our handle for the attempt, echoed back to `finishCardSetup`. */
  ref: string
  /**
   * The provider's browser-side credential. Publishable by design: it authorises exactly one
   * card to be attached to exactly one customer and expires. It is *not* an API key, and the
   * distinction matters because it is the one payments value that legitimately reaches a
   * browser.
   */
  clientSecret: string
  /** Which provider produced it, so the front end mounts the matching component. */
  provider: PaymentProviderName
  /** The publishable key the provider's browser SDK needs. Empty in mock mode. */
  publishableKey: string
}

/** How a setup ended. */
export type CardSetupOutcome =
  | { status: 'succeeded'; card: SavedCard }
  /** The issuer or the provider said no. `reason` is written for a person to read. */
  | { status: 'declined'; reason: string }
  /** Still mid-authentication. The browser has more to do; this is not an error. */
  | { status: 'pending' }

export type PaymentProviderName = 'stripe' | 'mock'

/**
 * What a provider must do.
 *
 * Three calls, because there are three moments: opening a setup, learning how it went, and
 * removing a card. Charging is deliberately absent — see ADR-004 — and will arrive as a
 * separate interface when there is a licensed party to charge on behalf of, rather than as
 * an optional method nobody implements.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName
  /** Find or create the household's handle at the provider. Idempotent on `groupId`. */
  customerFor(groupId: string): Promise<string>
  startCardSetup(request: CardSetupRequest): Promise<CardSetup>
  /** Ask the provider what became of a setup. Safe to call repeatedly. */
  finishCardSetup(ref: string): Promise<CardSetupOutcome>
  /** Detach at the provider. Must succeed if the token is already gone. */
  forgetCard(token: string): Promise<void>
  /** One line for the Settings page. Never contains a credential. */
  describe(): string
}

/**
 * Anything the provider or the network got wrong.
 *
 * `safeMessage` is the part that may be shown to a person; `message` may name an endpoint and
 * a status and belongs in a log. They are separate because a payment failure is one of the
 * few errors an ordinary user genuinely needs the detail of ("your bank declined this") and
 * also one where the raw text is often useless or alarming ("card_error: do_not_honor").
 */
export class PaymentError extends Error {
  readonly safeMessage: string
  readonly retryable: boolean

  constructor(message: string, options: { safeMessage?: string; retryable?: boolean } = {}) {
    super(message)
    this.name = 'PaymentError'
    this.safeMessage = options.safeMessage ?? 'The payment service could not be reached.'
    this.retryable = options.retryable ?? false
  }
}

/** Normalises whatever a provider calls a scheme onto {@link CardBrand}. */
export function toBrand(raw: unknown): CardBrand {
  const value = typeof raw === 'string' ? raw.toLowerCase().replace(/[\s_]/g, '') : ''
  switch (value) {
    case 'visa':
      return 'visa'
    case 'mastercard':
    case 'mc':
      return 'mastercard'
    case 'amex':
    case 'americanexpress':
      return 'amex'
    case 'discover':
      return 'discover'
    case 'diners':
    case 'dinersclub':
      return 'diners'
    case 'jcb':
      return 'jcb'
    case 'unionpay':
    case 'cup':
      return 'unionpay'
    default:
      return 'unknown'
  }
}

/** Human-readable scheme names, shared by the card face and the accessible label. */
export const BRAND_LABEL: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  unknown: 'Card',
}

/**
 * True when a card is past its printed expiry.
 *
 * Cards expire at the *end* of their month, which is the off-by-one everybody writes once.
 */
export function isExpired(
  card: Pick<SavedCard, 'expMonth' | 'expYear'>,
  now = new Date(),
): boolean {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  return card.expYear < year || (card.expYear === year && card.expMonth < month)
}
