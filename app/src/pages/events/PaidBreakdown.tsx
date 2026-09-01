import type { Person, PersonTotal } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney } from '@/theme'
import { barWidth, formatShare, postingsLabel } from './summary'

/** Used only when a posting names somebody who is no longer on the People list. */
const UNKNOWN_COLOUR = '#5b738b'

export interface PaidBreakdownProps {
  /** Straight from `eventTotals()` — participants who paid nothing are in here too. */
  totals: readonly PersonTotal[]
  /** People indexed by id, for the colour and the avatar. */
  people: ReadonlyMap<string, Person>
  currency?: string
}

function personFor(total: PersonTotal, people: ReadonlyMap<string, Person>): Person {
  const known = people.get(total.personId)
  if (known) return known
  return { ID: total.personId, name: total.name, colour: UNKNOWN_COLOUR, isDefault: false }
}

/**
 * Who paid what, as a roster with proportion bars.
 *
 * The bar is a *proportion of the event's spend* — `PersonTotal.share` — so the row reads
 * "this much of the event went through this person's card". It is not a claim, and the page
 * never subtracts one bar from another. A participant who paid nothing keeps their row and
 * their empty track: they were there, and the roster says so.
 */
export function PaidBreakdown({ totals, people, currency }: PaidBreakdownProps) {
  return (
    <ul className="ev-breakdown" data-testid="paid-breakdown">
      {totals.map(total => {
        const person = personFor(total, people)
        const paidNothing = total.paid <= 0

        return (
          <li className="ev-breakdown__row" key={total.personId} data-person-id={total.personId}>
            <span className="ev-breakdown__avatar">
              <PersonAvatar person={person} size="S" />
            </span>

            <span className="ev-breakdown__name">{total.name}</span>

            <span className="ev-breakdown__amount">
              <MoneyText amount={total.paid} currency={currency} bold={!paidNothing} />
              <span className="ev-breakdown__share">{formatShare(total.share)}</span>
            </span>

            {paidNothing ? (
              <span className="ev-breakdown__nothing">
                Paid for nothing on this one. Still here.
              </span>
            ) : (
              <span
                className="ev-breakdown__track"
                role="img"
                aria-label={`${total.name} paid ${formatMoney(total.paid, currency)}, ${formatShare(
                  total.share,
                )} of the total, over ${postingsLabel(total.count).toLowerCase()}`}
              >
                <span
                  className="ev-breakdown__fill"
                  style={{ width: barWidth(total.share), backgroundColor: person.colour }}
                />
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default PaidBreakdown
