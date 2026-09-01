/**
 * Every write the Ledger performs, in one place.
 *
 * The page and its dialogs call these plain async functions; the TanStack Query
 * hooks in `@/api/hooks` own the cache invalidation.
 */
import { useCallback } from 'react'
import {
  useConfirmExpense,
  useDeleteExpense,
  useMarkSettled,
  useRunSettlement,
  useUpdateExpense,
} from '@/api/hooks'
import type { Expense, Settlement } from '@/api/types'

export interface LedgerMutations {
  updateExpense: (id: string, patch: Partial<Expense>) => Promise<Expense>
  deleteExpense: (id: string) => Promise<void>
  confirmExpense: (
    id: string,
    predictedCategory?: string,
    predictedMoment?: string,
  ) => Promise<Expense>
  /** The payment run: closes `period` and files its clearing document. */
  runSettlement: (period: string) => Promise<Settlement>
  /** Marks a closed period done. */
  markSettled: (id: string) => Promise<Settlement>
  /** A posting is being written. */
  savingExpense: boolean
  /** The period close is in flight. */
  runningSettlement: boolean
  markingSettled: boolean
}

export function useLedgerMutations(): LedgerMutations {
  const update = useUpdateExpense()
  const remove = useDeleteExpense()
  const confirm = useConfirmExpense()
  const run = useRunSettlement()
  const settle = useMarkSettled()

  const updateExpense = useCallback(
    (id: string, patch: Partial<Expense>) => update.mutateAsync({ id, patch }),
    [update],
  )
  const deleteExpense = useCallback(
    async (id: string) => {
      await remove.mutateAsync(id)
    },
    [remove],
  )
  const confirmExpense = useCallback(
    (id: string, predictedCategory?: string, predictedMoment?: string) =>
      confirm.mutateAsync({ id, predictedCategory, predictedMoment }),
    [confirm],
  )
  const runSettlement = useCallback((period: string) => run.mutateAsync(period), [run])
  const markSettled = useCallback((id: string) => settle.mutateAsync(id), [settle])

  return {
    updateExpense,
    deleteExpense,
    confirmExpense,
    runSettlement,
    markSettled,
    savingExpense: update.isPending || remove.isPending || confirm.isPending,
    runningSettlement: run.isPending,
    markingSettled: settle.isPending,
  }
}
