# TWM-ADR-003 — The commons: shared places, ratings and date cards

**Status:** accepted, unimplemented. Supersedes nothing; extends ADR-002.
**Normative contract:** `docs/CONTRACTS.md` §14.

Every household using this app already records where it went, what it cost and whether it
was a good evening. All of that is trapped in one household. The single most useful thing
one household could hand another is *"this place worked, here is what to do there, it costs
about this much"* — and that is the feature.

It is also the first thing this app has ever built that lets data leave a household, so
most of this document is about how that is done without breaking the promise the rest of
the app makes.

---

## 1. What is being built

Three surfaces, one corpus.

| Surface | The question it answers |
|---|---|
| **Tonight** | "What do we do this evening?" — three cards, each a restaurant *and* an activity, with a cost band |
| **Places** | "What is good near us?" — map and list, stars, tags, what worked |
| **Give back** | "How was it?" — one tap after an event, from the household's own history |

Plus a second deck of cards for **gifts and activities** with no restaurant in them.

---

## 2. Decision: we cannot publish into Google or Apple Maps, and will not pretend to

The request was to share ratings "on Google or Apple Maps". That is not possible, and it is
worth stating plainly rather than quietly building something else:

- **Google** — the Business Profile API can list reviews and *reply* to them, and explicitly
  cannot create them. Review creation is restricted to a signed-in Google user in Search or
  Maps, deliberately, as an anti-spam measure. There is no third-party write path, and
  simulating one through automation would violate the platform policy outright.
- **Apple** — has no third-party review API at all. Apple Business Connect is for owners of
  a place, not for its visitors.

So the ratings live here, and Google and Apple are treated as **destinations, not stores**.
Every place carries two keyless universal links:

```
Google   https://www.google.com/maps/search/?api=1&query=<lat>,<lon>
Apple    https://maps.apple.com/?ll=<lat>,<lon>&q=<name>
```

Neither needs an API key, a billing account or a contract, and both fall back to a web map
on a platform that does not have the app. "Share" therefore means a share sheet that hands
somebody the place, our tips and a maps link — which is how a person actually shares a place.

## 3. Decision: place identity comes from OpenStreetMap

The app already talks to Nominatim, compliantly, in `app/src/pages/memories/geocode.ts` —
a 1.1 s process-wide queue, a cache and a debounce. Continue with it, and reject Google
Places: its terms forbid storing most fields beyond 30 days, which is incompatible with a
corpus that has to persist, and it requires billing from the first request.

**Move the call server-side.** The client stops talking to a geocoder and calls
`/api/commons/search`; the server holds the queue, the cache and the attribution. This is
worth doing before there is any load, because it makes the eventual cutover — Nominatim's
public instance is explicitly not for heavy use — a change of one URL in one file rather
than a change in every client.

## 4. Decision: the commons is a separate island, not a wider tenant

Every entity in this app carries `group` and is narrowed by the single `scopeToGroup`
handler. That invariant is the reason the app can be trusted at all, so the exception is
made loudly:

- Commons entities **do not carry the `tenant` aspect**, and `scopeToGroup` is never
  registered on them.
- They are served from their own path, `/api/commons`, with their own handlers.
- **No association crosses the line in either direction.** A published rating cannot be
  joined to an expense, an event, a memory or a person, because there is no column to join
  on. The link exists only in the app, at the moment of publishing, and is not stored.
- Nothing is ever published implicitly. Publishing is an action a person takes, once, per
  place, with the text in front of them.

## 5. Decision: anonymous authorship, and k-anonymity on display

`PlaceRatings` stores `group` for exactly two purposes — one rating per group per place, and
letting a group withdraw its own — and **it is never projected**. Reads never touch that
table; they read the aggregate.

**k = 3.** A place shows no stars, no tags and no tips until three distinct groups have
rated it. Below that it says so. The reason is concrete: "the only household that goes to
this bar gave it two stars" identifies a household to anybody who knows where they drink;
at three it does not. The same threshold gates tips, which are the part that can leak.

Free text is the risk, so it is bounded: 240 characters, no `@handles` or URLs, published
only above k, reportable by anybody, withdrawable by its author at any time, and never
shown next to anything that could narrow who wrote it.

**No group composition, anywhere, ever.** ADR-002 §6 refuses to store an orientation or a
couple type as a GDPR Art. 9 decision. This feature is the obvious place for that decision
to be quietly reversed — a "for couples like us" filter is the sort of thing that sounds
helpful — and it must not be. `Groups.kind` is not published, not filterable and not
inferable from anything in the corpus. **What is published is what the activity was, never
who did it.** A family of five and two women on a third date read the same corpus and
contribute to the same one, and neither can tell which rows came from the other.

That is not only a privacy position. It is the product position: the thing that makes a tip
useful is the *place*, and sorting tips by who wrote them is how every other app in this
category became worse.

## 6. Decision: stars to give, Bayes to rank

Stars, as asked, because they are one tap and everybody already knows what they mean. But a
raw mean is a bad ranking and the product research in `docs/PRODUCT-BUSINESS-RESEARCH.html`
says as much. Both are satisfiable at once:

- **Input** — five stars, one tap.
- **Display** — the plain mean, to one decimal, as people expect.
- **Rank** — the mean shrunk toward the global mean:

  ```
  score = (v · R + m · C) / (v + m)
  ```

  `v` ratings, mean `R`, global mean `C`, prior weight `m = 8`. One place with a single 5★
  therefore does not outrank forty ratings at 4.6★. It is one line of arithmetic, computed
  on write, and it is the difference between a ranking that is useful in month one and one
  that is noise.

Nothing is ever presented as a league table. A card says *"worked for 12 households"*, never
*"#3 in Zürich"* — celebrate, do not rank.

## 7. Decision: structured tags first, prose second

Chips beat essays: one tap, filterable, translatable, and they cannot contain a name. The
vocabulary is shared by CDS and TypeScript and is **additive-only**, exactly like the
category codes:

```
quiet  lively  great_food  good_value  view  outdoor  late_open  book_ahead
no_booking_needed  walk_after  easy_to_talk  step_free  dog_ok
first_date  big_group  rainy_day  special_occasion  surprise_worked
```

A free-text tip is optional and secondary. The chips are what discovery filters on.

## 8. Decision: read-optimised, write-amplified, and honest about the store

The target is millions of groups, so the shape is the usual one: writes do the work, reads
are a single indexed lookup.

- **`PlaceStats` is denormalised** and written in the same transaction as a rating: count,
  sum, the five-bucket histogram, the Bayesian score, the tag counts. Discovery never
  aggregates over `PlaceRatings`.
- **Keyset pagination**, never `OFFSET` — `(score, id) < (cursor)`.
- **Geography without PostGIS**: a `geohash6` column (≈1.2 km cells) with an index. "Near
  me" is a prefix `IN` over the nine neighbouring cells, which is an index range scan on
  SQLite today and on Postgres later, with no extension and no rewrite.
- Indexes: `(geohash6, score DESC)`, `(category, score DESC)`, unique `(place, group)` on
  ratings.

And the part that has to be said out loud: **this schema scales, this deployment does not.**
The store today is one SQLite file on one Fly volume. ADR-002 already names the cutover
triggers (a 2 GB file, or sustained load); a public commons crosses them far sooner than a
household ledger ever would. Postgres, with a read replica for discovery, is the plan.
Nothing in this design assumes SQLite, and nothing in it requires Postgres to *work* — it
requires Postgres to be *fast at scale*, which is the honest version of the claim.

## 9. Decision: the card is the product

The dossier's advice — make the action tiny, offer three choices, preserve autonomy, nudge
novelty gently, celebrate rather than rank — is not decoration. It is the interaction spec:

- **Three cards, never one.** One suggestion is an instruction; three is a choice.
- **A card is a whole evening**: a place to eat *and* something to do, not a search result.
- **Cost is a band, not a price** — `≈ CHF 40–70 for two` — because the number comes from
  what other households actually recorded, and a precise figure would be a lie about a menu
  we have not read.
- Two buttons only: **Open in Maps**, and **Plan it**, which creates an ordinary Event and
  hands the evening back to the surfaces that already exist.
- The deck prefers places the household has not been to, and never hides the ones it has.
- **No streaks, no badges, no notifications to come back.** This app has never had a growth
  loop that spends the household's attention, and a commons is not a reason to start.

---

## 10. What is deliberately not in this

- **Not** a social graph. No profiles, no following, no comment threads, no replies. The
  unit is a place, not a person.
- **Not** photos in the commons, in the first version. A photograph is the highest-risk
  thing a household could publish by accident and the hardest to moderate.
- **Not** a merchant or paid-placement layer. The dossier puts it last for good reasons;
  ranking that can be bought is ranking nobody believes.
- **Not** pre-moderation. Report-and-withdraw with rate limits is proportionate at this
  size; pre-moderation is a promise that needs staff to keep.
- **Not** anything touching `BodyMaps` / `BodyZones`. CONTRACTS §13.4's allowlist stands,
  and the commons is not added to it. The word "intimate" appears in this app in exactly one
  feature and it is not this one.

## 11. Phases

| # | Ships | Gate |
|---|---|---|
| 0 | Schema, commons service, ratings + stats + Bayesian score, server-side place search | Two groups rate one place; neither can read the other's row; stats correct |
| 1 | **Places** — map, list, place page, rate sheet, tag chips, maps deep links | k-anonymity holds under test; keyset pagination over 100 k synthetic places |
| 2 | **Tonight** — the three-card deck, cost bands, *Plan it* into an Event | Cards render with an empty corpus and with a full one |
| 3 | Gift and activity decks, share sheet, report/withdraw flows | Report hides a tip within one request; withdraw removes it from stats |
