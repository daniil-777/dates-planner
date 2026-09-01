# The two-head classifier

Every expense that enters the app gets two labels: a **category**
(`Groceries`, `Dining`, `Cafes`, …) and a **moment** (`everyday`, `date_night`,
`trip`, `gift`). One model, one feature vector, two independent linear heads on
top of it.

Training happens in Python, in `/ml`. Inference happens in TypeScript, in
`/srv/lib/classifier`, inside the CAP process. The two implementations are the
same maths written twice, and a parity fixture is what stops them from quietly
drifting apart.

> **The normative spec is `docs/CONTRACTS.md` §2–§5.** Every formula, regex,
> field name, rounding rule and key order lives there. This document explains
> _why_ the pipeline looks like that and how to operate it; where the two
> disagree, CONTRACTS.md wins and this file is the bug.

---

## 1. Why linear, and why these features

A logistic regression over hashed character n-grams is an unfashionable choice
and the right one here:

- The signal is almost entirely **in the merchant string**. "MIGROS M
  BAHNHOFSTR" is groceries; "RESTAURANT BLAUE ENTE" is dining. Character
  n-grams pick that up from a handful of examples and survive OCR noise,
  abbreviations, branch suffixes and the fact that Document AI sometimes returns
  `MIGROS MM ZUERICH HB` and sometimes `Migros MM Zürich HB`.
- The rest is **time and amount**. A CHF 12.80 purchase at 08:05 on a Thursday
  is a coffee; CHF 148.50 at 20:15 on a Saturday is a date night. Seven numeric
  features carry that.
- A linear model is a matrix multiply. Porting it to TypeScript is a hundred
  lines, not a runtime.
- A household generates a few thousand rows a year. Anything with more capacity
  would memorise them.

The heads are separate because the label sets are unrelated: a `Cafes` expense
can be `everyday` or `date_night`, and forcing one joint label set would make
the model learn the cross-product of two things it already knows separately.

---

## 2. The pipeline, walked through one receipt

Normative definition: `docs/CONTRACTS.md` §2. What follows is one real string
flowing through it. Every number below was computed with the reference
implementation, so you can paste the intermediate values into a REPL and check.

**Input**

```
merchantRaw = "Café Zürich Nr. 42 12.03.2026 08:05"
amount      = 12.80
whenISO     = "2026-03-12T08:05"
```

### 2.1 `normaliseMerchant` — six steps, in this order

| #   | Step                                              | Result                                 |
| --- | ------------------------------------------------- | -------------------------------------- |
| 1   | lowercase                                         | `café zürich nr. 42 12.03.2026 08:05`  |
| 2   | German transliteration (`ä→ae ö→oe ü→ue ß→ss`)    | `café zuerich nr. 42 12.03.2026 08:05` |
| 3   | NFKD, drop combining marks                        | `cafe zuerich nr. 42 12.03.2026 08:05` |
| 4a  | strip dates                                       | `cafe zuerich nr. 42 ␣ 08:05`          |
| 4b  | strip times                                       | `cafe zuerich nr. 42 ␣ ␣`              |
| 4c  | strip reference ids (`nr\|no\|ref\|trx\|tid\|kd`) | `cafe zuerich ␣ ␣ ␣`                   |
| 4d  | strip digit runs of 4+                            | _(nothing left to strip)_              |
| 5   | everything outside `[a-z0-9 ]` → space            | _(unchanged; the `.` went with 4c)_    |
| 6   | collapse whitespace, trim                         | **`cafe zuerich`**                     |

(`␣` marks a space the regex left behind — each pattern replaces its match with a
single space, and step 6 is what finally cleans up after them.)

Step 2 has to run **before** step 3, and that ordering is the single most
load-bearing line in the whole pipeline. `ü` under NFKD decomposes to `u` +
combining diaeresis, and dropping the mark gives `zurich`. German receipts write
`zürich`, `zuerich` and `ZURICH` interchangeably; transliterating first makes all
three collapse to `zuerich`. Get the order wrong and you get a model that works
until someone photographs a receipt from a printer that cannot do umlauts.

Step 4 exists because a till receipt's merchant line is full of one-shot noise —
transaction ids, timestamps, terminal numbers. Left in, every receipt from the
same shop hashes to a different set of n-grams and the model learns nothing.

### 2.2 `charWbNgrams` — 33 n-grams

Words are split on spaces and each is **padded with one space on each side**:
`" cafe "` and `" zuerich "`. Padding is what makes word boundaries visible to a
character model — `" ca"` (start of a word) and `"ca "` (end of a word) are
different features, and that distinction is most of why `char_wb` beats plain
`char`.

For each padded word and each `n` in 2..4, every contiguous slice is emitted:

```
" cafe "  n=2 → " c" "ca" "af" "fe" "e "          (5)
          n=3 → " ca" "caf" "afe" "fe "           (4)
          n=4 → " caf" "cafe" "afe "              (3)
" zuerich " n=2 → 8, n=3 → 7, n=4 → 6            (21)
                                          total = 33
```

Order is word by word, then `n` ascending, then left to right, and duplicates are
**kept** — they become counts. (For a word shorter than `n`, the padded word is
emitted once for that `n` and not sliced. `"a"` → `" a "` is a 3-gram, not three
of them.)

### 2.3 `hashedNgramIds` — crc32 into 65 536 buckets

Each n-gram becomes a column index:

```
id = crc32(utf8(ngram)) % nBuckets          nBuckets = 65536
```

| n-gram   | `zlib.crc32`  | bucket |
| -------- | ------------- | ------ |
| `" ca"`  | 3 010 066 008 | 63 064 |
| `"caf"`  | 1 843 868 384 | 13 024 |
| `"cafe"` | 1 337 818 896 | 32 528 |
| `"afe "` | 3 445 639 106 | 18 370 |

The hash must be _exactly_ Python's `zlib.crc32`: IEEE 802.3, reflected, init
`0xFFFFFFFF`, final XOR, and — the part that bites — **unsigned**. JavaScript's
bitwise operators produce a signed 32-bit result, so a crc32 implementation that
forgets a `>>> 0` returns negative numbers for half of all inputs, and
`-1284901288 % 65536` is not `63064`. Same n-gram, different column, silently
wrong predictions on roughly half the features.

Hashing instead of keeping a vocabulary means there is no dictionary to ship, no
train/serve vocabulary skew, and a merchant the model has never seen still lands
in columns that other merchants share — `"cafe"` is `"cafe"` whether or not this
particular café was in the training set. The price is collisions; at 65 536
buckets against a few thousand distinct n-grams they are rare and, being random,
mostly harmless.

Counts are accumulated (`+1.0` per occurrence) and the vector is
**L2-normalised**. Here all 33 n-grams land in 33 distinct buckets with count 1,
so the norm is `sqrt(33) = 5.744563` and every non-zero entry becomes
`1 / 5.744563 = 0.174078`. Normalisation is what makes a long merchant string
and a short one comparable: without it, `"MIGROS SUPERMARKT ZUERICH HAUPTBAHNHOF"`
would simply have larger features than `"COOP"` and the model would learn
string length.

The result is sparse — 33 non-zero entries out of 65 536 — and is kept sparse.
The dot product only visits those 33 columns.

### 2.4 `numericFeatures` — seven numbers

Fixed order, and the order _is_ the contract (it is `numericFeatures` in
`weights.json`):

| #   | name                              | value here  |
| --- | --------------------------------- | ----------- |
| 0   | `log_amount` = `log1p(12.80)`     | ` 2.624669` |
| 1   | `is_weekend` (Thursday)           | ` 0.000000` |
| 2   | `is_evening` (08:05 < 18:00)      | ` 0.000000` |
| 3   | `hour_sin` = `sin(2π·8.0833/24)`  | ` 0.854912` |
| 4   | `hour_cos`                        | `-0.518773` |
| 5   | `dow_sin` = `sin(2π·3/7)` (Mon=0) | ` 0.433884` |
| 6   | `dow_cos`                         | `-0.900969` |

`log1p` because expense amounts are log-distributed and a CHF 5 / CHF 50
difference matters far more than CHF 500 / CHF 545. Sin/cos pairs because hour
and weekday are **circular**: 23:00 and 01:00 are two hours apart, not
twenty-two, and a linear feature cannot say that.

The timestamp is parsed as **local wall-clock**, never UTC-shifted. A receipt
from 20:15 is a date night in the timezone where the dinner happened; converting
it to UTC turns a Zurich Saturday evening into a Sunday, flips `is_weekend` on
some rows and `is_evening` on others. In TypeScript that means never handing
`"2026-03-12T08:05"` to `new Date()` without controlling the parse — the same
string with a `Z` is a different receipt. A missing time means 12:00, which is
deliberately the least informative hour of the day.

These seven are then standardised with the scaler from training:
`(value − mean) / scale`, using the arrays in `weights.json`. With the model
currently in the repo —

```
scaler.mean  [ 3.6001, 0.2595, 0.3100, -0.2955, -0.2468, -0.0012, -0.0878 ]
scaler.scale [ 1.0768, 0.4384, 0.4625,  0.7037,  0.5971,  0.7028,  0.7059 ]
```

— the scaled row for this receipt is

```
[ -0.9059, -0.5920, -0.6703, 1.6348, -0.4554, 0.6191, -1.1519 ]
```

Retrain and those two arrays change. The pipeline above them does not.

### 2.5 Concatenate, multiply, softmax

```
x      = [ 65536 sparse text features | 7 scaled numeric features ]   length 65543
logits = coef · x + intercept          coef is [nClasses, 65543], float32
p      = softmax(logits)               max-subtracted for stability
```

The max subtraction is not optional politeness — `exp(800)` is `Infinity` and
the result becomes `NaN`. Subtracting the maximum logit changes nothing
mathematically and everything numerically.

Category head — 10 classes, labels sorted **ascending** so the row index _is_ the
label index. (Note that `CATEGORIES` in `ml/features.py` is in _display_ order,
which is a different order and is **not** the label order. The label order is
whatever sklearn's `classes_` reports, and `weights.json` records it.)

| label                         | logit  | p            |
| ----------------------------- | ------ | ------------ |
| **Cafes**                     | 7.899  | **0.995234** |
| Transport                     | 2.208  | 0.003363     |
| Groceries                     | 0.157  | 0.000432     |
| Entertainment                 | −0.044 | 0.000354     |
| Dining                        | −0.387 | 0.000251     |
| … five more, all below 0.0002 |        |              |

Moment head, 4 classes:

| label        | logit  | p            |
| ------------ | ------ | ------------ |
| **everyday** | 3.233  | **0.949561** |
| trip         | −0.299 | 0.027757     |
| date_night   | −0.694 | 0.018698     |
| gift         | −2.240 | 0.003984     |

### 2.6 What comes back

Probabilities are rounded to **6 decimals in both languages** before returning —
not for display, but so the parity test compares like with like instead of
chasing the last bits of a float64.

```json
{
  "category": "Cafes",
  "categoryConfidence": 0.995234,
  "categoryTop3": [
    { "label": "Cafes", "p": 0.995234 },
    { "label": "Transport", "p": 0.003363 },
    { "label": "Groceries", "p": 0.000432 }
  ],
  "moment": "everyday",
  "momentConfidence": 0.949561,
  "momentTop3": [
    { "label": "everyday", "p": 0.949561 },
    { "label": "trip", "p": 0.027757 },
    { "label": "date_night", "p": 0.018698 }
  ],
  "engine": "local"
}
```

Every number in this walkthrough is reproducible — that is the point of writing
it out. Check it yourself:

```bash
ml/.venv/bin/python ml/predict.py \
  --merchant 'Café Zürich Nr. 42 12.03.2026 08:05' \
  --amount 12.80 --when '2026-03-12T08:05'
```

Both confidences are above the review threshold of 0.6
(`NEEDS_REVIEW_THRESHOLD`, `docs/CONTRACTS.md` §1.4), so the confirm card opens
in its normal state. Under 0.6 the uncertain field is highlighted and the card
says "Two-way match needed — please confirm". The top-3 lists drive the category
chips: the model's ordering is a suggestion, and one tap overrides it.

---

## 3. Why inference is TypeScript

Python trains. Node serves. There is no Python in the request path, ever.

- **One process, one container.** The app is a single CAP process on a 512 MB
  VM. Adding a Python sidecar means a second process, a second image layer with
  numpy and scikit-learn in it (hundreds of megabytes), a health check, a
  restart policy, and a class of failure — "the sidecar is up but not ready" —
  that a matrix multiply does not deserve.
- **Latency and cold starts.** The port is a dot product over 33 non-zero
  columns plus a 7-element dense tail. It is microseconds, in-process, with no
  serialisation. A subprocess spawn per classification is milliseconds at best
  and a Python interpreter start at worst.
- **Deployment honesty.** `scanReceipt` classifies inline before returning the
  draft. If classification can fail because a sidecar is restarting, the scan
  flow can fail, and the scan flow is the app.
- **Types.** `ClassifyResult` (`docs/CONTRACTS.md` §5) is checked at compile
  time by the same compiler that checks the CAP handlers.

Python stays the trainer because that is where the honest tooling lives:
scikit-learn's `LogisticRegression`, `StandardScaler`, cross-validation, class
reports. Reimplementing _training_ in TypeScript would be the actual mistake.

The bridge is `ml/model/weights.json` (`docs/CONTRACTS.md` §3): buckets, scaler,
labels, intercepts, and each head's coefficient matrix as base64 float32,
row-major. `ml/export_ts.py` writes it. `srv/lib/classifier/model.ts` reads it
once into a `Float32Array` and caches it; `reloadModel()` drops the cache so a
freshly retrained model can be picked up without restarting the server.

One detail worth knowing because it looks like a bug: when a head ends up with
exactly two classes, scikit-learn stores a **single** row of coefficients and
one intercept. `export_ts.py` expands that into two rows — a **zero row** and
the real one, `[0, w]`, with intercepts `[0, b]` — so the TypeScript side has
exactly one code path and a `softmax` over two rows reproduces the sigmoid
exactly.

The zero row is not a stylistic choice, and the symmetric-looking alternative is
wrong. scikit-learn's binary `predict_proba` is `sigmoid(z)` for `z = w·x + b`.
Since `softmax([0, z]) = [1 − sigmoid(z), sigmoid(z)]`, the `[0, w]` expansion is
exact. Expanding to `[-w, +w]` instead gives `softmax([-z, +z]) = sigmoid(2z)` —
the same argmax, so every label still agrees and no accuracy metric moves, but
every probability is wrong. Both heads shipped today are multi-class, so nothing
currently reaches this path and the parity fixture cannot exercise it; see
CONTRACTS §2.5 and the dedicated binary-head test in
`test/classifier-parity.test.ts`, which asserts `softmax([0, z])[1] === sigmoid(z)`
across a range of `z`.

### 3.1 The remote escape hatch

If `CLASSIFIER_URL` is set, `classify()` POSTs `{merchantRaw, amount, whenISO}`
there instead and returns the response with `engine: 'remote'`, sending
`Authorization: Bearer ${CLASSIFIER_TOKEN}` and
`AI-Resource-Group: ${CLASSIFIER_RESOURCE_GROUP}` when those are set. **Any**
remote failure falls back to local inference with a warning — never the payload,
which contains merchant names. `ml/predict.py` and `ml/serve.py` speak the same
JSON, camelCase keys included, so a Python sidecar or an SAP AI Core deployment
drops in without a code change. See `docs/AI_CORE.md`.

---

## 4. The parity fixture is the load-bearing test

`ml/model/parity_fixture.json` (`docs/CONTRACTS.md` §4) is 60 rows sampled from
the training CSV, each with the merchant string, amount, timestamp, and the
**full `ClassifyResult` that Python produced**. `test/classifier-parity.test.ts`
runs the TypeScript pipeline over all 60 and asserts every probability matches
to `1e-4`.

Why a fixture and not "we wrote tests for both": because the failure mode here is
not a crash, it is a _drift_. Two implementations of the same maths agree on the
easy cases and disagree on the ones you did not think of. The fixture is 60
adversarial-by-accident real rows, and it fails loudly the moment the two sides
stop being the same model. Everything on this list is a real way to get it
wrong, and each of them passes a unit test written against itself:

- signed vs unsigned crc32 (§2.3) — wrong on about half of all n-grams;
- transliteration after NFKD instead of before — `zurich` vs `zuerich`;
- `toLowerCase()` under a Turkish locale — `I` → `ı`, and every n-gram
  containing an `i` moves;
- JavaScript `normalize('NFKD')` keeping a mark Python's `unicodedata` drops;
- an off-by-one in the padded-word slicing so the final `n`-gram is missed;
- `Date.parse` treating a bare `YYYY-MM-DDTHH:MM` as UTC, shifting `is_weekend`;
- accumulating the dot product in float32 instead of float64 (accumulate wide,
  store narrow);
- rounding on one side only;
- `export_ts.py` writing the coefficient matrix column-major, which looks fine
  for a square-ish head and is catastrophic otherwise.

A green parity test means the model that was measured is the model that runs.
That is the whole claim, and it is worth a test file.

**When it fails after a retrain,** the suspect is almost always the exporter or a
changed hyper-parameter, not the TypeScript. Check in this order: `nBuckets` in
`weights.json` vs the `--n-buckets` you trained with; the label lists (sorted
ascending? same 10 / 4 strings?); `shape` vs `coefB64` length
(`shape[0] * shape[1]` float32 values, exactly); then the scaler arrays.

---

## 5. Retraining

### 5.1 By hand

```bash
npm run ml:setup        # once: ml/.venv + requirements
npm run ml:gen          # regenerate the synthetic ml/data/transactions.csv
npm run ml:train        # python ml/train.py --n-buckets 65536
npm run ml:export       # weights.json + parity_fixture.json
npm test                # parity test must be green
```

Or in one shot: `npm run ml:retrain`, which is export-data → train → export →
parity test, and stops at the first failure.

**Mind which CSV you are training on.** `ml/train.py --csv` defaults to
`ml/data/transactions.csv`, the _synthetic_ set, and both `npm run ml:train` and
`npm run ml:retrain` invoke it without a `--csv`. So running `ml:export-data`
first does not, on its own, get your real ledger into the model — it only writes
the file. To train on the live dump, name it:

```bash
npm run ml:export-data   # writes ml/data/live_transactions.csv
ml/.venv/bin/python ml/train.py --csv ml/data/live_transactions.csv --n-buckets 65536
ml/.venv/bin/python ml/export_ts.py --csv ml/data/live_transactions.csv
npm test
```

`export_ts.py` needs the same `--csv` because the parity fixture is sampled from
it: exporting weights trained on the live set while sampling the fixture from the
synthetic one produces a fixture that passes and proves nothing about the rows
you actually care about.

`ml/train.py` takes `--csv`, `--n-buckets`, `--out`, `--test-size` (default 0.2)
and `--seed` (default 42); `ml/export_ts.py` takes `--model`, `--csv`,
`--weights` and `--fixture`. Only `--n-buckets` is load-bearing for the contract:
it has to match `nBuckets` in `weights.json` and therefore the value the
TypeScript port reads back. The seed is fixed so that two runs on the same CSV
report the same metrics, which is what makes "did that change help?" answerable.

`ml:export-data` writes `ml/data/live_transactions.csv` from **confirmed**
expenses joined with `Corrections`, with the corrected label winning over the
predicted one. Columns are exactly what `ml/train.py` expects:
`date,time,merchant_raw,amount_chf,payer,category,moment`. It never exports
notes or images — the trainer has no use for them and they are the private part.

### 5.2 The loop that closes itself

Every time you accept or override a suggestion on the confirm card,
`confirmExpense` compares the posted labels against the predicted ones and
writes a `Corrections` row when they differ (`field` = `category` | `moment`,
plus `predicted` and `corrected`). That table _is_ the training signal: it is a
log of every time the model was wrong, with the right answer attached, produced
by the only people whose opinion counts here.

A `node-cron` job at 03:00 local runs the retrain, but only if there are **≥ 20
new confirmed rows** since the last training. Twenty is a guess with a purpose:
retraining on three new rows moves nothing and costs a parity run; waiting for a
thousand means the model stays wrong about your new favourite bakery for a year.
After a successful retrain the job calls the protected `reloadModel()` action,
so the running server picks up the new weights without a restart. If the parity
test fails, the job stops and leaves the old `weights.json` in place —
a model that is merely out of date beats a model that is out of contract.

### 5.3 Reading the metrics

`weights.json` carries `trainedAt`, `trainedRows` and
`metrics: { categoryAccuracy, momentF1 }`, and the Settings page renders them as
one line. The model in the repo right now reports
_"Model: trained 2026-09-01 on 4 000 rows · category acc 0.9975 · moment F1
0.8392"_.

First, know where they come from: `ml/train.py` splits the CSV 80/20 with a
fixed seed, fits on the 80 % and **measures on the held-out 20 %** — but the
coefficients that get exported are then refit on **100 %** of the rows, because
throwing away a fifth of an already small ledger costs real accuracy. So the
metrics describe a model trained on slightly less data than the one that ships.
That is the right trade and it is worth knowing when a number looks too good.

How to read the two numbers honestly:

- **`categoryAccuracy` ≈ 0.99** on the generated dataset is _not_ evidence the
  model is brilliant. It is evidence that `ml/generate_data.py` builds merchants
  that are linearly separable by name — which they largely are in real life too,
  so it is not cheating, it is just not news. Treat it as a regression guard: if
  it drops below ~0.95 something broke, usually the label set, the CSV columns,
  or a normalisation change.
- **`momentF1` ≈ 0.85** is macro F1 across the four moments, and it is the
  interesting number. Macro rather than weighted, because `gift` is rare and a
  weighted average would hide it entirely. Two reasons it is not higher and
  cannot be: moment is genuinely ambiguous — a CHF 60 dinner on a Wednesday
  might be `everyday` or `date_night` and only the people who were there know — and the
  generator deliberately flips **8 %** of moment labels (`LABEL_NOISE` in
  `ml/generate_data.py`) to stop the model learning a rule that reality does not
  follow. That noise puts a ceiling around 0.92, so 0.85 is close to the
  achievable maximum, not a mediocre score. If it ever reports ~0.99, the noise
  pass is broken, not the model.
- The trainer also prints `moment accuracy` next to the macro F1. When accuracy
  is high and macro F1 is low, the model is quietly ignoring `gift` — the fix is
  gift rows, not hyper-parameters.
- One hyper-parameter is worth knowing about because it interacts with the review
  threshold: `INVERSE_REGULARISATION = 12.0` (sklearn's `C`). The text block is
  L2-normalised, so individual features are small (~0.1), and the default `C=1.0`
  regularises the model into permanent under-confidence — every prediction lands
  below the 0.6 threshold and the app asks you to confirm _everything_. `C=12`
  buys back calibration. If you change it, watch the share of scans that open in
  review state, not just the accuracy.
- The number that actually matters is not in the file: **the correction rate**,
  `count(Corrections) / count(confirmed Expenses)` over the last month. If it is
  falling, the loop is working. If a single category dominates the corrections,
  that category needs training rows, not a new model.
- `trainedRows` climbing while the correction rate is flat means you are feeding
  it more of what it already knows.

### 5.4 Changing the pipeline

Any change to normalisation, n-gram range, bucket count or the numeric features
is a change to `docs/CONTRACTS.md` §2, and it is a **four-file** change: the
contract, `ml/features.py`, `srv/lib/classifier/features.ts`, and a regenerated
`parity_fixture.json`. Doing three of the four produces a model that trains fine,
exports fine, and predicts differently in production than it did in testing.
That is exactly the failure the fixture exists to make impossible.
