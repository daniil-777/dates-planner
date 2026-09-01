# Forecasting on SAP HANA Cloud with PAL — the optional path

The app forecasts monthly spending so the "Pre-spend planner" can answer
_"Lisbon in October?"_. That forecast is computed in TypeScript, in
`srv/lib/forecast.ts`: Holt-Winters additive with monthly seasonality when there
are ≥ 24 months of history, and `damped-holt` / `seasonal-naive` / `last-value`
below that. `forecast(series, monthsAhead)` returns
`ForecastPoint[]` — `{ index, point, lo, hi }` — where the band is
`1.2816 × σ` of the in-sample residuals, `lo` clamped at zero because a month
cannot be spent backwards.

**That stays the default.** This document describes an optional second path
where the same forecast is computed by SAP HANA Cloud's Predictive Analysis
Library instead. It exists because "the forecast runs in HANA PAL" is a true and
pleasing sentence, and because pushing `monthlyTotals()` into a column store and
calling a PAL procedure is a genuinely nice piece of SAP plumbing to have built.

It is not the default for three honest reasons:

1. **The free-tier instance stops every day.** SAP HANA Cloud free tier shuts the
   instance down automatically and you restart it by hand from SAP HANA Cloud
   Central. A feature that only works on days you remembered to press _Start_ is
   not a feature, it is a demo.
2. **`@sap/hana-client` is not a dependency of this project** and will not be.
   It is a large native driver, it complicates the Docker image, and it would be
   loaded for exactly one optional function.
3. **The TypeScript forecaster is good enough.** A household's monthly spending is
   twelve numbers a year with one seasonal cycle. PAL's advantage is scale, and
   there is no scale here.

So: the HANA path is opt-in, it is tried only when all three `HANA_*` variables
are set, and **any** failure — no driver, instance stopped, connection refused,
PAL missing — falls back to the TypeScript forecaster with a logged warning.
The planner card must never show a spinner because a database in Frankfurt is
asleep.

---

## 1. Entitlement and instance

1. BTP cockpit → your subaccount → **Entitlements** → _Configure Entitlements_ →
   _Add Service Plans_ → search `HANA`. Add:
   - **SAP HANA Cloud** → plan `hana-free` (free tier). If your account only
     offers `hana`, you are on a paid plan and this instance will cost money.
   - **SAP HANA Cloud** (the _tools_ subscription, sometimes listed as
     _SAP HANA Cloud, Tools_) → plan `tools` — this is the SAP HANA Cloud Central
     UI you will live in.
     **Save**.
2. **Services → Instances and Subscriptions** → _Subscriptions_ → **SAP HANA
   Cloud** → **Go to Application**. This is SAP HANA Cloud Central.
3. **Create Instance** → _SAP HANA Cloud, SAP HANA Database_.
   - Instance name: `twoway-hana`
   - **DBADMIN password**: store it somewhere real; you cannot recover it, only
     reset it.
   - Memory: the free tier fixes this — accept it.
   - **Allowed connections**: this is the setting that will cost you an evening.
     The default restricts connections to BTP Cloud Foundry instances in the
     same region. The app runs on Fly.io (or on your laptop), so you must choose
     **"Allow all IP addresses"** or add your specific egress IPs. Getting this
     wrong produces a connection **timeout**, not a rejection — it looks exactly
     like a wrong hostname.
4. Create. Provisioning takes several minutes.
5. **Enable the script server.** PAL lives in the script server, and it is off by
   default. Instance → **⋮ → Manage Configuration** → _Advanced Settings_ → turn
   **Script Server** on → save → the instance restarts. Until you do this,
   `_SYS_AFL` contains no PAL procedures at all and every `CALL` fails with
   "invalid name of function or procedure", which reads like a typo and is not.

Verify:

```sql
SELECT COUNT(*) FROM SYS.AFL_FUNCTIONS WHERE AREA_NAME = 'AFLPAL';
-- 0 means the script server is still off
SELECT FUNCTION_NAME FROM SYS.AFL_FUNCTIONS
 WHERE AREA_NAME = 'AFLPAL' AND FUNCTION_NAME LIKE 'PAL_UNIFIED%'
 ORDER BY 1;
```

### The SQL endpoint

Instance → **⋮ → Copy SQL Endpoint**. It looks like:

```
a1b2c3d4-….hana.trial-eu10.hanacloud.ondemand.com:443
```

That whole string, port included, is `HANA_HOST`.

---

## 2. A database user for the app

Do not connect as DBADMIN. Open the SQL console (HANA Cloud Central → instance →
**⋮ → Open in SQL Console**, or DBeaver / `hdbsql`) as DBADMIN and run:

```sql
CREATE USER TWM_APP PASSWORD "ReplaceWithAStrongOne1!" NO FORCE_FIRST_PASSWORD_CHANGE;
ALTER USER TWM_APP DISABLE PASSWORD LIFETIME;   -- otherwise it expires in 182 days

CREATE SCHEMA TWM AUTHORIZATION TWM_APP;

-- PAL execution rights
GRANT AFL__SYS_AFL_AFLPAL_EXECUTE TO TWM_APP;
GRANT AFLPM_CREATOR_ERASER_EXECUTE TO TWM_APP;   -- needed to create the wrapper procedure
```

`ALTER USER … DISABLE PASSWORD LIFETIME` is not optional laziness: a password
that silently expires six months later turns into "the forecast stopped working"
with a 10 61 authentication error and no other clue.

Then in `.env`:

```dotenv
HANA_HOST=a1b2c3d4-….hana.trial-eu10.hanacloud.ondemand.com:443
HANA_USER=TWM_APP
HANA_PASSWORD=ReplaceWithAStrongOne1!
```

All three must be present. Any one missing and the forecaster never even tries
to load the driver.

---

## 3. The table

`monthlyTotals(fromPeriod, toPeriod)` already returns
`{ period, category, total }`. The HANA side is a mirror of exactly that, plus an
integer ordinal, because PAL's time-series functions want an ordered key column
first and a `DOUBLE` value column second.

```sql
SET SCHEMA TWM;

CREATE COLUMN TABLE TWM.MONTHLY_TOTALS (
  PERIOD_ID  INTEGER        NOT NULL,   -- 1..n, dense, ascending by PERIOD
  PERIOD     NVARCHAR(7)    NOT NULL,   -- 'YYYY-MM'
  CATEGORY   NVARCHAR(20)   NOT NULL,   -- '' = the overall series
  TOTAL      DOUBLE         NOT NULL,
  PRIMARY KEY (PERIOD, CATEGORY)
);
```

`CATEGORY = ''` holds the overall monthly total; the ten category codes from
`docs/CONTRACTS.md` §1.1 hold the per-category series. `TOTAL` is `DOUBLE` and
not `DECIMAL` on purpose — PAL wants a double, and this table is a scratch pad
for a forecast, not a ledger. **Money is still `Decimal(10,2)` everywhere it
matters**; this is a derived aggregate.

`PERIOD_ID` must be **dense and gap-free**. A month with no expenses is a `0.0`
row, not a missing row: Holt-Winters over a series with holes in it silently
learns a seasonality that is not there. The push does a full replace rather than
an upsert, for the same reason — it is a few hundred rows and correctness is
cheaper than cleverness:

```sql
DELETE FROM TWM.MONTHLY_TOTALS;   -- then INSERT the full series
```

---

## 4. The generated procedure

You _can_ call `_SYS_AFL.PAL_UNIFIED_EXPONENTIALSMOOTHING` inline, but the
parameter table is a 4-column name/int/double/string affair that is miserable to
build from a driver. So generate a thin SQLScript wrapper once and let Node call
it with two scalars:

```sql
SET SCHEMA TWM;

CREATE OR REPLACE PROCEDURE TWM.FORECAST_MONTHLY (
  IN  in_category NVARCHAR(20),
  IN  in_horizon  INTEGER,
  OUT out_forecast TABLE (
        "STEP"      INTEGER,          -- 1 = next month, matching ForecastPoint.index
        "VALUE"     DOUBLE,
        "PI1_LOWER" DOUBLE,
        "PI1_UPPER" DOUBLE,
        "PI2_LOWER" DOUBLE,
        "PI2_UPPER" DOUBLE )
) LANGUAGE SQLSCRIPT SQL SECURITY INVOKER AS
BEGIN
  DECLARE lv_last INTEGER;
  DECLARE lt_data TABLE ("ID" INTEGER, "RAWDATA" DOUBLE);
  DECLARE lt_param TABLE (
        "PARAM_NAME"   NVARCHAR(256),
        "INT_VALUE"    INTEGER,
        "DOUBLE_VALUE" DOUBLE,
        "STRING_VALUE" NVARCHAR(1000) );
  DECLARE lt_raw TABLE (
        "TIMESTAMP" INTEGER,
        "VALUE"     DOUBLE,
        "PI1_LOWER" DOUBLE,
        "PI1_UPPER" DOUBLE,
        "PI2_LOWER" DOUBLE,
        "PI2_UPPER" DOUBLE );
  DECLARE lt_stats   TABLE ("STAT_NAME" NVARCHAR(256), "STAT_VALUE" NVARCHAR(1000));
  DECLARE lt_metrics TABLE ("NAME" NVARCHAR(256), "VALUE" NVARCHAR(1000));

  lt_data = SELECT PERIOD_ID AS "ID", TOTAL AS "RAWDATA"
              FROM TWM.MONTHLY_TOTALS
             WHERE CATEGORY = :in_category
             ORDER BY PERIOD_ID;

  SELECT IFNULL(MAX(PERIOD_ID), 0) INTO lv_last
    FROM TWM.MONTHLY_TOTALS WHERE CATEGORY = :in_category;

  lt_param = SELECT * FROM ( VALUES
      -- 'TESM' = triple exponential smoothing = Holt-Winters, the same model
      -- srv/lib/forecast.ts uses. 'AUTO' lets PAL choose between SESM/DESM/TESM.
      ('FUNCTION',        NULL,        NULL,  'TESM'),
      ('FORECAST_NUM',    :in_horizon, NULL,  NULL),
      ('SEASONAL_PERIOD', 12,          NULL,  NULL),
      -- Additive, to match the TypeScript forecaster. PAL's SEASONAL flag reads
      -- 0 = multiplicative (its default), 1 = additive -- the opposite of the way
      -- most people guess it. Confirm against the PAL reference for your revision
      -- before trusting a forecast: getting it backwards is silent, not an error.
      ('SEASONAL',        1,           NULL,  NULL),
      ('MEASURE_NAME',    NULL,        NULL,  'MAPE')
    ) AS T("PARAM_NAME","INT_VALUE","DOUBLE_VALUE","STRING_VALUE");

  CALL _SYS_AFL.PAL_UNIFIED_EXPONENTIALSMOOTHING(
        :lt_data, :lt_param, lt_raw, lt_stats, lt_metrics);

  -- PAL returns the fitted values for the history *and then* the forecast, in one
  -- table. Taking the first :in_horizon rows would hand the planner card twelve
  -- smoothed versions of last year. Keep only the rows past the last observation
  -- and renumber them 1..n.
  out_forecast = SELECT "TIMESTAMP" - :lv_last AS "STEP",
                        "VALUE", "PI1_LOWER", "PI1_UPPER", "PI2_LOWER", "PI2_UPPER"
                   FROM :lt_raw
                  WHERE "TIMESTAMP" > :lv_last
                  ORDER BY "TIMESTAMP";
END;
```

Three things to verify against **your** HANA Cloud revision rather than trusting
this listing, because the unified PAL interfaces changed shape over time:

```sql
-- exact signature: how many IN/OUT tables, in what order
SELECT * FROM SYS.AFL_FUNCTION_PARAMETERS
 WHERE FUNCTION_NAME = 'PAL_UNIFIED_EXPONENTIALSMOOTHING'
 ORDER BY POSITION;
```

1. **Arity.** If the `CALL` complains about the number of parameters, add or drop
   a trailing `DECLARE`d output table to match what the query above reports.
2. **`FUNCTION` values.** If `'TESM'` is rejected, the PAL reference for your
   revision lists the accepted set — `'AUTO'` is always safe and picks the model
   for you (at the cost of not knowing which one you got: read `lt_stats`).
3. **Parameter names.** `SEASONAL_PERIOD` is named `CYCLE` in some revisions, and
   an unrecognised `PARAM_NAME` is **ignored rather than rejected** — the call
   succeeds and quietly forecasts with no seasonality at all. If the output looks
   like a straight line through a seasonal series, that is the first thing to
   check.

`PI1_LOWER`/`PI1_UPPER` is PAL's first prediction interval, 80 % by default,
which is the same nominal coverage as the TypeScript band — so the two paths map
onto `ForecastPoint` without a conversion. Be aware they are not the same object:
PAL's interval **widens with the horizon** the way a proper prediction interval
should, while the TypeScript band is a constant `1.2816 × σ` at every step, on
purpose (a fan that doubles by month six reads as noise on a planner card). Both
are honest; the HANA one is more correct and the local one is more legible, and a
month-six band that suddenly triples is the HANA path working, not failing.

Smoke test — exactly six rows back, `STEP` 1…6, nothing from the history:

```sql
CALL TWM.FORECAST_MONTHLY('', 6, ?);
```

If it returns more than six rows, the `WHERE "TIMESTAMP" > :lv_last` filter did
not match, which means `TIMESTAMP` is not the input `ID` on your revision —
inspect `lt_raw` unfiltered before adjusting.

---

## 5. Wiring it up from Node

The driver is **not** in `package.json` and must not be added to it. Install it
in the deployment where you want this path and load it dynamically, so that a
machine without it starts normally:

```bash
npm install @sap/hana-client   # only where you actually want the HANA path
```

The shape of the integration (in `srv/lib/forecast.ts`, behind the env check):

1. If any of `HANA_HOST` / `HANA_USER` / `HANA_PASSWORD` is missing → return the
   TypeScript forecast. No log, this is the normal case.
2. `await import('@sap/hana-client')` inside a `try`. `MODULE_NOT_FOUND` →
   TypeScript forecast, log once at info level. Never crash on a missing
   optional driver.
3. Connect with a **short** timeout (a few seconds — `connectTimeout` /
   `communicationTimeout` in the connect options), `encrypt: true`,
   `sslValidateCertificate: true`. A stopped free-tier instance must cost the
   request seconds, not a minute.
4. `DELETE` + batch `INSERT` the current `monthlyTotals()` into
   `TWM.MONTHLY_TOTALS`, then `CALL TWM.FORECAST_MONTHLY(?, ?, ?)` once per
   series you need.
5. Map each result row onto a `ForecastPoint`: `STEP` → `index` (never the row
   ordinal — the procedure already dropped the fitted history, but a row ordinal
   would silently paper over it if a revision change ever put it back), `VALUE` →
   `point`, `PI1_LOWER`/`PI1_UPPER` → `lo`/`hi`, clamping `lo` at zero. Round
   money to 2 decimals **at the end only** — the same rule as
   `docs/CONTRACTS.md` §9.
6. `finally { conn.disconnect() }`. Always. A leaked connection on a free-tier
   instance with a small connection limit locks you out of your own database.
7. Any throw anywhere in 3–6 → log a warning **without** the connection string,
   and return the TypeScript forecast.

The result must be indistinguishable in shape from the local forecaster, so the
Settings card renders the same either way. If you want to see which one ran, log
it; do not put it in the API response.

---

## 6. Living with the free tier

- **It stops.** Free-tier HANA Cloud instances are shut down automatically on a
  daily cycle. Restart from HANA Cloud Central → instance → **⋮ → Start**. It
  takes a few minutes. There is no way to disable this on the free tier.
- **It can be deleted.** An instance left stopped and unused for long enough is
  removed. Keep the DDL in this file, not only in the database — §3 and §4 are
  the whole schema and can be re-run from scratch in two minutes.
- **`TWM.MONTHLY_TOTALS` is derived data.** Losing it costs one re-push. Never
  put anything in HANA that is not reconstructible from the SQLite ledger — the
  ledger is the system of record, this is a calculator.
- Because of all of the above, the app treats a working HANA as a bonus, and
  the fallback path is exercised far more often than the HANA path. Test the
  fallback deliberately: stop the instance and confirm the planner card still
  answers _"Lisbon in October?"_ without a spinner.

---

## 7. Troubleshooting

| Symptom                                                                   | Cause                                                                                                                 | Fix                                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Connection hangs, then times out                                          | _Allowed connections_ still restricted to BTP CF                                                                      | HANA Cloud Central → instance → _Manage Configuration_ → allow your IPs / all IPs.                                                 |
| `authentication failed` (error 10)                                        | wrong password, or the password expired                                                                               | Reset in HANA Cloud Central; `ALTER USER TWM_APP DISABLE PASSWORD LIFETIME`.                                                       |
| `invalid name of function or procedure: PAL_UNIFIED_EXPONENTIALSMOOTHING` | script server not enabled                                                                                             | §1 step 5, then re-check `SYS.AFL_FUNCTIONS`.                                                                                      |
| `insufficient privilege: Not authorized` on the `CALL`                    | missing `AFL__SYS_AFL_AFLPAL_EXECUTE`                                                                                 | Grant it as DBADMIN (§2).                                                                                                          |
| `wrong number or types of parameters`                                     | the unified interface on your revision has a different out-table arity                                                | Query `SYS.AFL_FUNCTION_PARAMETERS` (§4) and match the `DECLARE`s.                                                                 |
| Forecast comes back flat / nonsensical                                    | gaps in `PERIOD_ID`, or fewer than two full seasons                                                                   | Insert `0.0` rows for empty months; below 24 months let the TypeScript fallback handle it — it degrades to damped Holt on purpose. |
| Forecast has no seasonal shape at all                                     | `SEASONAL_PERIOD` is called `CYCLE` on this revision, and PAL ignores an unknown `PARAM_NAME` instead of rejecting it | Rename the parameter and re-run (§4, point 3).                                                                                     |
| Forecast is seasonal but the peaks are the wrong size                     | `SEASONAL` set to multiplicative where the TypeScript path is additive                                                | `('SEASONAL', 1, …)` for additive; confirm the flag's meaning in the PAL reference for your revision (§4).                         |
| Twelve forecast rows come back for a 6-month horizon                      | the fitted history was not filtered out                                                                               | `WHERE "TIMESTAMP" > :lv_last` in the wrapper (§4); check that `TIMESTAMP` really is the input `ID` column on your revision.       |
| `MODULE_NOT_FOUND: @sap/hana-client`                                      | driver not installed here                                                                                             | That is the designed behaviour; install it or ignore it.                                                                           |
| Everything worked yesterday, nothing today                                | the free-tier instance stopped overnight                                                                              | Start it. This is the headline caveat, not an anomaly.                                                                             |
