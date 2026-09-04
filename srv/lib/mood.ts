/*
 * Looking at a face and describing what it is doing.
 *
 * The same machinery as the receipt reader (`srv/lib/documentai/llm-extractor.ts`) pointed
 * at a much softer question. Two rules keep it honest, and both are load-bearing:
 *
 *  - **The photograph is never stored.** It arrives in memory, goes to the model, and is
 *    gone when this function returns. `detectMood` in `ledger-service.ts` writes nothing;
 *    saving the *reading* is a separate, ordinary POST that carries no image. A ledger of
 *    receipts is one thing to keep; an archive of face photographs is not.
 *  - **It describes a face; it does not name a feeling.** This is the load-bearing rule and
 *    it is not a matter of tone. A facial configuration agrees with a named emotion at about
 *    r = .32 — weak against the field's own published thresholds — and its specificity has
 *    never been measured, because studies do not report how often a scowl appears on somebody
 *    who is not angry. So the model is asked for "a downturned mouth" and never for "sad".
 *
 *    The same line is the legal one. Emotion recognition is high-risk under AI Act Annex III
 *    1(c) with no sector limit, while Recital 18 excludes "the mere detection of readily
 *    apparent expressions, gestures or movements" — naming smiles and frowns exactly. The
 *    honest feature and the unregulated feature turn out to be the same feature.
 *
 *    Changing the UI's words without changing this file would have been microcopy dressed as
 *    policy: whatever the screen said, the prompt was still asking a model to report somebody's
 *    emotional state from a photograph.
 *
 *  - **The reading is an estimate and is labelled as one.** The model reports its own
 *    confidence and the UI presents the result as a suggestion to confirm, not a fact. The
 *    schema forces `confidence` out of the model rather than inventing one here — the same
 *    no-fabricated-measurements rule the receipt reader follows.
 *
 * The model answers through structured outputs (`messages.parse` + zod), so a mis-shapen
 * answer is a thrown error the handler turns into a plain sentence, never a half-parsed
 * guess that gets saved.
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { createAnthropicClient } from './anthropic-client'

/** Exact, and carries no date suffix — the same rule CONTRACTS.md §7 states for the LLM. */
const DEFAULT_MODEL = 'claude-opus-5'

/** A face is one look, not a document — the answer is four short fields. */
const MAX_TOKENS = 1024

const SYSTEM = [
  'You look at a photograph of a person and describe what their face is doing.',
  '',
  'The distinction in that sentence is the whole brief, and it is not a matter of tone.',
  'A facial configuration agrees with a named emotion at about r = .32 — weak by the',
  "field's own published thresholds — and the specificity has never been measured at all,",
  'because studies do not report how often a scowl appears on somebody who is not angry.',
  'So "a downturned mouth" is an observation and "sad" is a guess dressed as one.',
  '',
  'Rules:',
  '- Describe the most prominent face: the mouth, the eyes, the brows, the set of the',
  '  head. What it is DOING, not what it means. Name no feeling, ever — not happy, sad,',
  '  angry, anxious, stressed, tired, content, upset or any synonym.',
  '- Never anything clinical. Not depressed, not burnt out, not exhausted. Those are',
  '  health claims about a person, from a photograph.',
  '- level places what you see on a 1..5 comfort scale: 1 rough, 3 level, 5 bright. It is',
  '  a suggestion the person will confirm or overrule, and they are the authority.',
  '- label is two or three words for the EXPRESSION: "a broad smile", "a half-smile",',
  '  "a downturned mouth", "pulled-together brows", "a level face".',
  '- confidence is your own honest 0..1 estimate. A blurry photo, a covered face, an',
  '  ambiguous expression or an angled head should push it DOWN. Never report high',
  '  confidence to be polite.',
  '- observation is one warm sentence about what you can see — the light, the room, the',
  '  set of the shoulders, whether the smile reaches the eyes. It is shown to the person',
  '  themselves, so never be unkind about how they look. You may say a face looks tired',
  '  ONLY as a description of eyes and posture, never as a verdict about their day.',
  '- Never contradict somebody about themselves. You are describing a picture.',
  '- If there is no discernible face, set faceFound to false and confidence to 0. Do not',
  '  invent an expression for a coffee mug.',
].join('\n')

const SCHEMA = z.object({
  faceFound: z.boolean().describe('False when no discernible face is in the photograph.'),
  level: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Overall mood on a 1..5 scale: 1 rough, 3 okay, 5 great.'),
  label: z
    .string()
    .describe(
      'Two or three words for the EXPRESSION, never a feeling: "a broad smile", ' +
        '"a downturned mouth", "a level face". Not "content", not "stressed".',
    ),
  confidence: z.number().min(0).max(1).describe('Your own honest estimate, 0..1.'),
  observation: z
    .string()
    .describe(
      'One warm sentence about what is visible in the picture, shown to the person ' +
        'themselves. Describes the photograph, never diagnoses the person.',
    ),
})

export type MoodReading = z.infer<typeof SCHEMA>

/** True when an `ANTHROPIC_API_KEY` is available to look with. */
export function moodDetectionConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== ''
}

/**
 * Trim the reading to what the ledger stores, with the bounds enforced once more.
 *
 * zod already validated the shape and ranges; the clamp survives anyway because this is
 * the last line before a database write, and a schema edit two years from now should not
 * be able to widen what `Moods.level` receives.
 */
export function clampReading(reading: MoodReading): MoodReading {
  return {
    faceFound: reading.faceFound,
    level: Math.min(5, Math.max(1, Math.round(reading.level))),
    label: reading.label.trim().slice(0, 60),
    confidence: Math.min(1, Math.max(0, reading.confidence)),
    observation: reading.observation.trim().slice(0, 280),
  }
}

/**
 * One look. The image goes to the model and nowhere else; see the header comment.
 *
 * Effort is `medium` rather than the receipt reader's `low`: a face is genuinely more
 * ambiguous than a printed total, the answer is shown to a person about themselves, and
 * nobody is standing at a till while it thinks.
 */
export async function detectMood(
  image: Buffer,
  mimeType: string,
  model = DEFAULT_MODEL,
): Promise<MoodReading> {
  const client = createAnthropicClient()

  const response = await client.messages.parse({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { effort: 'medium', format: zodOutputFormat(SCHEMA) },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
              data: image.toString('base64'),
            },
          },
          // The user turn matters as much as the system prompt: asking "how does this
          // person seem to be feeling" invites exactly the answer the whole file is written
          // to avoid, however carefully the rules above are phrased.
          { type: 'text', text: 'Describe what this face is doing.' },
        ],
      },
    ],
  })

  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error(
      `the model returned no parsable mood reading (stop_reason=${response.stop_reason ?? 'unknown'})`,
    )
  }

  return clampReading(response.parsed_output)
}
