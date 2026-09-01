"""Synthetic Swiss card-transaction generator for bootstrapping the two-head classifier.

The real ledger starts empty, so the model needs a plausible world to learn from before the
first receipt is ever scanned. Everything here is drawn from one seeded PRNG, so the CSV is
byte-identical on every machine and the parity fixture stays stable.

Two deliberate asymmetries encode what we actually want the model to learn:

* **category** is almost perfectly recoverable from the merchant string alone -- each shop
  belongs to exactly one category, so the text head should reach ~0.99 accuracy;
* **moment** is genuinely uncertain. It is drawn from a distribution over
  merchant "romance", hour, weekday and amount, and then 8% of the labels are corrupted.
  A perfect classifier is therefore impossible by construction, which is the point: the app
  routes anything below 0.6 confidence to a human, and that path has to get exercised.

Usage: python ml/generate_data.py [--rows 4000] [--out ml/data/transactions.csv]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import os
import random
import sys
from collections import Counter
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import CATEGORIES, MOMENTS, normalise_merchant  # noqa: E402

SEED = 20240615
START_DATE = dt.date(2024, 6, 15)
END_DATE = dt.date(2026, 8, 31)
LABEL_NOISE = 0.08

# Who paid. A household has however many people it has, so the roster is a list rather than a
# pair, and the names are names rather than letters. The column is carried through to the CSV
# for provenance only -- ``ml/train.py`` never turns it into a feature, because who paid says
# nothing about what was bought.
PAYERS = ('Ada', 'Bruno', 'Noemi')


def _pick_payer(rng: random.Random) -> str:
    """One ``random()`` draw, so adding a name never reshuffles the rest of the stream."""
    return PAYERS[min(int(rng.random() * len(PAYERS)), len(PAYERS) - 1)]


@dataclass(frozen=True)
class Merchant:
    """A shop, with everything the sampler needs to invent a believable line on a statement."""

    name: str
    weight: float
    median: float
    romance: float = 0.0


def _m(name: str, weight: float, median: float, romance: float = 0.0) -> Merchant:
    return Merchant(name, weight, median, romance)


# Romance is the per-merchant prior for "this was a date, not a Tuesday". It is the main reason
# the moment head is learnable at all: a linear model cannot express "Dining AND evening AND
# expensive", but it can learn that the n-grams of KRONENHALLE lean date_night while the
# n-grams of KEBAB HOUSE do not.
CATALOGUE: dict[str, list[Merchant]] = {
    'Groceries': [
        _m('MIGROS', 12, 34.0),
        _m('COOP', 11, 31.0),
        _m('MIGROS MM ZUERICH HB', 5, 24.0),
        _m('COOP PRONTO', 4, 14.0),
        _m('DENNER', 4, 22.0),
        _m('ALDI SUISSE', 3, 28.0),
        _m('LIDL SCHWEIZ', 3, 26.0),
        _m('VOLG', 2, 16.0),
        _m('MIGROLINO', 3, 11.0),
        _m('BAECKEREI FISCHER', 3, 9.0),
        _m('BÄCKEREI HUG', 2, 8.5),
        _m('ALNATURA ZUERICH', 2, 36.0),
        _m('METZGEREI ANGST', 1, 27.0),
        _m('MARKTHALLE BASEL', 1, 23.0),
        _m('SPAR EXPRESS', 2, 18.0),
    ],
    'Dining': [
        _m('RESTAURANT BLAUE ENTE', 4, 134.0, 0.95),
        _m('KRONENHALLE', 2, 172.0, 0.95),
        _m('BRASSERIE LIPP ZUERICH', 2, 98.0, 0.88),
        _m('LE DEZALEY', 2, 106.0, 0.88),
        _m('BINDELLA RISTORANTE', 3, 94.0, 0.85),
        _m('RESTAURANT ZUM GRUENEN GLAS', 2, 89.0, 0.82),
        _m('SUSHI ZEN', 3, 66.0, 0.78),
        _m('PIZZERIA DA MICHELE', 4, 58.0, 0.68),
        _m('ZEUGHAUSKELLER', 4, 78.0, 0.66),
        _m('SWISS CHUCHI', 2, 69.0, 0.66),
        _m('RESTAURANT SANTA LUCIA', 4, 62.0, 0.64),
        _m('RESTAURANT LINDE', 3, 71.0, 0.62),
        _m('HILTL', 5, 46.0, 0.26),
        _m('NOOCH ASIAN KITCHEN', 3, 34.0, 0.16),
        _m('TIBITS', 4, 29.0, 0.12),
        _m('KEBAB HOUSE', 4, 19.0, 0.05),
        _m('MCDONALDS', 4, 17.0, 0.03),
        _m('BURGER KING', 3, 18.0, 0.03),
    ],
    'Cafes': [
        _m('STARBUCKS', 6, 7.6, 0.05),
        _m('VICAFE', 5, 5.2, 0.04),
        _m('BLACK SHEEP', 4, 6.4, 0.05),
        _m('COFFEE STOP', 4, 5.8, 0.03),
        _m('CAFETERIA ETH', 3, 4.9, 0.02),
        _m('CAFE BÄCKEREI ZEIT', 3, 9.2, 0.10),
        _m('MOEVENPICK CAFE', 2, 11.5, 0.10),
        _m('BOHEMIA CAFE', 3, 12.5, 0.14),
        _m('CAFE SPRUENGLI', 4, 19.0, 0.44),
        _m('GRAND CAFE ODEON', 2, 25.0, 0.56),
    ],
    'Transport': [
        _m('SBB CFF FFS', 10, 18.0),
        _m('ZVV', 6, 4.4),
        _m('VBZ TICKET', 2, 4.2),
        _m('UBER TRIP', 4, 23.0),
        _m('MOBILITY', 3, 41.0),
        _m('BP TANKSTELLE', 3, 76.0),
        _m('SOCAR TANKSTELLE', 2, 72.0),
        _m('SHELL AUTOBAHN', 2, 79.0),
        _m('POSTAUTO', 2, 9.0),
        _m('TAXI ZUERICH', 2, 34.0),
        _m('PARKHAUS HOHE PROMENADE', 3, 12.0),
        _m('BOLT RIDE', 2, 19.0),
    ],
    'Travel': [
        _m('SWISS INTERNATIONAL AIR LINES', 4, 289.0),
        _m('BOOKING.COM', 5, 212.0),
        _m('AIRBNB PAYMENTS', 4, 244.0),
        _m('HOTEL ADLER', 3, 168.0),
        _m('SWISS TRAVEL', 3, 96.0),
        _m('EASYJET', 3, 128.0),
        _m('HOTEL SCHWEIZERHOF', 2, 246.0),
        _m('HOTEL BELLEVUE', 2, 196.0),
        _m('SBB RAILAWAY', 2, 88.0),
        _m('FLIXBUS', 2, 39.0),
    ],
    'Gifts': [
        _m('MANOR', 4, 68.0),
        _m('GLOBUS', 3, 112.0),
        _m('INTERFLORA', 3, 74.0),
        _m('BLUME 3000', 3, 58.0),
        _m('JELMOLI', 2, 138.0),
        _m('CHRIST UHREN SCHMUCK', 2, 248.0),
        _m('ORELL FUESSLI', 3, 34.0),
        _m('BLUMENGALERIE SEEFELD', 2, 49.0),
        _m('GESCHENKIDEE CH', 2, 62.0),
    ],
    'Home': [
        _m('IKEA DIETLIKON', 4, 128.0),
        _m('JUMBO', 3, 64.0),
        _m('MICASA', 3, 89.0),
        _m('HORNBACH', 3, 78.0),
        _m('OBI BAUMARKT', 2, 56.0),
        _m('DEPOT ZUERICH', 2, 42.0),
        _m('PFISTER MOEBEL', 2, 218.0),
        _m('LANDI', 2, 38.0),
        _m('COOP BAU HOBBY', 3, 47.0),
    ],
    'Health': [
        _m('APOTHEKE ZUR ROSE', 4, 38.0),
        _m('TOPPHARM APOTHEKE', 3, 34.0),
        _m('AMAVITA APOTHEKE', 3, 31.0),
        _m('MEDBASE', 3, 78.0),
        _m('DR MED HUBER PRAXIS', 2, 145.0),
        _m('PHYSIOTHERAPIE SEEFELD', 2, 98.0),
        _m('ZAHNARZT ZENTRUM OERLIKON', 2, 212.0),
        _m('OPTIKER KOCH', 2, 165.0),
    ],
    'Entertainment': [
        _m('KINO ARENA', 4, 24.0, 0.72),
        _m('PATHE SPREITENBACH', 3, 26.0, 0.68),
        _m('KINO RIFFRAFF', 3, 22.0, 0.74),
        _m('KAUFLEUTEN', 3, 32.0, 0.64),
        _m('HALLENSTADION', 2, 98.0, 0.60),
        _m('OPERNHAUS ZUERICH', 2, 148.0, 0.92),
        _m('SCHAUSPIELHAUS', 2, 88.0, 0.88),
        _m('ZOO ZUERICH', 2, 46.0, 0.20),
        _m('TECHNORAMA', 1, 38.0, 0.14),
        _m('BOWLING CENTER HEUERIED', 2, 34.0, 0.24),
    ],
    'Subscriptions': [
        _m('SPOTIFY', 4, 12.95),
        _m('NETFLIX', 4, 19.90),
        _m('SALT MOBILE', 3, 49.95),
        _m('SWISSCOM', 3, 79.90),
        _m('ICLOUD', 4, 2.95),
        _m('DISNEY PLUS', 2, 15.90),
        _m('SUNRISE', 2, 59.00),
        _m('NZZ ABO', 2, 39.00),
        _m('SERAFE', 1, 111.50),
        _m('FITNESSPARK ABO', 2, 89.00),
    ],
}

# Everything except Subscriptions (billed on a schedule) and the trip clusters (generated as
# clusters so that trip expenses actually sit next to each other in time).
DAILY_CATEGORY_WEIGHTS: dict[str, float] = {
    'Groceries': 0.225,
    'Dining': 0.175,
    'Cafes': 0.130,
    'Transport': 0.130,
    'Entertainment': 0.085,
    'Gifts': 0.080,
    'Home': 0.075,
    'Health': 0.050,
    'Travel': 0.055,
}

AMOUNT_SIGMA: dict[str, float] = {
    'Groceries': 0.55,
    'Dining': 0.45,
    'Cafes': 0.34,
    'Transport': 0.60,
    'Travel': 0.50,
    'Gifts': 0.52,
    'Home': 0.65,
    'Health': 0.52,
    'Entertainment': 0.40,
    'Subscriptions': 0.02,
}

# Monday .. Sunday. Swiss shops are shut on Sunday, which is a real and very learnable signal.
WEEKDAY_WEIGHTS: dict[str, list[float]] = {
    'Groceries': [1.00, 1.00, 1.00, 1.05, 1.25, 1.40, 0.10],
    'Dining': [0.75, 0.75, 0.85, 0.95, 1.55, 1.75, 1.05],
    'Cafes': [1.20, 1.20, 1.20, 1.20, 1.25, 0.80, 0.45],
    'Transport': [1.30, 1.30, 1.30, 1.30, 1.30, 0.70, 0.50],
    'Travel': [1.00, 1.00, 1.00, 1.00, 1.20, 1.10, 0.90],
    'Gifts': [0.90, 0.90, 1.00, 1.00, 1.20, 1.40, 0.15],
    'Home': [0.70, 0.70, 0.80, 0.80, 1.00, 2.00, 0.30],
    'Health': [1.20, 1.20, 1.20, 1.20, 1.10, 0.45, 0.05],
    'Entertainment': [0.60, 0.60, 0.80, 1.00, 1.60, 1.80, 1.10],
}

# (probability, start hour, end hour) mixtures, in local wall-clock.
HOUR_MIXTURES: dict[str, list[tuple[float, float, float]]] = {
    'Groceries': [(0.25, 8.0, 12.0), (0.20, 12.0, 15.5), (0.55, 16.0, 20.0)],
    'Dining': [(0.30, 11.5, 13.75), (0.70, 18.25, 21.75)],
    'Cafes': [(0.55, 7.0, 10.5), (0.25, 13.0, 16.0), (0.20, 16.0, 18.75)],
    'Transport': [(0.40, 6.5, 9.0), (0.35, 16.0, 19.5), (0.25, 9.0, 22.0)],
    'Travel': [(1.00, 6.0, 22.0)],
    'Gifts': [(1.00, 10.0, 19.0)],
    'Home': [(1.00, 9.5, 18.5)],
    'Health': [(1.00, 8.0, 18.5)],
    'Entertainment': [(0.75, 18.5, 22.5), (0.25, 13.0, 17.0)],
    'Subscriptions': [(1.00, 2.0, 6.0)],
}

HOME_CITIES: list[str] = [
    'ZUERICH',
    'ZÜRICH',
    'ZURICH',
    'ZUERICH OERLIKON',
    'ZUERICH WIEDIKON',
    'ZH',
    'WINTERTHUR',
    'WALLISELLEN',
    'DIETIKON',
    'USTER',
    'THALWIL',
    'SCHLIEREN',
    'KLOTEN',
    'BASEL',
    'BERN',
    'LUZERN',
    'ST GALLEN',
]

TRIP_DESTINATIONS: list[tuple[str, str]] = [
    ('LISBOA', 'PT'),
    ('PORTO', 'PT'),
    ('BARCELONA', 'ES'),
    ('MADRID', 'ES'),
    ('PARIS', 'FR'),
    ('LYON', 'FR'),
    ('ROMA', 'IT'),
    ('MAILAND', 'IT'),
    ('WIEN', 'AT'),
    ('BERLIN', 'DE'),
    ('HAMBURG', 'DE'),
    ('AMSTERDAM', 'NL'),
    ('LONDON', 'GB'),
    ('EDINBURGH', 'GB'),
    ('KOPENHAGEN', 'DK'),
    ('PRAG', 'CZ'),
    ('ATHEN', 'GR'),
    ('ZERMATT', 'CH'),
    ('AROSA', 'CH'),
    ('LAAX', 'CH'),
    ('LUGANO', 'CH'),
    ('LOCARNO', 'CH'),
]

# Merchants that only ever show up abroad. They keep their category disjoint from the Swiss
# catalogue, so category stays clean while the destination suffix teaches the moment head
# what a trip looks like.
TRIP_CATALOGUE: dict[str, list[Merchant]] = {
    'Dining': [
        _m('RESTAURANTE DO FADO', 3, 72.0, 0.45),
        _m('TRATTORIA DA NINO', 3, 68.0, 0.45),
        _m('BISTRO LE PETIT', 3, 76.0, 0.50),
        _m('TAVERNA MYKONOS', 2, 58.0, 0.40),
        _m('OSTERIA DEL BORGO', 2, 82.0, 0.50),
        _m('BRASSERIE GEORGES', 2, 88.0, 0.50),
    ],
    'Cafes': [
        _m('CAFE CENTRAL', 3, 11.0, 0.20),
        _m('PASTELARIA BELEM', 2, 8.5, 0.15),
        _m('CAFE DE FLORE', 2, 16.0, 0.30),
        _m('KAFFEEHAUS SPERL', 2, 13.0, 0.25),
    ],
    'Transport': [
        _m('METRO TICKET', 4, 6.5),
        _m('TRENITALIA', 2, 42.0),
        _m('RENFE VIAJEROS', 2, 48.0),
        _m('AEROPORTO TAXI', 3, 38.0),
        _m('CITY BIKE RENT', 2, 14.0),
    ],
    'Travel': [
        _m('HOTEL BOAVISTA', 3, 186.0),
        _m('HOTEL DE LA PAIX', 3, 214.0),
        _m('PENSION MARIA', 2, 124.0),
        _m('AIRBNB PAYMENTS', 3, 248.0),
    ],
    'Entertainment': [
        _m('MUSEU NACIONAL', 3, 28.0, 0.35),
        _m('TEATRO ROMANO', 2, 34.0, 0.40),
        _m('GUIDED CITY TOUR', 2, 44.0, 0.40),
        _m('OCEANARIO', 1, 39.0, 0.30),
    ],
    'Gifts': [
        _m('SOUVENIR SHOP', 3, 26.0),
        _m('MERCADO ARTESANAL', 2, 34.0),
    ],
}

TRIP_DAY_MIX: list[tuple[str, float]] = [
    ('Dining', 0.34),
    ('Cafes', 0.22),
    ('Transport', 0.18),
    ('Entertainment', 0.13),
    ('Travel', 0.08),
    ('Gifts', 0.05),
]


def _assert_catalogue_matches_contract() -> None:
    """Tie the catalogue keys below to the one list of category codes in ``features.py``.

    CONTRACTS section 1.1 names this file as a consumer of those codes, but the catalogue spells
    them out a second time so that each shop can sit under its category. Without this check a
    rename in features.py would go unnoticed here and the generated CSV would carry a code that
    has no row in db/data/twowaymatch-Categories.csv -- surfacing much later as a foreign-key
    error in the app instead of as a failure in the generator that caused it.
    """
    if list(CATALOGUE) != CATEGORIES:
        raise AssertionError(
            f'CATALOGUE keys {list(CATALOGUE)} != contract categories {CATEGORIES}'
        )
    unknown = (set(TRIP_CATALOGUE) | set(DAILY_CATEGORY_WEIGHTS)) - set(CATEGORIES)
    if unknown:
        raise AssertionError(f'unknown category codes in generator tables: {sorted(unknown)}')


_assert_catalogue_matches_contract()


@dataclass
class Row:
    """One statement line. Mutable because the label-noise pass rewrites ``moment`` in place."""

    when: dt.datetime
    merchant_raw: str
    amount: float
    payer: str
    category: str
    moment: str


def _weighted_choice(rng: random.Random, options: dict[str, float]) -> str:
    keys = list(options)
    return rng.choices(keys, weights=[options[key] for key in keys], k=1)[0]


def _pick_merchant(rng: random.Random, pool: list[Merchant]) -> Merchant:
    return rng.choices(pool, weights=[item.weight for item in pool], k=1)[0]


def _sample_hour(rng: random.Random, category: str) -> tuple[int, int]:
    """Pick a wall-clock time from the category's daily rhythm.

    The hour is where most of the moment signal that is *not* in the merchant name lives, so it
    has to be shaped rather than uniform: groceries after work, coffee before it, dinner late.
    """
    mixture = HOUR_MIXTURES[category]
    draw = rng.random()
    cumulative = 0.0
    low, high = mixture[-1][1], mixture[-1][2]
    for probability, start, end in mixture:
        cumulative += probability
        if draw <= cumulative:
            low, high = start, end
            break
    value = rng.uniform(low, high)
    hour = int(value)
    minute = int((value - hour) * 60)
    if hour > 23:
        hour, minute = 23, 59
    return hour, minute


def _sample_amount(rng: random.Random, merchant: Merchant, category: str) -> float:
    """Lognormal around the merchant's typical ticket -- spending is right-skewed, never normal."""
    sigma = AMOUNT_SIGMA[category]
    value = merchant.median * math.exp(rng.gauss(0.0, sigma))
    return round(max(value, 1.0), 2)


def _render_raw(rng: random.Random, name: str, city: str | None) -> str:
    """Dress a clean merchant name up as the mess a card processor actually prints.

    Casing, terminal ids, booking dates and reference numbers all vary per transaction; this is
    exactly the noise ``normalise_merchant`` exists to remove, so the generator has to produce it
    or the normaliser never gets tested by the data.
    """
    text = name
    style = rng.random()
    if style < 0.72:
        text = text.upper()
    elif style < 0.90:
        text = text.title()
    else:
        text = text.lower()

    if city and rng.random() < 0.58:
        separator = rng.choice([' ', ' ', ' ', '/', ' //'])
        city_text = city if rng.random() < 0.8 else city.title()
        text = f'{text}{separator}{city_text}'

    if rng.random() < 0.26:
        # Two to four digits: a single digit would leave a one-character token behind, which is
        # the one place sklearn's char_wb has an edge case we would rather not lean on.
        store = rng.randint(11, 9999)
        prefix = rng.choice(['', '', 'FIL.', 'NR.', 'STORE'])
        text = f'{text} {prefix}{store}' if prefix else f'{text} {store}'

    if rng.random() < 0.15:
        stamp = dt.date(rng.randint(2024, 2026), rng.randint(1, 12), rng.randint(1, 28))
        text = f'{text} {stamp.strftime("%d.%m.%y")}'

    if rng.random() < 0.12:
        tag = rng.choice(['TRX', 'REF', 'KD.NR', 'TID', 'NO.'])
        text = f'{text} {tag} {rng.randint(10000, 99999999)}'

    if rng.random() < 0.08:
        text = f'{text} CARD*{rng.randint(1000, 9999)}'

    if rng.random() < 0.05:
        text = f'{text} {rng.choice(["CH", "SCHWEIZ", "SUISSE"])}'

    return ' '.join(text.split())


def _moment_distribution(
    category: str,
    merchant: Merchant,
    hour: int,
    dow: int,
    amount: float,
    in_trip: bool,
) -> dict[str, float]:
    """The generative story behind the ``moment`` label.

    Each branch is mostly decided but never certain, so a perfect classifier is impossible even
    before the label-noise pass. The shape matters as much as the noise level: the model is a
    linear one, so the rule has to be expressible as "this merchant leans romantic" plus "it was
    the evening" plus "it was expensive" rather than as a true three-way interaction, or nothing
    downstream could ever learn it.
    """
    if in_trip:
        return {'trip': 0.985, 'everyday': 0.011, 'date_night': 0.003, 'gift': 0.001}
    if category == 'Travel':
        return {'trip': 0.982, 'everyday': 0.014, 'date_night': 0.002, 'gift': 0.002}
    if category == 'Gifts':
        return {'gift': 0.984, 'everyday': 0.012, 'date_night': 0.002, 'trip': 0.002}
    if category == 'Subscriptions':
        return {'everyday': 0.996, 'trip': 0.002, 'gift': 0.001, 'date_night': 0.001}

    if category in ('Dining', 'Cafes', 'Entertainment'):
        evening = 1.0 if hour >= 18 else 0.10
        weekend = 1.35 if dow in (4, 5) else (1.05 if dow == 6 else 0.72)
        if amount >= 80.0:
            ticket = 1.15
        elif amount >= 45.0:
            ticket = 1.00
        elif amount >= 20.0:
            ticket = 0.72
        else:
            ticket = 0.45
        # A logistic squash rather than the raw product: it makes the outcome nearly decided at
        # both ends (a cheap Tuesday coffee is never a date, KRONENHALLE on a Saturday always is)
        # while leaving a genuinely undecided band in the middle for the app's review queue.
        score = merchant.romance * evening * weekend * ticket
        date_night = 1.0 / (1.0 + math.exp(-16.0 * (score - 0.42)))
        date_night = min(max(date_night, 0.01), 0.97)
        rest = 1.0 - date_night
        return {
            'date_night': date_night,
            'everyday': rest * 0.992,
            'trip': rest * 0.004,
            'gift': rest * 0.004,
        }

    return {'everyday': 0.996, 'trip': 0.002, 'gift': 0.001, 'date_night': 0.001}


def _make_row(
    rng: random.Random,
    day: dt.date,
    category: str,
    merchant: Merchant,
    city: str | None,
    in_trip: bool,
) -> Row:
    hour, minute = _sample_hour(rng, category)
    amount = _sample_amount(rng, merchant, category)
    moment = _weighted_choice(
        rng, _moment_distribution(category, merchant, hour, day.weekday(), amount, in_trip)
    )
    return Row(
        when=dt.datetime(day.year, day.month, day.day, hour, minute),
        merchant_raw=_render_raw(rng, merchant.name, city),
        amount=amount,
        payer=_pick_payer(rng),
        category=category,
        moment=moment,
    )


def _sample_day(rng: random.Random, category: str, span_days: int) -> dt.date:
    """Rejection-sample a date so the weekday profile of each category actually shows up."""
    weights = WEEKDAY_WEIGHTS[category]
    ceiling = max(weights)
    for _ in range(64):
        day = START_DATE + dt.timedelta(days=rng.randrange(span_days))
        if rng.random() * ceiling <= weights[day.weekday()]:
            return day
    return START_DATE + dt.timedelta(days=rng.randrange(span_days))


def _subscription_rows(rng: random.Random) -> list[Row]:
    """Standing orders: same merchant, same day of month, overnight, essentially fixed amount."""
    rows: list[Row] = []
    for merchant in CATALOGUE['Subscriptions']:
        billing_day = rng.randint(1, 28)
        cursor = dt.date(START_DATE.year, START_DATE.month, billing_day)
        if rng.random() < 0.35:
            cursor = cursor + dt.timedelta(days=31 * rng.randint(1, 6))
            cursor = cursor.replace(day=billing_day)
        stops_early = rng.random() < 0.25
        last_month = END_DATE - dt.timedelta(days=31 * rng.randint(2, 7)) if stops_early else END_DATE
        while cursor <= last_month:
            if cursor >= START_DATE:
                hour, minute = _sample_hour(rng, 'Subscriptions')
                amount = round(merchant.median * (1.0 + rng.gauss(0.0, 0.01)), 2)
                rows.append(
                    Row(
                        when=dt.datetime(cursor.year, cursor.month, cursor.day, hour, minute),
                        merchant_raw=_render_raw(rng, merchant.name, None),
                        amount=amount,
                        payer=_pick_payer(rng),
                        category='Subscriptions',
                        moment=_weighted_choice(
                            rng,
                            _moment_distribution(
                                'Subscriptions', merchant, hour, cursor.weekday(), amount, False
                            ),
                        ),
                    )
                )
            month = cursor.month + 1
            year = cursor.year + (1 if month > 12 else 0)
            month = 1 if month > 12 else month
            cursor = dt.date(year, month, billing_day)
    return rows


def _trip_rows(rng: random.Random, trip_count: int) -> list[Row]:
    """Generate travel as clusters, because a trip is a run of days and not a random Tuesday.

    The booking (flight or platform) is charged weeks earlier from home; everything from the
    departure day onwards carries the destination in the merchant string, which is precisely the
    cue a human reads off a statement.
    """
    rows: list[Row] = []
    span_days = (END_DATE - START_DATE).days
    for _ in range(trip_count):
        start = START_DATE + dt.timedelta(days=rng.randrange(span_days))
        length = rng.randint(3, 8)
        if start + dt.timedelta(days=length) > END_DATE:
            start = END_DATE - dt.timedelta(days=length + 1)
        city, country = rng.choice(TRIP_DESTINATIONS)

        booking_day = start - dt.timedelta(days=rng.randint(14, 70))
        if booking_day >= START_DATE:
            booking = _pick_merchant(rng, CATALOGUE['Travel'])
            rows.append(_make_row(rng, booking_day, 'Travel', booking, None, True))

        suffix = city if rng.random() < 0.75 else f'{city} {country}'
        for offset in range(length):
            day = start + dt.timedelta(days=offset)
            for _ in range(rng.randint(1, 3)):
                category = rng.choices(
                    [name for name, _ in TRIP_DAY_MIX],
                    weights=[weight for _, weight in TRIP_DAY_MIX],
                    k=1,
                )[0]
                merchant = _pick_merchant(rng, TRIP_CATALOGUE[category])
                rows.append(_make_row(rng, day, category, merchant, suffix, True))
    return rows


def _apply_label_noise(rng: random.Random, rows: list[Row], rate: float) -> int:
    """Corrupt a slice of the moment labels, drawing replacements from the label prior.

    Real couples disagree with themselves about what counted as a date night, and the app logs
    those corrections as training data. Replacing from the prior rather than uniformly matters:
    uniform noise would flood the two rare classes with false positives and quietly destroy
    macro F1 for a reason that has nothing to do with the model.
    """
    prior = Counter(row.moment for row in rows)
    flipped = 0
    for row in rows:
        if rng.random() >= rate:
            continue
        alternatives = [label for label in MOMENTS if label != row.moment]
        weights = [float(prior[label]) + 1.0 for label in alternatives]
        row.moment = rng.choices(alternatives, weights=weights, k=1)[0]
        flipped += 1
    return flipped


def generate(rows_target: int, seed: int) -> list[Row]:
    """Assemble the whole ledger: subscriptions, trips, then everyday spend to fill the quota."""
    rng = random.Random(seed)
    span_days = (END_DATE - START_DATE).days

    rows: list[Row] = []
    rows.extend(_subscription_rows(rng))
    rows.extend(_trip_rows(rng, trip_count=42))

    while len(rows) < rows_target:
        category = _weighted_choice(rng, DAILY_CATEGORY_WEIGHTS)
        day = _sample_day(rng, category, span_days)
        merchant = _pick_merchant(rng, CATALOGUE[category])
        city = rng.choice(HOME_CITIES) if rng.random() < 0.85 else None
        rows.append(_make_row(rng, day, category, merchant, city, False))

    flipped = _apply_label_noise(rng, rows, LABEL_NOISE)
    rows.sort(key=lambda row: (row.when, row.merchant_raw))
    print(f'label noise: flipped {flipped} of {len(rows)} moment labels')
    return rows


def _assert_no_single_char_tokens(rows: list[Row]) -> None:
    """Guard the one place where sklearn's char_wb has behaviour worth not depending on.

    A one-character word padded to three characters is shorter than the 4-gram window, and the
    "emit once, then stop" rule is the subtlest line in CONTRACTS section 2.2. Keeping such
    tokens out of the corpus means the parity fixture can never hinge on it.
    """
    for row in rows:
        for token in normalise_merchant(row.merchant_raw).split(' '):
            if len(token) == 1:
                raise AssertionError(f'single-character token from {row.merchant_raw!r}')


def write_csv(rows: list[Row], path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(['date', 'time', 'merchant_raw', 'amount_chf', 'payer', 'category', 'moment'])
        for row in rows:
            writer.writerow(
                [
                    row.when.strftime('%Y-%m-%d'),
                    row.when.strftime('%H:%M'),
                    row.merchant_raw,
                    f'{row.amount:.2f}',
                    row.payer,
                    row.category,
                    row.moment,
                ]
            )


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description='Generate synthetic Swiss transactions.')
    parser.add_argument('--rows', type=int, default=4000, help='approximate number of rows')
    parser.add_argument('--seed', type=int, default=SEED, help='PRNG seed (reproducibility)')
    parser.add_argument(
        '--out', default=os.path.join(here, 'data', 'transactions.csv'), help='output CSV path'
    )
    args = parser.parse_args()

    rows = generate(args.rows, args.seed)
    _assert_no_single_char_tokens(rows)
    write_csv(rows, args.out)

    categories = Counter(row.category for row in rows)
    moments = Counter(row.moment for row in rows)
    print(f'wrote {len(rows)} rows to {args.out}')
    print('dates : ' + f'{rows[0].when.date()} .. {rows[-1].when.date()}')
    print('category: ' + ', '.join(f'{k}={v}' for k, v in categories.most_common()))
    print('moment  : ' + ', '.join(f'{k}={v}' for k, v in moments.most_common()))


if __name__ == '__main__':
    main()
