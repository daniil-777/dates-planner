import { PersonPicker } from '../../components/PersonPicker'
import type { Person } from '../../api/types'

interface PaidByToggleProps {
  people: Person[]
  selected: string | null
  onSelect: (id: string) => void
}

/**
 * Whose card it was. A receipt never says, so the confirm card asks.
 *
 * One payer, chosen from however many people the household has (CONTRACTS.md §10) — the
 * shared `PersonPicker` handles the wrapping and, past six names, the filter, so this stays
 * a thumb-sized choice whether there are two people or ten. Clearing the choice is not
 * offered: a posting has to be booked against somebody, so re-tapping the chosen person
 * leaves them chosen.
 */
export function PaidByToggle({ people, selected, onSelect }: PaidByToggleProps) {
  return (
    <div data-testid="scan-paid-by">
      <PersonPicker
        people={people}
        selectedIds={selected === null ? [] : [selected]}
        label="Paid by"
        emptyText="Nobody is set up to pay yet — add people in Settings before posting."
        onChange={ids => {
          if (ids.length > 0) onSelect(ids[0])
        }}
      />
    </div>
  )
}
