import { BusyIndicator, Card, CardHeader, ProgressIndicator, Text } from '@ui5/webcomponents-react'
import { BUSY_STEPS, phaseIndex, phaseLabel } from './phases'
import type { ScanQueueItem } from './types'

interface ScanBusyCardProps {
  item: ScanQueueItem
  /** How many receipts are still behind this one. */
  remaining: number
}

/**
 * The wait, made legible: which of the four steps is running, and how far the
 * batch has to go. Document AI is named on purpose — the pause is its, not ours.
 */
export function ScanBusyCard({ item, remaining }: ScanBusyCardProps) {
  const current = phaseIndex(item.phase)

  return (
    <Card
      className="scan-card"
      data-testid="scan-busy-card"
      header={
        <CardHeader
          titleText="Reading the receipt"
          subtitleText={item.fileName}
          additionalText={remaining > 0 ? `${remaining} more in this batch` : undefined}
        />
      }
    >
      <div className="scan-busy" role="status" aria-live="polite">
        <BusyIndicator active delay={0} size="M" />
        {item.previewUrl ? (
          <img className="scan-busy-thumb" src={item.previewUrl} alt="" aria-hidden="true" />
        ) : null}
        <div className="scan-busy-text">
          <Text>{phaseLabel(item.phase)}</Text>
          <ProgressIndicator
            value={Math.round(item.progress)}
            valueState="Information"
            accessibleName={`Scan progress: ${phaseLabel(item.phase)}`}
          />
          <ul className="scan-busy-steps">
            {BUSY_STEPS.map((step, index) => (
              <li
                key={step}
                className="scan-busy-step"
                data-active={index === current}
                data-complete={index < current}
              >
                <span className="scan-busy-dot" aria-hidden="true" />
                <span>{phaseLabel(step)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}
