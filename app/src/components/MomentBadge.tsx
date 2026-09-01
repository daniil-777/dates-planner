import '@ui5/webcomponents-icons/dist/home.js'
import '@ui5/webcomponents-icons/dist/heart.js'
import '@ui5/webcomponents-icons/dist/flight.js'
import '@ui5/webcomponents-icons/dist/present.js'
import { Icon, Tag } from '@ui5/webcomponents-react'
import type { MomentCode } from '../api/types'
import { MOMENT_ICONS, MOMENT_LABELS } from '../theme'

export interface MomentBadgeProps {
  moment: MomentCode
  className?: string
}

/**
 * Why the money was spent, as a Fiori tag.
 *
 * The four moments are ranked, not categorical: `everyday` is the neutral default and the
 * other three are the ones worth noticing, so they get colour and `everyday` does not.
 */
const MOMENT_TAG: Record<
  MomentCode,
  { design: 'Neutral' | 'Set1' | 'Set2'; colorScheme?: string }
> = {
  everyday: { design: 'Neutral' },
  date_night: { design: 'Set1', colorScheme: '6' },
  trip: { design: 'Set2', colorScheme: '8' },
  gift: { design: 'Set1', colorScheme: '5' },
}

export function MomentBadge({ moment, className }: MomentBadgeProps) {
  const tag = MOMENT_TAG[moment] ?? MOMENT_TAG.everyday
  const label = MOMENT_LABELS[moment] ?? moment

  return (
    <Tag
      className={className ? `twm-moment ${className}` : 'twm-moment'}
      design={tag.design}
      colorScheme={tag.colorScheme}
      icon={<Icon name={MOMENT_ICONS[moment] ?? 'home'} />}
      data-testid="moment-badge"
    >
      {label}
    </Tag>
  )
}

export default MomentBadge
