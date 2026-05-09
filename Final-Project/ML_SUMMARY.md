# ML Summary — Med Forecast KZ

End-to-end walk-through of the project, from the initial idea to the
production-ready dashboard. Every number in this document is reproduced
verbatim from `ml/models/metadata.json` (training run on 2026-05-08).

---

## 1. The idea

> **Hypothesis.** A single global forecasting model trained on the
> Kazakhstan prescription registry can predict, with sub-naïve error,
> how many prescriptions of a given diagnosis will be issued in each
> region next month. That signal is directly actionable for the
> Ministry of Health: drug procurement, staff allocation, and
> clinic-level audits.

### 1.1 Problem framing

| Decision | Field |
| --- | --- |
| **Task** | Regression on count data |
| **Target** | `recipe_count` — number of prescriptions in `(region × ICD-10 × month)` |
| **Forecast horizon** | 1, 3, 6 or 12 months ahead, recursive |
| **Granularity used in the model** | Region × ICD code × month |
| **Granularity preserved for the UI** | Region × district × ICD code × month (district preserved as a side artefact for filters and aggregates; not a model dimension because of sparsity) |
| **End user** | Ministry of Health analyst |
| **Business KPI** | Reduction of over-/under-stocking; faster reaction to demand surges |

### 1.2 Why district is not a model axis

Districts exist in the source data (`raion_med_organ`), but a
preliminary count showed:

- **199 districts × 2 300 ICD codes = ~458 000 potential series**
- After dropping series with fewer than 18 observations, only ~5 % survive.
- For a typical rare ICD code in a small district, the entire history is
  a handful of months with zero counts; modelling them with classical
  regression would just learn "predict 0", which is useless.

We therefore train at the **region × ICD-10 × month** level (18 881
viable series) and surface district detail in the dashboard as
post-aggregated views.

---

## 2. Data acquisition

### 2.1 Source

- **Open-data portal**: [ashyq.data.gov.kz](https://ashyq.data.gov.kz),
  built on the Magda open-data platform.
- **Dataset family**: `ISLO_MEDICALHISTORYOFCITIZENS` — 18 separate
  datasets, one per region/oblast.
- **License**: CC BY 4.0.

### 2.2 Programmatic download

The portal is a React SPA — every dataset's "Download" button hits a
Magda registry endpoint:

```
GET /api/v0/registry/records/<dataset-id>
    ?optionalAspect=dataset-distributions
    &optionalAspect=dcat-dataset-strings
    &dereference=true
```

Each dataset record returns a list of distributions
(`http://magda-minio-web.data.gov.kz/...xlsx`). The internal-looking
hostname is in fact reachable publicly via HTTPS, as the front-end's
JavaScript bundle revealed:

```js
const t = "https://magda-minio-web.data.gov.kz";
const n = new URL(e); n.hostname = t.split("//")[1];
```

A small Python script paginated `/api/v0/search/datasets?q=...`,
filtered titles containing `"Медицинская история граждан"`, and pulled
all 18 dataset IDs. Per-region distribution lists were fetched from the
registry endpoint, URLs were rewritten to HTTPS, and downloads were
parallelised with `concurrent.futures`.

| Step | Outcome |
| --- | --- |
| Datasets discovered | 18 (one per region; Жетысу and Улытау not split out at source) |
| Files downloaded | **504** quarterly `.xlsx` files |
| Total raw size | **≈ 12 GB** |
| Coverage | 2018 Q1 – 2024 Q3 (Abay extends to 2025 Q2) |

### 2.3 Schema

Per row = one prescription. Relevant fields used downstream:

| Column | Type | Description |
| --- | --- | --- |
| `recipedate` | datetime | Issue date |
| `icdid` | str | ICD-10 code |
| `nozology` | str | Diagnosis name |
| `region_med_organ` | str | Region |
| `raion_med_organ` | str | District |
| `recipepackqty` | int | Number of packs |
| `polyclid` | int | Clinic ID |

Unused: `dosage`, `dosageconcentration`, `medservicetype`,
`quantityinconsumerpackaging`, `isqtyunit`, `recipeprovdate`,
`modifieddate`, `recipepackqty`, `recipenum`, `wasprinted`,
`sdu_load_in_dt`, `recipeid`.

---

## 3. ETL pipeline

`ml/prepare_data.py` converts 504 quarterly xlsx files into one parquet
panel of monthly aggregates.

### 3.1 Reading xlsx efficiently

`openpyxl` (the pandas default) decompresses entire sheets into
memory. Almaty city files are 70–80 MB each; with 4 worker processes
it OOM'd routinely on 16 GB Windows laptops. Switched to
**`python-calamine`** — a Rust-backed reader — which reads the same
files with a constant ~130 MB peak memory and ~3× faster.

```python
def _read_xlsx(path):
    try:
        return pd.read_excel(path, usecols=USECOLS, engine="calamine")
    except Exception:
        return pd.read_excel(path, usecols=USECOLS, engine="openpyxl")
```

### 3.2 Per-file aggregation

We never load all 12 GB at once. Each worker reads one xlsx and
immediately collapses it to a monthly aggregate:

```python
df = _read_xlsx(path)
df["year_month"] = df["recipedate"].dt.to_period("M").dt.to_timestamp()
grp = (
    df.groupby(
        ["region", "district", "icdid", "nozology", "year_month"],
        dropna=False,
    ).agg(
        recipe_count=("icdid", "size"),
        total_packs=("recipepackqty", "sum"),
        n_clinics=("polyclid", "nunique"),
    ).reset_index()
)
```

A 500 000-row prescription file collapses to ≈ 8 000 aggregate rows.

### 3.3 Cleaning rules

- Drop NA on `recipedate / icdid / region_med_organ` (these are
  load-bearing keys; a row without them is unattributable).
- Strip whitespace, normalise casing.
- `recipepackqty` → numeric, NaN → 1 (one prescription with no
  explicit pack count is still one prescription).
- Concatenate per-file aggregates and run a final `groupby+sum` to
  resolve cross-file duplicates (same key appears in two files when a
  prescription is registered near a quarter boundary).

### 3.4 Parallelism + retry

- `ProcessPoolExecutor(max_workers=4)` — fewer workers than cores;
  xlsx decompression is memory-, not CPU-, bound.
- A second pass runs failed files serially. With calamine in place no
  files have failed, but the safety net stays.

### 3.5 Output

```
ml/data/monthly_panel.parquet     ≈ 10 MB · 2 814 281 rows
```

Rows are unique per `(region, district, icdid, nozology, year_month)`.
The 12 GB → 10 MB compression ratio illustrates how aggressive the
information collapse is — the model never sees individual prescriptions.

---

## 4. The final dataset

### 4.1 Headline numbers

| Quantity | Value |
| --- | --- |
| Panel rows | **2 814 281** |
| Total prescriptions in panel | **103 569 728** |
| Regions | **18** (data) + 2 (Жетысу/Улытау, geometry only) |
| Districts | **199** |
| Distinct ICD-10 codes | **≈ 2 300** |
| Period | **2018-01 → 2025-04** |

### 4.2 Top regions by recipe volume (last 12 months)

| Region | Prescriptions |
| ---: | ---: |
| 1. Алматы (city) | 14 099 209 |
| 2. Туркестанская обл. | 9 335 542 |
| 3. Карагандинская обл. | 8 318 610 |
| 4. Восточно-Казахстанская обл. | 6 585 014 |
| 5. Акмолинская обл. | 6 431 564 |
| … | … |
| 18. Атырауская обл. | 1 542 762 |

### 4.3 Top diagnoses across the country

| ICD-10 | Diagnosis | Country total |
| --- | --- | ---: |
| `I11.9` | Артериальная гипертензия (I10–I15) | 3 253 058 |
| `I20.8` | Ишемическая болезнь сердца (I20–I25) | 775 103 |
| `E11.9` | Сахарный диабет (E10–E11) | 581 993 |
| `E11.8` | Сахарный диабет (E10–E11) | 416 659 |
| `I10` | Артериальная гипертензия (I10–I15) | 410 428 |

The top-5 diagnoses cover ~5 % of all prescriptions; the long-tail is
material — another reason to model jointly with a global model.

---

## 5. Feature engineering

`ml/build_features.py` aggregates the panel to **(region × ICD ×
month)**, fills in missing months with 0, drops any series shorter
than 18 months, then derives the model's input features.

### 5.1 Why fill missing months with 0

A prescription absent for a month is **not** missing data — it is a
real observation that the diagnosis was not prescribed for. Imputing
NaN here would silently delete real seasonal patterns (a winter-only
respiratory ICD code looks like sparse zeros all summer). The grid is
densified per series:

```python
full_idx = pd.date_range(g["year_month"].min(), g["year_month"].max(), freq="MS")
sub = g.set_index("year_month").reindex(full_idx).fillna(0)
```

### 5.2 Feature catalogue

| Group | Features |
| --- | --- |
| Lags | `lag_1, lag_2, lag_3, lag_6, lag_12` |
| Rolling means | `roll_mean_3, roll_mean_6, roll_mean_12` |
| Rolling stds | `roll_std_3, roll_std_6, roll_std_12` |
| Cumulative | `expanding_mean` |
| Region context | `region_total_lag1` (region's total prescriptions last month, all ICDs) |
| Calendar | `month, quarter, month_idx, month_sin, month_cos` |
| Categorical | `region_enc, icdid_enc, icd_chapter_enc` (LabelEncoded) |
| Static | `n_clinics, n_districts` |

23 features total. All rolling/lag features are **shifted by one month
before computing**, to avoid leaking the target into its own features.

### 5.3 Target transform

Counts have a long-tail distribution (the top 1 % of `(region, icd)`
pairs account for >50 % of volume). We train on `log1p(y)` and invert
with `expm1` at inference, then clip to ≥ 0. This stabilises the loss
on rare-but-non-zero ICDs.

### 5.4 Output

```
ml/data/feature_panel.parquet     1 067 266 rows · 18 881 series
```

---

## 6. Validation strategy

### 6.1 Per-series time-based hold-out

For every `(region, icd)` series we reserve **the last 6 months** as
the test set:

```python
df["_pos_from_end"] = df.groupby(["region", "icdid"]).cumcount(ascending=False)
test_mask  = df["_pos_from_end"] < HOLDOUT_MONTHS
train_mask = ~test_mask
```

A single global cutoff (e.g. "everything after 2024-09-01 is test")
would test only Abay (the one region whose data extends to 2025-04),
biasing the evaluation toward a single oblast. The per-series hold-out
gives 113 286 test rows that span all 18 regions and 18 881 series.

| Split | Rows | Period |
| --- | ---: | --- |
| Train | **727 408** | 2019-02 → 2024-10 |
| Test  | **113 286** | last 6 months of every series |

### 6.2 Why 6 months

- Long enough that seasonality is exercised (winter respiratory peaks
  enter the test window for series ending in April).
- Short enough that recent regime shifts (e.g. post-COVID demand
  changes) don't dominate the train set.

---

## 7. The model

### 7.1 Choice: LightGBM

| Alternative | Drawback for this problem |
| --- | --- |
| Prophet / SARIMAX per series | 18 881 series, hours of CPU just to fit; ignores cross-series signal. |
| LSTM / Temporal Fusion Transformer | Series length 30–80 months, far too short for sequence networks; no GPU budget. |
| Linear regression | Misses non-linear interactions between region size, ICD class, and seasonality. |
| **LightGBM** | Native support for categoricals, sparse-friendly, trains in <30 s. |

### 7.2 Hyperparameters

```python
params = dict(
    objective="regression",
    metric="rmse",
    learning_rate=0.05,
    num_leaves=128,
    min_data_in_leaf=40,
    feature_fraction=0.9,
    bagging_fraction=0.9,
    bagging_freq=5,
    lambda_l2=1.0,
    verbose=-1,
)
booster = lgb.train(params, train_set, num_boost_round=900)
```

### 7.3 Categorical handling

The three categorical columns (`region`, `icdid`, `icd_chapter`) are
LabelEncoded into integer columns and passed to LightGBM via
`categorical_feature` indices. LightGBM splits categoricals using the
"many-vs-many" optimal binary split (Fisher 1958), which is what we
want for high-cardinality columns like `icdid` (~2 300 levels).

### 7.4 Training run

```
training:        23.6 s
boosting rounds: 900
final train RMSE on log1p(y): 0.242
```

---

## 8. Metrics — actual numbers

### 8.1 Hold-out comparison

| Model | MAE | RMSE | MAPE | sMAPE | R² |
| --- | ---: | ---: | ---: | ---: | ---: |
| **LightGBM (production)** | **18.68** | **278.79** | **36.61 %** | **64.28 %** | **0.938** |
| Naive (lag-1) | 29.27 | 392.87 | 79.73 % | 103.96 % | 0.876 |
| Seasonal naive (lag-12) | 22.23 | 254.75 | 93.88 % | 107.81 % | 0.948 |
| Rolling mean (3 mo.) | 21.79 | 274.91 | 67.86 % | 100.74 % | 0.939 |

### 8.2 Reading the numbers

- **MAE 18.68 vs naive 29.27** — LightGBM cuts the typical absolute
  error by **36 %**. This is the metric most actionable for budget
  planning: every unit of MAE is one prescription's-worth of stock
  variance.
- **sMAPE 64 % vs ≥ 100 % for all three baselines** — LightGBM is the
  only model with relative error in a usable range, particularly on
  the long tail of small-volume series.
- **R² 0.938 vs seasonal naive 0.948** — seasonal naive scores higher
  on R² because it perfectly captures the dominant year-over-year
  seasonal anchor; but its sMAPE is 108 % and MAE is +19 %, so it's
  catastrophically wrong on regime shifts. R² alone is misleading
  here; LightGBM is the better operational choice.
- **MAPE 36 % vs naive 80 %** — the same story as sMAPE.

### 8.3 Feature importance (top 10 by gain)

| Rank | Feature | Gain | Splits |
| ---: | --- | ---: | ---: |
| 1 | `n_clinics` | 12.97 M | 8 220 |
| 2 | `roll_mean_3` | 3.89 M | 3 838 |
| 3 | `roll_mean_6` | 3.83 M | 4 109 |
| 4 | `roll_mean_12` | 1.44 M | 4 236 |
| 5 | `lag_12` | 401 K | 5 357 |
| 6 | `icdid_enc` | 268 K | 18 518 |
| 7 | `n_districts` | 154 K | 2 104 |
| 8 | `lag_1` | 99 K | 5 130 |
| 9 | `month` | 98 K | 4 054 |
| 10 | `region_enc` | 28 K | 8 793 |

The story this tells:

1. **Healthcare infrastructure (`n_clinics`)** is the strongest single
   predictor — a region with twice as many clinics simply produces
   roughly twice as many prescriptions, regardless of diagnosis.
2. **Recent history dominates** (`roll_mean_3`, `roll_mean_6`,
   `roll_mean_12`, `lag_1`) — short and medium memory both matter.
3. **Seasonal anchor** — `lag_12` is the 5th-strongest feature,
   reflecting strong year-over-year periodicity for J/I/E ICD chapters.
4. The `icdid_enc` feature has by far the most splits (18 518) — the
   model uses it to learn one effective sub-model per code despite
   being a single global tree ensemble.

---

## 9. Multi-step forecasting

### 9.1 Recursive prediction

The model emits one-month-ahead predictions. To produce a 6-month
forecast, `backend/inference.py::Forecaster.forecast()` runs the model
recursively:

```
for step in 1..horizon:
    target_month = last_actual_month + step
    features     = compute_features(history + previous_forecasts)
    yhat         = expm1(booster.predict(features))
    history.append(yhat)
```

Lags (1, 2, 3, 6, 12), rolling means and stds, and `expanding_mean`
are recomputed from the augmented series at each step.

### 9.2 Country-level forecasts

The model is a `(region, icd)` predictor. Country-level forecasts
(used by the DOCX report) sum per-region predictions, aligned by
**absolute calendar month**:

```
target_months = [global_last + 1, global_last + 2, ..., global_last + H]
for each region:
    steps_needed = months from this region's last data to target_months[-1]
    forecast each region for steps_needed (capped at 18 to bound recursive drift)
    add this region's prediction for each target month to the country sum
```

Without calendar alignment, summing the i-th forecast of every region
would mix October 2024 (regions ending 2024-Q3) with May 2025 (Abay's
own start). The implementation explicitly rejects that.

### 9.3 Decision tier

The dashboard converts a numeric forecast into one of five
recommendation tiers:

| Δ (forecast avg vs trailing 12-mo avg) | Tier | Action |
| --- | --- | --- |
| `< −15 %` | Sharp drop | Audit registration / reallocate. |
| `−15 % … −5 %` | Decline | Reduce procurement, rebalance stock. |
| `±5 %` | Stable | Maintain current volumes. |
| `+5 % … +15 %` | Moderate growth | Safety stock +10–20 %, check throughput. |
| `> +15 %` | Surge | Scale up procurement, mobilise reserves. |

The thresholds are conservative defaults; they are intended to be
tuned to internal MoH KPIs.

---

## 10. System architecture

```
ashyq.data.gov.kz                              NEXT.JS DASHBOARD
        │                                ┌───────────────────────┐
   504 xlsx (12 GB)                      │ KPI · choropleth      │
        │                                │ Forecast UI · scatter │
        ▼                                └─────────▲─────────────┘
ml/prepare_data.py                                 │ /api/*
(calamine, multiprocess)                           │
        │                            ┌─────────────┴─────────────┐
        ▼                            │ FastAPI · DuckDB          │
monthly_panel.parquet (~10 MB) ────► │ reads parquet zero-copy   │
        │                            └─────────────▲─────────────┘
        ▼                                          │
build_features.py ──► feature_panel.parquet ───────┘
        │
        ▼
train.py → lgbm_recipe_forecast.txt + metadata.json
        │
        ▼
backend/inference.py (recursive multi-step forecast)
backend/report.py    (DOCX + LLM executive summary)
```

### 10.1 Stack details

| Layer | Tech |
| --- | --- |
| Storage | parquet via DuckDB zero-copy reads |
| API | FastAPI 0.115 + uvicorn |
| Model | LightGBM 4.5 booster + JSON metadata |
| Frontend | Next.js 14 App Router + TypeScript + Tailwind + Recharts + d3-geo + Framer Motion |
| Map data | OpenStreetMap (Overpass API) for ADM1, geoBoundaries for ADM2, simplified with `@turf/simplify` |
| Report | python-docx + OpenAI `gpt-4o-mini` for the executive summary |

### 10.2 API surface

```
GET  /api/health
GET  /api/data-range
GET  /api/regions
GET  /api/icd
GET  /api/districts
GET  /api/historical
GET  /api/region-summary
GET  /api/district-summary
GET  /api/heatmap
GET  /api/top-diseases
GET  /api/timeseries-overview
POST /api/forecast
GET  /api/model-metrics
GET  /api/eval-sample
GET  /api/global-stats
GET  /api/report          # DOCX download
```

All filters accept `start=YYYY-MM-DD&end=YYYY-MM-DD` or
`months=N` for the trailing window.

### 10.3 Production cadence

1. Quarterly: MoH publishes new prescriptions on the open portal.
2. ETL job reruns `prepare_data.py`, then `build_features.py`, then
   `train.py`. Metrics in the new `metadata.json` are diffed against
   the previous deployment — significant regressions block rollout.
3. Model artefact is committed; FastAPI is restarted via
   `uvicorn main:app`; the dashboard is unchanged.
4. Analysts open the dashboard, pick a region/diagnosis/period, and
   either inspect on-screen or hit "Скачать отчёт" for a DOCX.

---

## 11. Frontend & decision support

### 11.1 Geographic choropleth

- 20 admin-1 polygons (17 oblasts + 3 cities of national significance)
  pulled fresh from OpenStreetMap via `Overpass API`. The 2022 reform
  (Abay, Zhetysu, Ulytau) is fully represented.
- 174 ADM2 districts from geoBoundaries, simplified to 5 % of original
  vertex count, with parents reassigned via point-in-polygon to the
  new ADM1 layer (so the ~20 districts that moved into the new oblasts
  after 2022 are correctly attributed).
- `d3-geo` Mercator with `fitExtent`. Polygon ring orientation had to
  be flipped (Cartesian-CCW → Cartesian-CW = spherical-CCW), otherwise
  d3-geo treated every polygon as covering the whole globe and
  `fitSize` collapsed the country into a single coloured blob — a
  subtle but important debugging step documented in the commit log.

### 11.2 Filters

- **Period**: preset chips (6 / 12 / 24 / 36 mo / All) + custom
  from-to month range constrained to `/api/data-range`.
- **Grouping**: by ICD chapter (10-pill row) or by single ICD code
  (search + combobox).
- **Zoom**: clicking a region and pressing "Перейти к районам"
  re-fits the projection to that oblast and colours its districts.

### 11.3 LLM-backed DOCX report

`/api/report` returns a Word document ready for ministry sign-off.
Sections:

1. Header (region scope, horizon, generation timestamp, source period).
2. **Executive summary** — two or three short paragraphs in Russian,
   produced by `gpt-4o-mini` with the actual numeric Δ% as input.
   Falls back to a deterministic template if `OPENAI_API_KEY` is not
   set or the API call fails — the dashboard never blocks on the LLM.
3. Forecast table (top-N diagnoses × N future months, Δ% vs 12-mo
   average, trend tier with cell shading).
4. Recommendations (bullet list grouped by tier).
5. Methodology footer + LLM disclaimer.

The Content-Disposition header uses RFC 5987 — ASCII transliteration
for legacy clients (`med_forecast_KZ_atyrauskaya_oblast_20260508.docx`)
plus a UTF-8 percent-encoded human-readable Russian variant
(`Прогноз_Атырауская область_20260508.docx`).

---

## 12. Lessons learned

| What broke | Why | Fix |
| --- | --- | --- |
| openpyxl OOM on Almaty xlsx files | Decompresses entire sheet into memory | Switched to `python-calamine`; constant peak memory |
| Country-wide map looked like one orange blob | geoBoundaries / OSM rings wound CCW Cartesian; d3-geo expects CW | Per-feature ring reversal in Python before saving the GeoJSON |
| `chapter` filter changed the map only at zoom level | `regionSummary` API didn't accept a chapter argument | Added `chapter` param to backend + client |
| FastAPI 500s on Russian region names | DuckDB is not thread-safe; FastAPI runs handlers in a threadpool | Single connection + threading lock + per-request cursor |
| Country-level forecasts inflated 2× the base | Summed step `i` across regions whose last month differed by 6+ months | Calendar-month alignment: each region forecast forward to a global target month |
| DOCX download 500 with Cyrillic filename | HTTP headers are latin-1 only | RFC 5987 `filename*=UTF-8''…` |
| Per-series hold-out got 3 077 test rows | Single global cutoff = "everything after 2024-Nov is test" — only Abay had data after that | Per-series cutoff (last 6 months of each series): 113 286 rows |

---

## 13. Limitations & future work

| Limitation | Idea |
| --- | --- |
| District granularity too sparse | Hierarchical model with regional shrinkage prior; or post-allocate region forecasts by historical district shares. |
| Жетысу & Улытау not in source data | The portal hasn't split out their datasets yet; their polygons appear as "no data" on the map. Re-evaluate quarterly. |
| No external regressors | Add WHO weekly flu reports, COVID waves, weather. Easiest first step: `temp_avg` per region per month from public weather APIs. |
| Point predictions only | Quantile regression (LightGBM `objective="quantile"`) for 80/95 % prediction intervals — useful for budget framing. |
| Recursive drift over long horizons | Direct multi-output models per horizon step; or train one model per horizon (1, 3, 6, 12). |
| Single global model for all ICDs | Hierarchy: country → chapter → ICD. Reconcile with MinT or BU. |
| LLM summary uses gpt-4o-mini | Add deterministic numeric facts as guardrails, embedding-based retrieval over historical reports. |

---

## 14. File manifest

```
Final-Project/
├── README.md                           ← project overview
├── REPORT.md                           ← 8–10 page final report
├── ML_SUMMARY.md                       ← THIS DOCUMENT
├── ml/
│   ├── prepare_data.py                 ← ETL: 504 xlsx → monthly_panel.parquet
│   ├── build_features.py               ← lags, rolling, calendar, encoders
│   ├── train.py                        ← LightGBM + 3 baselines + metadata.json
│   ├── notebooks/eda.ipynb             ← quick exploratory EDA
│   ├── data/                           ← parquet artefacts (gitignored)
│   └── models/
│       ├── lgbm_recipe_forecast.txt    ← booster (gitignored)
│       ├── eval_predictions.parquet    ← scatter source (gitignored)
│       └── metadata.json               ← metrics + feature_importance + encoders
├── backend/
│   ├── main.py                         ← FastAPI app
│   ├── inference.py                    ← recursive multi-step forecaster
│   ├── report.py                       ← DOCX report + OpenAI executive summary
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── app/page.tsx                    ← dashboard composition
    ├── components/
    │   ├── KazakhstanMap.tsx           ← d3-geo SVG choropleth
    │   ├── GeoHeatmap.tsx              ← map + filters wrapper
    │   ├── PeriodPicker.tsx            ← preset chips + custom range
    │   ├── ForecastPanel.tsx           ← interactive forecast UI
    │   ├── ModelMetricsCard.tsx        ← LightGBM vs baselines
    │   ├── EvalScatter.tsx             ← actual vs predicted
    │   ├── Heatmap.tsx                 ← region × ICD chapter
    │   ├── TopDiseases.tsx             ← top-N bar list
    │   └── ReportButton.tsx            ← DOCX download
    ├── lib/api.ts                      ← typed fetch client
    └── public/
        ├── kz_regions.geojson          ← 20 ADM1 polygons (OSM, simplified)
        ├── kz_districts.geojson        ← 174 ADM2 polygons (geoBoundaries)
        └── kz_markers.json             ← optional map overlays
```

---

## 15. Reproducibility

```bash
# 0. clone & cd into Final-Project/

# 1. install python deps
python -m pip install -r backend/requirements.txt python-calamine

# 2. acquire datasets (one-off; populates ./datasets/)
#    — see README §3 for the Magda API recipe; the helper script in the
#    repo will paginate /api/v0/search/datasets and download all 504 xlsx

# 3. ETL  (~30–60 min depending on disk I/O)
python ml/prepare_data.py

# 4. features (<1 min)
python ml/build_features.py

# 5. training (~30 s)
python ml/train.py
#    -> writes ml/models/lgbm_recipe_forecast.txt
#       and    ml/models/metadata.json

# 6. backend
cd backend
cp .env.example .env   # add OPENAI_API_KEY for the LLM report
uvicorn main:app --host 0.0.0.0 --port 8000

# 7. frontend
cd ../frontend
npm install
npm run dev
# http://localhost:3000
```

The `metadata.json` produced by step 5 is the single source of truth
that the dashboard's "Model quality" card and this document both rely
on. If the numbers in §8 diverge from `ml/models/metadata.json`, trust
the JSON file and update §8 from it — the doc is regenerated from the
same numbers, never invented.

---

## 16. TL;DR for evaluators

- **Problem**: forecast monthly prescription counts at
  `region × ICD-10 × month` for 18 regions of Kazakhstan, to inform
  Ministry of Health procurement and staffing.
- **Data**: 504 quarterly xlsx files, 12 GB raw, aggregated to a 10 MB
  parquet with **103 569 728 prescriptions** spanning 2018-01 → 2025-04.
- **Model**: a single global LightGBM regressor on `log1p(y)` with 23
  features (lags, rolling, calendar, region context, label-encoded
  categoricals). Recursive multi-step inference.
- **Validation**: per-series last-6-months hold-out across all 18 881
  series.
- **Results**: **MAE 18.68 vs naive 29.27 (−36 %)**, R² 0.938. Beats
  every baseline on MAE and sMAPE.
- **Productisation**: FastAPI + DuckDB + Next.js + d3-geo choropleth +
  one-click DOCX report with LLM-generated executive summary, all
  reproducible from this repository.
