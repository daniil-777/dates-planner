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
import { HOME_SECTIONS, HOME_TILES, type HomeTileId } from './home/tiles'
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
    // Static, like `mood` above and for the same reason: the commons is arranged by where
    // somebody is, and asking a home tile to locate them before they have opened the page
    // would fire a permission prompt nobody asked for.
    tonight: {
      status: 'ready',
      figure: {
        kind: 'text',
        value: t('tile.tonight.value', 'Three'),
        emphasis: 'number',
        caption: t('tile.tonight.caption', 'evenings that worked'),
      },
    },
    // Static, like `mood` and `tonight`. The points balance would be a lovely live figure
    // and is not worth a second request on the first screen — the wallet is one tap away
    // and the number is the first thing on it.
    wallet: {
      status: 'ready',
      figure: {
        kind: 'text',
        value: t('tile.wallet.value', 'Points'),
        emphasis: 'number',
        caption: t('tile.wallet.caption', 'and cards on file'),
      },
    },
    // Static, and deliberately says nothing about what is in there. A count of entries on
    // the household's most public screen would be a number about somebody's private
    // journal, which is the one figure this tile must never carry.
    reflect: {
      status: 'ready',
      figure: {
        kind: 'text',
        value: t('tile.reflect.value', 'Write'),
        emphasis: 'number',
        caption: t('tile.reflect.caption', 'just for you'),
      },
    },
    games: {
      status: 'ready',
      figure: {
        kind: 'text',
        value: t('tile.games.value', 'Play'),
        emphasis: 'number',
        caption: t('tile.games.caption', 'one minute each question'),
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
    // Deliberately figureless. Every other tile carries a live number, and a count of
    // marked regions on the household's first screen would put the one thing in this app
    // that is nobody else's business onto the surface most likely to be read over a
    // shoulder — CONTRACTS.md §13.4. The tile shows its hint and nothing else.
    intimacy: { status: 'unavailable' },
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

      <nav className="home-nav" aria-label={t('home.nav', 'Everything in the app')}>
        {/*
          Grouped rather than one grid of twelve. Twelve tiles is past the point where a flat
          grid is scanned — it starts being hunted through — and the four headings are the
          app's own account of itself rather than four new words to learn.
        */}
        {HOME_SECTIONS.map(section => (
          <section className="home-section" key={section.id}>
            <h2 className="home-section__heading">
              {t(`home.section.${section.id}`, section.heading)}
            </h2>
            <ul className="home-grid">
              {HOME_TILES.filter(spec => spec.section === section.id).map(spec => (
                <HomeTile key={spec.id} spec={spec} figure={figures[spec.id]} />
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <NextUpStrip items={nextUp} loading={nextUpLoading} />
    </div>
  )
}

export default HomePage
