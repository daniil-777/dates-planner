/**
 * A round of "What? Where? When?".
 *
 * One phone, one reader, everybody else answering out loud. The phone is deliberately a
 * *prop* rather than the game: it holds the question, runs the minute and keeps the score,
 * and every other part of the game happens in the room. So each screen shows one thing and
 * has one button, because the person holding it is also talking.
 *
 * ## The shape of a round
 *
 *   idle → spinning → reading → discussing → timeUp → revealed → idle, or over
 *
 * `reading` has no timer running on purpose. The reader needs however long it takes to read
 * the question aloud and be asked to read it again, and a minute that starts when the
 * question appears is a minute that is half gone by the time anybody has heard it. The
 * reader starts the clock.
 *
 * ## The one deliberate asymmetry
 *
 * The team can stop the clock early — "we have an answer" — and the question cannot. That is
 * the real game's rule and it is a good one: it rewards a table that commits, and it makes
 * the last ten seconds a decision rather than a wait.
 */
import { useMemo, useState } from 'react'
import { Button } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/restart.js'

import { SpinningTop } from './SpinningTop'
import { Timer } from './Timer'
import { useGame } from './useGame'
import { THEMES, THEME_LABEL, WINNING_SCORE, type Question, type Theme } from './types'

export interface ChgkGameProps {
  bank: readonly Question[]
}

export function ChgkGame({ bank }: ChgkGameProps): React.ReactElement {
  const [themes, setThemes] = useState<ReadonlySet<Theme>>(new Set())
  const game = useGame(bank, themes)
  const round = game.history.length

  const toggleTheme = (theme: Theme): void => {
    const next = new Set(themes)
    if (next.has(theme)) next.delete(theme)
    else next.add(theme)
    setThemes(next)
  }

  const score = (
    <div className="chgk-score" aria-label={`Team ${game.team}, questions ${game.questions}`}>
      <span className="chgk-score__side">
        <span className="chgk-score__value">{game.team}</span>
        <span className="chgk-score__label">Us</span>
      </span>
      <span className="chgk-score__colon">:</span>
      <span className="chgk-score__side chgk-score__side--them">
        <span className="chgk-score__value">{game.questions}</span>
        <span className="chgk-score__label">The questions</span>
      </span>
    </div>
  )

  if (game.phase === 'over') {
    const won = game.team >= WINNING_SCORE
    return (
      <section className={`chgk chgk--over${won ? ' chgk--won' : ''}`}>
        <p className="chgk-verdict__kicker">
          {won ? 'The table takes it' : 'The questions take it'}
        </p>
        <h2 className="chgk-verdict">
          {game.team} : {game.questions}
        </h2>
        <p className="chgk-verdict__line">
          {won
            ? 'Six to you. Somebody in this room thinks sideways.'
            : 'Six to the questions. They were, in hindsight, all obvious.'}
        </p>
        <ol className="chgk-recap">
          {game.history.map((entry, index) => (
            <li key={entry.question.id} className={entry.won ? 'chgk-recap--won' : undefined}>
              <span className="chgk-recap__num">{index + 1}</span>
              <span className="chgk-recap__answer">{entry.question.a}</span>
            </li>
          ))}
        </ol>
        <Button design="Emphasized" icon="restart" onClick={game.reset}>
          Play again
        </Button>
      </section>
    )
  }

  return (
    <section className="chgk">
      {score}

      <div className="chgk-stage">
        {game.phase === 'idle' && (
          <>
            <SpinningTop spinning={false} seed={round} />
            <p className="chgk-stage__hint">
              {round === 0
                ? 'One of you reads. Everybody else has a minute.'
                : `Round ${round + 1}.`}
            </p>
          </>
        )}

        {game.phase === 'spinning' && (
          <>
            <SpinningTop spinning seed={round} />
            <p className="chgk-stage__hint chgk-stage__hint--live">Choosing…</p>
          </>
        )}

        {(game.phase === 'reading' ||
          game.phase === 'discussing' ||
          game.phase === 'timeUp' ||
          game.phase === 'revealed') &&
          game.question !== null && (
            <QuestionFace
              question={game.question}
              phase={game.phase}
              left={game.left}
              revealed={game.phase === 'revealed'}
            />
          )}
      </div>

      <div className="chgk-actions">
        {game.phase === 'idle' && (
          <Button design="Emphasized" onClick={game.spin} disabled={game.available === 0}>
            {round === 0 ? 'Start' : 'Next question'}
          </Button>
        )}
        {game.phase === 'reading' && (
          <>
            <p className="chgk-actions__aside">Read it aloud. Twice, if they ask.</p>
            <Button design="Emphasized" onClick={game.start}>
              Start the minute
            </Button>
          </>
        )}
        {game.phase === 'discussing' && (
          <Button design="Transparent" onClick={game.reveal}>
            We have an answer
          </Button>
        )}
        {game.phase === 'timeUp' && (
          <Button design="Emphasized" onClick={game.reveal}>
            Reveal the answer
          </Button>
        )}
        {game.phase === 'revealed' && (
          <div className="chgk-verdict-buttons">
            <Button design="Emphasized" onClick={() => game.score(true)}>
              We got it
            </Button>
            <Button design="Transparent" onClick={() => game.score(false)}>
              We did not
            </Button>
          </div>
        )}
      </div>

      {game.phase === 'idle' && (
        <details className="chgk-themes">
          <summary>
            {themes.size === 0 ? 'Everything' : `${themes.size} chosen`} · {game.fresh} unplayed
          </summary>
          <div className="chgk-themes__chips">
            {THEMES.map(theme => (
              <button
                type="button"
                key={theme}
                aria-pressed={themes.has(theme)}
                className={`chgk-chip${themes.has(theme) ? ' chgk-chip--on' : ''}`}
                onClick={() => toggleTheme(theme)}
              >
                {THEME_LABEL[theme]}
              </button>
            ))}
          </div>
          <p className="chgk-themes__note">
            {/* Said here rather than discovered later: a filter that silently empties the
                bank is a filter that looks like a broken game. */}
            Choose none and you get everything. A question already played does not come back until
            the rest have.
          </p>
        </details>
      )}
    </section>
  )
}

function QuestionFace({
  question,
  phase,
  left,
  revealed,
}: {
  question: Question
  phase: string
  left: number
  revealed: boolean
}): React.ReactElement {
  const timer = useMemo(() => <Timer left={left} idle={phase === 'reading'} />, [left, phase])

  return (
    <div className={`chgk-card${revealed ? ' chgk-card--revealed' : ''}`}>
      <div className="chgk-card__face chgk-card__face--front">
        <p className="chgk-card__kicker">The question</p>
        <p className="chgk-card__q">{question.q}</p>
        {phase !== 'reading' && <div className="chgk-card__timer">{timer}</div>}
        {phase === 'reading' && <div className="chgk-card__timer">{timer}</div>}
      </div>

      <div className="chgk-card__face chgk-card__face--back">
        <p className="chgk-card__kicker">The answer</p>
        <p className="chgk-card__a">{question.a}</p>
        {/* The line that turns "oh" into "*oh*". Without it this is trivia. */}
        <p className="chgk-card__note">{question.note}</p>
      </div>
    </div>
  )
}

export default ChgkGame
