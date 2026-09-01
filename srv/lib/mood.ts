/*
 * Looking at a face and estimating a mood.
 *
 * The same machinery as the receipt reader (`srv/lib/documentai/llm-extractor.ts`) pointed
 * at a much softer question. Two rules keep it honest, and both are load-bearing:
 *
 *  - **The photograph is never stored.** It arrives in memory, goes to the model, and is
 *    gone when this function returns. `detectMood` in `ledger-service.ts` writes nothing;
 *    saving the *reading* is a separate, ordinary POST that carries no image. A ledger of
 *    receipts is one thing to keep; an archive of face photographs is not.
 *  - **A mood is an estimate, and it is labelled as one.** The model reports its own
 *    confidence and the UI presents the result as a suggestion to confirm, not a fact. The
 *    schema forces `confidence` out of the model rather than inventing one here — the same
 *    no-fabricated-measurements rule the receipt reader follows.
 *
 * The model answers through structured outputs (`messages.parse` + zod), so a mis-shapen
 * answer is a thrown error the handler turns into a plain sentence, never a half-parsed
 * guess that gets saved.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

/** Exact, and carries no date suffix — the same rule CONTRACTS.md §7 states for the LLM. */
const DEFAULT_MODEL = 'claude-opus-5'

/** A face is one look, not a document — the answer is four short fields. */
const MAX_TOKENS = 1024

const SYSTEM = [
  'You look at a photograph of a person and estimate their apparent mood.',
  '',
  'Rules:',
  '- Report the apparent emotional state of the most prominent face: the expression, the',
  '  posture, what the face is actually doing. You are describing appearance, not reading',
  '  minds — "looks tired" is a fair observation, a diagnosis is not.',
  '- level maps the overall mood to 1..5: 1 rough, 2 low, 3 okay, 4 good, 5 great.',
  '- label is one or two plain words for it: "content", "tired but happy", "stressed".',
  '- confidence is your own honest 0..1 estimate. A blurry photo, a covered face or an',
  '  ambiguous expression should push it DOWN. Never report high confidence to be polite.',
  '- observation is one warm, human sentence about what you see — it is shown to the',
  '  person themselves. Never negative about their appearance; describe the mood, not the',
  '  face.',
  '- If there is no discernible face in the photograph, say so by setting faceFound to',
  '  false and confidence to 0. Do not invent a mood for a coffee mug.',
].join('\n')

const SCHEMA = z.object({
  faceFound: z.boolean().describe('False when no discernible face is in the photograph.'),
  level: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Overall mood on a 1..5 scale: 1 rough, 3 okay, 5 great.'),
  label: z.string().describe('One or two plain words, e.g. "content" or "tired but happy".'),
  confidence: z.number().min(0).max(1).describe('Your own honest estimate, 0..1.'),
  observation: z
    .string()
    .describe('One warm sentence about the apparent mood, shown to the person themselves.'),
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
  const client = new Anthropic()

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
          { type: 'text', text: 'How does this person seem to be feeling?' },
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
