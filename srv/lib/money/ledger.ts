/**
 * Double-entry, in minor units — CONTRACTS.md §17.
 *
 * The foundation under anything that holds real money, written before there is any, because
 * retrofitting it is how money goes missing. Three decisions, each of which is the one that
 * bites when it is got wrong.
 *
 * ## 1. Integer minor units, never a decimal and never a float
 *
 * `Money` here is a whole number of cents (or rappen, or pence). CLAUDE.md says stored
 * amounts are `Decimal(10,2)`, and this is *stricter* than that rather than a departure from
 * it: a decimal still rounds when divided, and a ledger divides constantly — splitting a
 * charge, applying a fee, converting a rate. Integers make the rounding a decision somebody
 * has to write down (see {@link allocate}) instead of an accident the database performs.
 *
 * `Expenses.amount` stays `Decimal(10,2)`. That column records what a receipt said, and a
 * receipt is a decimal.
 *
 * ## 2. A balance is a sum, never a column
 *
 * There is no `balance` field anywhere in this subsystem, and adding one would be the single
 * most damaging change somebody could make to it. A stored balance is a cache of a sum, and
 * a cache that money depends on will one day disagree with the thing it caches — after a
 * crash between two writes, after a retry that applied twice, after a migration that missed
 * a row. When it does, there is no way to tell which is right.
 *
 * A derived sum cannot drift, because there is nothing for it to drift from. It costs an
 * aggregate query, which is a rounding error next to what it buys, and it stays correct
 * through every partial failure there is.
 *
 * ## 3. Every movement is two entries that sum to zero
 *
 * Money is never created or destroyed, only moved between accounts, and a transfer that does
 * not balance cannot be written — {@link postings} refuses it. This is the property that
 * makes the whole thing auditable: at any instant, summing *every* posting in the system
 * gives exactly zero, and any figure that does not is a bug rather than a mystery.
 *
 * Where money enters or leaves the app entirely, it still balances — against an `external`
 * account standing for the world outside. The world's account goes as negative as the app's
 * accounts are positive, which is the correct description of "somebody paid us".
 */

/** A whole number of minor units. Negative is meaningful: it is the other side of an entry. */
export type Money = number

/**
 * What an account is for.
 *
 * Deliberately few. A chart of accounts grows to fit the business, and one invented ahead of
 * the business is a guess that everything then has to be bent around.
 */
export type AccountKind =
  /** A household's own funds. The thing a person thinks of as "the pot". */
  | 'household'
  /** The world outside: a card, a bank, a chain. Money entering the app comes from here. */
  | 'external'
  /** Fees taken by the provider. Kept separate so "what did this cost us" is one query. */
  | 'fees'

export interface Account {
  /** Stable and meaningful: `household:<groupId>`, `external:stripe`, `fees:stripe`. */
  id: string
  kind: AccountKind
  /** ISO 4217. Accounts never mix currencies; a transfer across two is two transfers. */
  currency: string
}

/** One side of a movement. */
export interface Posting {
  account: string
  /** Positive into the account, negative out of it. */
  amount: Money
  currency: string
}

/** A complete, balanced movement. */
export interface Transfer {
  /**
   * The caller's own idea of this movement, unique forever.
   *
   * Not a convenience. A payment provider will deliver the same webhook twice, a phone will
   * retry a request whose response was lost, and a queue will replay after a restart. The
   * key is what makes the second delivery a no-op instead of a second transfer, and it is
   * the difference between an accounting system and a random number generator.
   */
  idempotencyKey: string
  /** What happened, in words, for the statement line and the audit. */
  reason: string
  postings: Posting[]
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** Rejects anything that is not a whole, finite number of minor units. */
export function assertMoney(value: unknown, what = 'amount'): asserts value is Money {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LedgerError(`${what} must be a number of minor units`)
  }
  if (!Number.isInteger(value)) {
    // The most valuable error in the file. A caller reaching here has passed 12.34 where
    // 1234 was wanted, and silently truncating would lose a third of a franc per row until
    // somebody noticed the totals were wrong.
    throw new LedgerError(
      `${what} must be a whole number of minor units — got ${value}. ` +
        `Use ${Math.round(value * 100)} for ${value}, not ${value}.`,
    )
  }
  if (!Number.isSafeInteger(value)) {
    throw new LedgerError(`${what} is too large to be exact`)
  }
}

/**
 * Build a balanced transfer, or refuse.
 *
 * Every currency present must sum to zero on its own — a transfer that balances only when
 * two currencies are added together does not balance at all, and that is exactly the bug an
 * unchecked ledger hides for months.
 */
export function postings(entries: Posting[]): Posting[] {
  if (entries.length < 2) {
    throw new LedgerError('A transfer needs at least two postings: money comes from somewhere')
  }

  const perCurrency = new Map<string, Money>()
  for (const entry of entries) {
    assertMoney(entry.amount, `posting to ${entry.account}`)
    if (entry.amount === 0) {
      throw new LedgerError(`A posting of zero to ${entry.account} records nothing`)
    }
    perCurrency.set(entry.currency, (perCurrency.get(entry.currency) ?? 0) + entry.amount)
  }

  for (const [currency, sum] of perCurrency) {
    if (sum !== 0) {
      throw new LedgerError(
        `Postings in ${currency} sum to ${sum}, not zero. Money cannot be created or ` +
          `destroyed — the other side of this movement is missing.`,
      )
    }
  }

  return entries
}

/** The shorthand for the common case: money moving from one account to another. */
export function transfer(input: {
  idempotencyKey: string
  reason: string
  from: string
  to: string
  amount: Money
  currency: string
  /** Taken out of `amount` on the way, so `to` receives the remainder. */
  fee?: { account: string; amount: Money }
}): Transfer {
  assertMoney(input.amount, 'transfer amount')
  if (input.amount <= 0) throw new LedgerError('A transfer moves a positive amount')
  if (input.from === input.to) throw new LedgerError('A transfer between one account is nothing')

  const fee = input.fee
  if (fee !== undefined) {
    assertMoney(fee.amount, 'fee')
    if (fee.amount < 0) throw new LedgerError('A fee is not negative')
    if (fee.amount >= input.amount) throw new LedgerError('A fee cannot exceed what is sent')
  }

  const received = input.amount - (fee?.amount ?? 0)
  const entries: Posting[] = [
    { account: input.from, amount: -input.amount, currency: input.currency },
    { account: input.to, amount: received, currency: input.currency },
  ]
  if (fee !== undefined && fee.amount > 0) {
    entries.push({ account: fee.account, amount: fee.amount, currency: input.currency })
  }

  return {
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    postings: postings(entries),
  }
}

/**
 * Split an amount into `parts` shares that add back to exactly the amount.
 *
 * The classic: 10.00 across three ways is not 3.33 three times, because that is 9.99 and a
 * cent has evaporated. The remainder is handed out one minor unit at a time to the earliest
 * shares, which is what every payment system does and what an auditor expects to see.
 *
 * Weighted splits take the same treatment — the largest remainders get the spare units,
 * which is the Hamilton apportionment and the least surprising answer available.
 */
export function allocate(amount: Money, parts: number | readonly number[]): Money[] {
  assertMoney(amount, 'amount to allocate')

  const weights = typeof parts === 'number' ? Array.from({ length: parts }, () => 1) : [...parts]
  if (weights.length === 0) throw new LedgerError('Nothing to allocate across')
  if (weights.some(one => !Number.isFinite(one) || one < 0)) {
    throw new LedgerError('Weights are finite and not negative')
  }

  const total = weights.reduce((sum, one) => sum + one, 0)
  if (total === 0) throw new LedgerError('Weights sum to zero, so there is no way to divide')

  const sign = amount < 0 ? -1 : 1
  const size = Math.abs(amount)

  const exact = weights.map(weight => (size * weight) / total)
  const floors = exact.map(Math.floor)
  let remaining = size - floors.reduce((sum, one) => sum + one, 0)

  // Largest fractional remainder first; ties go to the earlier share, so the result is
  // deterministic rather than dependent on sort stability.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  const shares = [...floors]
  for (const { index } of order) {
    if (remaining <= 0) break
    shares[index] = (shares[index] ?? 0) + 1
    remaining -= 1
  }

  return shares.map(share => share * sign)
}

/**
 * What is in an account, from its postings.
 *
 * Takes the rows rather than reading them, so the arithmetic is testable without a database
 * and so the caller decides what "as at" means — every posting, or only those before a date.
 */
export function balanceOf(rows: readonly Posting[], account: string, currency: string): Money {
  return rows
    .filter(row => row.account === account && row.currency === currency)
    .reduce((sum, row) => sum + row.amount, 0)
}

/**
 * The whole-system check: every currency, across every account, sums to zero.
 *
 * Run in tests, and worth running as a scheduled job against production. A non-zero answer
 * means a transfer was written unbalanced, which should be impossible — and the day it is
 * not impossible is the day you want to find out from a check rather than from a customer.
 */
export function proves(rows: readonly Posting[]): boolean {
  const perCurrency = new Map<string, Money>()
  for (const row of rows) {
    perCurrency.set(row.currency, (perCurrency.get(row.currency) ?? 0) + row.amount)
  }
  return [...perCurrency.values()].every(sum => sum === 0)
}

/** `household:<groupId>` and friends. One place, so nothing invents its own spelling. */
export function accountId(kind: AccountKind, of: string): string {
  return `${kind}:${of}`
}

/**
 * Format for a person, from minor units.
 *
 * Goes through `Intl`, so a Swiss household sees CHF 12.50 and a German one 12,50 €. The
 * `minor` argument exists because not every currency has two decimal places, and hard-coding
 * two is the bug that makes yen amounts a hundred times too small.
 */
export function formatMoney(amount: Money, currency: string, locale = 'en-CH'): string {
  const minor = MINOR_UNITS[currency.toUpperCase()] ?? 2
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 10 ** minor)
}

/** Currencies whose minor unit is not 1/100. Not exhaustive; extended as needed. */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  ISK: 0,
  CLP: 0,
  VND: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  TND: 3,
}
