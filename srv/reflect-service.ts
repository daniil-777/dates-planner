/// <reference types="@cap-js/cds-types" />
/**
 * ReflectService handlers — CONTRACTS.md §18.
 *
 * Four things here are load-bearing, and three of them are about restraint.
 *
 * 1. **The safety check runs before the model, always, and short-circuits it.** If somebody
 *    writes about hurting themselves, they get a short human-written reply and real phone
 *    numbers, and the model is never called. Not called *and then overridden* — never called.
 *    A generated paragraph appended under a crisis line would be the app talking over
 *    somebody at the worst possible moment, and a model that is never asked cannot time out,
 *    refuse, or invent a helpline.
 *
 * 2. **A reflection is readable by its author and by nobody else.** Every read filters on
 *    `author_ID`, not on the group. This is the only entity in the app where narrowing to the
 *    household would be a privacy failure rather than the correct behaviour: two people
 *    sharing a ledger is the point, and two people sharing a diary is not.
 *
 * 3. **Nothing about the household reaches the model.** The prompt is the entry and nothing
 *    else — no names, no ledger, no moods, no events. It would be easy to pass more and the
 *    answers would feel uncannily specific, which is exactly the objection.
 *
 * 4. **The entry is never logged.** Not at debug level, not in an error path. `LOG` lines
 *    here carry ids and lengths and nothing else.
 */
import cds from '@sap/cds'
import type { Request } from '@sap/cds'

import { readSessionToken, verifySessionToken } from './lib/auth'
import { LlmError, getProvider } from './lib/llm'
import {
  NO_MODEL_REPLY,
  REFLECT_MAX_TOKENS,
  REFLECT_SYSTEM,
  reflectPrompt,
} from './lib/reflect/prompt'
import { checkSafety, type Helpline } from './lib/reflect/safety'

const { SELECT, INSERT, DELETE } = cds.ql

const REFLECTIONS = 'twowaymatch.Reflections'
const PEOPLE = 'twowaymatch.People'
const GROUPS = 'twowaymatch.Groups'
const MEMBERSHIPS = 'twowaymatch.Memberships'

const LOG = cds.log('reflect')

/** Long enough for anything anybody wants to say, short enough to bound the prompt. */
const MAX_ENTRY = 4_000

function one<T>(row: unknown): T | null {
  return (row ?? null) as T | null
}

interface Row {
  ID: string
  createdAt: string
  entry: string
  reply: string | null
  concerned: boolean
  author_ID: string | null
}

/** Who is writing, and in which household. Both, because a person exists per household. */
interface Writer {
  personId: string
  groupId: string
}

export default class ReflectService extends cds.ApplicationService {
  /** `onX`, for the reason spelled out in `commons-service.ts`. */
  override async init(): Promise<void> {
    this.on('reflect', req => this.onReflect(req))
    this.on('myReflections', req => this.onMyReflections(req))
    this.on('forgetReflection', req => this.onForgetReflection(req))
    this.on('reflectAvailable', () => this.onReflectAvailable())
    await super.init()
  }

  /* --------------------------------------------------------------- identity */

  /**
   * The person making this request.
   *
   * Rejects rather than guessing. Everywhere else in this app an unresolved caller can fall
   * back to the default household and see a shared ledger, which is harmless. Here a wrong
   * answer shows one person another's diary, so there is no fallback: no person, no journal.
   */
  private async writer(req: Request): Promise<Writer> {
    const cookie = req.headers?.cookie
    const claimed = verifySessionToken(
      readSessionToken(typeof cookie === 'string' ? cookie : undefined),
    )

    const groupId =
      claimed?.groupId ??
      one<{ ID?: string }>(await SELECT.one.from(GROUPS).columns('ID').where({ isDefault: true }))
        ?.ID ??
      null

    if (groupId === null) {
      return req.reject(403, 'This request is not attached to a household.')
    }

    if (claimed?.userId) {
      const membership = one<{ person_ID?: string | null }>(
        await SELECT.one
          .from(MEMBERSHIPS)
          .columns('person_ID')
          .where({ user_ID: claimed.userId, group_ID: groupId }),
      )
      if (membership?.person_ID) {
        return { personId: String(membership.person_ID), groupId: String(groupId) }
      }
    }

    // Open-door development mode: one household, and the first seated person. Acceptable
    // only because `AUTH_ALLOW_ANY` already means everybody sharing one identity — it is not
    // a fallback that can be reached by a real session.
    const seat = one<{ ID?: string }>(
      await SELECT.one
        .from(PEOPLE)
        .columns('ID')
        .where({ group_ID: groupId })
        .orderBy('isDefault desc', 'name'),
    )
    if (seat?.ID) return { personId: String(seat.ID), groupId: String(groupId) }

    return req.reject(403, 'There is nobody to write this down as.')
  }

  /* ---------------------------------------------------------------- writing */

  private async onReflect(req: Request): Promise<Record<string, unknown>> {
    const me = await this.writer(req)

    const raw = typeof req.data.entry === 'string' ? req.data.entry.trim() : ''
    if (raw === '') return req.reject(400, 'There is nothing written down yet.')
    const entry = raw.slice(0, MAX_ENTRY)

    // First, always, before anything can go wrong. See the file header.
    const safety = checkSafety(entry)

    let reply: string
    let engine: string
    let helplines: readonly Helpline[] = []

    if (safety.concerning) {
      reply = safety.reply ?? ''
      helplines = safety.helplines ?? []
      // Not a model name. Nothing generated this.
      engine = 'none'
    } else {
      const answered = await this.ask(entry)
      reply = answered.reply
      engine = answered.engine
    }

    const ID = cds.utils.uuid()
    await INSERT.into(REFLECTIONS).entries({
      ID,
      group_ID: me.groupId,
      author_ID: me.personId,
      entry,
      reply,
      concerned: safety.concerning,
      engine,
    })

    // Ids and a length. Never the text.
    LOG.info(`reflection ${ID} (${entry.length} chars, ${engine})`)

    return {
      ID,
      at: new Date().toISOString(),
      entry,
      reply,
      concerned: safety.concerning,
      helplines,
    }
  }

  /**
   * Ask the model, and degrade honestly.
   *
   * The LLM layer falls back to a deterministic template provider when nothing is
   * configured, which is right for the statement generator and wrong here: there is no
   * template that can reflect on a sentence it has not read, and a canned "that sounds hard"
   * would be worse than silence because it would look like it had been read. So the template
   * provider is treated as *no model* and says so.
   */
  private async ask(entry: string): Promise<{ reply: string; engine: string }> {
    const provider = getProvider()
    if (provider.name === 'template') return { reply: NO_MODEL_REPLY, engine: 'none' }

    try {
      const written = await provider.generate({
        system: REFLECT_SYSTEM,
        prompt: reflectPrompt(entry),
        maxTokens: REFLECT_MAX_TOKENS,
      })
      const trimmed = written.trim()
      if (trimmed === '') return { reply: NO_MODEL_REPLY, engine: 'none' }
      return { reply: trimmed, engine: provider.name }
    } catch (error) {
      // The message, never the entry — an LLM error can quote the request back.
      LOG.warn('could not reflect:', error instanceof LlmError ? error.message : 'provider failed')
      return {
        reply:
          'Saved, but the reflecting part could not be reached just now. What you wrote is ' +
          'kept, and that is the half that matters.',
        engine: 'none',
      }
    }
  }

  /* ---------------------------------------------------------------- reading */

  private async onMyReflections(req: Request): Promise<Array<Record<string, unknown>>> {
    const me = await this.writer(req)
    const limit = Math.min(100, Math.max(1, Number(req.data.limit) || 20))

    // On `author_ID`, not on the group. The whole access rule is this line.
    const rows = (await SELECT.from(REFLECTIONS)
      .where({ author_ID: me.personId })
      .orderBy('createdAt desc')
      .limit(limit)) as Row[]

    return rows.map(row => ({
      ID: row.ID,
      at: row.createdAt,
      entry: row.entry,
      reply: row.reply ?? '',
      concerned: row.concerned === true,
      // Re-attached from the constant rather than stored, so a helpline can never go stale
      // in a row and can never have been written by anything but a person.
      helplines: row.concerned === true ? (checkSafety(row.entry).helplines ?? []) : [],
    }))
  }

  private async onForgetReflection(req: Request): Promise<boolean> {
    const me = await this.writer(req)
    const ID = typeof req.data.ID === 'string' ? req.data.ID : ''
    if (ID === '') return req.reject(400, 'Which one?')

    // Scoped to the author, so this cannot delete somebody else's even with a valid id.
    const gone = await DELETE.from(REFLECTIONS).where({ ID, author_ID: me.personId })
    if (!gone) return req.reject(404, 'No such entry.')
    return true
  }

  private onReflectAvailable(): { available: boolean; engine: string } {
    const provider = getProvider()
    return { available: provider.name !== 'template', engine: provider.name }
  }
}
