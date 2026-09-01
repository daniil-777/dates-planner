import { Icon, List, ListItemCustom } from '@ui5/webcomponents-react'
import type { Category, Expense, Person } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney, resolveIcon } from '@/theme'
import './icons'
import { formatDay } from './dates'

export interface EventExpenseListProps {
  expenses: readonly Expense[]
  categories: ReadonlyMap<string, Category>
  people: ReadonlyMap<string, Person>
}

/** Newest first; inside a day, the latest posting on top. */
export function sortPostings(expenses: readonly Expense[]): Expense[] {
  return [...expenses].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      (b.time ?? '').localeCompare(a.time ?? '') ||
      a.merchantRaw.localeCompare(b.merchantRaw),
  )
}

/**
 * The postings booked on one event.
 *
 * Rows are inactive: this list is a statement of what the event cost, and the place to edit a
 * posting is the ledger, where the whole month is in view. Each row names who paid — that is
 * the only person-shaped fact an expense carries.
 */
export function EventExpenseList({ expenses, categories, people }: EventExpenseListProps) {
  const rows = sortPostings(expenses)

  return (
    <List accessibleName="Postings on this event" separators="Inner">
      {rows.map(expense => {
        const category = expense.category_code ? categories.get(expense.category_code) : undefined
        const payer = expense.paidBy_ID ? people.get(expense.paidBy_ID) : undefined
        const meta = [formatDay(expense.date), category?.name ?? 'Uncategorised', expense.place]
          .filter((part): part is string => Boolean(part))
          .join(' · ')

        return (
          <ListItemCustom
            key={expense.ID}
            type="Inactive"
            data-expense-id={expense.ID}
            accessibleName={`${expense.merchantRaw}, ${formatMoney(
              expense.amount,
              expense.currency,
            )}, ${meta}${payer ? `, paid by ${payer.name}` : ''}`}
          >
            <div className="ev-posting">
              <Icon
                name={resolveIcon(category?.icon)}
                style={category ? { color: category.colour } : undefined}
                aria-hidden="true"
              />
              <span className="ev-posting__body">
                <span className="ev-posting__merchant">{expense.merchantRaw}</span>
                <span className="ev-posting__meta">{meta}</span>
              </span>
              <span className="ev-posting__trailing">
                <MoneyText amount={expense.amount} currency={expense.currency} bold />
                {payer ? (
                  <PersonAvatar person={payer} size="S" />
                ) : (
                  <span aria-hidden="true">—</span>
                )}
              </span>
            </div>
          </ListItemCustom>
        )
      })}
    </List>
  )
}

export default EventExpenseList
