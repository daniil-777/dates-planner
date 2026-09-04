/**
 * The bank.
 *
 * Ten themed packs, loaded together and shuffled by `useGame`. They are split by theme
 * rather than kept in one file for two reasons: the game offers theme filters, so the split
 * is the data model rather than filing; and a thousand questions in one module is a module
 * nobody will ever open to fix a typo in.
 *
 * ## What a question in here has to be
 *
 * Not a fact you either know or do not — that is trivia, and trivia is a worse game. It has
 * to be reachable by thinking sideways from ordinary knowledge, and obvious in hindsight.
 * The test is the sound a table makes: a groan is right, a shrug means the question failed.
 *
 * Every entry therefore carries a `note`, and the note is not optional decoration. It is the
 * sentence the reader delivers after the answer, and it is the reason anybody asks for
 * another question.
 *
 * ## Ids
 *
 * `<letter><number>` per pack, and **stable forever**: a played id lives in the player's
 * browser, so renumbering a pack would show everybody a set of questions they have already
 * had. Append, never renumber.
 */
import type { Question } from '../types'

import { WORDS } from './words'
import { SCIENCE } from './science'
import { HISTORY } from './history'
import { GEOGRAPHY } from './geography'
import { ARTS } from './arts'
import { EVERYDAY } from './everyday'
import { FOOD } from './food'
import { NATURE } from './nature'
import { NUMBERS } from './numbers'
import { SPORT } from './sport'

export const BANK: readonly Question[] = [
  ...WORDS,
  ...SCIENCE,
  ...HISTORY,
  ...GEOGRAPHY,
  ...ARTS,
  ...EVERYDAY,
  ...FOOD,
  ...NATURE,
  ...NUMBERS,
  ...SPORT,
]
