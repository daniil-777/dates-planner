/**
 * The mock card vault — CONTRACTS.md §16.3.
 *
 * The same bargain as the Document AI mock: the entire flow — adding a card, an issuer
 * challenge, a decline, a duplicate, removing a card — is developable and testable with no
 * account, no keys and no network. Without it, the payments screen is unreachable on a
 * laptop, which means it is untested, which means it is broken.
 *
 * ## The part worth copying: there is nothing to type
 *
 * Most mock payment forms render real-looking card fields and accept `4242…`. That is a
 * loaded gun in the repository. The field exists, it posts to our own server, and the only
 * thing standing between it and a real card number is that the person using it read the
 * placeholder text. People do not read placeholder text, and the person who eventually types
 * a real card into a dev form is usually the one demoing to somebody.
 *
 * So this mock has **no card entry at all**. It offers a short list of *scenarios* — a card
 * that works, one that needs the issuer's approval, one that is declined, one already on
 * file — and the front end renders them as buttons. There is no input to put a PAN into,
 * which means no PAN can reach the server by accident, which means the guard in `pan.ts`
 * never has to be the last line of defence in development.
 *
 * It also happens to be *better* for testing than typing numbers: every branch including
 * "your bank said no" is one tap away, and the awkward ones are usually the untested ones.
 *
 * ## Fidelity
 *
 * Setups live in memory and die with the process, which is correct — a setup is short-lived
 * at every real provider too. Cards, once attached, are held per customer so that duplicate
 * detection and removal behave; that is deliberately *not* persisted either, because a mock
 * card surviving a restart while the row referencing it also survives is a state real life
 * cannot produce, and debugging an impossible state is a waste of an afternoon.
 */
import { randomUUID } from 'node:crypto'

import {
  PaymentError,
  type CardSetup,
  type CardSetupOutcome,
  type CardSetupRequest,
  type PaymentProvider,
  type SavedCard,
} from './types'

/**
 * What the mock can be asked to do.
 *
 * Chosen to cover the four outcomes that behave differently downstream, not to be a
 * catalogue of card schemes.
 */
export const MOCK_SCENARIOS = [
  {
    id: 'succeeds',
    label: 'A card that works',
    detail: 'Attaches immediately, no challenge.',
    brand: 'visa',
    last4: '4242',
    issuer: 'Bank of Elsewhere',
  },
  {
    id: 'authenticates',
    label: 'Needs your bank’s approval',
    detail: 'One round of strong customer authentication, then succeeds.',
    brand: 'mastercard',
    last4: '3220',
    issuer: 'Second Northern',
  },
  {
    id: 'declined',
    label: 'Declined by the issuer',
    detail: 'The bank refuses the setup. Nothing is stored.',
    brand: 'visa',
    last4: '0002',
    issuer: 'Bank of Elsewhere',
  },
  {
    id: 'duplicate',
    label: 'A card already on file',
    detail: 'Same fingerprint as “a card that works”, to exercise duplicate handling.',
    brand: 'visa',
    last4: '4242',
    issuer: 'Bank of Elsewhere',
  },
] as const

export type MockScenarioId = (typeof MOCK_SCENARIOS)[number]['id']

/** How long the mock pretends an issuer challenge takes. Enough to see the spinner. */
export const MOCK_CHALLENGE_MS = 900

interface MockSetup {
  ref: string
  customerRef: string
  /** Null until the front end chooses one. */
  scenario: MockScenarioId | null
  /** When an `authenticates` scenario stops being pending. */
  clearsAt: number | null
}

const setups = new Map<string, MockSetup>()
const cards = new Map<string, SavedCard[]>()
const customers = new Map<string, string>()

/** Test suites share a process; each case wants an empty vault. */
export function resetMockVault(): void {
  setups.clear()
  cards.clear()
  customers.clear()
}

/** Read by the payments service so the front end can render the scenario buttons. */
export function mockCardsOf(customerRef: string): readonly SavedCard[] {
  return cards.get(customerRef) ?? []
}

/**
 * Records which scenario the person tapped.
 *
 * Called only by the mock-only service action, which refuses to exist when a live provider
 * is configured. Splitting it out this way keeps `PaymentProvider` free of a mock-shaped
 * method that a real provider would have to stub.
 */
export function chooseMockScenario(ref: string, scenario: MockScenarioId): void {
  const setup = setups.get(ref)
  if (!setup) throw new PaymentError(`No mock setup ${ref}`, { safeMessage: 'That form expired.' })

  setup.scenario = scenario
  setup.clearsAt = scenario === 'authenticates' ? Date.now() + MOCK_CHALLENGE_MS : Date.now()
}

function cardFor(scenario: MockScenarioId): SavedCard {
  const spec = MOCK_SCENARIOS.find(one => one.id === scenario) ?? MOCK_SCENARIOS[0]
  const now = new Date()
  return {
    token: `pm_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    brand: spec.brand,
    last4: spec.last4,
    expMonth: 11,
    // Always comfortably in the future, so a fixture never starts failing because time passed.
    expYear: now.getUTCFullYear() + 3,
    // `duplicate` deliberately shares the fingerprint of `succeeds`: that is the whole point
    // of it, and it is how the duplicate path gets exercised without a second real card.
    fingerprint: scenario === 'duplicate' ? 'fp_mock_succeeds' : `fp_mock_${scenario}`,
    issuer: spec.issuer,
    country: 'DE',
    authenticated: scenario === 'authenticates',
  }
}

export function createMockProvider(): PaymentProvider {
  return {
    name: 'mock',

    async customerFor(groupId: string): Promise<string> {
      const existing = customers.get(groupId)
      if (existing !== undefined) return existing

      const ref = `cus_mock_${groupId.replace(/-/g, '').slice(0, 16)}`
      customers.set(groupId, ref)
      return ref
    },

    async startCardSetup(request: CardSetupRequest): Promise<CardSetup> {
      const ref = `seti_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      setups.set(ref, {
        ref,
        customerRef: request.customerRef,
        scenario: null,
        clearsAt: null,
      })
      return {
        ref,
        // Deliberately the ref itself. A mock client secret that looked like a real one
        // would invite somebody to try it against a real endpoint.
        clientSecret: ref,
        provider: 'mock',
        publishableKey: '',
      }
    },

    async finishCardSetup(ref: string): Promise<CardSetupOutcome> {
      const setup = setups.get(ref)
      if (!setup) {
        return { status: 'declined', reason: 'That form expired. Please start again.' }
      }
      if (setup.scenario === null) return { status: 'pending' }
      if (setup.clearsAt !== null && Date.now() < setup.clearsAt) return { status: 'pending' }

      if (setup.scenario === 'declined') {
        setups.delete(ref)
        return {
          status: 'declined',
          reason: 'Your bank declined this card. Nothing was saved — try another card.',
        }
      }

      const card = cardFor(setup.scenario)
      const held = cards.get(setup.customerRef) ?? []
      cards.set(setup.customerRef, [...held, card])
      setups.delete(ref)
      return { status: 'succeeded', card }
    },

    async forgetCard(token: string): Promise<void> {
      for (const [customerRef, held] of cards) {
        const left = held.filter(one => one.token !== token)
        if (left.length !== held.length) cards.set(customerRef, left)
      }
      // Deliberately silent when the token is unknown: removing something already gone is
      // the caller getting what they asked for, and every real provider agrees.
    },

    describe(): string {
      return 'Mock vault · no account needed · scenario buttons instead of card fields'
    },
  }
}
