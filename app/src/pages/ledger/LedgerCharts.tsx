import { useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Card } from '@ui5/webcomponents-react'
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'
import type { Category, Expense, MonthlyTotal } from '@/api/types'
import { formatMoney, formatPeriod } from '@/theme'
import {
  breakdownDescription,
  categoryBreakdown,
  compactAmount,
  monthlyTrend,
  trendDescription,
} from './charts'
import { periodWindow } from './period'

const AXIS_COLOUR = 'var(--sapContent_LabelColor, #556b82)'
const GRID_COLOUR = 'var(--sapList_BorderColor, rgba(0, 0, 0, 0.08))'
const BRAND = 'var(--sapBrandColor, #0070f2)'
const TREND_MUTED = 'var(--sapNeutralElementColor, #788fa6)'

/** Six months of history, including the selected one. */
export const TREND_MONTHS = 6

interface ChartTooltipProps extends TooltipContentProps {
  currency: string
}

function ChartTooltip({ active, payload, label, currency }: ChartTooltipProps): ReactNode {
  if (!active || !payload || payload.length === 0) return null
  const entry = payload[0]
  const value = typeof entry.value === 'number' ? entry.value : Number(entry.value ?? 0)
  const title = typeof label === 'string' || typeof label === 'number' ? String(label) : ''
  return (
    <div className="chart__tooltip">
      <span className="chart__tooltip-label">{title}</span>
      {formatMoney(Number.isFinite(value) ? value : 0, currency)}
    </div>
  )
}

export interface LedgerChartsProps {
  period: string
  /** All postings of the selected month, before filters. */
  expenses: readonly Expense[]
  categories: readonly Category[]
  monthly: readonly MonthlyTotal[]
  monthlyLoading: boolean
  currency: string
}

export function LedgerCharts({
  period,
  expenses,
  categories,
  monthly,
  monthlyLoading,
  currency,
}: LedgerChartsProps) {
  const breakdownId = useId()
  const trendId = useId()

  const slices = useMemo(() => categoryBreakdown(expenses, categories), [expenses, categories])
  const periods = useMemo(() => periodWindow(period, TREND_MONTHS), [period])
  const trend = useMemo(() => monthlyTrend(monthly, periods, period), [monthly, periods, period])

  const breakdownHeight = Math.max(150, slices.length * 34 + 16)
  const top = slices[0]
  const trendTotal = trend.reduce((sum, point) => sum + point.total, 0)
  const average = trend.length > 0 ? trendTotal / trend.length : 0
  const hasTrend = trend.some(point => point.total > 0)

  return (
    <div className="charts">
      <Card accessibleName="Category breakdown">
        <figure className="chart" aria-labelledby={breakdownId}>
          <figcaption className="chart__title" id={breakdownId}>
            Where it went · {formatPeriod(period)}
          </figcaption>
          {slices.length === 0 ? (
            <p className="chart__caption">Nothing posted this month yet.</p>
          ) : (
            <>
              <div role="img" aria-label={breakdownDescription(slices, period, currency)}>
                <ResponsiveContainer width="100%" height={breakdownHeight}>
                  <BarChart
                    data={slices}
                    layout="vertical"
                    margin={{ top: 4, right: 72, bottom: 4, left: 0 }}
                    barCategoryGap="26%"
                    accessibilityLayer
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={88}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: AXIS_COLOUR, fontSize: 12 }}
                      interval={0}
                    />
                    <Tooltip
                      cursor={{ fill: GRID_COLOUR }}
                      content={props => <ChartTooltip {...props} currency={currency} />}
                    />
                    <Bar
                      dataKey="total"
                      radius={[0, 4, 4, 0]}
                      isAnimationActive={false}
                      maxBarSize={20}
                    >
                      {slices.map(slice => (
                        <Cell key={slice.code} fill={slice.colour} />
                      ))}
                      <LabelList
                        dataKey="label"
                        position="right"
                        fill={AXIS_COLOUR}
                        fontSize={12}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {top && (
                <p className="chart__caption">
                  {top.name} leads with {Math.round(top.share * 100)}% of the month.
                </p>
              )}
            </>
          )}
        </figure>
      </Card>

      <Card accessibleName="Six month trend">
        <figure className="chart" aria-labelledby={trendId}>
          <figcaption className="chart__title" id={trendId}>
            Last {TREND_MONTHS} months
          </figcaption>
          {monthlyLoading && !hasTrend ? (
            <p className="chart__caption">Loading monthly totals…</p>
          ) : !hasTrend ? (
            <p className="chart__caption">No history yet — it starts building this month.</p>
          ) : (
            <>
              <div role="img" aria-label={trendDescription(trend, currency)}>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={trend}
                    margin={{ top: 20, right: 8, bottom: 0, left: 0 }}
                    barCategoryGap="24%"
                    accessibilityLayer
                  >
                    <XAxis
                      dataKey="axis"
                      tickLine={false}
                      axisLine={{ stroke: GRID_COLOUR }}
                      tick={{ fill: AXIS_COLOUR, fontSize: 12 }}
                      interval={0}
                      tickMargin={6}
                    />
                    <YAxis
                      width={42}
                      tickCount={3}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: AXIS_COLOUR, fontSize: 11 }}
                      tickFormatter={compactAmount}
                    />
                    <Tooltip
                      cursor={{ fill: GRID_COLOUR }}
                      content={props => <ChartTooltip {...props} currency={currency} />}
                    />
                    <Bar
                      dataKey="total"
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={false}
                      maxBarSize={40}
                    >
                      {trend.map(point => (
                        <Cell key={point.period} fill={point.selected ? BRAND : TREND_MUTED} />
                      ))}
                      <LabelList
                        dataKey="selectedLabel"
                        position="top"
                        fill={AXIS_COLOUR}
                        fontSize={12}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="chart__caption">
                Monthly average {formatMoney(average, currency)} · the highlighted bar is{' '}
                {formatPeriod(period)}.
              </p>
            </>
          )}
        </figure>
      </Card>
    </div>
  )
}
