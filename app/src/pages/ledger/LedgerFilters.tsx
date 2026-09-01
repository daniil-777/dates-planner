import { Button, Option, Select, ToggleButton } from '@ui5/webcomponents-react'
import type { SelectDomRef, Ui5CustomEvent } from '@ui5/webcomponents-react'
import type { SelectChangeEventDetail } from '@ui5/webcomponents/dist/Select.js'
import type { Category, Event, Person } from '@/api/types'
import { MOMENT_CODES, MOMENT_LABELS } from '@/theme'
import { ALL, EMPTY_FILTERS, NO_EVENT, isFiltered } from './filters'
import type { LedgerFilterState } from './filters'
import './icons'

export interface LedgerFiltersProps {
  categories: readonly Category[]
  people: readonly Person[]
  events: readonly Event[]
  value: LedgerFilterState
  onChange: (next: LedgerFilterState) => void
  draftCount: number
  shownCount: number
  totalCount: number
}

/**
 * Four drop-downs and a toggle. Every one of them is a plain `Select` because the roster is
 * a list of unknown length — there is no "one or the other" control left in this app.
 */
export function LedgerFilters({
  categories,
  people,
  events,
  value,
  onChange,
  draftCount,
  shownCount,
  totalCount,
}: LedgerFiltersProps) {
  const selected = (event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>): string =>
    event.detail.selectedOption.value ?? ALL

  return (
    <div className="ledger__section">
      <div className="filters" role="group" aria-label="Filter postings">
        <Select
          accessibleName="Category"
          onChange={event => onChange({ ...value, category: selected(event) })}
          className="ledger-touch"
          tooltip="Filter by category"
        >
          <Option value={ALL} selected={value.category === ALL}>
            All categories
          </Option>
          {categories.map(category => (
            <Option
              key={category.code}
              value={category.code}
              selected={value.category === category.code}
            >
              {category.name}
            </Option>
          ))}
        </Select>

        <Select
          accessibleName="Moment"
          onChange={event => onChange({ ...value, moment: selected(event) })}
          className="ledger-touch"
          tooltip="Filter by moment"
        >
          <Option value={ALL} selected={value.moment === ALL}>
            All moments
          </Option>
          {MOMENT_CODES.map(moment => (
            <Option key={moment} value={moment} selected={value.moment === moment}>
              {MOMENT_LABELS[moment]}
            </Option>
          ))}
        </Select>

        <Select
          accessibleName="Paid by"
          onChange={event => onChange({ ...value, paidBy: selected(event) })}
          className="ledger-touch"
          tooltip="Filter by who paid"
        >
          <Option value={ALL} selected={value.paidBy === ALL}>
            Paid by anyone
          </Option>
          {people.map(person => (
            <Option key={person.ID} value={person.ID} selected={value.paidBy === person.ID}>
              {person.name}
            </Option>
          ))}
        </Select>

        <Select
          accessibleName="Event"
          onChange={event => onChange({ ...value, event: selected(event) })}
          className="ledger-touch"
          tooltip="Filter by event"
        >
          <Option value={ALL} selected={value.event === ALL}>
            All events
          </Option>
          <Option value={NO_EVENT} selected={value.event === NO_EVENT}>
            No event
          </Option>
          {events.map(entry => (
            <Option key={entry.ID} value={entry.ID} selected={value.event === entry.ID}>
              {entry.name}
            </Option>
          ))}
        </Select>

        <ToggleButton
          className="ledger-touch"
          icon="filter"
          pressed={value.needsReview}
          accessibleName="Show only postings that need review"
          onClick={() => onChange({ ...value, needsReview: !value.needsReview })}
        >
          {draftCount > 0 ? `Needs review (${draftCount})` : 'Needs review'}
        </ToggleButton>

        {isFiltered(value) && (
          <Button
            className="filters__reset ledger-touch"
            design="Transparent"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Clear
          </Button>
        )}
      </div>
      {isFiltered(value) && (
        <p className="filters__summary" aria-live="polite">
          Showing {shownCount} of {totalCount} postings
        </p>
      )}
    </div>
  )
}
