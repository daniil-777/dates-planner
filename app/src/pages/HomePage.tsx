/**
 * Home — the launcher, and the first screen anybody sees.
 *
 * `/` used to redirect to the ledger and the desktop had a side rail down its left edge.
 * Both are gone (FRONTEND-CONTRACT §8): the rail was six words in a column that told you
 * nothing, and a redirect meant the app opened on a list of documents rather than on a view
 * of the household. What replaced them is a grid of tiles, each carrying a **live figure** —
 * what the month has come to, how many drafts are waiting, when the next thing is — so the
 * home screen is worth arriving at rather than something to get past.
 *
 * Three rules the grid keeps, all from §8:
 *
 *  - a figure still loading shows a shimmer, never a blank tile and never a zero it made up;
 *  - a figure that **failed** shows the tile with its label and no number, not an error —
 *    every tile is a link first, and one dead request must not cost you the other six;
 *  - two columns below 40rem, three above, with the whole tile as the target.
 *
 * Every number here comes from a query the rest of the app already runs, so arriving home
 * warms the caches the Ledger, Events and Memories pages read from — and `usePeople` is the
 * shell's own query, already in flight before this page mounts.
 */

import { useMemo } from 'react'
import { useI18n } from '@/i18n'
import { Title } from '@ui5/webcomponents-react'
import type {
  CalendarEntry,
  Event,
  Expense,
  Memory,
  PeriodTotals,
  Person,
  Statement,
} from '@/api/types'
import {
  useEvents,
  useExpenses,
  useMemories,
  usePeople,
  usePeriodTotals,
  useStatements,
  useUpcoming,
} from '@/api/hooks'
import { useActivePerson } from '@/components/AppShell'
import { currentPeriod, formatPeriod } from '@/theme'
import { todayIso } from './events/dates'
import { computeAnniversaries } from './memories/anniversaries'
import './home/icons'
import './home/home.css'
import { HomeTile } from './home/HomeTile'
import { NextUpStrip } from './home/NextUpStrip'
import { HOME_TILES, type HomeTileId } from './home/tiles'
import {
  calendarFigure,
  draftsFigure,
  eventsFigure,
  figureFrom,
  figureFromBoth,
  memoriesFigure,
  monthFigure,
  peopleFigure,
  statementFigure,
  type FigureState,
} from './home/figures'
import { NEXT_UP_HORIZON_DAYS, addIsoDays, anniversarySeeds, buildNextUp } from './home/nextUp'

/** How many things the strip lists: one large, two behind it. */
const NEXT_UP_COUNT = 3

export function HomePage() {
  const { t } = useI18n()
  const today = todayIso()
  const period = currentPeriod()
  const horizonEnd = useMemo(() => addIsoDays(today, NEXT_UP_HORIZON_DAYS), [today])

  // One unfiltered read of the postings serves two tiles' worth of truth: how many drafts
  // are waiting, and where Document #1 sits in the year. It is the same query key the
  // Ledger and Memories pages use, so this is a cache entry rather than a third request.
  const expensesQuery = useExpenses()
  const periodQuery = usePeriodTotals(period)
  const eventsQuery = useEvents()
  const upcomingQuery = useUpcoming(today, horizonEnd)
  const memoriesQuery = useMemories()
  const statementsQuery = useStatements()
  const peopleQuery = usePeople()

  const { person } = useActivePerson()

  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])
  const memories = useMemo(() => memoriesQuery.data ?? [], [memoriesQuery.data])
  const entries = useMemo(() => upcomingQuery.data ?? [], [upcomingQuery.data])

  const anniversaries = useMemo(
    () => computeAnniversaries(anniversarySeeds(expenses, memories), today),
    [expenses, memories, today],
  )

  // The Calendar tile answers "the next reminder or event" and nothing else: anniversaries
  // are a Memories concept and belong on the strip, not on a tile about the diary.
  const scheduled = useMemo(
    () => buildNextUp({ entries, anniversaries: [], today, limit: 1 }),
    [entries, today],
  )

  const nextUp = useMemo(
    () => buildNextUp({ entries, anniversaries, today, limit: NEXT_UP_COUNT }),
    [entries, anniversaries, today],
  )

  const figures: Record<HomeTileId, FigureState> = {
    scan: figureFrom<Expense[]>(expensesQuery, draftsFigure),
    // Static on purpose: fetching the whole mood table to decorate a tile would cost more
    // than the tile is worth, and the page itself opens in one tap.
    mood: {
      status: 'ready',
      figure: {
        kind: 'text',
        value: t('tile.mood.value', 'Check in'),
        emphasis: 'number',
        caption: t('tile.mood.caption', 'two seconds'),
      },
    },
    ledger: figureFrom<PeriodTotals>(periodQuery, monthFigure),
    events: figureFrom<Event[]>(eventsQuery, events => eventsFigure(events, today)),
    calendar: figureFrom<CalendarEntry[]>(upcomingQuery, () => calendarFigure(scheduled)),
    memories: figureFromBoth<Memory[], Expense[]>(memoriesQuery, expensesQuery, memoriesFigure),
    statement: figureFrom<Statement[]>(statementsQuery, statementFigure),
    settings: figureFrom<Person[]>(peopleQuery, peopleFigure),
    // The thread's own live figure — an unread count — needs a read marker this app does
    // not keep yet, so the tile says what it is for instead of guessing at a number.
    chat: {
      status: 'ready',
      figure: { kind: 'text', value: 'Say something', emphasis: 'phrase', caption: null },
    },
    // The write-up is a static asset, so its figure never loads and never fails —
    // it is simply what the article is.
    howItWorks: {
      status: 'ready',
      figure: { kind: 'text', value: '10 sections', emphasis: 'number', caption: 'and a PDF' },
    },
  }

  // The strip waits only while it has nothing at all to draw; once one stream has answered
  // it draws what it has rather than holding the whole strip back for the last read to land.
  const nextUpLoading =
    nextUp.length === 0 &&
    (upcomingQuery.isPending || expensesQuery.isPending || memoriesQuery.isPending)

  return (
    <div className="twm-page home" data-testid="home-page">
      <header className="home__head">
        <Title level="H3">Home</Title>
        <span className="home__subtitle">
          {formatPeriod(period)}
          {person ? ` · posting as ${person.name}` : ''}
        </span>
      </header>

      <nav aria-label="Destinations">
        <ul className="home-grid" data-testid="home-grid">
          {HOME_TILES.map(spec => (
            <HomeTile key={spec.id} spec={spec} figure={figures[spec.id]} />
          ))}
        </ul>
      </nav>

      <NextUpStrip items={nextUp} loading={nextUpLoading} />
    </div>
  )
}

export default HomePage
