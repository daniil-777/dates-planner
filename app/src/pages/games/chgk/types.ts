/**
 * "What? Where? When?" — the shape of a question, and of a game.
 *
 * ## The format this borrows
 *
 * A reader reads a question aloud. Everybody else has **one minute** to discuss it, out
 * loud, together. At the gong somebody says the answer, the reader reveals the real one, and
 * the point goes to the team or to the question. First to six wins.
 *
 * The minute is the whole game. It is long enough that a table has to actually think and
 * short enough that nobody drifts off, and it is the reason this works with three people in
 * a kitchen as well as with six — the constraint does the work, not the difficulty.
 *
 * ## What makes a question good, which is what the bank is written against
 *
 * A good one is **not** a fact you either know or do not. It is a small puzzle whose answer
 * is reachable from ordinary knowledge if you think sideways, and which is obvious in
 * hindsight — the sound a table makes when it gets one is a groan, not a cheer. So every
 * question here has a `note`: the sentence that turns "oh" into "*oh*". A question without
 * one is trivia, and trivia is a different, worse game.
 */

export const THEMES = [
  'words',
  'science',
  'history',
  'geography',
  'arts',
  'everyday',
  'food',
  'nature',
  'numbers',
  'sport',
] as const

export type Theme = (typeof THEMES)[number]

export const THEME_LABEL: Record<Theme, string> = {
  words: 'Words',
  science: 'Science',
  history: 'History',
  geography: 'Places',
  arts: 'Books, music, film',
  everyday: 'Everyday things',
  food: 'Food and drink',
  nature: 'The natural world',
  numbers: 'Numbers',
  sport: 'Games and sport',
}

export interface Question {
  /** Stable, so a question already played is not offered again. */
  id: string
  /** Read aloud, exactly as written. Kept to a breath or two — a long one loses the room. */
  q: string
  /** What the team has to arrive at. */
  a: string
  /**
   * The turn. Why the answer is the answer, and the line the reader delivers after it —
   * this is the part that makes people want another question.
   */
  note: string
  theme: Theme
  /** Harder than the rest of its theme. Used to keep a session from spiking. */
  hard?: boolean
}

/** How long a team gets. Sixty seconds, because that is the game. */
export const DISCUSSION_SECONDS = 60

/** The last stretch, when the timer changes character. */
export const URGENT_SECONDS = 10

/** First to this many points wins the session. */
export const WINNING_SCORE = 6

/**
 * Where a round is.
 *
 * `spinning` exists for one reason and it is not decoration: the moment before a question is
 * the best moment in this game, and giving it a second and a half of anticipation is most of
 * why people ask for another one.
 */
export type Phase = 'idle' | 'spinning' | 'reading' | 'discussing' | 'timeUp' | 'revealed' | 'over'

export interface Round {
  question: Question
  /** True when the team got it. Null until the reader says. */
  won: boolean | null
}

export interface GameState {
  phase: Phase
  question: Question | null
  /** Seconds left in the discussion. */
  left: number
  team: number
  questions: number
  history: Round[]
}
