# Med Forecast KZ — Prescription Forecast for Kazakhstan Regions

An ML system that forecasts the number of prescriptions issued in upcoming
months at **region × district × ICD-10 diagnosis** granularity, built on
historical records from the Kazakhstan Ministry of Health prescription
registry (**ESBR MoH RK**, dataset `ISLO_MEDICALHISTORYOFCITIZENS`,
published on [ashyq.data.gov.kz](https://ashyq.data.gov.kz)).

> **Target user — the Ministry of Health of the Republic of Kazakhstan.**
> Forecasts inform decisions on drug procurement, staffing allocation,
> and clinic-level audits.

---

## 1. Problem statement

**Goal.** Predict `recipe_count` — the number of prescriptions issued in
a given month for a specific ICD-10 code in a specific region/district.

**Granularity.** The forecasting model operates at the
`(region × icd_code × month)` level (district granularity is too sparse
for classical regression — many combinations have fewer than 12
observations). District-level data is preserved separately for the
dashboard (filters, aggregates).

**Horizon.** 1, 3, 6 or 12 months ahead, computed recursively.

**Metrics.** MAE / RMSE / sMAPE / R². sMAPE is preferred over MAPE
because the data contains zero observations for rare `(region, icd)`
pairs, which would explode the MAPE denominator.

---

## 2. Architecture

```
┌────────────────────────┐    Magda Open Data API    ┌────────────────────────────┐
│  18 regional datasets  │ ─── download (504 xlsx) ─→  datasets/<region>/*.xlsx   │
│  on ashyq.data.gov.kz  │                            (≈ 12 GB raw data)         │
└────────────────────────┘                            └────────┬───────────────────┘
                                                               │
                                                               ▼
                                            ┌──────────────────────────────────┐
                                            │ ml/prepare_data.py               │
                                            │  Excel → aggregation by          │
                                            │  (region, district, icd, month)  │
                                            │  → monthly_panel.parquet (~10MB) │
                                            └────────────┬─────────────────────┘
                                                         ▼
                                            ┌──────────────────────────────────┐
                                            │ ml/build_features.py             │
                                            │  lags (1..12) · rolling stats    │
                                            │  · calendar features · ICD chap. │
                                            │  · region totals                 │
                                            │  → feature_panel.parquet         │
                                            └────────────┬─────────────────────┘
                                                         ▼
                                            ┌──────────────────────────────────┐
                                            │ ml/train.py                      │
                                            │  LightGBM regressor (log-target) │
                                            │  per-series time-based hold-out  │
                                            │  (last 6 months) · 4 baselines   │
                                            │  → models/lgbm_recipe_forecast.txt│
                                            │     models/metadata.json         │
                                            └────────────┬─────────────────────┘
                                                         ▼
                          ┌──────────────────────────────────────────────┐
                          │ FastAPI · backend/main.py                    │
                          │  · /api/regions  /api/icd  /api/districts    │
                          │  · /api/historical  /api/heatmap             │
                          │  · /api/top-diseases  /api/region-summary    │
                          │  · /api/district-summary  /api/data-range    │
                          │  · POST /api/forecast (recursive multi-step) │
                          │  · /api/report (DOCX, LLM exec summary)      │
                          │  · /api/model-metrics  /api/eval-sample      │
                          │  DuckDB reads parquet directly (zero-copy)   │
                          └────────────┬─────────────────────────────────┘
                                       ▼
                          ┌──────────────────────────────────────────────┐
                          │ Next.js 14 · frontend/                       │
                          │  · KPI / hero                                │
                          │  · Geographic choropleth (OSM, d3-geo)       │
                          │  · 174 ADM2 districts (zoom-in per region)   │
                          │  · Period filter (presets + custom range)    │
                          │  · Heatmap region × ICD chapter              │
                          │  · Forecast panel + decision recommendation  │
                          │  · Model metrics + actual-vs-predicted       │
                          │  · "Download report" — DOCX for the ministry │
                          └──────────────────────────────────────────────┘
```

**Production data flow.**

1. ETL is run quarterly, when the Ministry publishes new prescription
   data on the open portal.
2. `prepare_data.py` aggregates ~500 xlsx files into one
   `monthly_panel.parquet`.
3. `build_features.py` builds the feature panel; `train.py` retrains
   LightGBM and saves the booster + `metadata.json` (metrics,
   feature list, encoders).
4. The dashboard compares the new metadata with the previous version —
   regressions trigger an alert.
5. Model artefacts are committed to `ml/models/`; FastAPI is started
   via `uvicorn main:app` from `backend/`.
6. The frontend issues `/api/forecast` requests and renders the
   forecast plus the system's decision recommendation.

---

## 3. Data

### 3.1 Source

- The Republic of Kazakhstan open data platform `ashyq.data.gov.kz`
  (built on Magda).
- 18 regional datasets titled "Medical history of citizens (`<region>`)".
- 504 quarterly `.xlsx` files plus a preview CSV (2024 Q3) per region.
- Coverage: 2018 Q1 – 2024 Q3 (Abay Region extends to 2025 Q2).

### 3.2 Schema

| Column | Type | Description |
| --- | --- | --- |
| `recipedate` | datetime | Issue date |
| `icdid` | str | ICD-10 code |
| `nozology` | str | Diagnosis name |
| `region_med_organ` | str | Region |
| `raion_med_organ` | str | District |
| `recipepackqty` | int | Number of packs |
| `polyclid` | int | Clinic ID |
| `dosage`, `medservicetype`, … | num | (auxiliary, unused) |

### 3.3 Preprocessing

- Cleaning: drop NA on `recipedate / icdid / region_med_organ`.
- Strip whitespace, normalise casing.
- `recipepackqty` → numeric, NaN → 1 (a prescription with no explicit
  pack count is still one prescription).
- Group by `(region, district, icdid, nozology, year_month)` to obtain
  `recipe_count`, `total_packs`, `n_clinics`.
- Build a complete monthly grid for every series `(region, icd)` —
  missing months are filled with 0 (an absent prescription is a
  meaningful signal, not noise).
- Series shorter than 18 months are excluded from training (insufficient
  history to compute `lag_12` plus rolling features).

### 3.4 Feature engineering

| Group | Features |
| --- | --- |
| Lags | `lag_1, lag_2, lag_3, lag_6, lag_12` |
| Rolling | `roll_mean_{3,6,12}`, `roll_std_{3,6,12}` |
| Cumulative | `expanding_mean` |
| Region | `region_total_lag1` (region-wide total, lagged one month) |
| Calendar | `month`, `quarter`, `month_idx`, `month_sin/cos` |
| Categorical | `region_enc`, `icdid_enc`, `icd_chapter_enc` |
| Context | `n_clinics`, `n_districts` |

The target is transformed as `log1p(recipe_count)`; predictions are
inverted with `expm1` at inference time, then clipped to ≥ 0.

---

## 4. Model

- **LightGBM** (`gbdt`), regression on `log1p(y)`.
- Hyperparameters: `num_leaves=128`, `learning_rate=0.05`,
  `min_data_in_leaf=40`, `feature_fraction=0.9`, `bagging_fraction=0.9`,
  `lambda_l2=1.0`, 900 boosting rounds.
- Categorical columns are passed through LightGBM's
  `categorical_feature` indices.

### 4.1 Why LightGBM

| Alternative | Drawback for this problem |
| --- | --- |
| Prophet / SARIMAX per series | 18,000+ series — prohibitively expensive; ignores cross-series signal. |
| LSTM / Temporal Fusion Transformer | History length 30–80 months — too short for sequence networks; high infra cost. |
| Linear regression | Misses non-linear seasonal interactions between region and ICD chapter. |
| **LightGBM** | Handles sparse series, native categorical support, trains in minutes. |

### 4.2 Baselines

- `naive_last` — `y_{t-1}`.
- `seasonal_naive_12` — `y_{t-12}`.
- `rolling_mean_3` — average of the previous 3 months.

### 4.3 Hold-out metrics

The hold-out is per-series: the last 6 months of every `(region, icd)`
series form the test set. A single global cutoff would test only the
few regions whose data extends furthest in time and would bias the
evaluation.

| Model | MAE | RMSE | sMAPE | R² |
| --- | ---: | ---: | ---: | ---: |
| **LightGBM (production)** | **18.7** | **278.8** | **64.3 %** | **0.938** |
| Naive (lag-1) | 29.3 | 392.9 | 104.0 % | 0.876 |
| Seasonal naive (lag-12) | 22.2 | 254.7 | 107.8 % | 0.948 |
| Rolling mean (3 mo.) | 21.8 | 274.9 | 100.7 % | 0.939 |

LightGBM beats all baselines on MAE — the metric most actionable for
budget planning — by a large margin. Top features by gain:
`roll_mean_6`, `n_clinics`, `roll_mean_3`, `roll_mean_12`, `lag_12`.
The model leans on recent-history smoothing plus a seasonal anchor,
which matches domain intuition.

After running `python ml/train.py` the metrics are written to
`ml/models/metadata.json` and rendered in the "Model quality" card on
the dashboard.

### 4.4 Multi-step forecasting

`backend/inference.py::Forecaster.forecast()` runs recursively: the
prediction for month _t+1_ is appended to the history, lags and rolling
statistics are recomputed from the augmented series, and the model
predicts _t+2_, and so on up to `horizon` steps.

---

## 5. Decision logic (front-end perspective)

The dashboard converts a numeric forecast into an actionable
**recommendation tier** by comparing the forecast average against the
trailing 12-month average:

| Δ (forecast vs trailing 12-mo) | Tier | Action |
| --- | --- | --- |
| `< −15 %` | Sharp drop | Audit root cause (registration outage?), reallocate resources. |
| `−15 % … −5 %` | Decline | Reduce new procurement, rebalance stock between districts. |
| `±5 %` | Stable | Maintain current volumes. |
| `+5 % … +15 %` | Moderate growth | Increase safety stock 10–20 %, verify clinic throughput. |
| `> +15 %` | Surge | Scale up procurement, mobilise reserve medical staff. |

The heuristic lives in `frontend/components/ForecastPanel.tsx` and can
be tuned to internal MoH KPIs.

---

## 6. Geographic dashboard

The frontend renders a true-geometry SVG choropleth of all **20
admin-level-1 entities** of Kazakhstan, including the three new oblasts
created by the 2022 reform (**Abay**, **Zhetysu**, **Ulytau**) and the
three cities of national significance (**Astana**, **Almaty**,
**Shymkent**). Pipeline:

1. `Overpass API` query for `admin_level=4` polygons inside the KZ ISO
   area.
2. `osmtogeojson` converts the OSM relation membership into proper
   GeoJSON polygons.
3. Ring rewinding — geoBoundaries / OSM use Cartesian-CCW rings, while
   d3-geo expects Cartesian-CW (= spherical-CCW). Without rewinding,
   `fitSize` collapses every region to a single coloured blob because
   d3 interprets backwards-wound polygons as covering the entire globe.
4. `@turf/simplify` with tolerance 0.01° (~1 km) shrinks the file from
   2.2 MB / 94k vertices to 117 KB / 5k vertices without visible loss.
5. ADM2 district boundaries (174 polygons, geoBoundaries) are
   spatial-joined to the new ADM1 layer so the 20 districts that moved
   into Abay / Zhetysu / Ulytau after 2022 are correctly attributed.

The map supports a **period filter** (preset chips 6 / 12 / 24 / 36
months and "all time", or a custom from–to month range constrained by
`/api/data-range`), a **grouping toggle** between ICD chapter and
single ICD code, and a **zoom-to-region** mode that re-fits the
projection to one oblast and colours its districts.

---

## 7. Ministry-grade DOCX report

`GET /api/report?region=&horizon=&top_n=` returns a Word document
ready for ministry sign-off. Sections:

- **Header** — region scope, horizon, generation timestamp, source
  period.
- **Executive summary** — narrative paragraphs generated by an LLM
  (`gpt-4o-mini` by default) prompted with the actual numeric forecasts.
  When `OPENAI_API_KEY` is missing or the API call fails, a
  deterministic template is used.
- **Forecast table** — top-N diagnoses × N future months, Δ% versus
  the 12-month average, trend tier with cell shading.
- **Recommendations** — bullet list grouped by tier (surge / growth /
  decline / drop).
- **Methodology footer** — LightGBM hold-out metrics, source
  disclaimer, and a note that the LLM-generated summary should be
  validated by authorised personnel.

Country-level forecasts are aligned by **calendar month**: each region
is forecast forward enough steps to reach the global target month, and
predictions for the same calendar month are summed (otherwise October
2024 from one region would be added to May 2025 from another, because
regions stop at different dates in the source data).

The frontend's "Download report" button hits this endpoint, extracts
the filename from `Content-Disposition` (RFC 5987 — ASCII
transliteration for legacy clients plus a UTF-8 percent-encoded
human-readable Russian variant) and triggers a download via blob URL.

---

## 8. Running the stack

### 8.1 Data → model

```bash
# 1. Install Python dependencies
python -m pip install -r backend/requirements.txt python-calamine

# 2. ETL: ~30–60 minutes on 12 GB of source data
python ml/prepare_data.py

# 3. Feature engineering: < 1 minute
python ml/build_features.py

# 4. Training: ~1–5 minutes
python ml/train.py
```

### 8.2 Backend

```bash
cd backend
cp .env.example .env   # add your OPENAI_API_KEY for /api/report
uvicorn main:app --host 0.0.0.0 --port 8000
# Swagger docs: http://localhost:8000/docs
```

### 8.3 Frontend

```bash
cd frontend
npm install
npm run dev
# http://localhost:3000
```

`next.config.js` proxies `/api/*` to `http://localhost:8000/api/*`.
Point the frontend at a different backend host with:
```bash
NEXT_PUBLIC_API_URL=http://my-host:8000 npm run dev
```

---

## 9. Repository layout

```
.
├── datasets/                  # 18 regional folders with xlsx (504 files, 12 GB) — gitignored
├── ml/
│   ├── prepare_data.py        # ETL xlsx → monthly_panel.parquet
│   ├── build_features.py      # Feature engineering
│   ├── train.py               # Train LightGBM + baselines
│   ├── notebooks/eda.ipynb    # Quick EDA
│   ├── data/                  # parquet artefacts (created by scripts)
│   └── models/                # model + metadata.json
├── backend/
│   ├── main.py                # FastAPI
│   ├── inference.py           # Multi-step forecaster
│   ├── report.py              # DOCX report generator (OpenAI-backed)
│   ├── .env.example           # env-var template
│   └── requirements.txt
├── frontend/
│   ├── app/page.tsx           # Dashboard page
│   ├── components/            # KazakhstanMap, GeoHeatmap, ForecastPanel, …
│   ├── public/                # kz_regions.geojson, kz_districts.geojson
│   ├── lib/api.ts             # API client
│   └── tailwind.config.ts     # Design tokens
├── README.md                  # this file
└── REPORT.md                  # written report (8–10 pages)
```

---

## 10. Limitations and future work

- District-level granularity is too sparse for classical regression —
  add a hierarchical model (regional shrinkage prior) or post-allocate
  region forecasts by historical district shares.
- External factors (seasonal flu, COVID-19 waves, weather) are not
  modelled. Possible exogenous sources: WHO weekly reports, weather
  data.
- Bayesian quantile regression would yield 80 / 95 % prediction
  intervals — useful for budget risk framing.
- In production: A/B compare new model versions across a holdout of
  regions before rollout.

---

## 11. Source and license

- **Data**: Republic of Kazakhstan open data portal
  `ashyq.data.gov.kz` (Magda), CC BY 4.0.
- **Code**: see the LICENSE file in the repository.
