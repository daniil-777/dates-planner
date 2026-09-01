# `ml/` — the trainer behind the two-head classifier

Python trains the model; **TypeScript runs it**. Nothing in this directory is on the request
path of the app. `ml/export_ts.py` emits two JSON files that `srv/lib/classifier` loads, and
`test/classifier-parity.test.ts` proves the two languages agree to `1e-4`.

Everything here implements `docs/CONTRACTS.md` sections 2–5. That document is authoritative: if
a change here contradicts it, the change is wrong.

## The model in one paragraph

Two independent multinomial logistic-regression heads share one feature vector:

- **text** — the merchant string is normalised (umlauts transliterated, dates/terminal ids/card
  numbers stripped, punctuation collapsed), cut into character n-grams of length 2–4 inside word
  boundaries, hashed with `zlib.crc32` into 65 536 buckets, and L2-normalised;
- **numeric** — seven dense features (`log_amount`, `is_weekend`, `is_evening`, and sine/cosine
  encodings of the hour and the weekday), standardised.

`category` is answered almost entirely by the text half. `moment` needs both: which shop it was
*and* whether it was a Saturday evening for CHF 148.

Hashing rather than a learned vocabulary is what makes the port cheap — there is no dictionary
to ship, only weights, and `crc32` exists in both standard libraries.

## Files

| File | What it is |
|---|---|
| `features.py` | **The single source of truth for featurisation.** Pure stdlib + numpy, no sklearn. `srv/lib/classifier/features.ts` is a port of this file. |
| `generate_data.py` | Writes `data/transactions.csv` — ~4 000 synthetic Swiss card transactions from a fixed seed. |
| `train.py` | Builds the sparse matrix, fits both heads, prints held-out reports, writes `model/model.pkl`. |
| `export_ts.py` | Writes `model/weights.json` (CONTRACTS §3) and `model/parity_fixture.json` (§4). |
| `predict.py` | Reference inference **from `weights.json`**, plus a one-shot CLI. |
| `serve.py` | Stdlib HTTP sidecar with the same JSON contract, for `CLASSIFIER_URL`. |

`model/model.pkl` is gitignored; `weights.json` and `parity_fixture.json` are committed, because
the app and the test suite need them and they are the actual deliverable.

## Running it

Dependencies are already installed in `ml/.venv` (`npm run ml:setup` recreates it). Always use
that interpreter — the system Python will not have scikit-learn.

```bash
npm run ml:gen      # ml/.venv/bin/python ml/generate_data.py    -> data/transactions.csv
npm run ml:train    # ml/.venv/bin/python ml/train.py --n-buckets 65536 -> model/model.pkl
npm run ml:export   # ml/.venv/bin/python ml/export_ts.py        -> model/weights.json + parity_fixture.json
npx vitest run test/classifier-parity.test.ts
```

Regenerating is only necessary if you change `generate_data.py`; the CSV is deterministic, so a
re-run with the same seed produces a byte-identical file.

Classify a single transaction:

```bash
ml/.venv/bin/python ml/predict.py \
  --merchant "RESTAURANT BLAUE ENTE" --amount 148.5 --when 2026-03-14T20:15
```

Run it as a remote classifier instead of the in-process TypeScript one:

```bash
ml/.venv/bin/python ml/serve.py --port 8088     # then CLASSIFIER_URL=http://127.0.0.1:8088/
curl -s localhost:8088/health
curl -s localhost:8088/ -H 'Content-Type: application/json' \
  -d '{"merchantRaw":"MIGROS ZUERICH","amount":42.10,"whenISO":"2026-03-14T18:05"}'
```

`GET /health` reports `trainedAt`, `trainedRows` and the metrics, so a deployment can be
identified without shipping the weights around. `POST` answers with the CONTRACTS §5
`ClassifyResult` and sets `"engine": "remote"` — a result that arrived over `CLASSIFIER_URL` is
remote from the app's point of view, so the TypeScript side can pass the body straight through.
The CLI (`predict.py`) says `"local"` for the same reason. Error responses never quote the
request back; the body is the household's data.

## Useful flags

`train.py`: `--csv` (default `data/transactions.csv`), `--n-buckets` (65536), `--out`
(`model/model.pkl`), `--test-size` (0.2), `--seed` (42).
`generate_data.py`: `--rows` (4000), `--seed` (20240615), `--out`.
`export_ts.py`: `--model`, `--csv`, `--weights`, `--fixture`.

## Retraining on the real ledger

`npm run ml:export-data` dumps confirmed expenses (with `Corrections` applied, so the human's
last word wins) into a CSV with exactly these columns:

```
date,time,merchant_raw,amount_chf,payer,category,moment
```

Then point the trainer at it and re-export:

```bash
ml/.venv/bin/python ml/train.py --csv ml/data/live_transactions.csv --n-buckets 65536
ml/.venv/bin/python ml/export_ts.py
```

Keep `--n-buckets` at 65536 unless you also change it everywhere: it is baked into
`weights.json`, into the fixture, and into the width of every coefficient row.

> **`npm run ml:retrain` is missing a flag.** It chains `ml:export-data` (which writes the live
> CSV) into `ml:train`, but `ml:train` passes no `--csv`, so the trainer falls back to its
> default `ml/data/transactions.csv` and quietly retrains on the synthetic corpus. Until
> `--csv ml/data/live_transactions.csv` is added to that script in `package.json`, run the two
> commands above by hand. `train.py` prints the CSV it loaded on its first line — check it.

## What the numbers mean

`train.py` splits the rows 80/20 (stratified on category), reports on the held-out fifth, and
then **refits both heads on all the rows** for the artefact it ships — the estimate comes from
data the model never saw, but there is no reason to throw away a fifth of an already small
ledger once the estimate has been taken. Current run:

```
category accuracy 0.9975      (held out, 800 rows)
moment macro F1   0.8392
moment accuracy   0.8875
```

- **category accuracy ≈ 1.0 is expected and not a bug.** Each merchant belongs to exactly one
  category, so once the model has seen `KRONENHALLE` the answer is not in doubt. It only tells
  you the text pipeline works; it says nothing about how the model behaves on a shop it has
  never seen.
- **moment macro F1 ≈ 0.84 is the number that matters,** and it is capped by construction.
  `moment` is drawn from a distribution over the merchant's "romance", the hour, the weekday
  and the amount, and then **8% of the labels are flipped at random**. A classifier that scored
  1.0 would have memorised noise. Macro (not weighted) F1 is reported deliberately: `everyday`
  is two thirds of the data and would otherwise hide bad performance on `gift` and `date_night`.
- **Per-class F1 is where to look for regressions.** `date_night` is the weakest (0.722) because
  it is the one genuinely subjective label — a Tuesday dinner at a mid-range restaurant is a
  coin flip, which is exactly why the app sends anything under the 0.6 confidence threshold to a
  human instead of posting it silently.

Confidence is real probability mass, not a score: `categoryConfidence` is the winning label's
softmax output. The app's `NEEDS_REVIEW_THRESHOLD` of 0.6 depends on that, which is why the
heads are trained without `class_weight='balanced'` — balancing raises minority recall but
distorts the probabilities the review queue is thresholding on, and measurably *lowered* macro
F1 here (0.8392 → 0.7664 on the same split).

Both heads see the numeric block, so an amount far outside a merchant's usual range pulls the
category prediction around. Measured against the shipped weights:

| merchant | amount | when | category | confidence |
|---|---|---|---|---|
| `STARBUCKS` | 7.50 | Tue 08:30 | `Cafes` | 0.999 |
| `STARBUCKS` | 40.00 | Sat 19:30 | `Cafes` | 0.785 |
| `STARBUCKS` | 80.00 | Sat 19:30 | `Cafes` | 0.362 |
| `STARBUCKS` | 150.00 | Sat 19:30 | `Travel` | 0.415 |

That is the intended failure mode rather than a defect: the merchant string still wins as long as
the ticket is plausible, and once it is not, confidence falls through `NEEDS_REVIEW_THRESHOLD`
(0.6) well before the label flips — so the expense lands in the review queue instead of being
posted on a bad guess. An entirely unseen merchant behaves the same way: `ZZZQQQ UNKNOWN SHOP`
scores 0.379 and is routed to a human.

## Three edges worth knowing

- **`char_wb` and one-character words.** scikit-learn emits a word shorter than the n-gram
  window once, for the first such `n`, and then stops widening — `features.char_wb_ngrams`
  copies that exactly, and CONTRACTS §2.2 specifies it. `generate_data.py` asserts that no
  normalised merchant string in the corpus contains a one-character token, so the parity fixture
  can never come to depend on the subtlest line in the contract.
- **Binary head expansion.** CONTRACTS §2.5 requires a two-class head to be exported as two rows
  `[-w, +w]` / `[-b, +b]` so the TypeScript scorer has a single code path. Note that
  `softmax([-z, +z])` is `sigmoid(2z)`, not `sigmoid(z)`: the argmax is unchanged but the
  confidence is sharpened relative to sklearn's own `predict_proba`. Neither shipped head is
  binary (10 and 4 classes), so this only matters if a label set ever collapses to two.
- **`whenISO` fields are read like `parseInt`, not like `int()`.** `features.parse_when` takes the
  leading digits of each field and drops the rest, so `2026-03-14T20:15+02:00` and
  `...T20:15:00Z` both read as 20:15 local — CONTRACTS §2.4 says to read the wall clock and never
  UTC-shift, and a zone suffix has to be ignored rather than crash the featuriser. The
  TypeScript port must use `parseInt`; `Number('15+02')` is `NaN` and would diverge.

## Parity

`export_ts.py` scores the fixture **from the freshly written `weights.json`**, not from the
pickle, so the Python numbers in `parity_fixture.json` start from the same float32 bits the
TypeScript port reads. Residual difference against sklearn's own float64 `predict_proba` over
the 60 fixture rows is ~5e-7, well inside the 1e-4 the test allows.

Probabilities are rounded to 6 decimals on both sides with `floor(p * 1e6 + 0.5) / 1e6` —
half-up, matching JavaScript's `Math.round`. Python's built-in `round` is banker's rounding and
would disagree on ties.

If the parity test fails, the cause is almost always in `normalise_merchant` or
`char_wb_ngrams`: dump both sides' n-gram lists for the failing row before looking anywhere else.
