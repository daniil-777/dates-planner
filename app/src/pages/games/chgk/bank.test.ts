/**
 * The question bank, checked as data.
 *
 * A thousand hand-written entries is a thousand chances to paste a duplicate id, forget a
 * note, or leave a placeholder in. None of those would throw — they would simply produce a
 * bad evening: the same question twice, an answer with no punchline, a blank card. So the
 * bank is validated the way a dataset is, not the way a module is.
 *
 * The rule these enforce is the one from `questions/index.ts`: **every question carries a
 * note**. Without it the game is trivia, and trivia is a worse game. That is a content
 * standard, and a content standard that is not tested is a preference.
 */
import { describe, expect, it } from 'vitest'

import { BANK } from './questions'
import { THEMES, type Theme } from './types'

describe('the bank', () => {
  it('is large enough that a household does not exhaust it', () => {
    // Six questions a game, once a week, is 312 a year. A thousand is several years of
    // Friday nights before anything repeats.
    expect(BANK.length).toBeGreaterThanOrEqual(1000)
  })

  it('has no duplicate ids', () => {
    const ids = BANK.map(one => one.id)
    const seen = new Set(ids)
    // A duplicate id means one of the two is unreachable and the other is served twice —
    // and, because played ids are stored by id, both vanish together.
    expect(seen.size, `duplicate ids: ${ids.filter((id, at) => ids.indexOf(id) !== at)}`).toBe(
      ids.length,
    )
  })

  it('gives every question a question, an answer and a note', () => {
    const broken = BANK.filter(
      one => one.q.trim().length < 20 || one.a.trim().length === 0 || one.note.trim().length < 10,
    )
    expect(broken.map(one => one.id)).toEqual([])
  })

  it('ends every question with a question mark or an instruction', () => {
    // A question read aloud has to sound like one. It may end in a question mark, or in an
    // instruction — "Name either", "Give any two" — which is a normal form in this game. The
    // test looks at the *last* sentence, because the instruction always comes last.
    const lastSentence = (text: string): string =>
      text
        .trim()
        .split(/(?<=[.?!])\s+/)
        .at(-1) ?? text
    const notAsked = BANK.filter(one => {
      const tail = lastSentence(one.q)
      return !/[?]$/.test(tail) && !/^(Name|Give|Which|What)\b/i.test(tail)
    })
    expect(notAsked.map(one => one.id)).toEqual([])
  })

  it('fills every theme, so a filtered game is still playable', () => {
    const counts = new Map<Theme, number>(THEMES.map(theme => [theme, 0]))
    for (const one of BANK) counts.set(one.theme, (counts.get(one.theme) ?? 0) + 1)

    for (const theme of THEMES) {
      // Below about fifty, choosing one theme means seeing repeats within a few months.
      expect(counts.get(theme), `${theme} is thin`).toBeGreaterThanOrEqual(50)
    }
  })

  it('carries no placeholder text left in from drafting', () => {
    const suspicious = /\bTODO\b|\bTBD\b|\bLorem\b|\bXXX\b|\bFIXME\b/i
    const found = BANK.filter(
      one => suspicious.test(one.q) || suspicious.test(one.a) || suspicious.test(one.note),
    )
    expect(found.map(one => one.id)).toEqual([])
  })

  it('keeps questions short enough to read aloud in a breath or two', () => {
    // Past about 320 characters a reader loses the room and has to start again.
    const rambling = BANK.filter(one => one.q.length > 320)
    expect(rambling.map(one => one.id)).toEqual([])
  })

  it('uses an id prefix that matches its theme’s pack', () => {
    const prefixes: Record<Theme, string> = {
      words: 'w',
      science: 's',
      history: 'h',
      geography: 'g',
      arts: 'a',
      everyday: 'e',
      food: 'f',
      nature: 'n',
      numbers: 'm',
      sport: 'p',
    }
    // Ids are stable forever because they are stored in players' browsers, so a question in
    // the wrong pack is a question that will be renumbered one day — and renumbering shows
    // everybody a set they have already had.
    const misfiled = BANK.filter(one => !one.id.startsWith(prefixes[one.theme]))
    expect(misfiled.map(one => `${one.id} is ${one.theme}`)).toEqual([])
  })
})
