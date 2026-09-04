/**
 * Tonight — one card, one evening.
 *
 * ## Three, never one, and never a list
 *
 * One suggestion is an instruction. A list of forty is a search result, which is the thing
 * somebody opened this page to avoid. Three is a choice small enough to make standing up.
 *
 * The server deals them from a seed of the day and the household, so the three do not change
 * while somebody is deciding, and two households in the same street get different ones. The
 * deck is a weighted sample from the top of the ranking rather than the top three, so a place
 * at rank nine still turns up — that is the whole of the "encourage novelty gently" idea, and
 * it lives in arithmetic rather than in a banner telling anybody to try something new.
 *
 * ## A card is an evening, not a result
 *
 * Somewhere to eat *and* something to do afterwards, with what the pair costs one person.
 * Cost is a band because it comes from what other households recorded paying, and a precise
 * figure would be a claim about a menu nobody here has read.
 *
 * ## Fewer than three is a valid answer
 *
 * A young corpus near a small town has one card in it, or none. Padding the deck with
 * somewhere bad to reach three is how a recommendation surface stops being believed, so this
 * shows what it has and says plainly what would fill it.
 */
import { useMemo, useState } from 'react'
import { Button, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/add.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import { useNavigate } from 'react-router-dom'

import { useTonight } from '@/api/commonsHooks'
import { useI18n } from '@/i18n'
import type { Evening } from '@/api/commons'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { EveningCardView } from './tonight/EveningCard'
import { CommonsNav } from './places/CommonsNav'
import { HerePrompt } from './places/HerePrompt'
import { RateSheet } from './places/RateSheet'
import { useHere } from './places/useHere'
import { COST_BANDS, costLabel, type CostBand } from './places/vocabulary'
// Both: the cards are styled by `tonight.css`, but every shared piece on them — the nav, the
// chips, the stars, the map links — is styled by `places.css`. Importing only the first is
// what left the nav rendering as three run-together underlined links.
import './places/places.css'
import './tonight/tonight.css'

export function TonightPage(): React.ReactElement {
  const { t } = useI18n()
  const { here, status, locate, setHere } = useHere()
  const [ceiling, setCeiling] = useState<CostBand | null>(null)
  const [rating, setRating] = useState(false)
  const navigate = useNavigate()

  const tonight = useTonight(here, ceiling)
  const evenings = useMemo<Evening[]>(() => tonight.data ?? [], [tonight.data])

  return (
    <section className="tonight">
      <CommonsNav />
      <header className="tonight__head">
        <Title level="H2">{t('commons.tonight', 'Tonight')}</Title>
        <p className="tonight__lede">
          {t('tonight.lede', 'Three evenings other households said worked. Pick one, or none.')}
        </p>
      </header>

      {here === null ? (
        <HerePrompt status={status} onLocate={locate} onPick={setHere} />
      ) : (
        <>
          <div
            className="tonight__filter"
            role="group"
            aria-label={t('tonight.budget', 'Spend at most, each')}
          >
            <button
              type="button"
              aria-pressed={ceiling === null}
              className={`tonight__chip${ceiling === null ? ' tonight__chip--on' : ''}`}
              onClick={() => setCeiling(null)}
            >
              {t('tonight.any', 'Any')}
            </button>
            {COST_BANDS.slice(1).map(band => (
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

          {tonight.isPending && <LoadingSkeleton />}
          {tonight.isError && (
            <ErrorState error={tonight.error} onRetry={() => tonight.refetch()} />
          )}

          {!tonight.isPending && !tonight.isError && evenings.length === 0 && (
            <div className="tonight__empty">
              <p className="tonight__empty-line">{t('tonight.empty', 'Nothing to deal yet.')}</p>
              <p className="tonight__empty-hint">
                {/* The honest empty state: this is a corpus, and a corpus with nothing in it
                    has nothing to say. Saying so is better than inventing three cards. */}
                A place appears here once three households have rated it. Rate somewhere you already
                like and it starts filling up — yours included.
              </p>
              <Button design="Emphasized" icon="add" onClick={() => setRating(true)}>
                {t('commons.rate', 'Rate a place')}
              </Button>
            </div>
          )}

          {evenings.length > 0 && (
            <>
              <ol className="tonight__deck">
                {evenings.map((evening, index) => (
                  <li key={evening.ID}>
                    <EveningCardView
                      evening={evening}
                      index={index}
                      onPlan={() =>
                        // Handing the evening to the surface that already exists, rather
                        // than growing a second one here.
                        navigate('/events', {
                          state: {
                            name: evening.eat?.name ?? evening.doIdea?.title ?? 'Tonight',
                            place: evening.eat?.name ?? null,
                          },
                        })
                      }
                    />
                  </li>
                ))}
              </ol>
              <p className="tonight__footnote">Dealt for today. Tomorrow they will be different.</p>
            </>
          )}

          {/* Only when there is a deck. The empty state carries its own, and showing both put
              the same call to action on the screen twice. */}
          {evenings.length > 0 && (
            <div className="tonight__actions">
              <Button design="Transparent" icon="add" onClick={() => setRating(true)}>
                {t('commons.rate', 'Rate a place')}
              </Button>
            </div>
          )}
        </>
      )}

      <RateSheet open={rating} onClose={() => setRating(false)} />
    </section>
  )
}
