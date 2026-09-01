import type { Expense } from '@/api/types'

export interface LedgerFilterState {
  /** Category code, or 'all'. */
  category: string
  /** Moment code, or 'all'. */
  moment: string
  /** `People.ID`, or 'all'. */
  paidBy: string
  /** `Events.ID`, 'all', or `NO_EVENT` for everyday spending that belongs to no event. */
  event: string
  /** Only postings that still need review (drafts). */
  needsReview: boolean
}

export const ALL = 'all'

/** Postings with no event at all — everyday spending. */
export const NO_EVENT = 'none'

export const EMPTY_FILTERS: LedgerFilterState = {
  category: ALL,
  moment: ALL,
  paidBy: ALL,
  event: ALL,
  needsReview: false,
}

export function isFiltered(filters: LedgerFilterState): boolean {
  return (
    filters.category !== ALL ||
    filters.moment !== ALL ||
    filters.paidBy !== ALL ||
    filters.event !== ALL ||
    filters.needsReview
  )
}

export function filterExpenses(
  expenses: readonly Expense[],
  filters: LedgerFilterState,
): Expense[] {
  return expenses.filter(expense => {
    if (filters.category !== ALL && expense.category_code !== filters.category) return false
    if (filters.moment !== ALL && expense.moment !== filters.moment) return false
    if (filters.paidBy !== ALL && expense.paidBy_ID !== filters.paidBy) return false
    if (filters.event === NO_EVENT && expense.event_ID !== null) return false
    if (filters.event !== ALL && filters.event !== NO_EVENT && expense.event_ID !== filters.event)
      return false
    if (filters.needsReview && expense.status !== 'draft') return false
    return true
  })
}
