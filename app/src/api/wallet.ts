/**
 * The wallet and payments client — CONTRACTS.md §16, §17.
 *
 * A third service root, and a third client, for the same reason `commons.ts` is separate
 * from `client.ts`: these two services have rules the ledger does not, and a client that
 * could reach all three is one refactor away from mixing them up.
 *
 * ## The rule this file exists to keep
 *
 * **Nothing here ever sends a card number, and there is no function that could.** Card
 * details go from the provider's own fields straight to the provider; this client only ever
 * carries a *setup reference* and, coming back, a token that is useless to anybody without
 * the server's secret key. If a future change seems to need a `number` argument on one of
 * these calls, the change is wrong — see ADR-004 §3.
 *
 * The server sweeps every payload it receives for anything card-shaped and refuses it, so a
 * mistake here fails loudly rather than quietly. That is the belt; this file is the braces.
 */

const PAYMENTS = '/api/payments'
const WALLET = '/api/wallet'

export interface SavedCard {
  ID: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
  issuer: string | null
  country: string | null
  authenticated: boolean
  label: string | null
  isDefault: boolean
  createdAt: string
}

export interface StartedSetup {
  ref: string
  clientSecret: string
  provider: string
  publishableKey: string
}

export interface SetupResult {
  status: 'pending' | 'succeeded' | 'declined'
  cardID: string | null
  brand: string | null
  last4: string | null
  reason: string | null
  duplicate: boolean
}

export interface MockScenario {
  id: string
  label: string
  detail: string
  brand: string
  last4: string
}

export interface PointsEntry {
  at: string
  reason: string
  points: number
}

export interface Wallet {
  balance: number
  earned: number
  worth: number
  currency: string
  standing: string
  nextStanding: number | null
  into: number
  minimum: number
  rate: number
  canConvert: boolean
  cannotConvert: string
  recent: PointsEntry[]
}

export interface EarnWay {
  reason: string
  label: string
  points: number
  perDay: number
  left: number
}

export class WalletError extends Error {}

async function unwrap(response: Response): Promise<unknown> {
  const text = await response.text()
  const body: unknown = text.length === 0 ? null : JSON.parse(text)

  if (!response.ok) {
    // CAP's message is written for a person — "Your bank declined this card." — so it is
    // safe to show verbatim, which matters more here than anywhere else in the app: a
    // payment failure is one of the few errors somebody can actually act on.
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { message?: string } }).error
        : undefined
    throw new WalletError(error?.message ?? `Request failed (${response.status})`)
  }
  return body
}

async function get(base: string, path: string): Promise<unknown> {
  return unwrap(
    await fetch(`${base}/${path}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    }),
  )
}

async function post(base: string, name: string, body: unknown = {}): Promise<unknown> {
  return unwrap(
    await fetch(`${base}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }),
  )
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as { value?: unknown }).value
    return Array.isArray(inner) ? inner : []
  }
  return []
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toCard(row: unknown): SavedCard {
  const one = (row ?? {}) as Record<string, unknown>
  return {
    ID: String(one.ID ?? ''),
    brand: String(one.brand ?? 'unknown'),
    last4: String(one.last4 ?? '••••'),
    expMonth: num(one.expMonth),
    expYear: num(one.expYear),
    issuer: str(one.issuer),
    country: str(one.country),
    authenticated: one.authenticated === true,
    label: str(one.label),
    isDefault: one.isDefault === true,
    createdAt: String(one.createdAt ?? ''),
  }
}

export const wallet = {
  /* ------------------------------------------------------------------ cards */

  async cards(): Promise<SavedCard[]> {
    return list(await get(PAYMENTS, 'Cards?$orderby=createdAt desc')).map(toCard)
  },

  /**
   * Open a setup.
   *
   * `label` is the household's own nickname for the card. It is explicitly not the
   * cardholder's name and must never be collected as one.
   */
  async startCardSetup(label: string | null): Promise<StartedSetup> {
    const body = (await post(PAYMENTS, 'startCardSetup', { label })) as Record<string, unknown>
    return {
      ref: String(body.ref ?? ''),
      clientSecret: String(body.clientSecret ?? ''),
      provider: String(body.provider ?? 'mock'),
      publishableKey: String(body.publishableKey ?? ''),
    }
  },

  async finishCardSetup(ref: string): Promise<SetupResult> {
    const body = (await post(PAYMENTS, 'finishCardSetup', { ref })) as Record<string, unknown>
    const status = String(body.status ?? 'pending')
    return {
      status: status === 'succeeded' || status === 'declined' ? status : 'pending',
      cardID: str(body.cardID),
      brand: str(body.brand),
      last4: str(body.last4),
      reason: str(body.reason),
      duplicate: body.duplicate === true,
    }
  },

  /**
   * The mock vault's scenarios.
   *
   * An empty array means a real provider is configured. There is deliberately no separate
   * "are we mocking" flag — one signal cannot get out of step with itself.
   */
  async mockScenarios(): Promise<MockScenario[]> {
    return list(await get(PAYMENTS, 'mockScenarios()')).map(row => {
      const one = (row ?? {}) as Record<string, unknown>
      return {
        id: String(one.id ?? ''),
        label: String(one.label ?? ''),
        detail: String(one.detail ?? ''),
        brand: String(one.brand ?? 'unknown'),
        last4: String(one.last4 ?? '••••'),
      }
    })
  },

  async chooseMockScenario(ref: string, scenario: string): Promise<void> {
    await post(PAYMENTS, 'chooseMockScenario', { ref, scenario })
  },

  async renameCard(ID: string, label: string): Promise<void> {
    await post(PAYMENTS, 'renameCard', { ID, label })
  },

  async makeDefaultCard(ID: string): Promise<void> {
    await post(PAYMENTS, 'makeDefaultCard', { ID })
  },

  async forgetCard(ID: string): Promise<void> {
    await post(PAYMENTS, 'forgetCard', { ID })
  },

  /* ----------------------------------------------------------------- points */

  async wallet(): Promise<Wallet> {
    const body = (await get(WALLET, 'wallet()')) as Record<string, unknown>
    return {
      balance: num(body.balance),
      earned: num(body.earned),
      worth: num(body.worth),
      currency: String(body.currency ?? 'CHF'),
      standing: String(body.standing ?? ''),
      nextStanding: body.nextStanding === null ? null : num(body.nextStanding),
      // `into` is Decimal(5,4) and therefore arrives as a string, like every other decimal
      // in this app. See the note at the top of `client.ts`.
      into: num(body.into),
      minimum: num(body.minimum),
      rate: num(body.rate, 1),
      canConvert: body.canConvert === true,
      cannotConvert: String(body.cannotConvert ?? ''),
      recent: list(body.recent).map(row => {
        const one = (row ?? {}) as Record<string, unknown>
        return {
          at: String(one.at ?? ''),
          reason: String(one.reason ?? ''),
          points: num(one.points),
        }
      }),
    }
  },

  async waysToEarn(): Promise<EarnWay[]> {
    return list(await get(WALLET, 'waysToEarn()')).map(row => {
      const one = (row ?? {}) as Record<string, unknown>
      return {
        reason: String(one.reason ?? ''),
        label: String(one.label ?? ''),
        points: num(one.points),
        perDay: num(one.perDay),
        left: num(one.left),
      }
    })
  },
}
