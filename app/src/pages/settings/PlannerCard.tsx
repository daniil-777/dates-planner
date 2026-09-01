/**
 * "Lisbon in October?" — the pre-spend planner.
 *
 * Somebody names a sum and a date; the ledger says whether that is a plan or a wish. The
 * facts are the backend's: `monthlyTotals` over the last twelve months (confirmed postings
 * only, docs/API.md §3.5) and the postings behind them for who has been paying. The
 * arithmetic and the verdict are `planner.ts`, which is pure and clamped — including the
 * horizon, which never leaves 1…120 months however creative the date in the field is.
 *
 * The per-person figures are intentions, not invoices: this app has no debt in it, so the
 * card says what each person plans to put aside and stops there.
 */
import { useMemo, useState } from 'react'
import { Label, MessageStrip, Text } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/simulate.js'
import { useExpenses, useMonthlyTotals, usePeople } from '@/api/hooks'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { currentPeriod, formatPeriod, shiftPeriod } from '@/theme'
import { SettingsCard } from './SettingsCard'
import { parseAmount } from './csv'
import {
  defaultTargetDate,
  derivePlannerFacts,
  planSpend,
  MAX_HORIZON_MONTHS,
  type ShareMode,
} from './planner'

/** The window the run-rate is taken from: a year, so one expensive month cannot decide it. */
const WINDOW_MONTHS = 11

const SHARE_MODES: Array<{ value: ShareMode; label: string }> = [
  { value: 'equal', label: 'Evenly' },
  { value: 'observed', label: 'As you pay' },
]

export function PlannerCard() {
  const toPeriod = currentPeriod()
  const fromPeriod = shiftPeriod(toPeriod, -WINDOW_MONTHS)

  const totals = useMonthlyTotals(fromPeriod, toPeriod)
  const expenses = useExpenses({ status: 'confirmed' })
  const people = usePeople()

  const [targetText, setTargetText] = useState('1800')
  const [targetDate, setTargetDate] = useState(() => defaultTargetDate())
  const [shareMode, setShareMode] = useState<ShareMode>('equal')

  const facts = useMemo(
    () =>
      derivePlannerFacts(
        totals.data ?? [],
        expenses.data ?? [],
        people.data ?? [],
        fromPeriod,
        toPeriod,
      ),
    [totals.data, expenses.data, people.data, fromPeriod, toPeriod],
  )

  const target = parseAmount(targetText) ?? 0
  const plan = useMemo(
    () => planSpend({ target, targetDate, shareMode }, facts),
    [target, targetDate, shareMode, facts],
  )

  const byId = useMemo(
    () => new Map((people.data ?? []).map(person => [person.ID, person])),
    [people.data],
  )

  // "52% · 31% · 17%", in the same order the contributions are listed.
  const observedSummary = useMemo(() => {
    const shares = new Map(facts.paidShares.map(share => [share.personId, share.share]))
    return plan.perPerson
      .map(contribution => `${Math.round((shares.get(contribution.personId) ?? 0) * 100)}%`)
      .join(' · ')
  }, [facts.paidShares, plan.perPerson])

  const loading = totals.isPending || expenses.isPending

  return (
    <SettingsCard
      icon="simulate"
      title="Pre-spend planner"
      subtitle="Commitment approval for something that has not happened yet."
    >
      <Text>
        <strong>Lisbon in October?</strong> Name the number and the date. The verdict is measured
        against what this household already spends on things that could be given up, because that is
        the only budget this ledger has ever been told about.
      </Text>

      <div className="twm-field-row">
        <div className="twm-field">
          <Label for="plan-target">Target amount (CHF)</Label>
          <input
            id="plan-target"
            className="twm-native-input"
            inputMode="decimal"
            value={targetText}
            onChange={event => setTargetText(event.target.value)}
          />
          {parseAmount(targetText) === null ? (
            <span className="twm-card-subtitle">
              Not a number yet — try 1&rsquo;800, 1800 or 1800.00.
            </span>
          ) : null}
        </div>

        <div className="twm-field">
          <Label for="plan-date">Needed by</Label>
          <input
            id="plan-date"
            className="twm-native-input"
            type="date"
            value={targetDate}
            onChange={event => setTargetDate(event.target.value)}
          />
        </div>

        <div className="twm-field">
          <Label>Set aside</Label>
          <div className="twm-segmented" role="group" aria-label="How to divide the set-aside">
            {SHARE_MODES.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={shareMode === option.value}
                onClick={() => setShareMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : totals.isError ? (
        <ErrorState error={totals.error} onRetry={() => void totals.refetch()} />
      ) : (
        <>
          <div className="twm-plan-verdict" data-verdict={plan.verdict}>
            <span className="twm-plan-headline">{plan.headline}</span>
            <span>{plan.rationale}</span>
          </div>

          <div className="twm-plan-figures">
            <div className="twm-plan-figure">
              <span className="twm-plan-figure-label">Set aside per month</span>
              <MoneyText amount={plan.monthlySetAside} size="L" bold />
            </div>
            <div className="twm-plan-figure">
              <span className="twm-plan-figure-label">Horizon</span>
              <Text>{`${plan.horizonMonths} ${plan.horizonMonths === 1 ? 'month' : 'months'}`}</Text>
            </div>
            <div className="twm-plan-figure">
              <span className="twm-plan-figure-label">Commitment</span>
              <MoneyText amount={plan.target} />
            </div>
          </div>

          <div className="twm-plan-shares">
            {plan.perPerson.map(contribution => {
              const person = byId.get(contribution.personId)
              return (
                <span className="twm-plan-person" key={contribution.personId}>
                  {person ? <PersonAvatar person={person} size="S" /> : null}
                  <span>{contribution.name}</span>
                  <MoneyText amount={contribution.amount} />
                </span>
              )
            })}
            <span className="twm-card-subtitle">
              {plan.perPerson.length === 0
                ? 'Nobody is on the roster yet, so there is nobody to put it aside.'
                : shareMode === 'equal'
                  ? 'Divided evenly, one share each.'
                  : `Weighted the way this household has actually been paying (${observedSummary}).`}
            </span>
          </div>

          {plan.clamped ? (
            <MessageStrip design="Critical" hideCloseButton>
              {plan.requestedMonths < 1
                ? 'That date has already been and gone, so the plan assumes this month.'
                : `That is further out than ${MAX_HORIZON_MONTHS} months; the plan uses ten years.`}
            </MessageStrip>
          ) : null}

          <p className="twm-card-footnote">
            {`Simulation basis: monthlyTotals(${formatPeriod(facts.fromPeriod)} … ` +
              `${formatPeriod(facts.toPeriod)}), ${facts.monthsObserved} ` +
              `${facts.monthsObserved === 1 ? 'month' : 'months'} with postings. `}
            {facts.monthsObserved > 0 ? (
              <>
                Average <MoneyText amount={facts.averageMonthly} tone="subtle" /> a month, of which{' '}
                <MoneyText amount={facts.discretionaryMonthly} tone="subtle" /> is discretionary.
              </>
            ) : null}
          </p>
        </>
      )}
    </SettingsCard>
  )
}

export default PlannerCard
