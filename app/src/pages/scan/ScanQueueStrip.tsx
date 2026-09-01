import { Button, ObjectStatus, ProgressIndicator, Text } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/delete.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import { formatBytes } from './imageProcessing'
import { phaseLabel } from './phases'
import type { ScanQueueItem } from './types'

interface ScanQueueStripProps {
  items: ScanQueueItem[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}

function strippedState(item: ScanQueueItem): 'error' | 'done' | 'busy' {
  if (item.phase === 'error') return 'error'
  if (item.phase === 'done') return 'done'
  return 'busy'
}

/** Per-file progress for a batch. Scrolls horizontally on a phone. */
export function ScanQueueStrip({ items, onRetry, onRemove }: ScanQueueStripProps) {
  if (items.length === 0) return null

  return (
    <ul className="scan-strip" aria-label="Receipts in this batch" data-testid="scan-queue-strip">
      {items.map(item => {
        const state = strippedState(item)
        return (
          <li key={item.id} className="scan-strip-item" data-state={state}>
            <img
              className="scan-thumb"
              src={item.previewUrl}
              alt={`Receipt photo ${item.fileName}`}
              loading="lazy"
            />
            <span className="scan-strip-name" title={item.fileName}>
              {item.fileName}
            </span>
            {item.phase === 'error' ? (
              <ObjectStatus state="Negative" showDefaultIcon>
                {item.error ?? 'Upload failed'}
              </ObjectStatus>
            ) : (
              <ProgressIndicator
                value={Math.round(item.progress)}
                valueState={item.phase === 'done' ? 'Positive' : 'Information'}
                displayValue={phaseLabel(item.phase)}
                accessibleName={`${item.fileName}: ${phaseLabel(item.phase)}`}
              />
            )}
            {item.uploadBytes !== null && item.phase !== 'error' ? (
              <Text className="scan-strip-name">{formatBytes(item.uploadBytes)} uploaded</Text>
            ) : null}
            <div className="scan-strip-actions">
              {item.phase === 'error' ? (
                <Button
                  design="Transparent"
                  icon="refresh"
                  accessibleName={`Retry ${item.fileName}`}
                  onClick={() => onRetry(item.id)}
                />
              ) : null}
              <Button
                design="Transparent"
                icon="delete"
                accessibleName={`Remove ${item.fileName} from the batch`}
                onClick={() => onRemove(item.id)}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
