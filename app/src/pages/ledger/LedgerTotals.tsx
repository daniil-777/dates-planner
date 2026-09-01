import { Card } from '@ui5/webcomponents-react'
import type { PeriodTotals, Person } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney, formatPeriod } from '@/theme'
import { PERSON_FALLBACK_COLOUR } from './colour'
import { rosterTotals } from './totals'

export interface LedgerTotalsProps {
  period: string
  /** What the month came to and who paid it — `usePeriodTotals(period)`. */
  totals: PeriodTotals
  /** The whole roster, so somebody who paid nothing this month still gets a line. */
  people: readonly Person[]
  loading: boolean
  /** Postings in the month, and how many of them still need review. */
  postings: number
  drafts: number
  currency: string
}

/** `0.3821` → `'38%'`. Whole percent everywhere; a bar this small needs no decimals. */
const percent = (share: number): string =>
  `${Math.round((Number.isFinite(share) ? share : 0) * 100)}%`

/**
 * The two numbers the month is actually about: what it cost, and who paid it.
 *
 * There is no third card: there is no debt in this app (CONTRACTS.md §9). The roster is a
 * list of amounts with a proportion bar behind each one — a picture of where the money came
 * from, and nothing anyone has to act on.
 */
export function LedgerTotals({
  period,
  totals,
  people,
  loading,
  postings,
  drafts,
  currency,
}: LedgerTotalsProps) {
  const rows = rosterTotals(totals, people)
  const byId = new Map(people.map(person => [person.ID, person]))

  return (
    <div className="kpi-grid">
      <Card accessibleName={`Total posted in ${formatPeriod(period)}`}>
        <div className="kpi">
          <span className="kpi__label">Month total</span>
          <span className="kpi__value" data-testid="month-total">
            <MoneyText amount={totals.grandTotal} currency={currency} bold />
          </span>
          <span className="kpi__hint">
            {postings} {postings === 1 ? 'posting' : 'postings'}
            {drafts > 0 ? ` · ${drafts} need review` : ''}
          </span>
        </div>
      </Card>

      <Card accessibleName={`Who paid in ${formatPeriod(period)}`}>
        <div className="kpi">
          <span className="kpi__label">Who paid</span>
          {rows.length === 0 ? (
            <span className="kpi__hint">
              {loading ? 'Adding it up…' : 'No people on the roster yet.'}
            </span>
          ) : (
            <ul className="paid-list" data-testid="paid-by-card">
              {rows.map(row => {
                const person = byId.get(row.personId)
                const colour = person?.colour || PERSON_FALLBACK_COLOUR
                return (
                  <li
                    className="paid-row"
                    key={row.personId}
                    data-testid="paid-row"
                    data-person-id={row.personId}
                    aria-label={`${row.name} paid ${formatMoney(row.paid, currency)}, ${percent(
                      row.share,
                    )} of the month`}
                  >
                    <span className="paid-row__head">
                      {person ? (
                        <PersonAvatar person={person} size="S" />
                      ) : (
                        <span
                          className="paid-row__dot"
                          style={{ backgroundColor: colour }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="paid-row__name">{row.name}</span>
                      <MoneyText amount={row.paid} currency={currency} bold />
                    </span>
                    <span className="paid-row__bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.min(100, Math.max(0, row.share * 100))}%`,
                          backgroundColor: colour,
                        }}
                      />
                    </span>
                    <span className="paid-row__share">
                      {percent(row.share)} of the month · {row.count}{' '}
                      {row.count === 1 ? 'posting' : 'postings'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}
