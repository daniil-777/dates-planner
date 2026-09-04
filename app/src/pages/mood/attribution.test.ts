/**
 * Who the app says answered the question.
 *
 * Small file, and the only one guarding a claim the mood page makes about its own data. The
 * bug it exists for shipped: a person who scanned their face, disagreed with the reading and
 * tapped a different one had that correction stored as a machine reading, complete with the
 * model's word, the model's confidence and an AI badge in the history.
 */
import { describe, expect, it } from 'vitest'

import { attribute } from './attribution'

const READING = { level: 2, label: 'tired but fine', confidence: 0.8 }

describe('attributing a saved mood', () => {
  it('is the person’s own when there was no scan', () => {
    expect(attribute(null, 4)).toEqual({ source: 'manual', detected: null, confidence: null })
  })

  it('is the camera’s only when the person kept the level it suggested', () => {
    expect(attribute(READING, 2)).toEqual({
      source: 'face',
      detected: 'tired but fine',
      confidence: 0.8,
    })
  })

  it('is the person’s own the moment they change it', () => {
    // The whole bug. This used to come back as `face`, with the model's word and confidence
    // attached to a level the model did not choose.
    for (const chosen of [1, 3, 4, 5]) {
      expect(attribute(READING, chosen), `chose ${chosen}`).toEqual({
        source: 'manual',
        detected: null,
        confidence: null,
      })
    }
  })

  it('keeps no record of a guess that was rejected', () => {
    // Storing an inference about somebody's emotional state that they have just told us is
    // wrong would be a strange thing for this app to keep.
    const overruled = attribute(READING, 5)
    expect(overruled.detected).toBeNull()
    expect(overruled.confidence).toBeNull()
  })

  it('never reports a confidence without the reading it belongs to', () => {
    // A confidence with no `detected` beside it is a number about nothing, and a `detected`
    // with no confidence is a claim with no hedge. They travel together or not at all.
    for (const chosen of [1, 2, 3, 4, 5]) {
      const { detected, confidence } = attribute(READING, chosen)
      expect(detected === null, `chose ${chosen}`).toBe(confidence === null)
    }
  })
})
