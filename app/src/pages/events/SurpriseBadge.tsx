import { Icon } from '@ui5/webcomponents-react'
import './icons'

export interface SurpriseBadgeProps {
  /** The card version, where the row is already crowded with dates and a total. */
  compact?: boolean
}

/**
 * "Only you can see this" — CONTRACTS §11.3 rule 3.
 *
 * Discreet on purpose. It is a quiet marker beside the name, not a warning banner: the
 * person reading it already knows, because they are the one keeping the secret. Its job is
 * to stop them wondering why the trip they planned is missing from the other phone in the
 * house.
 *
 * It is drawn only for the creator of a still-hidden surprise, which is decided by
 * `isOwnSecret` in `./surprise`. Nothing here decides anything; if this badge is on screen,
 * the event was already the viewer's own secret.
 */
export function SurpriseBadge({ compact = false }: SurpriseBadgeProps) {
  return (
    <span className="ev-onlyyou" data-testid="only-you-badge">
      <Icon name="hide" aria-hidden="true" />
      <span>{compact ? 'Only you' : 'Only you can see this'}</span>
    </span>
  )
}

export default SurpriseBadge
