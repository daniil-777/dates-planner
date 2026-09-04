/**
 * Games.
 *
 * A chapter rather than a page: one game today, and the shape is built for more. Everything
 * here is played *in the room* with the phone as a prop — a household app has no business
 * offering somebody a way to play alone on their phone while sitting next to the people they
 * live with.
 *
 * The game itself is a lazy import inside a lazy route. It carries a thousand questions and
 * a dark stylesheet that nothing else uses, and neither belongs in the bundle of somebody
 * who only ever scans receipts.
 */
import { Suspense, lazy, useState } from 'react'
import { Title } from '@ui5/webcomponents-react'

import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { useI18n } from '@/i18n'
import { BANK } from './games/chgk/questions'
import './games/games.css'
import './games/chgk/chgk.css'

const ChgkGame = lazy(async () => ({ default: (await import('./games/chgk/ChgkGame')).ChgkGame }))

export function GamesPage(): React.ReactElement {
  const { t } = useI18n()
  const [playing, setPlaying] = useState(false)

  if (playing) {
    return (
      <section className="games">
        <button type="button" className="games__back" onClick={() => setPlaying(false)}>
          ‹ {t('games.title', 'Games')}
        </button>
        <Suspense fallback={<LoadingSkeleton />}>
          <ChgkGame bank={BANK} />
        </Suspense>
      </section>
    )
  }

  return (
    <section className="games">
      <header>
        <Title level="H2">{t('games.title', 'Games')}</Title>
        <p className="games__lede">
          {t('games.lede', 'Things to play at the table, with one phone between you.')}
        </p>
      </header>

      <button type="button" className="game-card" onClick={() => setPlaying(true)}>
        <span className="game-card__art" aria-hidden="true">
          <span className="game-card__top" />
        </span>
        <span className="game-card__body">
          <span className="game-card__name">{t('games.chgk.name', 'What? Where? When?')}</span>
          <span className="game-card__blurb">
            {t(
              'games.chgk.blurb',
              'One of you reads a question. Everybody else has a minute to work it out, out loud, together. First to six.',
            )}
          </span>
          <span className="game-card__meta">
            {t('games.chgk.meta', '{count} questions · 2 players or more · about 20 minutes', {
              count: String(BANK.length),
            })}
          </span>
        </span>
      </button>
    </section>
  )
}

export default GamesPage
