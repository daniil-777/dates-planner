# TWM-ADR-004 — Cards, points, and the line we do not cross

**Status:** Phases 0–1 shipped (card vault, points ledger, wallet screen).
Phase 2 (real money) is blocked on a decision only the owner can make — see §7.

## Context

Three requests arrived together:

1. "Add a stylish and secure way to add a bank card first, we would need to keep money there."
2. "But we need to add real money. Check crypto also."
3. "Build instead an artificial score of this app as points — that could be converted to
   money if users would like."

They are three attempts at one thing: **the app should hold value.** Each runs into a
different wall, and the walls are legal rather than technical. This ADR records where each
one is, because the walls decide the architecture and a design that ignores them is not a
shortcut — it is an unlicensed financial institution with a nice UI.

## 1. Decision, in one paragraph

The app stores **card tokens** and never card numbers; it mints **points** that can be earned
and never bought; and it holds **no money at all**. Everything sits on one double-entry
ledger so that the day a licensed partner exists, holding money is a new account type rather
than a rewrite.

## 2. Why the card number never arrives

Keeping a PAN puts every machine that has ever held a backup of this database into PCI DSS
audit scope. The smallest scope available (SAQ-A) survives only if the number never touches
our network — not in logs, not in memory, not in transit.

So the fields belong to the provider. The browser posts them to the provider's own origin and
we receive a token. `srv/lib/payments/types.ts` has **nowhere to put a card number**: no
method takes one, which means a provider that wanted raw fields could not implement the
interface without changing it, and changing it is a reviewable act.

That is the design. The enforcement is `srv/lib/payments/pan.ts`: every inbound payload on
the payments service is swept for anything Luhn-valid and refused at the door, with the value
never logged. It exists because the architecture is not what fails — a well-meaning change
next year is. Somebody widens a debug log, or adds a "card details" box to a support form.
Neither looks dangerous in review, and both put a PAN on our side of the line.

**Two obligations do not go away with a hosted field**, and they are the ones people miss:
an inventory of the scripts on the page that mounts the provider's element, and tamper
detection on that page. Both are ours. Neither is code in `srv/`.

## 3. What we are allowed to keep

`token`, `brand`, `last4`, `expMonth`, `expYear`, `fingerprint`, `issuer`, `country`.

That is what a bank app prints on its own cards screen, and the overlap is not a coincidence:
the facts that identify a card _to its owner_ and the facts that are _safe to hold_ are the
same facts. A `pan`, `cvv`, `cardholderName` or `expiryFull` column would be a defect, not a
feature — see the comment block above `PaymentMethods` in `db/schema.cds`.

## 4. Points, and the single invariant that keeps them unregulated

Electronically stored value becomes **e-money** when it is _"issued on receipt of funds"_.
That phrase is the whole hinge:

- Points somebody **bought** are money in a costume, whatever the UI calls them. Issuing them
  needs an e-money licence.
- Points somebody **earned** received no funds and are therefore not e-money at all.

So: **there is no way to buy points.** No top-up, no bundle, no subscription that grants
them, no "convert your card balance into points". `EARN_RULES` is the complete list of ways
points come into existence and every entry is an act. `assertEarnable()` is the only gate,
and it takes a _reason_ rather than an amount — there is no argument through which a payment
could be smuggled.

A test asserts that no rule carries a rate, a price or a multiplier. That is deliberate: the
day somebody adds "500 points for €5" to a growth experiment, it must fail a test rather than
pass review.

**A second rule, which is product rather than law:** nothing pays out in proportion to money
spent. A household app that rewards spending is training two people to spend more together
and calling it a gift. It would work, which is exactly what makes it a dark pattern. Points
are for _acts_, never for _amounts_.

## 5. Redemption

Spending points inside the app or with partner places falls under the **limited network
exclusion**. Paying a household cash is a rebate of our own money rather than the return of
theirs, which is an ordinary commercial arrangement.

The number operations must watch: **€1,000,000 in any rolling 12 months** across the scheme
triggers a notification duty to the competent authority. `REDEMPTION.cashCapPerYear` is a
per-household cap that keeps the aggregate somewhere a person can reason about; the aggregate
counter itself is not built, because nothing can be redeemed for cash yet.

## 6. Why double-entry, for something that is not money

Because an unbalanced points ledger is an infinite-points exploit, and points convertible to
anything real are worth attacking.

- **Integers, in minor units.** Stricter than the `Decimal(10,2)` CLAUDE.md specifies, not
  looser: a decimal still rounds when divided and a ledger divides constantly. Integers force
  the rounding to be a decision somebody wrote down (`allocate()`).
- **No balance column anywhere.** A stored balance is a cache of a sum, and a cache money
  depends on will one day disagree with the thing it caches — after a crash between two
  writes, after a retry that applied twice — with nothing able to say which is right. A
  derived sum cannot drift.
- **Every movement balances per currency or is refused.** At any instant, summing every
  posting gives exactly zero. Anything else is a bug rather than a mystery.

## 7. Real money: the three routes, and what each costs

This is the open decision.

### (a) Card charges — real money out, available now

Money moves household → merchant through the PSP. No licence, because we never _hold_ it.
Needs only a Stripe account. This is real money and it is the cheapest route to it.

### (b) A held balance — needs a licensed partner

Holding client funds requires an **e-money licence**, or a **BaaS partner who has one**
(Swan, Solaris, Treezor, Modulr, Paynetics). Obligations: 100% of client funds segregated by
the end of the next business day, ring-fenced, never lent. Plus KYC and AML on every
household.

Buildable, and the ledger is already shaped for it — a `household` account in a real currency
alongside the points one. What it needs is a signed contract, not code.

### (c) Crypto — checked, and it is not the loophole

Under **MiCA**, custody is a _legal status, not an architecture_: the test is whether the
provider can move a client's assets without the client. If we hold keys we are a CASP and
need authorisation, and the grandfathering window **closed on 1 July 2026** — there is no
transitional cover left.

What _is_ explicitly out of scope: **non-custodial wallets where the provider does not
control the keys**. So there is one genuinely licence-free crypto route, and it is the
self-custody shape — the household holds its own keys, we watch an address and record what
happens, and we can never move a franc of it. For a shared pot specifically, a 2-of-2 multisig
is a real answer: both partners hold keys, we hold nothing.

It is a different product from "a balance in the app", and it should be chosen on its merits
rather than as a way around (b).

## 8. What is deliberately not built

- No `balance` column. See §6.
- No `charge()` on `PaymentProvider`. Charging arrives as its own interface when there is a
  licensed party to charge on behalf of, not as an optional method nobody implements.
- No cash redemption. The wallet screen says so plainly rather than offering a button that
  fails — somebody who taps a thing that does not work trusts the next screen less.

## 9. Operational notes

- `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY`. Both or neither; one without the other is
  always a typo and fails in the browser rather than the server.
- **The mock vault is refused in production.** A deploy that quietly accepted cards into a
  mock would tell people their card was saved when it was nowhere.
- The mock has no card fields at all — only scenario buttons — so there is no input on a dev
  machine that a real card can be typed into.

## References

- [PCI compliance and tokenisation](https://stripe.com/guides/pci-compliance)
- [What is an EMI](https://www.innreg.com/blog/what-is-an-electronic-money-institution)
- [Are loyalty points schemes e-money?](https://www.dentons.com/en/insights/newsletters/2019/july/11/bank-notes/bank-notes-summer-2019/are-loyalty-points-schemes-a-form-of-electronic-money)
- [EBA guidelines on the limited network exclusion](https://eba.europa.eu/publications-and-media/press-releases/eba-publishes-final-guidelines-limited-network-exclusion)
- [MiCA and custody](https://www.anankai.com/mica-compliance-a-practical-guide-for-crypto-custody-providers-in-2026/)
