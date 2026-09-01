import type { Category, Expense, MonthlyTotal } from '@/api/types'
import { formatAmount, formatMoney, formatPeriod } from '@/theme'
import { UNCATEGORISED_COLOUR } from './colour'
import { periodAxisLabel } from './period'

export interface CategorySlice {
  code: string
  name: string
  total: number
  colour: string
  /** Pre-rendered bar label — recharts gets a string, never a formatter. */
  label: string
  share: number
}

/** Month spend per category, biggest first. Colours always come from the Category row. */
export function categoryBreakdown(
  expenses: readonly Expense[],
  categories: readonly Category[],
): CategorySlice[] {
  const byCode = new Map<string, Category>(categories.map(category => [category.code, category]))
  const totals = new Map<string, number>()
  for (const expense of expenses) {
    const code = expense.category_code ?? '__none'
    totals.set(code, (totals.get(code) ?? 0) + expense.amount)
  }
  const grand = [...totals.values()].reduce((sum, value) => sum + value, 0)
  return [...totals.entries()]
    .map(([code, total]) => {
      const category = byCode.get(code)
      return {
        code,
        name: category?.name ?? 'Uncategorised',
        total: Math.round(total * 100) / 100,
        colour: category?.colour ?? UNCATEGORISED_COLOUR,
        label: formatAmount(total),
        share: grand > 0 ? total / grand : 0,
      }
    })
    .filter(slice => slice.total > 0)
    .sort((a, b) => b.total - a.total)
}

export interface TrendPoint {
  period: string
  axis: string
  total: number
  selected: boolean
  /** Only the selected month is direct-labelled, so the axis stays uncluttered. */
  selectedLabel: string
}

/** Monthly totals for the six periods ending at `period`, zero-filled. */
export function monthlyTrend(
  monthly: readonly MonthlyTotal[],
  periods: readonly string[],
  selected: string,
): TrendPoint[] {
  const totals = new Map<string, number>(periods.map(period => [period, 0]))
  for (const row of monthly) {
    if (!totals.has(row.period)) continue
    totals.set(row.period, (totals.get(row.period) ?? 0) + row.total)
  }
  return periods.map((period, index) => {
    const total = Math.round((totals.get(period) ?? 0) * 100) / 100
    const isSelected = period === selected
    return {
      period,
      axis: periodAxisLabel(period, index > 0 ? periods[index - 1] : undefined),
      total,
      selected: isSelected,
      selectedLabel: isSelected && total > 0 ? formatAmount(total) : '',
    }
  })
}

/** Compact axis ticks: 1'250 → 1.3k. Never `toLocaleString`. */
export function compactAmount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1000) {
    const thousands = value / 1000
    const rounded =
      Math.abs(thousands) >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10
    return `${rounded}k`
  }
  return String(Math.round(value))
}

export function breakdownDescription(
  slices: readonly CategorySlice[],
  period: string,
  currency: string,
): string {
  if (slices.length === 0) return `No spending recorded in ${formatPeriod(period)}.`
  const total = slices.reduce((sum, slice) => sum + slice.total, 0)
  const parts = slices
    .slice(0, 5)
    .map(slice => `${slice.name} ${formatMoney(slice.total, currency)}`)
    .join(', ')
  const rest = slices.length > 5 ? `, and ${slices.length - 5} smaller categories` : ''
  return `Bar chart. Spending by category in ${formatPeriod(period)}, ${formatMoney(
    total,
    currency,
  )} in total: ${parts}${rest}.`
}

export function trendDescription(points: readonly TrendPoint[], currency: string): string {
  if (points.length === 0) return 'No monthly totals available yet.'
  const first = points[0]
  const last = points[points.length - 1]
  const parts = points
    .map(point => `${formatPeriod(point.period)} ${formatMoney(point.total, currency)}`)
    .join(', ')
  return `Bar chart. Monthly totals from ${formatPeriod(first.period)} to ${formatPeriod(
    last.period,
  )}: ${parts}.`
}
