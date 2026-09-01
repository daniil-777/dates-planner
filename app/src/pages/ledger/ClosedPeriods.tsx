import { List, ListItemCustom, Tag } from '@ui5/webcomponents-react'
import type { ListDomRef, Ui5CustomEvent } from '@ui5/webcomponents-react'
import type { ListItemClickEventDetail } from '@ui5/webcomponents/dist/List.js'
import type { Settlement } from '@/api/types'
import { EmptyState } from '@/components/EmptyState'
import { MoneyText } from '@/components/MoneyText'
import { formatMoney, formatPeriod } from '@/theme'
import './icons'

export interface ClosedPeriodsProps {
  settlements: readonly Settlement[]
  selectedId: string | undefined
  currency: string
  onSelect: (id: string) => void
}

/** Every period that has been closed, newest first, with what it totalled. */
export function ClosedPeriods({ settlements, selectedId, currency, onSelect }: ClosedPeriodsProps) {
  if (settlements.length === 0) {
    return (
      <EmptyState
        icon="money-bills"
        title="No periods closed yet"
        description="Run the payment run at the end of the month and the clearing document shows up here."
      />
    )
  }

  const ordered = [...settlements].sort((a, b) => b.period.localeCompare(a.period))

  const handleItemClick = (event: Ui5CustomEvent<ListDomRef, ListItemClickEventDetail>) => {
    const id = (event.detail.item as HTMLElement).dataset.settlementId
    if (id) onSelect(id)
  }

  return (
    <List accessibleName="Closed periods" separators="Inner" onItemClick={handleItemClick}>
      {ordered.map(settlement => {
        const document = settlement.clearingDocument || `CLR-${settlement.period}`
        const closed = settlement.status === 'settled'
        return (
          <ListItemCustom
            key={settlement.ID}
            className="history-row"
            data-settlement-id={settlement.ID}
            selected={settlement.ID === selectedId}
            accessibleName={`${document}, ${formatPeriod(settlement.period)}, ${formatMoney(
              settlement.grandTotal,
              currency,
            )} posted, ${closed ? 'closed' : 'open'}`}
          >
            <div className="history-row__inner">
              <div className="history-row__body">
                <div className="history-row__doc">{document}</div>
                <div className="history-row__meta">
                  {formatPeriod(settlement.period)} · total posted
                </div>
              </div>
              <MoneyText amount={settlement.grandTotal} currency={currency} bold={!closed} />
              <Tag design={closed ? 'Positive' : 'Critical'}>{closed ? 'Closed' : 'Open'}</Tag>
            </div>
          </ListItemCustom>
        )
      })}
    </List>
  )
}
