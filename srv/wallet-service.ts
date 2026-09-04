/// <reference types="@cap-js/cds-types" />
/**
 * WalletService handlers — TWM-ADR-004, CONTRACTS.md §17.
 *
 * Three things in this file carry the weight.
 *
 * 1. **A client can never mint.** There is no action here that awards points. Awards happen
 *    in `after` handlers attached to the services where acts actually occur — confirming an
 *    expense, rating a place — so the server observes the act rather than being told about
 *    it. An `awardPoints(reason)` endpoint would be an infinite points endpoint about ten
 *    minutes after anybody looked at the network tab.
 *
 * 2. **Balances are summed, never stored.** Every figure the screen shows is an aggregate
 *    over `LedgerPostings`. See the block in `db/schema.cds`: a stored balance is a cache
 *    that will one day disagree with the postings, with no way to tell which is right.
 *
 * 3. **Writes are idempotent by construction.** A transfer carries a key that is unique in
 *    the database, and a duplicate insert is caught and treated as success — because it *is*
 *    success: the movement the caller asked for is in the ledger. This is what makes a
 *    retried request, a replayed webhook and a double-tap all safe.
 */
import cds from '@sap/cds'
import type { Request, Service } from '@sap/cds'

import { readSessionToken, verifySessionToken } from './lib/auth'
import { accountId, proves, type Transfer } from './lib/money/ledger'
import {
  EARN_RULES,
  POINTS,
  REDEMPTION,
  canRedeem,
  earn,
  redeem,
  standingFor,
  worthInMinorUnits,
  type EarnReason,
} from './lib/money/points'

const { SELECT, INSERT } = cds.ql

const TRANSFERS = 'twowaymatch.LedgerTransfers'
const POSTINGS = 'twowaymatch.LedgerPostings'
const AWARDS = 'twowaymatch.PointsAwards'
const GROUPS = 'twowaymatch.Groups'
const MEMBERSHIPS = 'twowaymatch.Memberships'

const LOG = cds.log('wallet')

/** The currency a conversion is denominated in. One deployment, one currency, for now. */
const CURRENCY = 'CHF'

function one<T>(row: unknown): T | null {
  return (row ?? null) as T | null
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Write a balanced transfer, once.
 *
 * The idempotency key is unique in the database, so two concurrent attempts race and exactly
 * one wins. The loser catches a constraint violation and returns `false` — which is not a
 * failure to report but the correct answer to "did I write it": somebody did.
 */
export async function post(movement: Transfer): Promise<boolean> {
  if (!proves(movement.postings)) {
    // Unreachable — `postings()` refuses an unbalanced movement at construction. Checked
    // again here because this is the last point before it becomes durable, and a bug that
    // got past the first check must not become a row.
    LOG.error('refused an unbalanced transfer', movement.idempotencyKey)
    return false
  }

  const existing = one<{ ID?: string }>(
    await SELECT.one
      .from(TRANSFERS)
      .columns('ID')
      .where({ idempotencyKey: movement.idempotencyKey }),
  )
  if (existing !== null) return false

  const ID = cds.utils.uuid()
  try {
    await INSERT.into(TRANSFERS).entries({
      ID,
      idempotencyKey: movement.idempotencyKey,
      reason: movement.reason,
    })
    await INSERT.into(POSTINGS).entries(
      movement.postings.map(posting => ({
        ID: cds.utils.uuid(),
        transfer_ID: ID,
        account: posting.account,
        amount: posting.amount,
        currency: posting.currency,
      })),
    )
    return true
  } catch (error) {
    // The unique index did its job: another request wrote this movement between the read
    // above and the insert. Nothing to repair.
    LOG.debug('transfer already written:', movement.idempotencyKey, String(error))
    return false
  }
}

/**
 * Award points for an act.
 *
 * Exported because the `after` handlers that observe acts live in `srv/server.ts`, where the
 * services are already served. Takes a reason from the fixed list and an event key; there is
 * no parameter through which an amount could be passed.
 */
export async function award(input: {
  groupId: string
  reason: EarnReason
  eventKey: string
}): Promise<number> {
  const alreadyToday = (await SELECT.from(AWARDS)
    .columns('ID')
    .where({ group_ID: input.groupId, reason: input.reason, onDate: today() })) as unknown[]

  const minted = earn({
    groupId: input.groupId,
    reason: input.reason,
    alreadyToday: alreadyToday.length,
    eventKey: input.eventKey,
  })
  // Null is the daily cap, which is an ordinary outcome and not an error: the act happened,
  // it simply earns nothing more today.
  if (minted === null) return 0

  const written = await post(minted)
  if (!written) return 0

  await INSERT.into(AWARDS).entries({
    ID: cds.utils.uuid(),
    group_ID: input.groupId,
    reason: input.reason,
    eventKey: input.eventKey,
    points: EARN_RULES[input.reason].points,
    onDate: today(),
  })
  return EARN_RULES[input.reason].points
}

export default class WalletService extends cds.ApplicationService {
  /** `onX`, for the reason spelled out in `commons-service.ts`. */
  override async init(): Promise<void> {
    this.on('wallet', req => this.onWallet(req))
    this.on('waysToEarn', req => this.onWaysToEarn(req))
    this.on('previewConversion', req => this.onPreviewConversion(req))
    this.on('convertPoints', req => this.onConvertPoints(req))
    await super.init()
  }

  /* --------------------------------------------------------------- identity */

  /** The same resolution as every other service. See `payments-service.ts`. */
  private async scope(req: Request): Promise<string> {
    const cookie = req.headers?.cookie
    const claimed = verifySessionToken(
      readSessionToken(typeof cookie === 'string' ? cookie : undefined),
    )
    if (claimed?.groupId) return claimed.groupId

    if (claimed?.userId) {
      const mine = (await SELECT.from(MEMBERSHIPS)
        .columns('group_ID')
        .where({ user_ID: claimed.userId })) as Array<{ group_ID?: string | null }>
      if (mine.length === 1 && mine[0]?.group_ID) return String(mine[0].group_ID)
    }

    const fallback = one<{ ID?: string }>(
      await SELECT.one.from(GROUPS).columns('ID').where({ isDefault: true }),
    )
    if (fallback?.ID) return String(fallback.ID)

    return req.reject(403, 'This request is not attached to a household.')
  }

  /* ---------------------------------------------------------------- reading */

  /**
   * The balance, by summing postings.
   *
   * Deliberately `SELECT sum(amount)` rather than reading rows and adding them in JavaScript:
   * a household with ten thousand postings would otherwise pull ten thousand rows over the
   * wire to produce one number, and the database adds integers considerably faster than we
   * do. It also keeps the whole answer inside one statement, so it cannot be read halfway
   * through somebody else's transfer.
   */
  private async balance(groupId: string): Promise<number> {
    const account = accountId('household', groupId)
    const summed = one<{ total?: number | string | null }>(
      await SELECT.one
        .from(POSTINGS)
        .columns({ func: 'sum', args: [{ ref: ['amount'] }], as: 'total' })
        .where({ account, currency: POINTS }),
    )
    return Number(summed?.total ?? 0)
  }

  /** Everything ever earned, so the screen can show a number that only goes up. */
  private async earnedEver(groupId: string): Promise<number> {
    const summed = one<{ total?: number | string | null }>(
      await SELECT.one
        .from(AWARDS)
        .columns({ func: 'sum', args: [{ ref: ['points'] }], as: 'total' })
        .where({ group_ID: groupId }),
    )
    return Number(summed?.total ?? 0)
  }

  private async onWallet(req: Request): Promise<Record<string, unknown>> {
    const groupId = await this.scope(req)
    const account = accountId('household', groupId)

    const [balance, earned] = await Promise.all([this.balance(groupId), this.earnedEver(groupId)])
    const standing = standingFor(balance)

    const recent = (await SELECT.from(POSTINGS)
      .columns('amount', 'at', 'transfer_ID')
      .where({ account, currency: POINTS })
      .orderBy('at desc')
      .limit(20)) as Array<{ amount: number; at: string; transfer_ID: string }>

    // One read for the labels rather than one per row.
    const ids = [...new Set(recent.map(row => row.transfer_ID))]
    const reasons = new Map<string, string>()
    if (ids.length > 0) {
      const rows = (await SELECT.from(TRANSFERS)
        .columns('ID', 'reason')
        .where({ ID: { in: ids } })) as Array<{ ID: string; reason: string | null }>
      for (const row of rows) reasons.set(row.ID, row.reason ?? '')
    }

    return {
      balance,
      earned,
      worth: worthInMinorUnits(Math.max(0, balance)),
      currency: CURRENCY,
      standing: standing.name,
      nextStanding: standing.next,
      into: standing.into,
      minimum: REDEMPTION.minimumPoints,
      rate: REDEMPTION.rate,
      // Honest rather than hopeful: converting to cash needs something that can pay, and
      // this deployment has nothing that can. The screen says so instead of offering a
      // button that fails.
      canConvert: false,
      cannotConvert:
        'Converting points to money needs a licensed payment partner, which this ' +
        'deployment does not have yet. Points still count, and nothing is lost.',
      recent: recent.map(row => ({
        at: row.at,
        reason: reasons.get(row.transfer_ID) ?? '',
        points: Number(row.amount),
      })),
    }
  }

  private async onWaysToEarn(req: Request): Promise<Array<Record<string, unknown>>> {
    const groupId = await this.scope(req)

    const todays = (await SELECT.from(AWARDS)
      .columns('reason')
      .where({ group_ID: groupId, onDate: today() })) as Array<{ reason: string }>

    const used = new Map<string, number>()
    for (const row of todays) used.set(row.reason, (used.get(row.reason) ?? 0) + 1)

    return Object.entries(EARN_RULES).map(([reason, rule]) => ({
      reason,
      label: rule.label,
      points: rule.points,
      perDay: rule.perDay,
      left: Math.max(0, rule.perDay - (used.get(reason) ?? 0)),
    }))
  }

  /* -------------------------------------------------------------- spending */

  private async onPreviewConversion(req: Request): Promise<Record<string, unknown>> {
    const groupId = await this.scope(req)
    const points = Number(req.data.points)
    if (!Number.isInteger(points)) return { ok: false, reason: 'How many points?', value: 0 }

    const check = canRedeem({
      points,
      balance: await this.balance(groupId),
      cashedOutThisYear: 0,
    })
    return { ok: check.ok, reason: check.reason ?? '', value: check.value ?? 0 }
  }

  private async onConvertPoints(req: Request): Promise<Record<string, unknown>> {
    const groupId = await this.scope(req)
    const points = Number(req.data.points)
    const balance = await this.balance(groupId)

    const check = canRedeem({ points, balance, cashedOutThisYear: 0 })
    if (!check.ok) {
      return { ok: false, reason: check.reason ?? '', value: 0, balance }
    }

    // The key is what makes a double-tap safe. Same household, same points, same minute
    // resolves to one movement.
    const eventKey = `${groupId}:${points}:${new Date().toISOString().slice(0, 16)}`
    const written = await post(redeem({ groupId, points, eventKey }))

    const after = await this.balance(groupId)
    return {
      ok: written,
      reason: written ? '' : 'That conversion has already been made.',
      value: check.value ?? 0,
      balance: after,
    }
  }
}

/**
 * Attach the awards to the acts.
 *
 * Registered on `served` rather than inside a service's `init`, because it reaches across
 * services and every one of them has to exist first. Each handler is an `after`, so a failed
 * act pays nothing, and each derives the household from the request rather than the payload.
 *
 * Every award is wrapped: a failure to mint points must never fail the act that earned them.
 * Somebody rating a place cares that the rating was saved; the points are a bonus, and an
 * exception from this file turning into a 500 on their rating would be an absurd trade.
 */
export function attachAwards(services: { commons?: Service; ledger?: Service }): void {
  const groupOf = async (req: Request): Promise<string | null> => {
    const cookie = req.headers?.cookie
    const claimed = verifySessionToken(
      readSessionToken(typeof cookie === 'string' ? cookie : undefined),
    )
    if (claimed?.groupId) return claimed.groupId
    const fallback = one<{ ID?: string }>(
      await SELECT.one.from(GROUPS).columns('ID').where({ isDefault: true }),
    )
    return fallback?.ID ? String(fallback.ID) : null
  }

  const pay = (reason: EarnReason, key: (req: Request) => string) => {
    return async (_result: unknown, req: Request): Promise<void> => {
      try {
        const groupId = await groupOf(req)
        if (groupId === null) return
        await award({ groupId, reason, eventKey: `${groupId}:${key(req)}` })
      } catch (error) {
        LOG.warn('could not award points for', reason, String(error))
      }
    }
  }

  const commons = services.commons
  if (commons !== undefined) {
    commons.after(
      'rate',
      pay('placeRated', req => `rate:${String(req.data.placeID ?? '')}`),
    )
  }

  const ledger = services.ledger
  if (ledger !== undefined) {
    ledger.after(
      'confirmExpense',
      pay('expenseConfirmed', req => `expense:${String(req.data.ID ?? '')}`),
    )
  }
}
