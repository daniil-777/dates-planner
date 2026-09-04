/**
 * The one part of the reflective journal that is not allowed to be clever.
 *
 * ## Why this is deterministic and not a model call
 *
 * Everything else in this feature is a language model reflecting on what somebody wrote.
 * This is not, and must never become one, for a reason worth stating plainly: a model's
 * answer to "is this person in danger" is a probability, and the cost of the two errors is
 * wildly asymmetric. Showing a crisis line to somebody having an ordinary bad week costs
 * them a moment's mild irritation. Failing to show it to somebody who needed it costs
 * something that cannot be undone.
 *
 * So the check runs *first*, on the raw text, with no network call and no possibility of a
 * timeout, a rate limit or a refusal getting in the way. If it fires, the model is never
 * asked. The person gets a short, human-written response and real phone numbers, and that is
 * the entire output. A reflective paragraph appended underneath would be the app talking
 * over somebody at the worst possible moment.
 *
 * ## What it is not
 *
 * It is **not** a risk assessment and must never be described as one, in the UI or anywhere
 * else. It is a trigger for showing help. Nobody here is qualified to grade anybody's state,
 * and an app that implied it could would be doing something worse than useless.
 *
 * It will over-fire. That is the design. A phrase list cannot tell "I could kill him for
 * that" from anything else and does not try; it errs toward showing help, and the copy
 * around it is written so that seeing it when you did not need it feels like care rather
 * than like an accusation.
 *
 * ## Why the resources are hard-coded
 *
 * Because a model may not invent a phone number. A hallucinated crisis line is the single
 * worst output this feature could produce, and the only way to be certain of that is for the
 * numbers never to pass through a model at all.
 */

/**
 * Phrases that show the help card.
 *
 * Lower-cased, matched on word boundaries where the phrase is a word. Kept deliberately
 * short and unambiguous: a long list built from a thesaurus fires on everything and gets
 * quietly disabled, which is the failure mode that actually matters.
 */
const CONCERNING = [
  'kill myself',
  'killing myself',
  'end my life',
  'ending my life',
  'take my own life',
  'suicide',
  'suicidal',
  'want to die',
  'wish i was dead',
  'wish i were dead',
  'better off dead',
  // Broader than "not worth living" on purpose: "nothing feels worth living for" is the
  // same sentence and a list of exact negations will always be one phrasing short. The
  // false positive it admits — somebody writing that life *is* worth living — is a person
  // being shown a phone number they did not need, which is the cheap error.
  'worth living',
  'no reason to live',
  'reason to live',
  'point in living',
  'cant go on',
  'can t go on',
  'give up on life',
  'self harm',
  'self-harm',
  'hurt myself',
  'hurting myself',
  'cut myself',
  'cutting myself',
  'overdose',
  'kill him',
  'kill her',
  'kill them',
  'hurt him',
  'hurt her',
  'hurt them',
  'hit me',
  'hits me',
  'beats me',
  'afraid of him',
  'afraid of her',
  'afraid of them',
  'scared of him',
  'scared of her',
]

/** Where the app sends somebody. Never generated, never edited by a model. */
export interface Helpline {
  name: string
  /** Dialled as written. */
  contact: string
  detail: string
}

/**
 * Switzerland first, because that is where this household is, then two that answer from
 * anywhere. If this app is ever deployed elsewhere, this list is the thing to change and it
 * is deliberately one list in one file so that is a five-minute job.
 */
export const HELPLINES: readonly Helpline[] = [
  {
    name: 'Die Dargebotene Hand',
    contact: '143',
    detail: 'Free, day and night, anywhere in Switzerland. You do not have to be in crisis.',
  },
  {
    name: 'Emergency services',
    contact: '144',
    detail: 'If someone is in immediate danger.',
  },
  {
    name: 'Pro Juventute',
    contact: '147',
    detail: 'For anybody under 25. Free, day and night.',
  },
  {
    name: 'Find a helpline',
    contact: 'findahelpline.com',
    detail: 'Wherever you are in the world.',
  },
]

/**
 * The response, written once by a person.
 *
 * Short on purpose. Somebody who has just written something hard does not want six
 * paragraphs, and length here reads as a lecture. It says three things and stops: that it
 * was read, that talking to a person is worth more than talking to this, and where.
 */
export const CONCERNED_REPLY =
  'Thank you for writing that down — it took something to say it.\n\n' +
  'This is where I stop being the right thing to talk to. Not because of what you wrote, ' +
  'but because you deserve somebody who can actually listen back, and that is a person ' +
  'rather than an app.\n\n' +
  'The people below answer any hour, and you do not have to be in crisis to call them. ' +
  'Talking to somebody you trust counts too.'

export interface SafetyCheck {
  concerning: boolean
  /** Present only when `concerning`. Human-written; never from a model. */
  reply?: string
  helplines?: readonly Helpline[]
}

/**
 * Does this need a person rather than a paragraph?
 *
 * Matched on a normalised copy — lower-cased, punctuation flattened to spaces — so that
 * "kill  myself." and "kill myself" are the same thing. Deliberately does not attempt to
 * detect negation ("I would never hurt myself"): a phrase list that tries to be clever about
 * context is a phrase list that misses the case it exists for.
 */
export function checkSafety(text: string): SafetyCheck {
  const flat = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `

  for (const phrase of CONCERNING) {
    if (flat.includes(` ${phrase.replace(/[^a-z0-9]+/g, ' ')} `)) {
      return { concerning: true, reply: CONCERNED_REPLY, helplines: HELPLINES }
    }
  }
  return { concerning: false }
}
