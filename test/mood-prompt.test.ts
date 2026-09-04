/**
 * What the server is allowed to ask a model about a face.
 *
 * This is a policy test rather than a behaviour one, and it exists because the policy lives
 * in a string. The screen's words were about to be rewritten to describe expressions rather
 * than name feelings — and the prompt underneath still said "estimate their apparent mood"
 * and "Report the apparent emotional state", with example labels of "content", "tired but
 * happy" and "stressed". Changing the UI over that would have been microcopy dressed as
 * policy: whatever the screen said, the request going out was still asking a model to report
 * somebody's emotional state from a photograph.
 *
 * The line is both the scientific one and the legal one. Facial configurations agree with
 * named emotions at about r = .32 — weak by the field's own thresholds — and specificity has
 * never been measured. AI Act Recital 18 excludes "the mere detection of readily apparent
 * expressions" from the emotion-recognition regime that Annex III 1(c) makes high-risk.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync('srv/lib/mood.ts', 'utf8')

/** Everything between the first `const SYSTEM = [` and its `].join`, plus the user turn. */
const PROMPT = SOURCE.slice(SOURCE.indexOf('const SYSTEM = ['), SOURCE.indexOf('const SCHEMA'))
const USER_TURN = /text: '([^']*face[^']*)'/i.exec(SOURCE)?.[1] ?? ''

/**
 * The prompt as the model receives it.
 *
 * The source splits it across quoted array lines, so matching a sentence against the raw
 * file fails on wrapping — the quotes, the commas and the indentation all land mid-phrase.
 * This strips them and collapses the whitespace, which is what the `join` does at runtime.
 */
const READS_AS = PROMPT.replace(/',?\s*\n\s*'/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase()

describe('the face prompt', () => {
  it('asks the model to describe a face, not to read a mood', () => {
    expect(READS_AS).toContain('describe what their face is doing')
    expect(USER_TURN).toMatch(/describe what this face is doing/i)
  })

  it('never asks for an emotional state', () => {
    // The exact phrases that were there, and the shapes they would come back as.
    for (const banned of [
      'estimate their apparent mood',
      'apparent emotional state',
      'how does this person seem to be feeling',
    ]) {
      expect(SOURCE.toLowerCase()).not.toContain(banned)
    }
  })

  it('offers no feeling as an example label', () => {
    // The examples are the strongest instruction in any prompt. These three were the old
    // ones, and each is a named internal state rather than a description of a face.
    const examples = /label is[\s\S]{0,400}/i.exec(PROMPT)?.[0] ?? PROMPT
    for (const feeling of ['content', 'tired but happy', 'stressed', 'happy', 'sad', 'angry']) {
      expect(examples.toLowerCase(), `"${feeling}" is offered as an example label`).not.toContain(
        `"${feeling}"`,
      )
    }
  })

  it('forbids the clinical vocabulary by name', () => {
    // "Burnt out" and "depressed" are health claims about a person made from a photograph,
    // and they would also turn the output into Art. 9 data.
    expect(READS_AS).toContain('never anything clinical')
    expect(PROMPT.toLowerCase()).toContain('depressed')
    expect(PROMPT.toLowerCase()).toContain('burnt out')
  })

  it('forbids contradicting somebody about themselves', () => {
    // A 19%-reliable signal set against a person's own account of their own day, in their
    // own home, is the single worst thing this feature could ever say.
    expect(READS_AS).toContain('never contradict somebody about themselves')
  })

  it('still forces a confidence and a no-face answer out of the model', () => {
    // The properties that were already right and must survive the rewrite: the server path's
    // advantage over the on-device reader is precisely that it can say "I could not see one"
    // and "I am not sure".
    expect(READS_AS).toContain('facefound to false')
    expect(READS_AS).toContain('your own honest 0..1 estimate')
    expect(READS_AS).toContain('never report high confidence to be polite')
  })
})
