"""Featurisation shared by the trainer, the exporter, the CLI and the sidecar.

This module is the single source of truth for turning a raw bank-statement string plus an
amount and a timestamp into a feature vector. ``srv/lib/classifier/features.ts`` is a
line-by-line port of it and ``test/classifier-parity.test.ts`` fails the build when the two
drift, so every transformation here has to be expressible in plain arithmetic that JavaScript
can reproduce bit-for-bit. That is why this file imports nothing from scikit-learn: anything
that lives inside an sklearn transformer would be unportable state.

Specified by docs/CONTRACTS.md section 2 -- do not "improve" any step without changing the
contract and the TypeScript port together.
"""

from __future__ import annotations

import math
import re
import unicodedata
import zlib

# Category codes are ASCII and case-sensitive; the prettier display names live in the seed CSV
# (CONTRACTS section 1.1). Listed here in display sort order -- the trained label order is
# whatever sklearn's ``classes_`` reports (ascending), never this list.
CATEGORIES: list[str] = [
    'Groceries',
    'Dining',
    'Cafes',
    'Transport',
    'Travel',
    'Gifts',
    'Home',
    'Health',
    'Entertainment',
    'Subscriptions',
]

MOMENTS: list[str] = ['everyday', 'date_night', 'trip', 'gift']

# Order is load-bearing: it is the column order of the numeric block, of the StandardScaler
# arrays and of ``numericFeatures`` in weights.json (CONTRACTS section 2.4).
NUMERIC_FEATURE_NAMES: list[str] = [
    'log_amount',
    'is_weekend',
    'is_evening',
    'hour_sin',
    'hour_cos',
    'dow_sin',
    'dow_cos',
]

N_NUMERIC = len(NUMERIC_FEATURE_NAMES)

# Transliteration runs before accent stripping so that German umlauts expand the way a German
# speaker writes them ("zürich" -> "zuerich"), which is also how half of the bank statements
# already spell them. Stripping first would collapse both spellings to "zurich" and lose the
# match against the statements that spelled it out.
_TRANSLITERATIONS: tuple[tuple[str, str], ...] = (
    ('ä', 'ae'),
    ('ö', 'oe'),
    ('ü', 'ue'),
    ('ß', 'ss'),
)

_DATE_RE = re.compile(r'\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b')
_TIME_RE = re.compile(r'\b\d{1,2}:\d{2}(:\d{2})?\b')
_REF_RE = re.compile(r'\b(nr|no|ref|trx|tid|kd)[.:]?\s*\d+\b')
_LONG_DIGITS_RE = re.compile(r'\b\d{4,}\b')
_NON_TOKEN_RE = re.compile(r'[^a-z0-9 ]')
_WHITESPACE_RE = re.compile(r'\s+')


def normalise_merchant(raw: str) -> str:
    """Collapse a bank-statement descriptor to the stable part of the merchant name.

    Statements bolt terminal ids, card numbers, booking dates and city suffixes onto the same
    merchant, so the raw string is far too high-cardinality to learn from. Everything that
    varies per transaction is deleted; everything that identifies the shop survives.
    """
    text = raw.lower()
    for source, replacement in _TRANSLITERATIONS:
        text = text.replace(source, replacement)
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')
    text = _DATE_RE.sub(' ', text)
    text = _TIME_RE.sub(' ', text)
    text = _REF_RE.sub(' ', text)
    text = _LONG_DIGITS_RE.sub(' ', text)
    text = _NON_TOKEN_RE.sub(' ', text)
    return _WHITESPACE_RE.sub(' ', text).strip()


def char_wb_ngrams(text: str, n_min: int = 2, n_max: int = 4) -> list[str]:
    """Character n-grams inside word boundaries, byte-compatible with sklearn's ``char_wb``.

    Character n-grams beat word tokens here because merchant strings are riddled with
    typos, abbreviations and glued-on suffixes; "migro" and "migros mm" still share most of
    their grams. Word padding keeps prefixes and suffixes distinguishable from infixes.

    Mirrors ``CountVectorizer._char_wb_ngrams`` exactly, including its quirk that a word
    shorter than ``n`` is emitted once for the first such ``n`` and then no larger ``n`` is
    tried at all (CONTRACTS section 2.2: "emit the padded word once, only for that n").
    """
    ngrams: list[str] = []
    for word in text.split(' '):
        if not word:
            continue
        padded = ' ' + word + ' '
        width = len(padded)
        for n in range(n_min, n_max + 1):
            if width <= n:
                ngrams.append(padded)
                break
            for offset in range(width - n + 1):
                ngrams.append(padded[offset : offset + n])
    return ngrams


def hashed_ngram_ids(ngrams: list[str], n_buckets: int) -> dict[int, float]:
    """Hash n-grams into a fixed-width sparse vector with no vocabulary to ship.

    A learned vocabulary would have to be serialised into weights.json and kept in sync with
    the TypeScript port; ``zlib.crc32`` is in both standard libraries, so hashing keeps the
    exported artefact to weights only. Counts are L2-normalised so that a long merchant
    string does not simply out-shout a short one.
    """
    counts: dict[int, float] = {}
    for ngram in ngrams:
        bucket = zlib.crc32(ngram.encode('utf-8')) % n_buckets
        counts[bucket] = counts.get(bucket, 0.0) + 1.0
    norm = math.sqrt(sum(value * value for value in counts.values()))
    if norm == 0.0:
        return {}
    return {bucket: value / norm for bucket, value in counts.items()}


def text_features(raw: str, n_buckets: int) -> dict[int, float]:
    """The whole text half of the pipeline in one call, so callers cannot mis-order the steps."""
    return hashed_ngram_ids(char_wb_ngrams(normalise_merchant(raw)), n_buckets)


def _leading_int(text: str, field: str) -> int:
    """Read the leading run of ASCII digits, exactly the way JavaScript's ``parseInt`` does.

    Callers hand us shapes the contract does not name -- a trailing ``Z``, a ``+02:00`` offset,
    fractional seconds. Python's ``int()`` raises on those while a ``parseInt`` port in the
    TypeScript side quietly keeps the leading digits, so the two languages would disagree at
    precisely the point where CONTRACTS section 2.4 says to read the wall clock and ignore the
    zone. Matching parseInt keeps them identical and keeps the offset from shifting the hour.

    The error text names the field and never the value. ``ml/serve.py`` handles this over HTTP,
    and a message carrying a fragment of the request body has no business travelling back out.
    """
    stripped = text.strip()
    end = 0
    while end < len(stripped) and '0' <= stripped[end] <= '9':
        end += 1
    if end == 0:
        raise ValueError(f'unparseable {field} in whenISO')
    return int(stripped[:end])


def parse_when(when_iso: str) -> tuple[int, int, int, int, int]:
    """Read the timestamp as local wall-clock, because "evening" is a human fact, not a UTC one.

    Accepts ``YYYY-MM-DD`` and ``YYYY-MM-DDTHH:MM(:SS)``; a bare date means midday, which keeps
    imported bank rows (which carry no time) off the evening/weekend decision boundaries. Any
    timezone suffix is read and discarded rather than applied -- see ``_leading_int``.
    """
    stamp = when_iso.strip()
    separator_index = -1
    for index, char in enumerate(stamp):
        if char in ('T', 't', ' '):
            separator_index = index
            break
    if separator_index >= 0:
        date_part = stamp[:separator_index]
        time_part = stamp[separator_index + 1 :]
    else:
        date_part = stamp
        time_part = ''

    date_bits = date_part.split('-')
    if len(date_bits) < 3:
        raise ValueError('unparseable date in whenISO')
    year = _leading_int(date_bits[0], 'year')
    month = _leading_int(date_bits[1], 'month')
    day = _leading_int(date_bits[2], 'day')

    hour = 12
    minute = 0
    if time_part.strip():
        time_bits = time_part.split(':')
        hour = _leading_int(time_bits[0], 'hour')
        if len(time_bits) > 1:
            minute = _leading_int(time_bits[1], 'minute')
    return year, month, day, hour, minute


def _weekday(year: int, month: int, day: int) -> int:
    """Monday 0 .. Sunday 6 via Sakamoto, so the TypeScript port needs no Date object either."""
    table = (0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4)
    y = year
    if month < 3:
        y -= 1
    sunday_based = (y + y // 4 - y // 100 + y // 400 + table[month - 1] + day) % 7
    return (sunday_based + 6) % 7


def numeric_features(amount: float, when_iso: str) -> list[float]:
    """The seven dense features, in the exact contract order (CONTRACTS section 2.4).

    Hour and weekday are encoded as sine/cosine pairs so that 23:59 sits next to 00:01 for a
    linear model, while the blunt ``is_weekend`` / ``is_evening`` flags give it the sharp
    threshold that "date night" actually depends on.
    """
    year, month, day, hour, minute = parse_when(when_iso)
    dow = _weekday(year, month, day)
    hour_of_day = hour + minute / 60.0
    return [
        math.log1p(max(amount, 0.0)),
        1.0 if dow >= 5 else 0.0,
        1.0 if hour >= 18 else 0.0,
        math.sin(2.0 * math.pi * hour_of_day / 24.0),
        math.cos(2.0 * math.pi * hour_of_day / 24.0),
        math.sin(2.0 * math.pi * dow / 7.0),
        math.cos(2.0 * math.pi * dow / 7.0),
    ]
