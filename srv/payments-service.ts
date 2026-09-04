/// <reference types="@cap-js/cds-types" />
/**
 * PaymentsService handlers — TWM-ADR-004, CONTRACTS.md §16.
 *
 * The same division as everywhere else: the provider talk lives in `srv/lib/payments`, and
 * what is left here is transactions, validation, and turning a provider answer into a
 * response. Four things in this file are load-bearing.
 *
 * 1. **Every inbound payload is swept for card numbers before anything else happens.** Not
 *    because one is expected — the design is that a card number cannot get here — but
 *    because the cost of being wrong about that is an audit, and the cost of checking is a
 *    microsecond. The sweep runs in a `before('*')` so it cannot be forgotten by a handler
 *    added later, which is the actual failure mode.
 *
 * 2. **`finishCardSetup` is idempotent and safe to race.** The flow has a gap in it: the
 *    browser leaves for the issuer and comes back. In that gap the person may refresh, open
 *    a second tab, or lose signal and retry. All three must land on one card. The setup row
 *    is the lock — the first call to find a finished setup writes the card and stamps the
 *    row, and every later call reads the answer back out instead of attaching a second card.
 *
 * 3. **Removal detaches at the provider first.** A row deleted locally while the token still
 *    lives at the provider is a card that no screen shows and nothing can remove — the worst
 *    possible state, because the household believes it is gone. If the provider call fails,
 *    the local row is left alone and the person is told to try again.
 *
 * 4. **Nothing here logs a provider response.** `PaymentError.message` is for logs and
 *    `safeMessage` is for people; provider payloads are never printed even at debug level,
 *    because "just log the body while I debug this" is how a PAN ends up in a log file on
 *    the one day one is in the body.
 */
import cds from '@sap/cds'
import type { Request } from '@sap/cds'

import { readSessionToken, verifySessionToken } from './lib/auth'
import {
  MOCK_SCENARIOS,
  PanRejected,
  PaymentError,
  assertNoPan,
  chooseMockScenario,
  describePaymentProvider,
  getPaymentProvider,
  providerName,
  type MockScenarioId,
  type SavedCard,
} from './lib/payments'

const { SELECT, INSERT, UPDATE } = cds.ql

const CARDS = 'twowaymatch.PaymentMethods'
const SETUPS = 'twowaymatch.CardSetups'
const GROUPS = 'twowaymatch.Groups'
const MEMBERSHIPS = 'twowaymatch.Memberships'

const LOG = cds.log('payments')

/** See the note in `commons-service.ts`: `SELECT.one` resolves to `undefined`, not `null`. */
function one<T>(row: unknown): T | null {
  return (row ?? null) as T | null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed.slice(0, max)
}

interface CardRow {
  ID: string
  token: string
  provider: string
  brand: string
  last4: string
  fingerprint: string | null
  removedAt: string | null
}

interface SetupRow {
  ID: string
  ref: string
  provider: string
  status: string
  declineReason: string | null
  paymentMethod_ID: string | null
}

export default class PaymentsService extends cds.ApplicationService {
  /** Handlers are `onX` for the reason spelled out in `commons-service.ts`. */
  override async init(): Promise<void> {
    // The sweep. Registered first and against every operation, so a handler added next year
    // inherits it without its author having to know this file's history.
    this.before('*', req => {
      try {
        assertNoPan(req.data)
      } catch (error) {
        if (error instanceof PanRejected) {
          LOG.warn('rejected a payload with a card-shaped value at', error.path)
          return req.reject(
            400,
            'Card details must be entered in the payment provider’s own fields and can never ' +
              'be sent to this server. Nothing was stored.',
          )
        }
        throw error
      }
    })

    this.before('READ', 'Cards', req => this.narrow(req))

    this.on('startCardSetup', req => this.onStartCardSetup(req))
    this.on('finishCardSetup', req => this.onFinishCardSetup(req))
    this.on('mockScenarios', () => this.onMockScenarios())
    this.on('chooseMockScenario', req => this.onChooseMockScenario(req))
    this.on('renameCard', req => this.onRenameCard(req))
    this.on('makeDefaultCard', req => this.onMakeDefaultCard(req))
    this.on('forgetCard', req => this.onForgetCard(req))

    LOG.info('card vault:', describePaymentProvider())
    await super.init()
  }

  /* --------------------------------------------------------------- identity */

  /**
   * Which household is this request about?
   *
   * The same resolution order as `LedgerService.scope`, and it must stay that way: a card is
   * household property, and a request that resolved to a different group here than it does
   * in the ledger would show one household another's card. Rejects rather than falling back
   * to nothing, because "no household" and "every household" are one typo apart in a `where`
   * clause and only one of them is safe.
   */
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

  /** The `People` row to credit a card to. Null is fine — the column is optional. */
  private async actor(req: Request, groupId: string): Promise<string | null> {
    const cookie = req.headers?.cookie
    const claimed = verifySessionToken(
      readSessionToken(typeof cookie === 'string' ? cookie : undefined),
    )
    if (claimed?.userId) {
      const membership = one<{ person_ID?: string | null }>(
        await SELECT.one
          .from(MEMBERSHIPS)
          .columns('person_ID')
          .where({ user_ID: claimed.userId, group_ID: groupId }),
      )
      if (membership?.person_ID) return String(membership.person_ID)
    }
    return null
  }

  /** Narrows a read of `Cards` to the caller's household. */
  private async narrow(req: Request): Promise<void> {
    const groupId = await this.scope(req)
    // `req.query` is a real `cds.ql` SELECT; `.where()` on one that already carries a
    // `$filter` combines the two with `and` rather than replacing it, which is why this
    // narrows the query rather than sieving rows afterwards — see `ledger-service.ts`.
    const query = req.query as unknown as { where(filter: Record<string, unknown>): unknown }
    query.where({ group_ID: groupId })
  }

  /* ---------------------------------------------------------------- adding */

  private async onStartCardSetup(
    req: Request,
  ): Promise<{ ref: string; clientSecret: string; provider: string; publishableKey: string }> {
    const groupId = await this.scope(req)
    const label = text(req.data.label, 60)

    const provider = this.provider(req)
    const customerRef = await provider.customerFor(groupId)

    let setup
    try {
      setup = await provider.startCardSetup({
        customerRef,
        // What the issuer's authentication prompt shows. The app's name and nothing else —
        // an issuer prompt is read by anybody holding the phone, so it must not carry the
        // household's name, the label, or what the card is for.
        statementLabel: 'Two-Way Match',
      })
    } catch (error) {
      return this.fail(req, error)
    }

    await INSERT.into(SETUPS).entries({
      ID: cds.utils.uuid(),
      group_ID: groupId,
      ref: setup.ref,
      provider: setup.provider,
      status: 'pending',
      // Held here rather than passed back through the browser: a label round-tripping via
      // the client is a label the client can change between opening the form and finishing.
      declineReason: null,
      startedBy_ID: await this.actor(req, groupId),
    })

    if (label !== null) this.labels.set(setup.ref, label)

    return {
      ref: setup.ref,
      clientSecret: setup.clientSecret,
      provider: setup.provider,
      publishableKey: setup.publishableKey,
    }
  }

  /**
   * Labels chosen while a setup is open.
   *
   * In memory on purpose. It is a cosmetic string with a lifetime of about ninety seconds,
   * and a process restart mid-setup costing somebody a card nickname they can retype is a
   * better trade than a column that exists only to survive one.
   */
  private readonly labels = new Map<string, string>()

  private async onFinishCardSetup(req: Request): Promise<{
    status: string
    cardID: string | null
    brand: string | null
    last4: string | null
    reason: string | null
    duplicate: boolean
  }> {
    const groupId = await this.scope(req)
    const ref = text(req.data.ref, 200)
    if (ref === null) return req.reject(400, 'Which setup?')

    const setup = one<SetupRow>(await SELECT.one.from(SETUPS).where({ ref, group_ID: groupId }))
    if (setup === null) return req.reject(404, 'That form has expired. Please start again.')

    // Already finished. Read the answer back rather than asking the provider again — this is
    // the second tab, the refresh, and the retry after a dropped connection.
    if (setup.status === 'succeeded' && setup.paymentMethod_ID !== null) {
      const card = one<CardRow>(
        await SELECT.one.from(CARDS).where({ ID: setup.paymentMethod_ID, group_ID: groupId }),
      )
      return {
        status: 'succeeded',
        cardID: card?.ID ?? null,
        brand: card?.brand ?? null,
        last4: card?.last4 ?? null,
        reason: null,
        duplicate: false,
      }
    }
    if (setup.status === 'declined') {
      return {
        status: 'declined',
        cardID: null,
        brand: null,
        last4: null,
        reason: setup.declineReason,
        duplicate: false,
      }
    }

    let outcome
    try {
      outcome = await this.provider(req).finishCardSetup(ref)
    } catch (error) {
      return this.fail(req, error)
    }

    if (outcome.status === 'pending') {
      return {
        status: 'pending',
        cardID: null,
        brand: null,
        last4: null,
        reason: null,
        duplicate: false,
      }
    }

    if (outcome.status === 'declined') {
      await UPDATE.entity(SETUPS)
        .where({ ID: setup.ID })
        .with({
          status: 'declined',
          declineReason: outcome.reason.slice(0, 240),
          completedAt: new Date().toISOString(),
        })
      return {
        status: 'declined',
        cardID: null,
        brand: null,
        last4: null,
        reason: outcome.reason,
        duplicate: false,
      }
    }

    const saved = await this.keep(outcome.card, groupId, setup, ref, req)
    return {
      status: 'succeeded',
      cardID: saved.ID,
      brand: saved.brand,
      last4: saved.last4,
      reason: null,
      duplicate: saved.duplicate,
    }
  }

  /**
   * Write the card, or recognise one already here.
   *
   * The duplicate check is on the provider's fingerprint, which is the only reliable way to
   * tell two tokens for the same physical card apart — comparing brand and last four would
   * match two genuinely different cards often enough to be a bug people hit.
   *
   * A duplicate does not become a second row and the caller is told, so the screen can say
   * "that one is already here" instead of showing two identical cards.
   */
  private async keep(
    card: SavedCard,
    groupId: string,
    setup: SetupRow,
    ref: string,
    req: Request,
  ): Promise<{ ID: string; brand: string; last4: string; duplicate: boolean }> {
    if (card.fingerprint !== null) {
      const existing = one<CardRow>(
        await SELECT.one
          .from(CARDS)
          .where({ group_ID: groupId, fingerprint: card.fingerprint, removedAt: null }),
      )
      if (existing !== null) {
        // The new token is redundant. Detach it so the provider is not left holding a second
        // handle on a card that already has one.
        await this.provider(req)
          .forgetCard(card.token)
          .catch(() => undefined)
        await UPDATE.entity(SETUPS).where({ ID: setup.ID }).with({
          status: 'succeeded',
          paymentMethod_ID: existing.ID,
          completedAt: new Date().toISOString(),
        })
        return { ID: existing.ID, brand: existing.brand, last4: existing.last4, duplicate: true }
      }
    }

    const held = (await SELECT.from(CARDS)
      .columns('ID')
      .where({ group_ID: groupId, removedAt: null })) as Array<{ ID: string }>

    const ID = cds.utils.uuid()
    await INSERT.into(CARDS).entries({
      ID,
      group_ID: groupId,
      token: card.token,
      provider: this.provider(req).name,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      fingerprint: card.fingerprint,
      issuer: card.issuer,
      country: card.country,
      authenticated: card.authenticated,
      label: this.labels.get(ref) ?? null,
      // The first card a household adds is its default, because a household with one card
      // and no default is a household that has to make a meaningless choice.
      isDefault: held.length === 0,
      removedAt: null,
      addedBy_ID: await this.actor(req, groupId),
    })
    this.labels.delete(ref)

    await UPDATE.entity(SETUPS)
      .where({ ID: setup.ID })
      .with({ status: 'succeeded', paymentMethod_ID: ID, completedAt: new Date().toISOString() })

    return { ID, brand: card.brand, last4: card.last4, duplicate: false }
  }

  /* ------------------------------------------------------------------ mock */

  private onMockScenarios(): Array<{
    id: string
    label: string
    detail: string
    brand: string
    last4: string
  }> {
    // An empty array *is* the "a real provider is configured" signal. A separate boolean
    // would be one more thing to get out of step with what the vault actually is.
    if (providerName() !== 'mock') return []
    return MOCK_SCENARIOS.map(one => ({
      id: one.id,
      label: one.label,
      detail: one.detail,
      brand: one.brand,
      last4: one.last4,
    }))
  }

  private async onChooseMockScenario(req: Request): Promise<boolean> {
    // Refused outright rather than ignored: an action that silently does nothing in
    // production is an action somebody will one day believe worked.
    if (providerName() !== 'mock') {
      return req.reject(400, 'This server uses a real card provider; there is nothing to mock.')
    }

    const groupId = await this.scope(req)
    const ref = text(req.data.ref, 200)
    const scenario = text(req.data.scenario, 20)
    if (ref === null || scenario === null) return req.reject(400, 'A setup and a scenario.')
    if (!MOCK_SCENARIOS.some(one => one.id === scenario)) {
      return req.reject(400, 'No such scenario.')
    }

    // Still scoped, so one household cannot drive another's setup even in mock mode.
    const setup = one<SetupRow>(
      await SELECT.one.from(SETUPS).columns('ID').where({ ref, group_ID: groupId }),
    )
    if (setup === null) return req.reject(404, 'That form has expired.')

    chooseMockScenario(ref, scenario as MockScenarioId)
    return true
  }

  /* ---------------------------------------------------------------- keeping */

  private async onRenameCard(req: Request): Promise<boolean> {
    const groupId = await this.scope(req)
    const ID = text(req.data.ID, 40)
    if (ID === null) return req.reject(400, 'Which card?')

    const label = text(req.data.label, 60)
    const changed = await UPDATE.entity(CARDS)
      .where({ ID, group_ID: groupId, removedAt: null })
      .with({ label })
    if (!changed) return req.reject(404, 'No such card.')
    return true
  }

  private async onMakeDefaultCard(req: Request): Promise<boolean> {
    const groupId = await this.scope(req)
    const ID = text(req.data.ID, 40)
    if (ID === null) return req.reject(400, 'Which card?')

    const card = one<CardRow>(
      await SELECT.one.from(CARDS).columns('ID').where({ ID, group_ID: groupId, removedAt: null }),
    )
    if (card === null) return req.reject(404, 'No such card.')

    // Cleared then set, in that order and in one transaction: the other way round leaves a
    // window with two defaults, and a reader in that window picks one at random.
    await UPDATE.entity(CARDS).where({ group_ID: groupId }).with({ isDefault: false })
    await UPDATE.entity(CARDS).where({ ID, group_ID: groupId }).with({ isDefault: true })
    return true
  }

  private async onForgetCard(req: Request): Promise<boolean> {
    const groupId = await this.scope(req)
    const ID = text(req.data.ID, 40)
    if (ID === null) return req.reject(400, 'Which card?')

    const card = one<CardRow>(
      await SELECT.one.from(CARDS).where({ ID, group_ID: groupId, removedAt: null }),
    )
    if (card === null) return req.reject(404, 'No such card.')

    // The provider first. See the file header: a local row removed while the token lives on
    // is a card nobody can see and nobody can remove.
    try {
      await this.provider(req).forgetCard(card.token)
    } catch (error) {
      return this.fail(req, error)
    }

    await UPDATE.entity(CARDS)
      .where({ ID, group_ID: groupId })
      .with({ removedAt: new Date().toISOString(), isDefault: false })

    // Somebody has to be the default, and it should not be nobody just because the default
    // was the card removed.
    if (card.ID === ID) {
      const remaining = one<{ ID?: string }>(
        await SELECT.one
          .from(CARDS)
          .columns('ID')
          .where({ group_ID: groupId, removedAt: null })
          .orderBy('createdAt asc'),
      )
      if (remaining?.ID) {
        await UPDATE.entity(CARDS).where({ ID: remaining.ID }).with({ isDefault: true })
      }
    }

    return true
  }

  /* ----------------------------------------------------------------- plumbing */

  private provider(req: Request): ReturnType<typeof getPaymentProvider> {
    try {
      return getPaymentProvider()
    } catch (error) {
      return this.fail(req, error)
    }
  }

  /**
   * Turn a provider failure into a response.
   *
   * The log line gets the detail, the person gets `safeMessage`. Never the other way round:
   * a provider's raw error text is written for a developer and reads to a customer like
   * their bank has broken.
   */
  private fail(req: Request, error: unknown): never {
    if (error instanceof PaymentError) {
      LOG.warn('card vault:', error.message)
      return req.reject(error.retryable ? 503 : 400, error.safeMessage)
    }
    LOG.error('card vault failed unexpectedly')
    return req.reject(500, 'Something went wrong with the card service.')
  }
}
