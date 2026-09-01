import { SegmentedButton, SegmentedButtonItem, Text } from '@ui5/webcomponents-react'
import type { MomentCode } from '../../api/types'
import { formatConfidence } from '../../theme'
import { MOMENT_LABELS } from './constants'

interface MomentPickerProps {
  order: MomentCode[]
  selected: MomentCode | null
  /** Model probability per code, when there is one. */
  confidence: (code: MomentCode) => number | null
  onSelect: (code: MomentCode) => void
}

/** What kind of evening this was. Pre-selected from the model, changed by a tap. */
export function MomentPicker({ order, selected, confidence, onSelect }: MomentPickerProps) {
  const selectedConfidence = selected ? confidence(selected) : null

  return (
    <div data-testid="scan-moment">
      <SegmentedButton accessibleName="Moment" selectionMode="Single">
        {order.map(code => {
          const p = confidence(code)
          return (
            <SegmentedButtonItem
              key={code}
              selected={selected === code}
              accessibleName={
                p === null
                  ? MOMENT_LABELS[code]
                  : `${MOMENT_LABELS[code]}, model confidence ${formatConfidence(p)}`
              }
              onClick={() => onSelect(code)}
            >
              {MOMENT_LABELS[code]}
            </SegmentedButtonItem>
          )
        })}
      </SegmentedButton>
      {selectedConfidence === null ? null : (
        <Text className="scan-field-note">
          Model confidence {formatConfidence(selectedConfidence)}
        </Text>
      )}
    </div>
  )
}
