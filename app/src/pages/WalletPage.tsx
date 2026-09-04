/**
 * The wallet — points, and the cards that pay for things.
 *
 * ## Why the two live on one screen
 *
 * Because to a household they are one subject: what this app costs and what it gives back.
 * Splitting them would make the points look like a game and the cards look like a bill, and
 * neither reading is right.
 *
 * The points come first, and by a long way — they are the top two thirds of the screen, and
 * the cards are a quiet list underneath. That ordering is a claim about what this feature is
 * for. A card on file is plumbing: nobody opens an app to look at one. The points are the
 * part somebody might actually come back to see.
 *
 * ## What this screen refuses to do
 *
 * It never suggests spending. There is no "earn more by…" nudge attached to an amount, no
 * streak that punishes a missed day, and nothing anywhere that pays out in proportion to
 * money spent — the earn table is a list of *acts* and the largest of them is rating a place
 * for other households, which costs nothing and helps strangers.
 *
 * It also does not pretend to be a bank. The conversion panel says plainly that turning
 * points into money needs a licensed partner this deployment does not have, rather than
 * offering a button that fails. Somebody who taps a thing that does not work trusts the next
 * screen less.
 */
import { Suspense, lazy, useCallback, useState } from 'react'
import { Title } from '@ui5/webcomponents-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { wallet, type SavedCard, type SetupResult } from '@/api/wallet'
import { CardFace } from './wallet/CardFace'
import { PointsArc } from './wallet/PointsArc'
import './wallet/wallet.css'

// Only opened when somebody adds a card, and it carries the whole setup state machine.
const AddCardSheet = lazy(async () => ({
  default: (await import('./wallet/AddCardSheet')).AddCardSheet,
}))

/** Minor units to a readable amount. The server sends whole rappen; nobody reads rappen. */
function money(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat('en-CH', { style: 'currency', currency }).format(minorUnits / 100)
}

export function WalletPage(): React.ReactElement {
  const queries = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const purse = useQuery({ queryKey: ['wallet', 'purse'], queryFn: () => wallet.wallet() })
  const ways = useQuery({ queryKey: ['wallet', 'ways'], queryFn: () => wallet.waysToEarn() })
  const cards = useQuery({ queryKey: ['wallet', 'cards'], queryFn: () => wallet.cards() })
  // Which vault is running. An empty list means a real provider, so this doubles as the
  // signal the add-card sheet keys off.
  const scenarios = useQuery({
    queryKey: ['wallet', 'scenarios'],
    queryFn: () => wallet.mockScenarios(),
    staleTime: Infinity,
  })

  const afterAdding = useCallback(
    (result: SetupResult) => {
      setAdding(false)
      setSaid(
        result.duplicate
          ? 'That card is already on file — nothing was added twice.'
          : `Saved. ${result.brand ?? 'Card'} ending ${result.last4 ?? ''}.`,
      )
      void queries.invalidateQueries({ queryKey: ['wallet', 'cards'] })
    },
    [queries],
  )

  const forget = useCallback(
    async (card: SavedCard) => {
      // Confirmed, because it is not undoable: the token is detached at the provider and
      // adding the card again means going through the bank's check again.
      if (!window.confirm(`Take the card ending ${card.last4} off file?`)) return
      await wallet.forgetCard(card.ID)
      void queries.invalidateQueries({ queryKey: ['wallet', 'cards'] })
    },
    [queries],
  )

  const makeDefault = useCallback(
    async (card: SavedCard) => {
      await wallet.makeDefaultCard(card.ID)
      void queries.invalidateQueries({ queryKey: ['wallet', 'cards'] })
    },
    [queries],
  )

  if (purse.isPending) return <LoadingSkeleton />
  if (purse.isError) return <ErrorState error={purse.error} onRetry={() => void purse.refetch()} />

  const it = purse.data

  return (
    <section className="wallet">
      <header className="wallet__head">
        <Title level="H2">Wallet</Title>
        <p className="wallet__lede">What this app has given back, and what pays for things.</p>
      </header>

      {/* ------------------------------------------------------------- points */}

      <div className="wallet__hero">
        <PointsArc
          points={it.balance}
          standing={it.standing}
          next={it.nextStanding}
          into={it.into}
        />

        <dl className="wallet__figures">
          <div>
            <dt>Earned all time</dt>
            <dd>{it.earned.toLocaleString('en-CH')}</dd>
          </div>
          {/* "Worth CHF 0.00" is only worth saying if it can become something.
              With conversion unavailable the screen was making two loud, contradictory
              claims in its top third — here is what your points are worth, and here is why
              they can never be worth it — which is dispiriting and says nothing. The rung
              somebody is climbing towards is a real number that moves. */}
          {it.canConvert ? (
            <div>
              <dt>Worth</dt>
              <dd>{money(it.worth, it.currency)}</dd>
            </div>
          ) : (
            <div>
              <dt>{it.nextStanding === null ? 'Standing' : 'Next rung'}</dt>
              <dd>
                {it.nextStanding === null
                  ? 'Top'
                  : (it.nextStanding - it.balance).toLocaleString('en-CH')}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Said rather than hidden. A feature that is coming is more trustworthy than a
          button that does not work, and people notice the difference. */}
      {!it.canConvert && it.cannotConvert !== '' && (
        <p className="wallet__cannot">{it.cannotConvert}</p>
      )}

      {/* ---------------------------------------------------------- how to earn */}

      <section className="wallet__section">
        <h3 className="wallet__h3">Worth doing</h3>
        <ul className="ways">
          {(ways.data ?? []).map(way => (
            <li
              key={way.reason}
              className={`way${way.left === 0 ? ' way--spent' : ''}`}
              // The rail's width, as a fraction of the biggest award on the list.
              //
              // Its stylesheet has always claimed the rail was "proportional to what the act
              // is worth — so the list is scannable by shape as well as by number", and the
              // rule underneath said `width: 3px`. So a two-point act and a hundred-point one
              // were rendered identically, nine times, and the section was a wall. Now the
              // claim is true and the eye can find the thing worth doing without reading.
              style={
                {
                  '--way-weight': String(
                    way.points / Math.max(...(ways.data ?? [way]).map(one => one.points)),
                  ),
                } as React.CSSProperties
              }
            >
              <span className="way__label">{way.label}</span>
              <span className="way__points">+{way.points}</span>
              <span className="way__left">
                {way.left === 0 ? 'done for today' : `${way.left} left today`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------- cards */}

      <section className="wallet__section">
        <h3 className="wallet__h3">Cards</h3>

        {said !== null && (
          <p className="wallet__said" role="status">
            {said}
          </p>
        )}

        {cards.isPending ? (
          <LoadingSkeleton />
        ) : (cards.data ?? []).length === 0 ? (
          <p className="wallet__empty">
            No card on file. One is only needed when something has to be paid for.
          </p>
        ) : (
          <ul className="cards">
            {(cards.data ?? []).map(card => (
              <li key={card.ID} className="cards__row">
                <CardFace card={card} compact />
                <div className="cards__actions">
                  {!card.isDefault && (
                    <button type="button" onClick={() => void makeDefault(card)}>
                      Make default
                    </button>
                  )}
                  <button type="button" onClick={() => void forget(card)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button type="button" className="wallet__add" onClick={() => setAdding(true)}>
          Add a card
        </button>
      </section>

      {/* ------------------------------------------------------------ history */}

      {it.recent.length > 0 && (
        <section className="wallet__section">
          <h3 className="wallet__h3">Lately</h3>
          <ul className="history">
            {it.recent.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="history__row">
                <span className="history__reason">{entry.reason}</span>
                <span
                  className={`history__points${entry.points < 0 ? ' history__points--out' : ''}`}
                >
                  {entry.points > 0 ? '+' : ''}
                  {entry.points}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding && (
        <Suspense fallback={<LoadingSkeleton />}>
          <AddCardSheet
            scenarios={scenarios.data ?? []}
            onClose={() => setAdding(false)}
            onAdded={afterAdding}
          />
        </Suspense>
      )}
    </section>
  )
}
