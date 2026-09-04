/**
 * The round, as a state machine.
 *
 * All of the game's rules live here and none of them live in a component, for the ordinary
 * reason — a timer tangled into JSX is a timer that leaks — and for one specific to this
 * game: the minute has to be *right*. A countdown driven by `setInterval` and a decrementing
 * counter drifts, pauses when a phone locks the screen, and comes back having lost however
 * long the screen was off. A table watching a clock notices.
 *
 * So the clock is not counted, it is **read**. The deadline is a timestamp; every tick asks
 * what time it is and works out what is left. A tab that was backgrounded for twenty seconds
 * comes back showing twenty seconds fewer, which is what actually happened in the room.
 *
 * ## Which questions come up
 *
 * Never the same one twice, across sessions, until the bank is exhausted — a party game that
 * repeats itself within a fortnight is a party game people stop suggesting. Played ids live
 * in `localStorage`, and when the last one is used the pile is turned over and shuffled
 * rather than the game simply stopping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DISCUSSION_SECONDS,
  WINNING_SCORE,
  type GameState,
  type Question,
  type Theme,
} from './types'

const PLAYED_KEY = 'twm.chgk.played.v1'

/** How long the top spins before a question appears. Long enough to feel, short enough to sit through. */
export const SPIN_MS = 1600

function readPlayed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PLAYED_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set(parsed.filter(one => typeof one === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

function writePlayed(played: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(PLAYED_KEY, JSON.stringify([...played]))
  } catch {
    // A private window, or a full quota. Repeating a question is a small loss; failing to
    // start a game over it would be a large one.
  }
}

/** Only the tests and the settings screen need this. */
export function forgetPlayed(): void {
  try {
    window.localStorage.removeItem(PLAYED_KEY)
  } catch {
    /* nothing to do */
  }
}

export interface Game extends GameState {
  /** Total in the chosen themes, and how many are still unplayed. */
  available: number
  fresh: number
  spin: () => void
  start: () => void
  reveal: () => void
  score: (won: boolean) => void
  reset: () => void
}

export function useGame(bank: readonly Question[], themes: ReadonlySet<Theme>): Game {
  const [state, setState] = useState<GameState>({
    phase: 'idle',
    question: null,
    left: DISCUSSION_SECONDS,
    team: 0,
    questions: 0,
    history: [],
  })
  const [played, setPlayed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const deadline = useRef<number | null>(null)

  useEffect(() => {
    setPlayed(readPlayed())
  }, [])

  const pool = useMemo(
    () => (themes.size === 0 ? bank : bank.filter(one => themes.has(one.theme))),
    [bank, themes],
  )
  const unplayed = useMemo(() => pool.filter(one => !played.has(one.id)), [pool, played])

  /* ------------------------------------------------------------------ clock */

  useEffect(() => {
    if (state.phase !== 'discussing') return
    // A quarter-second tick: fast enough that the number never looks stuck, slow enough to
    // be nothing on a battery. The value shown is always derived from the deadline.
    const id = window.setInterval(() => {
      const end = deadline.current
      if (end === null) return
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      setState(current =>
        current.phase !== 'discussing'
          ? current
          : { ...current, left, phase: left === 0 ? 'timeUp' : 'discussing' },
      )
    }, 250)
    return () => window.clearInterval(id)
  }, [state.phase])

  /* ------------------------------------------------------------------ moves */

  const spin = useCallback(() => {
    if (unplayed.length === 0 && pool.length === 0) return
    setState(current => ({ ...current, phase: 'spinning', left: DISCUSSION_SECONDS }))

    window.setTimeout(() => {
      setState(current => {
        if (current.phase !== 'spinning') return current
        // The pile is turned over rather than the game ending: nobody wants "you have seen
        // them all" as the answer to "shall we play again".
        const source = unplayed.length > 0 ? unplayed : pool
        const question = source[Math.floor(Math.random() * source.length)] ?? null
        return { ...current, phase: question === null ? 'idle' : 'reading', question }
      })
    }, SPIN_MS)
  }, [pool, unplayed])

  const start = useCallback(() => {
    deadline.current = Date.now() + DISCUSSION_SECONDS * 1000
    setState(current =>
      current.phase === 'reading'
        ? { ...current, phase: 'discussing', left: DISCUSSION_SECONDS }
        : current,
    )
  }, [])

  const reveal = useCallback(() => {
    deadline.current = null
    setState(current =>
      current.phase === 'discussing' || current.phase === 'timeUp'
        ? { ...current, phase: 'revealed' }
        : current,
    )
  }, [])

  const score = useCallback(
    (won: boolean) => {
      setState(current => {
        if (current.phase !== 'revealed' || current.question === null) return current
        const team = current.team + (won ? 1 : 0)
        const questions = current.questions + (won ? 0 : 1)
        return {
          ...current,
          team,
          questions,
          history: [...current.history, { question: current.question, won }],
          phase: team >= WINNING_SCORE || questions >= WINNING_SCORE ? 'over' : 'idle',
          question: null,
          left: DISCUSSION_SECONDS,
        }
      })

      setPlayed(current => {
        const question = state.question
        if (question === null) return current
        const next = new Set(current)
        next.add(question.id)
        writePlayed(next)
        return next
      })
    },
    [state.question],
  )

  const reset = useCallback(() => {
    deadline.current = null
    setState({
      phase: 'idle',
      question: null,
      left: DISCUSSION_SECONDS,
      team: 0,
      questions: 0,
      history: [],
    })
  }, [])

  return {
    ...state,
    available: pool.length,
    fresh: unplayed.length,
    spin,
    start,
    reveal,
    score,
    reset,
  }
}
