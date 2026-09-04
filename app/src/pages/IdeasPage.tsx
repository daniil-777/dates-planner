/**
 * The decks — things to do, and things to give.
 *
 * Cards that need no place and no corpus. They are seeded and curated rather than rated,
 * which makes them the one surface here that works on the first day, in a town nobody has
 * rated anything in, with no location shared. That is their job: the commons is worth very
 * little until it has some weight behind it, and an app that is worth nothing until then does
 * not get opened a second time.
 *
 * They are also the fallback the Tonight deck reaches for when there is nowhere nearby to
 * pair a meal with, so the same rows do two jobs.
 *
 * ## Why these ideas and not a longer list
 *
 * Every card is a thing you could do this week, written as an instruction rather than a
 * category — "walk the whole tram line", not "outdoor activities". A category is a prompt to
 * think of something, which is the work somebody opened this to avoid.
 */
import { useState } from 'react'
import { SegmentedButton, SegmentedButtonItem, Title } from '@ui5/webcomponents-react'

import { useDeck } from '@/api/commonsHooks'
import { useI18n } from '@/i18n'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { CommonsNav } from './places/CommonsNav'
import { TagChips } from './places/Chips'
import { COST_BANDS, costLabel, costShort, minutesLabel, type CostBand } from './places/vocabulary'
import './places/places.css'
import './tonight/tonight.css'

type Deck = 'activity' | 'gift'

export function IdeasPage(): React.ReactElement {
  const { t } = useI18n()
  const [deck, setDeck] = useState<Deck>('activity')
  const [ceiling, setCeiling] = useState<CostBand | null>(null)
  const cards = useDeck(deck)

  /*
   * Twenty-eight cards is nine screens of scrolling on a phone, and an inspiration deck that
   * has to be scrolled through is one nobody reaches the end of. Cost is the filter worth
   * having — it is the question somebody actually arrives with ("what can we do that is
   * free?"), and unlike a topic filter it needs no vocabulary to use.
   */
  const shown = (cards.data ?? []).filter(
    idea =>
      ceiling === null ||
      COST_BANDS.indexOf(idea.costBand ?? 'free') <= COST_BANDS.indexOf(ceiling),
  )

  return (
    <section className="ideas">
      <CommonsNav />
      <header>
        <Title level="H2">{t('commons.ideas', 'Ideas')}</Title>
        <p className="tonight__lede">
          {deck === 'activity'
            ? t('ideas.ledeDo', 'Things to do that need no booking and no corpus.')
            : t('ideas.ledeGive', 'Things to give that are not a voucher.')}
        </p>
      </header>

      <SegmentedButton
        onSelectionChange={event => {
          const pressed = (event.detail as { selectedItems?: Array<{ id?: string }> })
            .selectedItems?.[0]?.id
          if (pressed === 'gift' || pressed === 'activity') setDeck(pressed)
        }}
      >
        <SegmentedButtonItem id="activity" selected={deck === 'activity'}>
          {t('ideas.toDo', 'To do')}
        </SegmentedButtonItem>
        <SegmentedButtonItem id="gift" selected={deck === 'gift'}>
          {t('ideas.toGive', 'To give')}
        </SegmentedButtonItem>
      </SegmentedButton>

      <div className="tonight__filter" role="group" aria-label={t('ideas.budget', 'At most, each')}>
        <button
          type="button"
          aria-pressed={ceiling === null}
          className={`tonight__chip${ceiling === null ? ' tonight__chip--on' : ''}`}
          onClick={() => setCeiling(null)}
        >
          {t('tonight.any', 'Any')}
        </button>
        {COST_BANDS.map(band => (
          <button
            type="button"
            key={band}
            aria-pressed={ceiling === band}
            className={`tonight__chip${ceiling === band ? ' tonight__chip--on' : ''}`}
            onClick={() => setCeiling(ceiling === band ? null : band)}
          >
            {costLabel(band).replace(' each', '')}
          </button>
        ))}
      </div>

      {cards.isPending && <LoadingSkeleton />}
      {cards.isError && <ErrorState error={cards.error} onRetry={() => cards.refetch()} />}

      {!cards.isPending && !cards.isError && (
        <ol className="ideas__grid">
          {shown.map(idea => (
            <li key={idea.ID}>
              <article className="idea">
                <h3 className="idea__title">{idea.title}</h3>
                <p className="idea__summary">{idea.summary}</p>
                <TagChips tags={idea.tags ?? []} limit={2} />
                <p className="idea__meta">
                  <span>{costShort(idea.costBand)}</span>
                  {minutesLabel(idea.minutes) !== null && (
                    <span>{minutesLabel(idea.minutes)?.replace('About ', '')}</span>
                  )}
                </p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
