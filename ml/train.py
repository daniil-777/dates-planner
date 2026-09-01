"""Train the two-head expense classifier (category + moment) on the transaction CSV.

Both heads share one feature matrix -- hashed char n-grams of the normalised merchant string,
concatenated with seven standardised numeric features -- and differ only in their target. That
sharing is deliberate: the merchant string is what identifies the category, while the same
string plus the clock is what hints at the moment, so one featurisation serves both and the
TypeScript port only ever has to build the vector once.

The hashing is done by ``features.hashed_ngram_ids`` rather than sklearn's HashingVectorizer
because the TypeScript side has to reproduce it exactly; HashingVectorizer's sign alternation
and its internal Murmur3 are not something we want to reimplement in JavaScript.

Usage: python ml/train.py --n-buckets 65536
"""

from __future__ import annotations

import argparse
import os
import sys

import joblib
import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import (  # noqa: E402
    NUMERIC_FEATURE_NAMES,
    numeric_features,
    text_features,
)

# The text block is L2-normalised, so each individual feature is small (~0.1) and the default
# C=1.0 regularises the model into permanent under-confidence. C=12 lets the merchant n-grams
# actually separate the ten categories while still keeping the moment head honest about the
# 8% of labels that are noise by construction.
INVERSE_REGULARISATION = 12.0
MAX_ITER = 2000
SOLVER = 'lbfgs'


def load_frame(csv_path: str) -> pd.DataFrame:
    """Read the CSV and fail loudly on a schema drift rather than training on the wrong columns."""
    frame = pd.read_csv(csv_path, dtype={'time': str})
    expected = ['date', 'time', 'merchant_raw', 'amount_chf', 'payer', 'category', 'moment']
    missing = [column for column in expected if column not in frame.columns]
    if missing:
        raise SystemExit(f'{csv_path} is missing columns: {", ".join(missing)}')
    # ``date`` is in the subset because a missing one would reach parse_when as the string "nan"
    # and die there with a message that points at the featuriser instead of at the CSV.
    frame = frame.dropna(subset=['date', 'merchant_raw', 'amount_chf', 'category', 'moment'])
    frame['time'] = frame['time'].fillna('12:00')
    return frame.reset_index(drop=True)


def build_text_matrix(merchants: list[str], n_buckets: int) -> sparse.csr_matrix:
    """Assemble the CSR matrix by hand so the hashing stays the one in ``features.py``.

    Building the three CSR arrays directly avoids materialising a 65k-wide dense row per
    transaction, and keeps the ordering of the indices sorted, which is what the exporter and
    the TypeScript scorer both assume.
    """
    indptr = [0]
    indices: list[int] = []
    data: list[float] = []
    for raw in merchants:
        buckets = text_features(raw, n_buckets)
        for bucket in sorted(buckets):
            indices.append(bucket)
            data.append(buckets[bucket])
        indptr.append(len(indices))
    return sparse.csr_matrix(
        (np.asarray(data, dtype=np.float64), np.asarray(indices, dtype=np.int32), np.asarray(indptr, dtype=np.int64)),
        shape=(len(merchants), n_buckets),
        dtype=np.float64,
    )


def build_numeric_matrix(frame: pd.DataFrame) -> np.ndarray:
    """Seven dense columns per row, in the contract order (CONTRACTS section 2.4)."""
    values = np.empty((len(frame), len(NUMERIC_FEATURE_NAMES)), dtype=np.float64)
    for position, (date, time, amount) in enumerate(
        zip(frame['date'], frame['time'], frame['amount_chf'])
    ):
        values[position] = numeric_features(float(amount), f'{date}T{time}')
    return values


def _fit_head(matrix: sparse.csr_matrix, labels: np.ndarray) -> LogisticRegression:
    head = LogisticRegression(
        C=INVERSE_REGULARISATION,
        max_iter=MAX_ITER,
        solver=SOLVER,
        n_jobs=None,
    )
    head.fit(matrix, labels)
    return head


def _combine(text: sparse.csr_matrix, numeric: np.ndarray) -> sparse.csr_matrix:
    return sparse.hstack([text, sparse.csr_matrix(numeric)], format='csr')


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description='Train the two-head expense classifier.')
    parser.add_argument('--csv', default=os.path.join(here, 'data', 'transactions.csv'))
    parser.add_argument('--n-buckets', type=int, default=65536)
    parser.add_argument('--out', default=os.path.join(here, 'model', 'model.pkl'))
    parser.add_argument('--test-size', type=float, default=0.2)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()

    frame = load_frame(args.csv)
    print(f'loaded {len(frame)} rows from {args.csv}')

    text = build_text_matrix([str(value) for value in frame['merchant_raw']], args.n_buckets)
    numeric = build_numeric_matrix(frame)
    categories = frame['category'].to_numpy()
    moments = frame['moment'].to_numpy()

    # Stratify on category: Travel and Health are thin enough that an unlucky split would
    # otherwise leave a class almost absent from the test fold and make the report meaningless.
    train_idx, test_idx = train_test_split(
        np.arange(len(frame)),
        test_size=args.test_size,
        random_state=args.seed,
        stratify=categories,
    )

    eval_scaler = StandardScaler().fit(numeric[train_idx])
    x_train = _combine(text[train_idx], eval_scaler.transform(numeric[train_idx]))
    x_test = _combine(text[test_idx], eval_scaler.transform(numeric[test_idx]))

    category_eval = _fit_head(x_train, categories[train_idx])
    moment_eval = _fit_head(x_train, moments[train_idx])

    category_pred = category_eval.predict(x_test)
    moment_pred = moment_eval.predict(x_test)

    print('\n=== category head (held-out) ===')
    print(classification_report(categories[test_idx], category_pred, digits=3, zero_division=0))
    print('=== moment head (held-out) ===')
    print(classification_report(moments[test_idx], moment_pred, digits=3, zero_division=0))

    category_accuracy = float(accuracy_score(categories[test_idx], category_pred))
    moment_macro_f1 = float(f1_score(moments[test_idx], moment_pred, average='macro'))
    moment_accuracy = float(accuracy_score(moments[test_idx], moment_pred))

    # The held-out numbers above are the honest estimate; the artefact we ship is refit on every
    # row, because throwing away 20% of an already small ledger would cost real accuracy in the
    # app for no benefit once the estimate has been taken.
    final_scaler = StandardScaler().fit(numeric)
    x_all = _combine(text, final_scaler.transform(numeric))
    category_head = _fit_head(x_all, categories)
    moment_head = _fit_head(x_all, moments)

    bundle = {
        'version': 1,
        'n_buckets': args.n_buckets,
        'numeric_feature_names': list(NUMERIC_FEATURE_NAMES),
        'scaler': final_scaler,
        'heads': {'category': category_head, 'moment': moment_head},
        'labels': {
            'category': [str(label) for label in category_head.classes_],
            'moment': [str(label) for label in moment_head.classes_],
        },
        'metrics': {
            'category_accuracy': category_accuracy,
            'moment_macro_f1': moment_macro_f1,
            'moment_accuracy': moment_accuracy,
        },
        'trained_rows': int(len(frame)),
        'source_csv': os.path.relpath(args.csv, os.path.dirname(here)),
        'test_size': args.test_size,
        'seed': args.seed,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    joblib.dump(bundle, args.out)

    print(f'category accuracy {category_accuracy:.4f}')
    print(f'moment macro F1   {moment_macro_f1:.4f}')
    print(f'moment accuracy   {moment_accuracy:.4f}')
    print(f'saved {args.out} ({os.path.getsize(args.out)} bytes, {len(frame)} rows, '
          f'{args.n_buckets} buckets)')


if __name__ == '__main__':
    main()
