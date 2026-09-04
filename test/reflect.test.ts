/**
 * The reflective journal's two halves that must not fail.
 *
 * The safety check gets most of this file, and not because it is intricate — it is a phrase
 * list. It is because its failure is silent and asymmetric: showing help to somebody having
 * an ordinary bad week costs a moment's irritation, and failing to show it to somebody who
 * needed it costs something that cannot be undone. So it is tested for over-firing rather
 * than under-firing, and the prompt is tested for the four things it must never do.
 */
import { describe, expect, it } from 'vitest'

import { CONCERNED_REPLY, HELPLINES, checkSafety } from '../srv/lib/reflect/safety'
import { NO_MODEL_REPLY, REFLECT_SYSTEM, reflectPrompt } from '../srv/lib/reflect/prompt'

describe('the safety check', () => {
  it('fires on somebody describing harm to themselves', () => {
    const said = [
      'I want to die',
      'sometimes I think about killing myself',
      "I've been thinking about suicide again",
      'I wish I was dead honestly',
      'I hurt myself last night',
      'nothing feels worth living for',
      "I can't go on like this",
      'there is no reason to live any more',
    ]
    for (const text of said) {
      expect(checkSafety(text).concerning, text).toBe(true)
    }
  })

  it('fires on somebody describing being hurt by another person', () => {
    // The other case this exists for, and the one a self-harm word list would miss.
    for (const text of ['he hits me when he drinks', 'I am scared of him', 'she beats me']) {
      expect(checkSafety(text).concerning, text).toBe(true)
    }
  })

  it('reads through punctuation and capitals', () => {
    expect(checkSafety('KILL   MYSELF...').concerning).toBe(true)
    expect(checkSafety('I want to die.').concerning).toBe(true)
  })

  it('leaves an ordinary hard day alone', () => {
    // The property that decides whether this survives contact with real use. A check that
    // fires on every bad mood is a check that gets switched off, and a check that is off
    // protects nobody.
    const ordinary = [
      'Work was exhausting and I snapped at him over nothing.',
      'I am so tired of the same argument every Sunday.',
      'Feeling flat today. Not sure why.',
      'That meeting killed me, honestly.',
      'I could murder a coffee.',
      'We had a lovely evening for once.',
      '',
    ]
    for (const text of ordinary) {
      expect(checkSafety(text).concerning, text).toBe(false)
    }
  })

  it('answers with a person’s words and real numbers, never a generated reply', () => {
    const check = checkSafety('I want to die')
    expect(check.reply).toBe(CONCERNED_REPLY)
    expect(check.helplines).toBe(HELPLINES)
    expect(HELPLINES.length).toBeGreaterThan(2)
    // A hallucinated crisis line is the worst thing this feature could produce, so the
    // numbers must be constants and must never pass through a model.
    expect(HELPLINES.some(one => one.contact === '143')).toBe(true)
  })

  it('says where to go without grading anybody', () => {
    // It is a trigger for showing help, not a risk assessment, and the copy must not imply
    // it has judged anything about the person.
    for (const word of ['risk', 'severe', 'crisis level', 'diagnos', 'you are']) {
      expect(CONCERNED_REPLY.toLowerCase()).not.toContain(word)
    }
    expect(CONCERNED_REPLY).toMatch(/rather than an app/i)
  })
})

describe('what the model is told', () => {
  it('forbids the four things a model does by default and which are all wrong here', () => {
    const system = REFLECT_SYSTEM.toLowerCase()
    expect(system).toContain('never give advice')
    expect(system).toContain('never reassure')
    expect(system).toContain('never diagnose')
    expect(system).toMatch(/three or four sentences/)
  })

  it('refuses the clinical vocabulary including the soft version', () => {
    // "That sounds like burnout" is the dangerous one: it reads as a verdict, it sticks, and
    // it is exactly what a helpful-sounding model reaches for.
    for (const word of ['burnout', 'anxiety', 'depression', 'trauma', 'narcissist']) {
      expect(REFLECT_SYSTEM.toLowerCase()).toContain(word)
    }
  })

  it('never claims to be a professional or to remember anything', () => {
    expect(REFLECT_SYSTEM).toMatch(/never claim to be a therapist/i)
    expect(REFLECT_SYSTEM).toMatch(/never claim to remember/i)
  })

  it('sends the entry and nothing about the household', () => {
    // A journal that quietly knows what you spent last week is a surveillance product
    // wearing a friendly face.
    const prompt = reflectPrompt('  I had a hard week.  ')
    expect(prompt).toContain('I had a hard week.')
    expect(prompt).toContain('<entry>')
    for (const leak of ['CHF', 'expense', 'mood', 'partner', 'household']) {
      expect(prompt.toLowerCase()).not.toContain(leak.toLowerCase())
    }
  })

  it('is honest when there is no model rather than faking a reply', () => {
    // A canned "that sounds hard" would be worse than silence: it would look like it had
    // been read.
    expect(NO_MODEL_REPLY).toMatch(/no language model/i)
    expect(NO_MODEL_REPLY).toMatch(/kept/i)
  })
})
