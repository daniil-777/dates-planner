import { Icon } from '@ui5/webcomponents-react'
import { Link } from 'react-router-dom'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { formatDay } from '../events/dates'
import { KIND_ICONS, KIND_LABELS, countdownLabel, type NextUpItem } from './nextUp'

export interface NextUpStripProps {
  /** Soonest first. The head of the list is the one drawn large. */
  items: readonly NextUpItem[]
  loading: boolean
}

/**
 * What is coming — FRONTEND-CONTRACT §8.
 *
 * The nearest reminder, event or anniversary, with its countdown, and the two behind it in
 * smaller type. Document #1's anniversary lands here like anything else: it is a date in
 * the year, not a special case in the code.
 *
 * A surprise the current person created carries the "Only you" badge of CONTRACTS §11.3.
 * Everybody else's surprises never reached the client, so a badge here is always a note to
 * the person who made it and never a leak.
 */
export function NextUpStrip({ items, loading }: NextUpStripProps) {
  return (
    <section className="home-next" aria-labelledby="home-next-heading" data-testid="next-up">
      <div className="home-next__head">
        <h2 className="home-next__heading" id="home-next-heading">
          Next up
        </h2>
        <Link className="home-next__more" to="/calendar">
          Calendar
          <Icon name="slim-arrow-right" className="home-next__more-icon" />
        </Link>
      </div>

      {loading ? (
        <LoadingSkeleton rows={2} className="home-next__skeleton" />
      ) : items.length === 0 ? (
        <p className="home-next__empty">
          Nothing in the next 90 days. <Link to="/events">Plan something</Link>.
        </p>
      ) : (
        <ol className="home-next__list">
          {items.map((item, index) => (
            <li key={item.key}>
              <Link
                to={item.to}
                className={
                  index === 0 ? 'home-next__item home-next__item--lead' : 'home-next__item'
                }
                data-testid={`next-up-${item.kind}`}
              >
                <span
                  className={`home-next__mark home-next__mark--${item.kind}`}
                  aria-hidden="true"
                >
                  <Icon name={KIND_ICONS[item.kind]} className="home-next__mark-icon" />
                </span>

                <span className="home-next__text">
                  <span className="home-next__title">
                    {item.title}
                    {item.onlyYou ? <span className="home-next__only">Only you</span> : null}
                  </span>
                  <span className="home-next__detail">
                    {KIND_LABELS[item.kind]}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </span>
                </span>

                <span className="home-next__when">
                  <span className="home-next__countdown">{countdownLabel(item)}</span>
                  <span className="home-next__date">{formatDay(item.date)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default NextUpStrip
