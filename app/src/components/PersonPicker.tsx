import '@ui5/webcomponents-icons/dist/search.js'
import { useMemo, useState } from 'react'
import { Icon, Input, Text } from '@ui5/webcomponents-react'
import type { Person } from '../api/types'
import { PersonAvatar } from './PersonAvatar'
import './components.css'

export interface PersonPickerProps {
  people: Person[]
  /** The ids currently chosen. Single-select pickers pass an array of at most one. */
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** Defaults to `false`: one at a time, and choosing the chosen one clears it. */
  multiple?: boolean
  /** Names the group for screen readers. */
  label?: string
  /** Shown instead of the roster when there is nobody to pick. */
  emptyText?: string
  className?: string
}

/**
 * Pick people. Any number of them.
 *
 * There is no fixed roster in this app (CONTRACTS.md §10) — a household of two and a trip
 * with nine both come through here — so the control is a wrapping list of toggles rather
 * than a pair of buttons, and past `SEARCH_FROM` names it grows a filter so the ninth
 * person is as reachable as the first. Filtering never hides somebody already chosen:
 * a selection you cannot see is a selection you cannot undo.
 */
const SEARCH_FROM = 6

export function PersonPicker({
  people,
  selectedIds,
  onChange,
  multiple = false,
  label,
  emptyText = 'Nobody to choose from yet — add people in Settings.',
  className,
}: PersonPickerProps) {
  const [filter, setFilter] = useState('')
  const chosen = useMemo(() => new Set(selectedIds), [selectedIds])

  const showSearch = people.length >= SEARCH_FROM
  const needle = filter.trim().toLowerCase()

  const shown = useMemo(() => {
    if (needle === '') return people
    return people.filter(
      person =>
        chosen.has(person.ID) ||
        person.name.toLowerCase().includes(needle) ||
        (person.email ?? '').toLowerCase().includes(needle),
    )
  }, [people, needle, chosen])

  const toggle = (id: string): void => {
    if (!multiple) {
      onChange(chosen.has(id) ? [] : [id])
      return
    }
    onChange(chosen.has(id) ? selectedIds.filter(current => current !== id) : [...selectedIds, id])
  }

  if (people.length === 0) {
    return <Text className="twm-people__empty">{emptyText}</Text>
  }

  return (
    <div className={className ? `twm-people ${className}` : 'twm-people'}>
      {showSearch ? (
        <Input
          className="twm-people__search"
          value={filter}
          placeholder="Find someone"
          icon={<Icon name="search" />}
          accessibleName={`Filter ${label ?? 'people'}`}
          onInput={event => setFilter(event.target.value ?? '')}
        />
      ) : null}

      <div
        className="twm-people__list"
        role="group"
        aria-label={label ?? (multiple ? 'People' : 'Person')}
        data-testid="person-picker"
      >
        {shown.map(person => {
          const isChosen = chosen.has(person.ID)
          return (
            <button
              key={person.ID}
              type="button"
              className={isChosen ? 'twm-person twm-person--chosen' : 'twm-person'}
              aria-pressed={isChosen}
              onClick={() => toggle(person.ID)}
            >
              <PersonAvatar person={person} size="S" selected={isChosen} />
              <span className="twm-person__name">{person.name}</span>
            </button>
          )
        })}

        {shown.length === 0 ? (
          <Text className="twm-people__empty">{`Nobody here is called “${filter.trim()}”.`}</Text>
        ) : null}
      </div>

      {multiple ? (
        <span className="twm-people__count">
          {selectedIds.length === 0
            ? 'Nobody selected yet.'
            : `${selectedIds.length} of ${people.length} selected.`}
        </span>
      ) : null}
    </div>
  )
}

export default PersonPicker
