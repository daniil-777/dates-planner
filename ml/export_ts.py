"""Export the trained pickle into the two JSON artefacts the TypeScript runtime consumes.

``ml/model/weights.json`` is the model itself (CONTRACTS section 3) and
``ml/model/parity_fixture.json`` is the evidence that the port is faithful (section 4). The
fixture is scored from the *exported* weights, not from the pickle, so a rounding or a float32
truncation bug shows up here rather than as a mystery failure in vitest.

Usage: python ml/export_ts.py
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import os
import random
import sys

import joblib
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import NUMERIC_FEATURE_NAMES  # noqa: E402
from predict import classify, load_model  # noqa: E402

FIXTURE_ROWS = 60
FIXTURE_SEED = 20260314


def _expand_head(coef: np.ndarray, intercept: np.ndarray, labels: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Give a binary head the two-row shape the TypeScript scorer expects.

    sklearn stores a two-class problem as a single row; the port has exactly one code path
    (softmax over ``shape[0]`` rows), so the contract requires ``[0, w]`` / ``[0, b]``
    (CONTRACTS section 2.5). The zero row is what makes the expansion exact:
    ``softmax([0, z]) == [1 - sigmoid(z), sigmoid(z)]``, which is sklearn's binary
    ``predict_proba``. The symmetric ``[-w, +w]`` would give ``sigmoid(2z)`` -- the same
    argmax but wrong probabilities. Both heads shipped today are multi-class, so this is
    the forward-compatibility path for a label set that ever collapses to two.
    """
    if coef.shape[0] != 1:
        return coef, intercept
    if len(labels) != 2:
        raise SystemExit(f'single-row coefficients with {len(labels)} labels -- refusing to guess')
    return np.vstack([np.zeros_like(coef[0]), coef[0]]), np.asarray([0.0, intercept[0]])


def _head_payload(head: object, labels: list[str], n_columns: int) -> dict[str, object]:
    coef = np.asarray(getattr(head, 'coef_'), dtype=np.float64)
    intercept = np.asarray(getattr(head, 'intercept_'), dtype=np.float64)
    coef, intercept = _expand_head(coef, intercept, labels)
    if coef.shape[1] != n_columns:
        raise SystemExit(f'coefficient width {coef.shape[1]} != n_buckets + numeric {n_columns}')
    if coef.shape[0] != len(labels):
        raise SystemExit(f'{coef.shape[0]} coefficient rows for {len(labels)} labels')
    flat = np.ascontiguousarray(coef, dtype='<f4')
    return {
        'labels': labels,
        'intercept': [float(value) for value in intercept],
        'shape': [int(coef.shape[0]), int(coef.shape[1])],
        'coefB64': base64.b64encode(flat.tobytes(order='C')).decode('ascii'),
    }


def write_weights(bundle: dict[str, object], path: str) -> dict[str, object]:
    """Serialise scaler + both heads as float32 base64, row-major (CONTRACTS section 3)."""
    n_buckets = int(bundle['n_buckets'])
    n_columns = n_buckets + len(NUMERIC_FEATURE_NAMES)
    scaler = bundle['scaler']
    labels = bundle['labels']
    heads = bundle['heads']
    metrics = bundle['metrics']

    payload = {
        'version': 1,
        'nBuckets': n_buckets,
        'numericFeatures': list(NUMERIC_FEATURE_NAMES),
        'scaler': {
            'mean': [float(value) for value in getattr(scaler, 'mean_')],
            'scale': [float(value) for value in getattr(scaler, 'scale_')],
        },
        # Local wall-clock with no suffix: the app renders it next to expense dates, which are
        # also local, and a Z here would silently shift the "trained on" line by an hour.
        'trainedAt': dt.datetime.now().replace(microsecond=0).isoformat(),
        'trainedRows': int(bundle['trained_rows']),
        'metrics': {
            'categoryAccuracy': float(metrics['category_accuracy']),
            'momentF1': float(metrics['moment_macro_f1']),
        },
        'heads': {
            'category': _head_payload(heads['category'], list(labels['category']), n_columns),
            'moment': _head_payload(heads['moment'], list(labels['moment']), n_columns),
        },
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return payload


def _sample_rows(csv_path: str, count: int, seed: int) -> list[dict[str, str]]:
    """Sample from the whole CSV with a fixed seed so the fixture is reproducible and varied."""
    with open(csv_path, newline='', encoding='utf-8') as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise SystemExit(f'{csv_path} has no data rows')
    rng = random.Random(seed)
    if len(rows) <= count:
        return rows
    return [rows[index] for index in sorted(rng.sample(range(len(rows)), count))]


def write_fixture(csv_path: str, weights_path: str, out_path: str, source_label: str) -> int:
    """Freeze 60 scored rows so vitest can prove the TypeScript port agrees to 1e-4."""
    model = load_model(weights_path)
    fixture_rows = []
    for row in _sample_rows(csv_path, FIXTURE_ROWS, FIXTURE_SEED):
        merchant_raw = row['merchant_raw']
        amount = float(row['amount_chf'])
        when_iso = f'{row["date"]}T{row["time"]}'
        fixture_rows.append(
            {
                'merchantRaw': merchant_raw,
                'amount': amount,
                'whenISO': when_iso,
                'expected': classify(model, merchant_raw, amount, when_iso),
            }
        )
    payload = {
        'generatedFrom': source_label,
        'nBuckets': model.n_buckets,
        'rows': fixture_rows,
    }
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return len(fixture_rows)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    parser = argparse.ArgumentParser(description='Export weights.json and parity_fixture.json.')
    parser.add_argument('--model', default=os.path.join(here, 'model', 'model.pkl'))
    parser.add_argument('--csv', default=os.path.join(here, 'data', 'transactions.csv'))
    parser.add_argument('--weights', default=os.path.join(here, 'model', 'weights.json'))
    parser.add_argument('--fixture', default=os.path.join(here, 'model', 'parity_fixture.json'))
    args = parser.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(f'{args.model} not found -- run "python ml/train.py" first')
    bundle = joblib.load(args.model)

    payload = write_weights(bundle, args.weights)
    size = os.path.getsize(args.weights)
    for name, head in payload['heads'].items():
        rows, columns = head['shape']
        decoded = len(base64.b64decode(head['coefB64'])) // 4
        status = 'ok' if decoded == rows * columns else 'MISMATCH'
        print(f'head {name:<9} shape {rows}x{columns} -> {decoded} float32 values ({status})')
    print(f'wrote {args.weights} ({size} bytes, {size / 1_048_576:.2f} MiB)')
    print(f'  trainedAt   {payload["trainedAt"]}')
    print(f'  trainedRows {payload["trainedRows"]}')
    print(f'  metrics     {payload["metrics"]}')

    written = write_fixture(
        args.csv, args.weights, args.fixture, os.path.relpath(args.csv, repo).replace(os.sep, '/')
    )
    print(f'wrote {args.fixture} ({written} rows, {os.path.getsize(args.fixture)} bytes)')


if __name__ == '__main__':
    main()
