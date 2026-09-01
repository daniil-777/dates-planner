import { Icon, List, ListItemCustom, ListItemGroup, Tag } from '@ui5/webcomponents-react'
import type { ListDomRef, Ui5CustomEvent } from '@ui5/webcomponents-react'
import type { ListItemClickEventDetail } from '@ui5/webcomponents/dist/List.js'
import type { Category, Event, Expense, Person } from '@/api/types'
import { EventChip } from '@/components/EventChip'
import { MoneyText } from '@/components/MoneyText'
import { MomentBadge } from '@/components/MomentBadge'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney, formatTime, resolveIcon } from '@/theme'
import { UNCATEGORISED_COLOUR, withAlpha } from './colour'
import './icons'
import { dayHeading } from './period'

interface DayGroup {
  date: string
  label: string
  total: number
  items: Expense[]
}

/** Newest day first; inside a day, latest posting first. */
function groupByDay(expenses: readonly Expense[], today?: Date): DayGroup[] {
  const byDate = new Map<string, Expense[]>()
  for (const expense of expenses) {
    const bucket = byDate.get(expense.date)
    if (bucket) bucket.push(expense)
    else byDate.set(expense.date, [expense])
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({
      date,
      label: dayHeading(date, today),
      total: items.reduce((sum, item) => sum + item.amount, 0),
      items: [...items].sort(
        (a, b) =>
          (b.time ?? '').localeCompare(a.time ?? '') || a.merchantRaw.localeCompare(b.merchantRaw),
      ),
    }))
}

export interface ExpenseListProps {
  expenses: readonly Expense[]
  categories: ReadonlyMap<string, Category>
  people: ReadonlyMap<string, Person>
  events: ReadonlyMap<string, Event>
  onSelect: (id: string) => void
}

export function ExpenseList({ expenses, categories, people, events, onSelect }: ExpenseListProps) {
  const groups = groupByDay(expenses)

  const handleItemClick = (event: Ui5CustomEvent<ListDomRef, ListItemClickEventDetail>) => {
    const id = (event.detail.item as HTMLElement).dataset.expenseId
    if (id) onSelect(id)
  }

  return (
    <List accessibleName="Postings" separators="Inner" onItemClick={handleItemClick}>
      {groups.map(group => (
        <ListItemGroup
          key={group.date}
          headerText={`${group.label} · ${formatMoney(group.total)}`}
          headerAccessibleName={`${group.label}, ${group.items.length} postings, ${formatMoney(group.total)}`}
        >
          {group.items.map(expense => (
            <ExpenseRow
              key={expense.ID}
              expense={expense}
              category={expense.category_code ? categories.get(expense.category_code) : undefined}
              payer={expense.paidBy_ID ? people.get(expense.paidBy_ID) : undefined}
              event={expense.event_ID ? events.get(expense.event_ID) : undefined}
            />
          ))}
        </ListItemGroup>
      ))}
    </List>
  )
}

interface ExpenseRowProps {
  expense: Expense
  category: Category | undefined
  payer: Person | undefined
  event: Event | undefined
}

function ExpenseRow({ expense, category, payer, event }: ExpenseRowProps) {
  const colour = category?.colour ?? UNCATEGORISED_COLOUR
  const time = formatTime(expense.time)
  const meta = [category?.name ?? 'Uncategorised', expense.place ?? undefined, time ?? undefined]
    .filter(Boolean)
    .join(' · ')

  return (
    <ListItemCustom
      className="expense-row"
      data-expense-id={expense.ID}
      accessibleName={`${expense.merchantRaw}, ${formatMoney(expense.amount, expense.currency)}, ${meta}${
        payer ? `, paid by ${payer.name}` : ''
      }${event ? `, part of ${event.name}` : ''}${
        expense.status === 'draft' ? ', needs review' : ''
      }`}
    >
      <div className="expense-row__inner">
        <span
          className="expense-row__icon"
          style={{ backgroundColor: withAlpha(colour, 0.14) }}
          aria-hidden="true"
        >
          <Icon
            name={resolveIcon(category?.icon)}
            style={{ color: colour, width: '1.125rem', height: '1.125rem' }}
          />
        </span>

        <span className="expense-row__body">
          <span className="expense-row__merchant">{expense.merchantRaw}</span>
          <span className="expense-row__meta">
            <span>{meta}</span>
            {expense.moment && <MomentBadge moment={expense.moment} />}
            {event && <EventChip event={event} />}
            {expense.status === 'draft' && (
              <Tag design="Critical" className="expense-row__draft">
                Needs review
              </Tag>
            )}
          </span>
        </span>

        <span className="expense-row__trailing">
          <span className="expense-row__amount">
            <MoneyText amount={expense.amount} currency={expense.currency} bold />
          </span>
          {payer ? <PersonAvatar person={payer} size="S" /> : <span aria-hidden="true">—</span>}
        </span>
      </div>
    </ListItemCustom>
  )
}
