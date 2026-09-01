/**
 * "New memories detected" — the nudge strip.
 *
 * The classifier already decided these expenses were a date night, a trip or a
 * gift. Nobody has written them up yet, so the app offers to do the boring half:
 * one tap posts a memory carrying the expense's date, place and coordinates,
 * and the story can be added later. Tapping the card itself opens the editor
 * pre-filled instead, for when the story is the point.
 */

import { Button, Icon, Text } from '@ui5/webcomponents-react'
import { MoneyText } from '@/components/MoneyText'
import { MomentBadge } from '@/components/MomentBadge'
import type { Expense } from '@/api/types'
import { formatSwissDate } from './dates'
import { kindIcon, momentToKind, titleFromExpense } from './timeline'

export interface NewMemoriesStripProps {
  expenses: readonly Expense[]
  /** One-tap: post the memory straight from the expense. */
  onQuickCreate: (expense: Expense) => void
  /** Open the editor pre-filled from this expense. */
  onCompose: (expense: Expense) => void
  /** The expense currently being posted, so its button can show it. */
  busyExpenseId: string | null
}

export function NewMemoriesStrip({
  expenses,
  onQuickCreate,
  onCompose,
  busyExpenseId,
}: NewMemoriesStripProps) {
  if (expenses.length === 0) return null

  return (
    <section className="tw-card tw-detected" aria-label="New memories detected">
      <div className="tw-card__title">
        <Icon name="history" aria-hidden="true" />
        <span>New memories detected</span>
        <Text className="tw-label" style={{ marginInlineStart: 'auto' }}>
          {expenses.length} unposted
        </Text>
      </div>

      <div className="tw-detected__scroller">
        {expenses.map(expense => (
          <div key={expense.ID} className="tw-detected__item">
            <div className="tw-detected__head">
              <Icon name={kindIcon(momentToKind(expense.moment))} aria-hidden="true" />
              <span className="tw-detected__merchant">{titleFromExpense(expense)}</span>
            </div>

            <div className="tw-detected__meta">
              <Text className="tw-label">{formatSwissDate(expense.date)}</Text>
              <MoneyText amount={expense.amount} currency={expense.currency} bold />
            </div>

            {expense.place ? (
              <Text className="tw-label" title={expense.place}>
                {expense.place}
              </Text>
            ) : null}

            <div className="tw-entry__line">
              {expense.moment ? <MomentBadge moment={expense.moment} /> : null}
            </div>

            <div className="tw-detected__buttons">
              <Button
                design="Emphasized"
                icon="write-new"
                disabled={busyExpenseId === expense.ID}
                onClick={() => onQuickCreate(expense)}
              >
                {busyExpenseId === expense.ID ? 'Posting…' : 'Write it up'}
              </Button>
              <Button
                design="Transparent"
                icon="edit"
                accessibleName={`Add the story for ${titleFromExpense(expense)}`}
                tooltip="Add the story"
                onClick={() => onCompose(expense)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
