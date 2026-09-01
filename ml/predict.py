"""Reference inference over ``ml/model/weights.json`` -- and the CLI that prints a ClassifyResult.

This deliberately scores from the exported JSON rather than from ``model.pkl``. weights.json is
what ``srv/lib/classifier`` actually loads, and its coefficients are float32; reading the pickle
here would score with float64 coefficients and leave a systematic gap between the Python numbers
in the parity fixture and the TypeScript numbers being compared against them. Scoring the shipped
artefact means both languages start from identical bits.

Usage:
    python ml/predict.py --merchant "RESTAURANT BLAUE ENTE" --amount 148.5 --when 2026-03-14T20:15
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
from dataclasses import dataclass

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import NUMERIC_FEATURE_NAMES, numeric_features, text_features  # noqa: E402

DEFAULT_WEIGHTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model', 'weights.json')


@dataclass(frozen=True)
class Head:
    """One softmax head: labels aligned row-for-row with the coefficient matrix."""

    labels: list[str]
    intercept: np.ndarray
    coef: np.ndarray


@dataclass(frozen=True)
class Model:
    n_buckets: int
    numeric_names: list[str]
    mean: np.ndarray
    scale: np.ndarray
    heads: dict[str, Head]
    trained_at: str
    trained_rows: int
    metrics: dict[str, float]


# Keyed on identity *and* mtime/size, not on the path alone: ``export_ts.py`` rewrites
# weights.json and then scores the parity fixture from it in the same process, so a path-only
# cache would silently freeze a stale model into the fixture and fail vitest with no clue why.
_CACHE: dict[tuple[str, int, int], Model] = {}


def load_model(path: str = DEFAULT_WEIGHTS) -> Model:
    """Decode weights.json once per version of the file; the CLI is forgiving, the sidecar is not.

    Coefficients are widened to float64 after decoding because that is what JavaScript does when
    it reads a Float32Array element into a number -- the values stay float32-exact, the
    arithmetic is done in doubles on both sides.
    """
    try:
        stat = os.stat(path)
    except OSError:
        raise SystemExit(
            f'{path} not found -- run "python ml/train.py" then "python ml/export_ts.py"'
        ) from None
    key = (os.path.abspath(path), stat.st_mtime_ns, stat.st_size)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    with open(path, encoding='utf-8') as handle:
        payload = json.load(handle)

    # A weights file whose numeric block disagrees with features.py would still score, just
    # wrongly and silently, so the mismatch is caught here rather than shipped to the app.
    numeric_names = [str(name) for name in payload['numericFeatures']]
    if numeric_names != NUMERIC_FEATURE_NAMES:
        raise SystemExit(
            f'{path}: numericFeatures {numeric_names} != features.py {NUMERIC_FEATURE_NAMES} '
            '-- re-run "python ml/export_ts.py"'
        )
    n_buckets = int(payload['nBuckets'])
    n_columns = n_buckets + len(NUMERIC_FEATURE_NAMES)

    heads: dict[str, Head] = {}
    for name, head in payload['heads'].items():
        rows, columns = head['shape']
        if columns != n_columns:
            raise SystemExit(
                f'head {name}: {columns} coefficient columns, expected nBuckets + numeric '
                f'= {n_columns}'
            )
        raw = base64.b64decode(head['coefB64'])
        coef = np.frombuffer(raw, dtype='<f4')
        if coef.size != rows * columns:
            raise SystemExit(
                f'head {name}: coefB64 decodes to {coef.size} floats, expected {rows * columns}'
            )
        labels = [str(label) for label in head['labels']]
        if len(labels) != rows:
            raise SystemExit(f'head {name}: {len(labels)} labels for {rows} coefficient rows')
        heads[name] = Head(
            labels=labels,
            intercept=np.asarray(head['intercept'], dtype=np.float64),
            coef=coef.reshape(rows, columns).astype(np.float64),
        )

    model = Model(
        n_buckets=n_buckets,
        numeric_names=numeric_names,
        mean=np.asarray(payload['scaler']['mean'], dtype=np.float64),
        scale=np.asarray(payload['scaler']['scale'], dtype=np.float64),
        heads=heads,
        trained_at=str(payload.get('trainedAt', '')),
        trained_rows=int(payload.get('trainedRows', 0)),
        metrics={str(k): float(v) for k, v in payload.get('metrics', {}).items()},
    )
    _CACHE[key] = model
    return model


def round6(value: float) -> float:
    """Round half-up to 6 decimals, matching JavaScript's ``Math.round(p * 1e6) / 1e6``.

    Python's built-in ``round`` is banker's rounding and would disagree with the TypeScript port
    on exact ties, which is precisely the kind of 1-ulp difference the parity test exists to
    catch. Both sides do the same three double operations, so both get the same answer.
    """
    return math.floor(value * 1_000_000.0 + 0.5) / 1_000_000.0


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - float(np.max(logits))
    exponentials = np.exp(shifted)
    return exponentials / float(np.sum(exponentials))


def _score(model: Model, head: Head, buckets: dict[int, float], scaled: np.ndarray) -> np.ndarray:
    """logits = W . x + b, with the text half kept sparse -- x is 99.9% zeros by construction."""
    logits = head.intercept.copy()
    if buckets:
        ids = np.fromiter(buckets.keys(), dtype=np.int64, count=len(buckets))
        values = np.fromiter(buckets.values(), dtype=np.float64, count=len(buckets))
        logits = logits + head.coef[:, ids] @ values
    logits = logits + head.coef[:, model.n_buckets :] @ scaled
    return _softmax(logits)


def _top(labels: list[str], probabilities: np.ndarray, limit: int = 3) -> list[dict[str, object]]:
    """Descending probability, ties broken by label so the fixture is stable across runs."""
    order = sorted(range(len(labels)), key=lambda index: (-probabilities[index], labels[index]))
    return [
        {'label': labels[index], 'p': round6(float(probabilities[index]))}
        for index in order[: min(limit, len(labels))]
    ]


def classify(
    model: Model, merchant_raw: str, amount: float, when_iso: str, engine: str = 'local'
) -> dict[str, object]:
    """Produce the ClassifyResult of CONTRACTS section 5, camelCase keys and all.

    The key order below is the one the contract lists; ``json.dumps`` preserves insertion order,
    which keeps the fixture diffable against the TypeScript output by eye.
    """
    buckets = text_features(merchant_raw, model.n_buckets)
    raw_numeric = np.asarray(numeric_features(float(amount), when_iso), dtype=np.float64)
    scaled = (raw_numeric - model.mean) / model.scale

    category_head = model.heads['category']
    moment_head = model.heads['moment']
    category_p = _score(model, category_head, buckets, scaled)
    moment_p = _score(model, moment_head, buckets, scaled)

    category_top = _top(category_head.labels, category_p)
    moment_top = _top(moment_head.labels, moment_p)
    return {
        'category': category_top[0]['label'],
        'categoryConfidence': category_top[0]['p'],
        'categoryTop3': category_top,
        'moment': moment_top[0]['label'],
        'momentConfidence': moment_top[0]['p'],
        'momentTop3': moment_top,
        'engine': engine,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Classify one transaction.')
    parser.add_argument('--merchant', required=True, help='raw merchant string from the statement')
    parser.add_argument('--amount', required=True, type=float, help='amount in CHF')
    parser.add_argument(
        '--when', required=True, help='YYYY-MM-DD or YYYY-MM-DDTHH:MM, local wall-clock'
    )
    parser.add_argument('--weights', default=DEFAULT_WEIGHTS, help='path to weights.json')
    args = parser.parse_args()

    model = load_model(args.weights)
    result = classify(model, args.merchant, args.amount, args.when)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
