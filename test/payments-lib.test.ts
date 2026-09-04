/**
 * The pure half of payments — the card-number guard, the provider switch, and the mock vault.
 *
 * The guard gets the most attention here by a wide margin, and it is not because it is the
 * most intricate code in the app. It is because it is the one piece whose failure is silent:
 * a broken ranking shows a wrong list, a broken timer shows a wrong number, and a broken PAN
 * guard shows *nothing at all* while card numbers accumulate in a log file. Nobody finds
 * that by using the app. So it is tested against real card numbers from every scheme's
 * published test range, against the near-misses that would make a noisy guard get switched
 * off, and against the shapes a payload actually arrives in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MOCK_SCENARIOS,
  PanRejected,
  PaymentError,
  assertNoPan,
  chooseMockScenario,
  describePaymentProvider,
  getPaymentProvider,
  isExpired,
  looksLikePan,
  paymentsConfigured,
  passesLuhn,
  providerName,
  redactPan,
  resetMockVault,
  toBrand,
} from '../srv/lib/payments'

/**
 * Published test numbers. Every scheme documents these precisely so that they can be written
 * down in files like this one — they are valid Luhn, they belong to no person, and no issuer
 * will ever authorise one.
 */
const TEST_CARDS = {
  visa: '4242424242424242',
  visaDebit: '4000056655665556',
  mastercard: '5555555555554444',
  mastercard2Series: '2223003122003222',
  amex: '378282246310005',
  discover: '6011111111111117',
  diners: '3056930009020004',
  jcb: '3566002020360505',
  unionpay: '6200000000000005',
  visa13: '4222222222222',
}

const env = { ...process.env }

beforeEach(() => {
  resetMockVault()
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_PUBLISHABLE_KEY
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  process.env = { ...env }
})

describe('the Luhn check', () => {
  it('accepts a real card number from every scheme the app draws a face for', () => {
    for (const [scheme, number] of Object.entries(TEST_CARDS)) {
      expect(passesLuhn(number), scheme).toBe(true)
    }
  })

  it('rejects a number one digit out', () => {
    // The whole value of Luhn: a typo is caught, so a guard built on it is not just a
    // length check wearing a hat.
    expect(passesLuhn('4242424242424243')).toBe(false)
  })

  it('rejects anything outside 13–19 digits, which is where cards live', () => {
    expect(passesLuhn('424242424242')).toBe(false) // 12
    expect(passesLuhn('42424242424242424242')).toBe(false) // 20
  })

  it('rejects a string with anything but digits in it', () => {
    expect(passesLuhn('4242-4242-4242-4242')).toBe(false)
  })
})

describe('recognising a card number in a payload', () => {
  it('finds one however a person typed it', () => {
    expect(looksLikePan('4242424242424242')).toBe(true)
    expect(looksLikePan('4242 4242 4242 4242')).toBe(true)
    expect(looksLikePan('4242-4242-4242-4242')).toBe(true)
    expect(looksLikePan('my card is 4242 4242 4242 4242 ok?')).toBe(true)
  })

  it('leaves ordinary long numbers alone', () => {
    // This is the property that decides whether the guard survives contact with production.
    // A guard that flags order numbers and timestamps gets disabled, and a disabled guard
    // protects nothing.
    // Fixed values, every one checked against Luhn by hand.
    //
    // This list used to contain `String(Date.now()) + '000'`, which is a *time-dependent*
    // fixture: about one run in ten produced a timestamp that happens to satisfy Luhn, and
    // the suite failed for no reason anybody could reproduce. It failed on
    // 1788535563967000. A test whose outcome depends on the clock is worse than no test,
    // because it teaches people to re-run until it passes.
    const innocents = [
      'order 1234567890123456',
      'invoice 9999999999999',
      '+41 79 123 45 67',
      'IBAN CH93 0076 2011 6238 5295 7',
      'a'.repeat(40),
      '',
    ]
    for (const value of innocents) {
      expect(looksLikePan(value), value).toBe(false)
    }
  })
})

describe('what the guard admits it will get wrong', () => {
  it('does flag a long number that happens to satisfy Luhn', () => {
    // Stated rather than hidden, because pretending otherwise is what produced a flaky test
    // above. Roughly one in ten random digit runs of card length passes Luhn, so an order
    // number or a millisecond timestamp will occasionally trip this.
    //
    // That is the direction the guard is deliberately wrong in. A false positive costs
    // somebody a rephrased support message; a false negative puts a card number in a log
    // file and every backup taken since. The asymmetry is the whole design.
    expect(looksLikePan('1788535563967000')).toBe(true)
  })

  it('is a shape check, not a card check — it cannot know an issuer', () => {
    // A Luhn-valid string in the right length band is all this can see, and no brand prefix
    // check is applied on purpose: matching `4` for Visa would miss every scheme the app has
    // not heard of, which is the wrong direction to be wrong in.
    expect(looksLikePan('4242424242424242')).toBe(true)
    expect(looksLikePan('0000000000000000')).toBe(true)
  })
})

describe('the sweep over an inbound payload', () => {
  it('passes a payload that carries only what the service actually accepts', () => {
    expect(() =>
      assertNoPan({ ref: 'seti_mock_abc', label: 'the joint one', scenario: 'succeeds' }),
    ).not.toThrow()
  })

  it('throws on a card number wherever it is hidden', () => {
    const hiding = [
      { number: TEST_CARDS.visa },
      { nested: { deeply: { card: TEST_CARDS.amex } } },
      { list: ['fine', TEST_CARDS.mastercard] },
      { note: `please charge ${TEST_CARDS.jcb} thanks` },
    ]
    for (const payload of hiding) {
      expect(() => assertNoPan(payload)).toThrow(PanRejected)
    }
  })

  it('throws when the number is a key rather than a value', () => {
    // How it happens for real: a form pivoted into an object, or a map keyed by whatever the
    // user typed. Checking only values would sail straight past it.
    expect(() => assertNoPan({ [TEST_CARDS.visa]: true })).toThrow(PanRejected)
  })

  it('names where it found one and never quotes what it found', () => {
    // The exception is going to be logged. If it carried the number, this file would be
    // describing the leak rather than preventing it.
    try {
      assertNoPan({ payment: { card: TEST_CARDS.visa } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PanRejected)
      const thrown = error as PanRejected
      expect(thrown.path).toBe('$.payment.card')
      expect(thrown.message).not.toContain(TEST_CARDS.visa)
      expect(thrown.message).not.toContain('4242')
    }
  })

  it('survives a cyclic object rather than hanging', () => {
    const cyclic: Record<string, unknown> = { label: 'fine' }
    cyclic.self = cyclic
    expect(() => assertNoPan(cyclic)).not.toThrow()
  })
})

describe('redaction, for the one case where refusing is worse', () => {
  it('replaces a card number and leaves the sentence around it readable', () => {
    const redacted = redactPan(`charge ${TEST_CARDS.visa} for the meal`)
    expect(redacted).toBe('charge [redacted-pan] for the meal')
    expect(redacted).not.toContain('4242')
  })

  it('leaves an ordinary long number in place', () => {
    expect(redactPan('order 1234567890123456')).toBe('order 1234567890123456')
  })
})

describe('choosing a provider', () => {
  it('uses the mock vault in development when nothing is configured', () => {
    expect(providerName()).toBe('mock')
    expect(paymentsConfigured()).toBe(true)
    expect(describePaymentProvider()).toContain('Mock vault')
  })

  it('refuses the mock vault in production', () => {
    // The important one. A production deploy that quietly accepted cards into a mock vault
    // would tell people their card was saved when it was nowhere.
    process.env.NODE_ENV = 'production'
    expect(providerName()).toBeNull()
    expect(paymentsConfigured()).toBe(false)
    expect(() => getPaymentProvider()).toThrow(PaymentError)
  })

  it('refuses a half-configured Stripe in any environment', () => {
    // Always a typo, never an intention — and it fails in the browser rather than the
    // server if it is allowed through, which is the worst place to find out.
    process.env.STRIPE_SECRET_KEY = 'sk_test_example'
    expect(() => getPaymentProvider()).toThrow(/half-configured/)

    delete process.env.STRIPE_SECRET_KEY
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example'
    expect(() => getPaymentProvider()).toThrow(/half-configured/)
  })

  it('never puts a secret in the line it shows on the Settings page', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_ThisIsTheWholeSecretValue'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_publishable'

    const described = describePaymentProvider()
    expect(described).toContain('Stripe')
    expect(described).not.toContain('ThisIsTheWholeSecretValue')
    // Naming the last four characters is how every provider dashboard identifies a key, and
    // it is the amount that helps somebody check which key is loaded without being useful.
    expect(described).toContain('alue')
  })
})

describe('the mock vault', () => {
  it('offers a scenario for each outcome that behaves differently downstream', () => {
    expect(MOCK_SCENARIOS.map(one => one.id)).toEqual([
      'succeeds',
      'authenticates',
      'declined',
      'duplicate',
    ])
  })

  it('gives a household one stable customer handle', async () => {
    const vault = getPaymentProvider()
    const first = await vault.customerFor('group-a')
    const second = await vault.customerFor('group-a')
    const other = await vault.customerFor('group-b')

    expect(first).toBe(second)
    expect(other).not.toBe(first)
  })

  it('stays pending until a scenario is chosen', async () => {
    const vault = getPaymentProvider()
    const setup = await vault.startCardSetup({
      customerRef: await vault.customerFor('g'),
      statementLabel: 'Two-Way Match',
    })

    expect((await vault.finishCardSetup(setup.ref)).status).toBe('pending')
  })

  it('produces a card that carries no card number', async () => {
    const vault = getPaymentProvider()
    const setup = await vault.startCardSetup({
      customerRef: await vault.customerFor('g'),
      statementLabel: 'Two-Way Match',
    })
    chooseMockScenario(setup.ref, 'succeeds')

    const outcome = await vault.finishCardSetup(setup.ref)
    expect(outcome.status).toBe('succeeded')
    if (outcome.status !== 'succeeded') return

    expect(outcome.card.last4).toHaveLength(4)
    // The fixture itself must be clean, or the mock becomes the thing that puts a
    // card-shaped value into a test database.
    expect(() => assertNoPan(outcome.card)).not.toThrow()
  })

  it('declines without storing anything', async () => {
    const vault = getPaymentProvider()
    const setup = await vault.startCardSetup({
      customerRef: await vault.customerFor('g'),
      statementLabel: 'Two-Way Match',
    })
    chooseMockScenario(setup.ref, 'declined')

    const outcome = await vault.finishCardSetup(setup.ref)
    expect(outcome.status).toBe('declined')
    if (outcome.status !== 'declined') return
    // Read by a person who has just been refused. It has to say what to do next.
    expect(outcome.reason).toMatch(/another card/i)
  })

  it('gives the duplicate scenario the same fingerprint as the one it duplicates', async () => {
    const vault = getPaymentProvider()
    const customerRef = await vault.customerFor('g')

    async function add(scenario: 'succeeds' | 'duplicate') {
      const setup = await vault.startCardSetup({ customerRef, statementLabel: 'x' })
      chooseMockScenario(setup.ref, scenario)
      return vault.finishCardSetup(setup.ref)
    }

    const first = await add('succeeds')
    const second = await add('duplicate')
    if (first.status !== 'succeeded' || second.status !== 'succeeded') {
      expect.unreachable('both should succeed')
      return
    }
    expect(second.card.fingerprint).toBe(first.card.fingerprint)
    expect(second.card.token).not.toBe(first.card.token)
  })

  it('treats removing a card that is already gone as success', async () => {
    // Every real provider agrees, and a caller retrying a failed removal must not be given
    // an error for the state they asked for.
    await expect(getPaymentProvider().forgetCard('pm_mock_nothing')).resolves.toBeUndefined()
  })
})

describe('small shared decisions', () => {
  it('normalises whatever a provider calls a scheme', () => {
    expect(toBrand('Visa')).toBe('visa')
    expect(toBrand('american_express')).toBe('amex')
    expect(toBrand('MasterCard')).toBe('mastercard')
    expect(toBrand('some new network')).toBe('unknown')
    expect(toBrand(undefined)).toBe('unknown')
  })

  it('expires a card at the end of its month, not the start', () => {
    // The off-by-one everybody writes once. A card marked 11/2026 is good all through
    // November.
    const november = new Date('2026-11-15T00:00:00Z')
    expect(isExpired({ expMonth: 11, expYear: 2026 }, november)).toBe(false)
    expect(isExpired({ expMonth: 10, expYear: 2026 }, november)).toBe(true)
    expect(isExpired({ expMonth: 1, expYear: 2027 }, november)).toBe(false)
  })
})
