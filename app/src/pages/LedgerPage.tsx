import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, MessageStrip, Panel, Title } from '@ui5/webcomponents-react'
import type { PanelDomRef, Ui5CustomEvent } from '@ui5/webcomponents-react'
import {
  useCategories,
  useEvents,
  useExpenses,
  useMonthlyTotals,
  usePeople,
  usePeriodTotals,
  useSettlements,
} from '@/api/hooks'
import type { Category, Event, PeriodTotals, Person } from '@/api/types'
import { DEFAULT_CURRENCY, currentPeriod, formatPeriod, shiftPeriod } from '@/theme'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { ClearingDocumentCard } from './ledger/ClearingDocumentCard'
import { ClosedPeriods } from './ledger/ClosedPeriods'
import { ExpenseDetailSheet } from './ledger/ExpenseDetailSheet'
import { ExpenseList } from './ledger/ExpenseList'
import { LedgerCharts, TREND_MONTHS } from './ledger/LedgerCharts'
import { LedgerFilters } from './ledger/LedgerFilters'
import { LedgerTotals } from './ledger/LedgerTotals'
import { MonthPicker } from './ledger/MonthPicker'
import { PeriodCloseDialog } from './ledger/PeriodCloseDialog'
import { EMPTY_FILTERS, filterExpenses } from './ledger/filters'
import './ledger/icons'
import './ledger/ledger.css'
import { previewClose, summarisePeriod, toTotalsInput } from './ledger/totals'
import { useLedgerMutations } from './ledger/useLedgerMutations'

export function LedgerPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState<string>(() => currentPeriod())
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | undefined>(undefined)
  const [selectedSettlementId, setSelectedSettlementId] = useState<string | undefined>(undefined)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeError, setCloseError] = useState<string | undefined>(undefined)
  const [markError, setMarkError] = useState<string | undefined>(undefined)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)

  const expensesQuery = useExpenses({ period })
  const categoriesQuery = useCategories()
  const peopleQuery = usePeople()
  const eventsQuery = useEvents()
  const totalsQuery = usePeriodTotals(period)
  const settlementsQuery = useSettlements()
  const monthlyQuery = useMonthlyTotals(shiftPeriod(period, -(TREND_MONTHS - 1)), period)
  const mutations = useLedgerMutations()

  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])
  const categories = useMemo<Category[]>(() => categoriesQuery.data ?? [], [categoriesQuery.data])
  const people = useMemo<Person[]>(() => peopleQuery.data ?? [], [peopleQuery.data])
  const events = useMemo<Event[]>(() => eventsQuery.data ?? [], [eventsQuery.data])
  const settlements = useMemo(() => settlementsQuery.data ?? [], [settlementsQuery.data])
  const monthly = useMemo(() => monthlyQuery.data ?? [], [monthlyQuery.data])

  const currency = expenses[0]?.currency ?? DEFAULT_CURRENCY

  const categoryMap = useMemo(
    () => new Map(categories.map(category => [category.code, category])),
    [categories],
  )
  const peopleMap = useMemo(() => new Map(people.map(person => [person.ID, person])), [people])
  const eventMap = useMemo(() => new Map(events.map(event => [event.ID, event])), [events])

  const visible = useMemo(() => filterExpenses(expenses, filters), [expenses, filters])
  const draftCount = expenses.filter(expense => expense.status === 'draft').length

  /**
   * The server owns the arithmetic (CONTRACTS.md §9); this falls back to the same sums over
   * the rows already on screen so the cards never sit blank while the query is in flight.
   */
  const totals = useMemo<PeriodTotals>(
    () => totalsQuery.data ?? summarisePeriod(expenses.map(toTotalsInput), period, people),
    [totalsQuery.data, expenses, period, people],
  )
  const preview = useMemo(() => previewClose(expenses, period), [expenses, period])

  const selectedExpense = expenses.find(expense => expense.ID === selectedExpenseId)
  const activeSettlement =
    settlements.find(settlement => settlement.ID === selectedSettlementId) ??
    settlements.find(settlement => settlement.period === period)

  const closePeriod = async () => {
    setCloseError(undefined)
    try {
      const settlement = await mutations.runSettlement(period)
      setSelectedSettlementId(settlement.ID)
      setCloseOpen(false)
    } catch (cause) {
      setCloseError(cause instanceof Error ? cause.message : 'The payment run failed.')
    }
  }

  const markClosed = async () => {
    if (!activeSettlement) return
    setMarkError(undefined)
    try {
      await mutations.markSettled(activeSettlement.ID)
    } catch (cause) {
      setMarkError(
        cause instanceof Error ? cause.message : 'The clearing document could not be closed.',
      )
    }
  }

  /** Changing month drops a document picked out of the history — the month picks its own. */
  const changePeriod = (next: string) => {
    setPeriod(next)
    setSelectedSettlementId(undefined)
    setMarkError(undefined)
  }

  const listContent = () => {
    if (expensesQuery.isLoading && expenses.length === 0) return <LoadingSkeleton rows={6} />
    if (expensesQuery.error)
      return <ErrorState error={expensesQuery.error} onRetry={() => void expensesQuery.refetch()} />
    if (expenses.length === 0)
      return (
        <EmptyState
          icon="receipt"
          title={`Nothing posted in ${formatPeriod(period)}`}
          description="Scan a receipt and it lands here, grouped by the day it happened."
          action={
            <Button className="ledger-touch" design="Emphasized" onClick={() => navigate('/scan')}>
              Scan a receipt
            </Button>
          }
        />
      )
    if (visible.length === 0)
      return (
        <EmptyState
          icon="filter"
          title="No postings match these filters"
          description="Loosen a filter to see the rest of the month."
          action={
            <Button className="ledger-touch" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      )
    return (
      <ExpenseList
        expenses={visible}
        categories={categoryMap}
        people={peopleMap}
        events={eventMap}
        onSelect={setSelectedExpenseId}
      />
    )
  }

  return (
    <div className="twm-page ledger">
      <div className="ledger__bar">
        <MonthPicker period={period} onChange={changePeriod} />
        <span className="ledger__bar-spacer" />
        <Button
          className="ledger-touch"
          design="Emphasized"
          icon="money-bills"
          onClick={() => {
            setCloseError(undefined)
            setCloseOpen(true)
          }}
        >
          Payment run
        </Button>
      </div>

      <LedgerTotals
        period={period}
        totals={totals}
        people={people}
        loading={totalsQuery.isLoading && !totalsQuery.data}
        postings={expenses.length}
        drafts={draftCount}
        currency={currency}
      />

      <LedgerCharts
        period={period}
        expenses={expenses}
        categories={categories}
        monthly={monthly}
        monthlyLoading={monthlyQuery.isLoading}
        currency={currency}
      />

      {activeSettlement && (
        <section className="ledger__section" aria-label="Clearing document">
          <ClearingDocumentCard
            settlement={activeSettlement}
            currency={currency}
            marking={mutations.markingSettled}
            onMarkClosed={markClosed}
          />
          {markError && (
            <MessageStrip design="Negative" onClose={() => setMarkError(undefined)}>
              {markError}
            </MessageStrip>
          )}
        </section>
      )}

      <section className="ledger__section" aria-label="Postings">
        <Title level="H4" className="ledger__section-title">
          Postings · {formatPeriod(period)}
        </Title>
        <LedgerFilters
          categories={categories}
          people={people}
          events={events}
          value={filters}
          onChange={setFilters}
          draftCount={draftCount}
          shownCount={visible.length}
          totalCount={expenses.length}
        />
        <div className="ledger__status">{listContent()}</div>
      </section>

      <Panel
        headerText="Closed periods"
        collapsed={historyCollapsed}
        onToggle={(event: Ui5CustomEvent<PanelDomRef>) =>
          setHistoryCollapsed(event.target.collapsed)
        }
      >
        {settlementsQuery.isLoading && settlements.length === 0 ? (
          <LoadingSkeleton rows={3} />
        ) : settlementsQuery.error ? (
          <ErrorState
            error={settlementsQuery.error}
            onRetry={() => void settlementsQuery.refetch()}
          />
        ) : (
          <ClosedPeriods
            settlements={settlements}
            selectedId={activeSettlement?.ID}
            currency={currency}
            onSelect={setSelectedSettlementId}
          />
        )}
      </Panel>

      <PeriodCloseDialog
        open={closeOpen}
        preview={preview}
        totals={totals}
        people={people}
        currency={currency}
        running={mutations.runningSettlement}
        error={closeError}
        onRun={closePeriod}
        onCancel={() => setCloseOpen(false)}
      />

      <ExpenseDetailSheet
        expense={selectedExpense}
        categories={categories}
        people={people}
        events={events}
        mutations={mutations}
        onClose={() => setSelectedExpenseId(undefined)}
      />
    </div>
  )
}

export default LedgerPage
