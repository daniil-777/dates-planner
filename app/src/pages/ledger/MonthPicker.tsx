import { useMemo } from 'react'
import { Button, Option, Select } from '@ui5/webcomponents-react'
import type { SelectDomRef, Ui5CustomEvent } from '@ui5/webcomponents-react'
import type { SelectChangeEventDetail } from '@ui5/webcomponents/dist/Select.js'
import { currentPeriod, formatPeriod, shiftPeriod } from '@/theme'
import { periodWindow } from './period'
import './icons'

export interface MonthPickerProps {
  period: string
  onChange: (period: string) => void
  /** How many months the drop-down offers, ending at the newer of today / the selection. */
  months?: number
}

/** Month navigation for the ledger: previous · month · next. Never runs into the future. */
export function MonthPicker({ period, onChange, months = 24 }: MonthPickerProps) {
  const today = currentPeriod()
  const newest = period > today ? period : today
  const options = useMemo(() => periodWindow(newest, months).reverse(), [newest, months])
  const atNewest = period >= newest

  const handleChange = (event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>) => {
    const next = event.detail.selectedOption.value
    if (next && next !== period) onChange(next)
  }

  return (
    <div className="ledger__month">
      <Button
        className="ledger-touch"
        design="Transparent"
        data-testid="month-previous"
        icon="slim-arrow-left"
        accessibleName={`Previous month, ${formatPeriod(shiftPeriod(period, -1))}`}
        tooltip="Previous month"
        onClick={() => onChange(shiftPeriod(period, -1))}
      />
      <Select accessibleName="Accounting period" onChange={handleChange}>
        {options.map(option => (
          <Option key={option} value={option} selected={option === period}>
            {formatPeriod(option)}
          </Option>
        ))}
      </Select>
      <Button
        className="ledger-touch"
        design="Transparent"
        data-testid="month-next"
        icon="slim-arrow-right"
        disabled={atNewest}
        accessibleName={`Next month, ${formatPeriod(shiftPeriod(period, 1))}`}
        tooltip="Next month"
        onClick={() => onChange(shiftPeriod(period, 1))}
      />
    </div>
  )
}
