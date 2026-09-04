/**
 * A card, drawn.
 *
 * ## Why the app draws a card at all
 *
 * Because people recognise their own cards by *sight*, not by reading digits. A list saying
 * "Visa ···· 4242" makes somebody with two Visas stop and think; a picture of a card in the
 * right colour with the right mark on it does not. Every bank app that people like has
 * arrived at the same answer, and it is not decoration — it is the fastest possible way to
 * answer "is that the one I meant".
 *
 * ## What is on it, and what is deliberately not
 *
 * Brand, last four, expiry, and a nickname the household chose. That is all this app is
 * permitted to know (CONTRACTS.md §16), and it turns out to be exactly what a card face
 * needs — which is not a coincidence. The set of facts that identify a card to its owner and
 * the set that are safe to hold are the same set.
 *
 * There is no cardholder name, because we never collect one. Real cards have one printed on
 * them and its absence here is the honest thing: this is a *representation* of a card, not a
 * copy of one, and making it look like a photograph of the real thing would imply we hold
 * more than we do.
 *
 * ## The gradient
 *
 * Each scheme gets its own, mixed from that scheme's own brand colours, so the cards in a
 * list are told apart at a glance rather than read. The sheen is a single wide, very
 * low-opacity linear gradient on a pseudo-element that shifts on hover — a compositor-only
 * transform, no blur, no repaint, for the reasons set out in `MoodAurora`.
 */
import type { SavedCard } from '@/api/wallet'

/** Lifted from each scheme's own brand palette, darkened until white type sits safely on it. */
const BRAND_SKIN: Record<string, { from: string; to: string; ink: string; name: string }> = {
  visa: { from: '#1a1f71', to: '#3b4bab', ink: '#ffffff', name: 'Visa' },
  mastercard: { from: '#7a1f0f', to: '#c1440e', ink: '#ffffff', name: 'Mastercard' },
  amex: { from: '#00516b', to: '#0a8ec4', ink: '#ffffff', name: 'American Express' },
  discover: { from: '#6b3a00', to: '#e07a1f', ink: '#ffffff', name: 'Discover' },
  diners: { from: '#12324f', to: '#2b6ca3', ink: '#ffffff', name: 'Diners Club' },
  jcb: { from: '#0b3d2c', to: '#128a5a', ink: '#ffffff', name: 'JCB' },
  unionpay: { from: '#0b2f45', to: '#c8102e', ink: '#ffffff', name: 'UnionPay' },
  unknown: { from: '#2a2f3a', to: '#4a5265', ink: '#ffffff', name: 'Card' },
}

export function skinFor(brand: string): (typeof BRAND_SKIN)['visa'] {
  return BRAND_SKIN[brand] ?? BRAND_SKIN.unknown!
}

export interface CardFaceProps {
  card: SavedCard
  /** Smaller, for a list rather than a hero. */
  compact?: boolean
  onClick?: () => void
}

/** `2026-11` from month 11, year 2026 — two digits, as printed on a card. */
function expiry(card: SavedCard): string {
  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`
}

export function CardFace({ card, compact = false, onClick }: CardFaceProps): React.ReactElement {
  const skin = skinFor(card.brand)
  const label = card.label ?? skin.name

  // The whole face is one control when it does something, and a plain figure when it does
  // not — rather than a div with a click handler, which is invisible to a keyboard.
  const Tag = onClick === undefined ? 'div' : 'button'

  return (
    <Tag
      {...(onClick === undefined ? {} : { type: 'button' as const, onClick })}
      className={`cardface${compact ? ' cardface--compact' : ''}`}
      style={
        {
          '--card-from': skin.from,
          '--card-to': skin.to,
          '--card-ink': skin.ink,
        } as React.CSSProperties
      }
      // Read as one thing rather than as five fragments. A screen reader saying
      // "the joint one, Visa, ending 4242, expires 11 26" is the whole card in one breath.
      aria-label={`${label}, ${skin.name} ending ${card.last4}, expires ${expiry(card)}${
        card.isDefault ? ', the default card' : ''
      }`}
    >
      <span className="cardface__sheen" aria-hidden="true" />

      <span className="cardface__top">
        <span className="cardface__label">{label}</span>
        {card.isDefault && <span className="cardface__default">Default</span>}
      </span>

      {/* The chip. Purely a visual anchor — it is what makes the shape read as a card at
          thumbnail size, where the digits are too small to notice. */}
      <span className="cardface__chip" aria-hidden="true" />

      <span className="cardface__digits" aria-hidden="true">
        <span className="cardface__dots">•••• •••• ••••</span> {card.last4}
      </span>

      <span className="cardface__foot">
        <span className="cardface__expiry" aria-hidden="true">
          {expiry(card)}
        </span>
        <span className="cardface__brand">{skin.name}</span>
      </span>
    </Tag>
  )
}
