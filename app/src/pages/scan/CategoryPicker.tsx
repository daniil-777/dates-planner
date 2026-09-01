import { CategoryChip } from '../../components/CategoryChip'
import type { RankedCategory } from './form'

interface CategoryPickerProps {
  ranked: RankedCategory[]
  selected: string | null
  onSelect: (code: string) => void
}

/**
 * Category chips ordered by what the model thinks, best first, with the
 * probability shown quietly next to the leaders. Everything else stays
 * reachable in code-list order — a human is never one chip short.
 */
export function CategoryPicker({ ranked, selected, onSelect }: CategoryPickerProps) {
  return (
    <div className="scan-chips" role="group" aria-label="Category" data-testid="scan-categories">
      {ranked.map(({ category, p }) => (
        <span className="scan-chip-slot" key={category.code}>
          <CategoryChip
            category={category}
            confidence={p ?? undefined}
            selected={selected === category.code}
            onSelect={() => onSelect(category.code)}
          />
        </span>
      ))}
    </div>
  )
}
