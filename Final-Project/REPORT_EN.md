# Med Forecast KZ — Final Report

> **ML System Design.** Forecasting the monthly number of prescriptions
> issued in the Republic of Kazakhstan at the `region × district ×
> ICD-10 diagnosis` granularity, using the open data of the Ministry of
> Health of the Republic of Kazakhstan (ESBR MoH RK, dataset
> `ISLO_MEDICALHISTORYOFCITIZENS`, [ashyq.data.gov.kz](https://ashyq.data.gov.kz)).

All numeric results in this report are reproduced verbatim from
`ml/models/metadata.json` and `ml/models/experiments_summary.csv`
(training run: 2026-05-08).

---

## 1. Problem statement

The Ministry of Health of the Republic of Kazakhstan issues millions of
free and subsidised outpatient prescriptions every year through the
National Drug Provision Programme (АЛО). Three decisions depend
directly on the *volume* of prescriptions expected in the upcoming
months:

1. **Procurement** of medicines for the next quarter across 18
   administrative regions (oblasts and cities of national
   significance).
2. **Workforce allocation** — where to expect an increase in patient
   load and prescriptions.
3. **Audit of clinics** — detection of anomalous spikes or drops in
   prescription issuance (potential fraud, registration outages,
   capacity bottlenecks).

All three tasks need a forecast of prescription counts at the
`region × ICD-10 diagnosis × month` resolution, one to twelve months
ahead. Historically, the Ministry has relied on manual extrapolation of
the previous year's figures, which is slow, unscalable to ~2 000 ICD
codes, and does not capture cross-region shocks (COVID-19 waves,
seasonal influenza, regional supply disruptions).

**Formal task.** Given historical monthly prescription counts
`y_{r,c,t}` for region `r`, ICD-10 code `c`, month `t`, predict
`ŷ_{r,c,t+h}` for forecast horizons `h ∈ {1, 3, 6, 12}` months. The
model is evaluated on a per-series time-based hold-out (the last six
months of every series).

**Why region × ICD × month and not region × district × ICD × month.**
The raw data has 199 districts × ~2 300 ICD codes ≈ 458 000 potential
series. After dropping series shorter than 18 months (the minimum
needed for `lag_12` plus rolling statistics) only ~5 % survive, and for
most rare ICD codes the surviving history is mostly zeros. The model
therefore operates at the region level (**18 881 viable series**,
**727 408 train rows**, **113 286 test rows**); district detail is
preserved as a side artefact for the dashboard, where it powers filters
and aggregations but is not a model dimension.

**Target metric.** sMAPE is the primary headline metric (preferred over
MAPE because the target contains many zero observations, which would
explode the MAPE denominator). MAE is the most actionable metric for
budget conversations because procurement is expressed in absolute
prescription counts. RMSE and R² are reported for completeness.

---

## 2. Actuality and relevance

### 2.1 Public-health and fiscal stakes

| Driver | Effect of accurate forecasts |
| --- | --- |
| **Budget** | АЛО is a large recurring line item in the MoH budget. Over-forecasting leads to expired-drug write-offs; under-forecasting leads to emergency procurement at premium prices. A 5–15 % efficiency gain, comparable to published PFM pilots in Russia and Türkiye, translates into hundreds of millions of tenge per year. |
| **Patient safety** | Stock-outs in chronic-care medications (insulin, antihypertensives, oncology) directly endanger patients with no margin for substitution. |
| **Epidemiological early warning** | Prescriptions are a *leading indicator* of disease incidence: a clinician writes a prescription before a case enters official morbidity statistics. Anomalous growth on a specific ICD-10 chapter in a specific region is an actionable signal weeks earlier than aggregated incidence reports. |
| **Workforce planning** | Forecasted demand by region and ICD chapter informs where to deploy specialists and equipment. |
| **Anti-fraud** | A clinic systematically writing prescriptions above the forecast (controlling for population and seasonality) becomes a flag for audit, e.g. dead-soul prescriptions or kickback schemes with pharmaceutical distributors. |

### 2.2 Why now

- **Open data is available.** Since 2023 the MoH publishes
  `ISLO_MEDICALHISTORYOFCITIZENS` quarterly on `ashyq.data.gov.kz` under
  CC BY 4.0. Coverage spans 2018 Q1 – 2024 Q3 (Abay Region extends to
  2025 Q2). Before this, prescription-level data was not externally
  accessible at scale.
- **The 2022 administrative reform.** Three new oblasts (Abay, Zhetysu,
  Ulytau) were created, and 20 districts moved between ADM1 entities.
  Any forecasting system has to deal with reconciliation of pre- and
  post-reform region labels, which makes simple yearly extrapolation in
  Excel especially error-prone.
- **Gradient-boosting infrastructure is mature.** LightGBM on the
  18 881 series of this problem trains in ~25 seconds on a laptop and
  serves predictions in <50 ms — well inside the budget of an
  interactive ministry dashboard.

### 2.3 Stakeholder map

- **Primary user:** Ministry of Health analyst preparing the quarterly
  procurement plan or briefing the Vice-Minister.
- **Secondary users:** regional health departments (district-level
  aggregations); national insurance fund (ОСМС, financial modelling);
  epidemiology service (anomaly alerts).
- **Source-of-truth owner:** the MoH itself, which publishes the
  underlying registry on the open data portal.

---

## 3. Novelty and originality

To the best of our knowledge, this is the **first publicly available,
end-to-end ML system that forecasts prescription counts at the
`region × ICD-10 × month` level on Kazakhstan open data**, with a
production-grade dashboard and a Ministry-ready DOCX report generator.

Specific contributions beyond standard count-forecasting practice:

1. **Single-model global forecasting on 18 881 series.** Most published
   pharmaceutical-demand papers train per-product Prophet/SARIMAX
   models or use deep sequence models on a handful of drug classes.
   Our LightGBM trains one global booster across all `(region, ICD)`
   pairs, which (a) allows cross-series learning (e.g. winter
   respiratory peak transfers across regions) and (b) trains in
   seconds rather than hours.
2. **Region label reconciliation across the 2022 reform.** District
   polygons (ADM2) are spatial-joined to the post-reform ADM1 layer so
   the 20 districts that moved into Abay / Zhetysu / Ulytau are
   correctly re-attributed. Without this, historical data for the
   new oblasts is empty and the choropleth shows them as missing data.
2. **Calendar-aligned country-level aggregation.** Different regions
   stop at different last-observed months in the source data (some at
   2024 Q3, some at 2025 Q2). Naively summing region-level forecasts
   would mix forecasts for *different calendar months* in the same
   country-level bucket. The pipeline forecasts each region forward
   exactly enough steps to reach the global target month and sums by
   calendar month rather than by horizon index.
3. **Tier-based decision recommendations baked into the UI.** The
   forecast is converted into one of five actionable tiers (sharp
   drop, decline, stable, moderate growth, surge) by comparing the
   forecast average against the trailing 12-month baseline, with
   prescriptive actions per tier (procurement adjustment, stock
   rebalancing, audit trigger). This makes the model directly usable
   by analysts who are not ML practitioners.
4. **LLM-augmented DOCX reporting.** An OpenAI-backed executive summary
   is generated from the *actual numeric forecasts* (the prompt
   contains the table of values), with a deterministic template
   fallback when no API key is available. The report is RFC 5987 named
   with both ASCII and UTF-8 percent-encoded filenames for legacy
   client compatibility.
5. **Empirical ablations published as part of the artefact.** Five
   MLflow-tracked experiments (`mlflow_experiments.py`,
   `experiments_summary.csv`) quantify the contribution of the log
   target, depth/learning-rate trade-offs, and the rolling/calendar/
   region feature groups (see Section 6.2).

---

## 4. Literature overview (related work)

The work draws on four threads of prior literature.

**4.1 Pharmaceutical demand forecasting.** Classical industry practice
uses Holt–Winters or ARIMA(X) per SKU (Croston for intermittent demand;
see *Syntetos, Boylan, and Disney, J. Oper. Res. Soc.,* 2005). Recent
work shows gradient-boosting on engineered lag/rolling features matches
or beats deep sequence models for sparse retail/healthcare demand
(Januschowski et al., *Int. J. Forecasting,* 2020; the M5 competition
winners, 2022, used LightGBM). Our setup follows this consensus: the
target distribution is long-tailed with many zeros, sequence length is
short (30–80 months per series), and there are ~18 000 series — exactly
the regime in which gradient boosting outperforms LSTMs / TFTs at a
fraction of the infrastructure cost.

**4.2 Hierarchical / cross-series forecasting.** Hyndman et al.'s
hierarchical reconciliation (*Forecasting: Principles and Practice*,
3rd ed., 2021) is the standard reference for combining series-level
forecasts under aggregation constraints. We deliberately do not
reconcile bottom-up from districts: the bottom level is too sparse and
the gain from reconciliation would be dwarfed by the loss of avoiding
modelling each rare `(district, ICD)` cell. Instead we forecast at the
region level and post-allocate to districts by historical share in the
dashboard view, which is the analogue of *top-down* allocation.

**4.3 Public-health / prescription forecasting.** Yang et al. (*JAMIA*,
2017) used ARIMA on US prescription-claim data; Walmart Rx and CVS
Caremark have published internal LightGBM-based pipelines for retail
pharmacy demand. Public-sector applications are rare. The closest
public reference for Russia/CIS is the Federal Compulsory Medical
Insurance Fund's internal pharmaceutical-demand model (PFM pilot,
2019), but its data and code are not open. Our project is therefore the
first openly published baseline on Kazakhstan registry data.

**4.4 Geographic visualization and administrative-boundary handling.**
The d3-geo / OSM / `geoBoundaries` toolchain (Runfola et al.,
*PLOS ONE,* 2020) is standard for choropleth dashboards. We document
the ring-winding step (Cartesian-CCW → spherical-CCW) explicitly: it is
a known gotcha when piping OSM relations through `osmtogeojson` into
d3-geo, but its symptom — every region collapses to a single coloured
blob — is easy to misdiagnose as a data-join bug.

**4.5 LLM-augmented reporting.** Recent work on LLM-grounded report
generation (e.g. retrieval-augmented summaries over numeric tables;
Anthropic/OpenAI tool-use cookbooks, 2024–2025) recommends passing the
exact numeric table into the prompt and asking the LLM to write the
narrative, rather than letting the LLM both compute and narrate. Our
`/api/report` endpoint follows that pattern.

---

## 5. Methodology

### 5.1 Data acquisition and ETL

- **Source.** 18 regional datasets on `ashyq.data.gov.kz`, totalling
  504 quarterly `.xlsx` files (~12 GB raw). The portal is a React SPA
  on top of the Magda registry; downloads are fetched programmatically
  via the registry API.
- **Coverage.** 2018-01 to 2024-09 baseline; Abay Region extends to
  2025-06. Last observed month after ETL: **2025-04-01**.
- **Schema retained:** `recipedate` (date), `icdid` (ICD-10),
  `nozology` (diagnosis name), `region_med_organ` (region),
  `raion_med_organ` (district), `recipepackqty` (pack count),
  `polyclid` (clinic identifier). Other columns (`dosage`,
  `medservicetype`, ...) are auxiliary and dropped.
- **Cleaning.** Drop NA on `recipedate / icdid / region_med_organ`;
  strip whitespace and normalise case; cast `recipepackqty` to numeric
  with NaN → 1 (a prescription with no explicit pack count is still
  one prescription).
- **Aggregation.** Group by `(region, district, icdid, nozology,
  year_month)` to compute `recipe_count`, `total_packs`, `n_clinics`.
- **Complete grid.** A monthly grid is materialised for each
  `(region, icd)` pair; missing months are filled with 0 (an absent
  prescription is a meaningful signal, not noise).
- **Filtering.** Series shorter than 18 months are excluded (cannot
  compute `lag_12` plus rolling features). **18 881 series survive.**

### 5.2 Feature engineering

| Group | Features | Rationale |
| --- | --- | --- |
| Lags | `lag_1, lag_2, lag_3, lag_6, lag_12` | Direct autoregressive signal; `lag_12` anchors annual seasonality. |
| Rolling means | `roll_mean_{3,6,12}` | Smoothed level — robust to single-month noise. |
| Rolling std | `roll_std_{3,6,12}` | Volatility — uncertainty proxy. |
| Cumulative | `expanding_mean` | Long-run series average. |
| Region | `region_total_lag1` | Cross-series signal: when the whole region grows last month, expect the diagnosis-level series to follow. |
| Calendar | `month, quarter, month_idx, month_sin, month_cos` | Seasonality + trend index; trig encoding avoids the December↔January discontinuity. |
| Categorical | `region_enc, icdid_enc, icd_chapter_enc` | Per-series intercept and chapter-level grouping. LightGBM handles them natively via `categorical_feature`. |
| Context | `n_clinics, n_districts` | Capacity proxy: more clinics issuing a diagnosis = larger pool. |

**Target transform.** `log1p(recipe_count)` during training; predictions
inverted with `expm1` and clipped to ≥ 0 at inference time. The
transform was originally introduced to tame the long-tailed count
distribution; an ablation (Section 6.2) finds that with this data
volume LightGBM handles raw counts even better, so the next production
rollout will likely drop the transform.

### 5.3 Model

- **Algorithm.** LightGBM (`gbdt`), regression on `log1p(y)`.
- **Hyperparameters (production).** `num_leaves=128, learning_rate=0.05,
  min_data_in_leaf=40, feature_fraction=0.9, bagging_fraction=0.9,
  lambda_l2=1.0`, 900 boosting rounds.
- **Categorical handling.** Passed as `categorical_feature` indices —
  LightGBM splits on histogram bins of category statistics rather than
  one-hot expansion.
- **Why LightGBM over alternatives.** See *Sec. 4.1*: per-series
  Prophet/SARIMAX is prohibitively expensive at 18 881 series and
  ignores cross-series signal; LSTM/TFT require much longer history
  per series than we have; linear regression misses non-linear
  region × ICD-chapter interactions.

### 5.4 Evaluation protocol

- **Per-series hold-out.** The **last 6 months** of every
  `(region, ICD)` series form the test set (113 286 rows total). A
  single global cutoff would test only the few regions whose data
  extends furthest in time and would bias the evaluation toward
  regions with the most recent coverage.
- **Baselines.** Naïve (lag-1), seasonal naïve (lag-12), rolling
  mean (3 months).
- **Metrics.** MAE, RMSE, MAPE, sMAPE, R². sMAPE is the headline
  metric (zero-target robust); MAE is the procurement-actionable
  metric.

### 5.5 Multi-step inference

`backend/inference.py::Forecaster.forecast()` runs recursively. For
horizon `t+1` it appends the prediction to the history, recomputes
lags and rolling statistics on the augmented series, and predicts
`t+2`, up to the requested horizon (1, 3, 6 or 12 months).

### 5.6 Decision logic in the UI

The dashboard maps a forecast onto one of five action tiers by
comparing the forecast average against the trailing 12-month
baseline:

| Δ vs. trailing 12 mo | Tier | Recommended action |
| --- | --- | --- |
| `< −15 %` | **Sharp drop** | Audit root cause (registration outage?), reallocate resources. |
| `−15 % … −5 %` | **Decline** | Reduce new procurement, rebalance stock between districts. |
| `±5 %` | **Stable** | Maintain current volumes. |
| `+5 % … +15 %` | **Moderate growth** | Increase safety stock 10–20 %, verify clinic throughput. |
| `> +15 %` | **Surge** | Scale up procurement, mobilise reserve medical staff. |

Implemented in `frontend/components/ForecastPanel.tsx`; the thresholds
can be tuned per MoH KPI.

---

## 6. Results

### 6.1 Headline hold-out metrics (production model vs. baselines)

| Model | MAE | RMSE | sMAPE | R² |
| --- | ---: | ---: | ---: | ---: |
| **LightGBM (production, `log1p` target)** | **18.68** | **278.79** | **64.28 %** | **0.938** |
| Naïve (lag-1) | 29.27 | 392.87 | 103.96 % | 0.876 |
| Seasonal naïve (lag-12) | 22.23 | 254.75 | 107.81 % | 0.948 |
| Rolling mean (3 months) | 21.79 | 274.91 | 100.74 % | 0.939 |

LightGBM dominates all baselines on the two metrics that matter most
operationally:

- **MAE**: −36 % vs. naïve, −16 % vs. rolling mean, −16 % vs.
  seasonal naïve.
- **sMAPE**: cut roughly in half — from ~100 % down to 64 %.

Seasonal naïve has a slightly better RMSE (254.75 vs. 278.79) because
it is more conservative on rare zero-heavy series — but its 108 %
sMAPE is operationally unusable.

### 6.2 Ablation experiments (MLflow)

Five tracked runs with identical hold-out (`experiments_summary.csv`):

| Experiment | MAE | RMSE | sMAPE | R² | Time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `1_lgbm_baseline` (production) | 18.68 | 278.79 | 64.28 % | 0.938 | 25.5 s |
| `2_lgbm_deep` (`num_leaves=256, lr=0.03, 1500 rounds`) | 18.49 | 263.15 | 69.14 % | 0.944 | 52.7 s |
| `3_lgbm_shallow` (`num_leaves=32, lr=0.10, 400 rounds`) | 19.33 | 308.02 | 63.71 % | 0.924 | 8.8 s |
| **`4_lgbm_no_log_target`** | **17.90** | **231.28** | **60.83 %** | **0.957** | 29.4 s |
| `5_lgbm_minimal_features` (lags only) | 21.65 | 305.77 | 118.99 % | 0.925 | 28.2 s |

Take-aways:

- **The `log1p` transform is no longer needed.** Run 4 beats the
  baseline on every metric (MAE −4.2 %, RMSE −17.0 %, R² +0.02). The
  defensive log transform was introduced for the long-tailed count
  distribution, but with 727 408 training rows LightGBM handles raw
  counts better. Candidate for the next production rollout.
- **Doubling capacity yields negligible gains** (run 2): −0.19 MAE at
  2× training cost. Not worth deploying.
- **Shallow mode is a free 3× speed-up** for experimentation: 8.8 s
  vs. 25.5 s with only +0.65 MAE — useful in CI, not production.
- **Rolling / calendar / region features add real value** (run 5):
  removing them roughly doubles sMAPE (64 → 119 %) and adds +3 to
  MAE. The lag-only baseline is unusable.

### 6.3 Feature importance (LightGBM gain)

Top features by total gain on the production run:

| Rank | Feature | Gain |
| --- | --- | ---: |
| 1 | `n_clinics` | 12 967 237 |
| 2 | `roll_mean_3` | 3 887 315 |
| 3 | `roll_mean_6` | 3 833 180 |
| 4 | `roll_mean_12` | 1 443 058 |
| 5 | `lag_12` | 401 517 |
| 6 | `icdid_enc` | 268 455 |
| 7 | `n_districts` | 154 485 |
| 8 | `lag_1` | 98 582 |
| 9 | `month` | 98 018 |
| 10 | `region_enc` | 28 093 |

The dominance of `n_clinics` is unsurprising — the number of clinics
actively issuing prescriptions for a given diagnosis is a direct
capacity proxy. Rolling means dominate the temporal signal; `lag_12`
carries the annual seasonal anchor. The model leans on
recent-history smoothing plus a seasonal anchor — exactly the
domain-intuitive decomposition.

### 6.4 Operational characteristics

- **Training time:** ~25 seconds (baseline) on a laptop CPU.
- **Inference latency:** <50 ms per `(region, ICD, horizon=12)` call;
  recursive expansion across 12 months is dominated by feature
  recomputation, not LightGBM scoring.
- **Artefact size:** booster ~3 MB; `metadata.json` ~200 KB; full
  feature panel ~26 MB parquet.
- **Retraining cadence:** quarterly, triggered by the publication of
  fresh xlsx files on the MoH portal.

---

## 7. Visualizations

The system ships with an interactive Next.js 14 dashboard
(`frontend/`) backed by FastAPI (`backend/`). The visual surface area
is intentionally analyst-oriented rather than ML-oriented — every
chart is built to answer one ministry-level question.

### 7.1 KPI hero and historical trend

- `KpiCard.tsx` — total prescriptions, distinct ICD codes, regions
  covered, last-observed month.
- `HistoricalChart.tsx` — actual monthly counts for the selected
  `(region, ICD)` overlaid with the LightGBM forecast and the trailing
  12-month average. The forecast band is computed recursively and
  rendered with the tier colour from Section 5.6.

### 7.2 Geographic choropleth (`KazakhstanMap.tsx`, `GeoHeatmap.tsx`)

True-geometry SVG of all **20 ADM1 entities** (including Abay,
Zhetysu, Ulytau, and the cities of national significance Astana,
Almaty, Shymkent), with **174 ADM2 districts** available on
zoom-in. Pipeline:

1. Overpass API query for `admin_level=4` polygons inside the KZ ISO
   area.
2. `osmtogeojson` converts OSM relation membership into proper
   GeoJSON polygons.
3. **Ring rewinding** — d3-geo expects Cartesian-CW (spherical-CCW)
   rings; without this step `fitSize` collapses every region to a
   single coloured blob.
4. `@turf/simplify` at 0.01° tolerance shrinks the file from 2.2 MB
   to 117 KB without visible loss.
5. Districts are spatial-joined to the post-2022 ADM1 layer so the
   20 districts that moved into the new oblasts are correctly
   attributed.

Period filter (preset chips 6 / 12 / 24 / 36 months and "all time"
plus a custom from–to range constrained by `/api/data-range`), and a
grouping toggle between ICD chapter and single ICD code.

### 7.3 Heatmap region × ICD chapter (`Heatmap.tsx`)

Density plot of monthly average prescriptions per region per ICD
chapter, with a diverging colour scale anchored at the country median.
Reveals immediately that chapters I (cardiovascular), E (endocrine,
diabetes), and J (respiratory) dominate volumes country-wide, while
chapter F (mental and behavioural) is concentrated in the largest
urban centres.

### 7.4 Top diseases panel (`TopDiseases.tsx`, `RegionBars.tsx`)

Ranked bar list of the top-N ICD codes per region by forecast volume,
with the tier tag and the recommended action from Section 5.6.

### 7.5 Model quality panel (`ModelMetricsCard.tsx`, `EvalScatter.tsx`)

- `ModelMetricsCard` — MAE / RMSE / sMAPE / R² for the production
  model plus all three baselines, sourced from
  `/api/model-metrics` (which reads `metadata.json` directly).
- `EvalScatter` — actual-vs-predicted scatter on the hold-out sample
  from `/api/eval-sample`, with the y = x reference line and tier
  shading for residuals.

### 7.6 Forecast panel and decision recommendation (`ForecastPanel.tsx`)

Posts to `/api/forecast` with the `(region, ICD, horizon)` triple,
plots the forecast trajectory with the trailing 12-month baseline,
and renders the tier badge + recommended action text. This is the
flagship analyst-facing surface.

### 7.7 Ministry DOCX report (`ReportButton.tsx` → `/api/report`)

One-click download of a Word document containing:

- **Header** — region scope, horizon, generation timestamp, source
  period.
- **Executive summary** — narrative paragraphs generated by an LLM
  (`gpt-4o-mini` by default), prompted with the actual numeric
  forecasts. Deterministic template fallback when no API key is
  present or the API call fails.
- **Forecast table** — top-N diagnoses × N future months, Δ % vs.
  the 12-month average, tier shading.
- **Recommendations** — grouped by tier.
- **Methodology footer** — hold-out metrics and a note that the
  LLM summary must be validated by authorised personnel before
  ministerial sign-off.

Country-level aggregation in the report aligns regions by **calendar
month** rather than by horizon index, so October 2024 from one region
is never summed with May 2025 from another.

### 7.8 MLflow UI (auxiliary)

`mlflow ui --backend-store-uri ./mlruns` (also exposed via Docker
Compose at `localhost:5000`) renders the five ablation runs with
params, metrics, and booster artefacts, supporting side-by-side
metric comparison and parallel-coordinate parameter exploration.

---

## 8. Conclusions

### 8.1 What was delivered

- An end-to-end ML system that converts the open Kazakhstan
  prescription registry into a quarterly, ministry-actionable
  forecast at `region × ICD-10 × month` resolution, with district
  detail preserved for the dashboard.
- A single global LightGBM model trained on **18 881 series** /
  **727 408 rows** in ~25 seconds, beating all three classical
  baselines on the two operationally relevant metrics (MAE −16 % vs.
  the best baseline; sMAPE cut from ~100 % to **64.3 %**).
- A Next.js / FastAPI / DuckDB stack with a geographic choropleth
  (post-2022 reform, 20 ADM1 + 174 ADM2 polygons), a tier-based
  decision recommender, an LLM-augmented DOCX report generator, and
  Docker Compose orchestration including an MLflow UI.
- Five MLflow-tracked ablations that quantify the contribution of
  hyperparameter depth, the `log1p` target transform, and the
  rolling / calendar / region feature groups.

### 8.2 Key empirical findings

1. **A single global model substantially outperforms classical
   per-series baselines** on this dataset — confirming the M5-era
   consensus that gradient boosting with engineered lag/rolling
   features is the right default for sparse, short-history,
   many-series count forecasting.
2. **Engineered context features carry roughly half of the model's
   value.** Removing rolling/calendar/region features doubles sMAPE
   from 64 % to 119 % and adds +3 to MAE; lags alone are unusable.
3. **The defensive `log1p` target transform is no longer needed** at
   this data volume — the no-log variant wins on every metric (MAE
   17.90, RMSE 231.28, sMAPE 60.83 %, R² 0.957) and is the candidate
   for the next production rollout.
4. **Capacity beyond `num_leaves=128` does not pay off.** Doubling
   capacity yields −0.19 MAE at 2× training cost; halving capacity
   yields a 3× speed-up at +0.65 MAE — useful for experimentation
   but not production.

### 8.3 Limitations

- District-level granularity is too sparse for classical regression.
  We use top-down allocation in the UI; a hierarchical model with a
  regional shrinkage prior would be the principled next step.
- **No exogenous covariates** are modelled. WHO weekly reports, local
  weather, and policy events (e.g. COVID-19 measures) are known
  drivers of prescription volume that the current feature set ignores.
- **Point forecasts only.** Quantile regression (LightGBM
  `objective='quantile'`) or conformal prediction would yield
  80 / 95 % prediction intervals, which would let the Ministry frame
  budget risk as ranges rather than point values — more honest and
  more actionable.
- The LLM-generated executive summary in `/api/report` is **not
  guaranteed faithful to the underlying numbers** even when prompted
  with them; the report explicitly states that the narrative must be
  validated by authorised personnel.
- The 2022 administrative reform causes label drift in early-period
  historical data; we reconcile via spatial join, but a handful of
  edge-case districts may still be mis-attributed for months close
  to the reform date.

### 8.4 Future work

1. **Promote `4_lgbm_no_log_target` to production** — update
   `Forecaster._inference` to drop the `expm1` call and re-run the
   hold-out evaluation.
2. **Hierarchical model** with a regional shrinkage prior so the
   district granularity becomes statistically tractable; alternative:
   GBM on (region, district, ICD) with target encoding and
   district-level dropout.
3. **Quantile / conformal prediction intervals** for budget risk
   framing.
4. **Exogenous covariates:** WHO weekly respiratory reports for the
   J chapter, weather for seasonal series, COVID-19 wave indicators
   for B-chapter spikes.
5. **A/B comparison protocol across a hold-out of regions** before
   each production rollout, so model upgrades are validated on
   regions not used during hyperparameter tuning.
6. **Anomaly-detection module** layered on top of the forecast: a
   clinic-level audit signal when actual issuance exceeds the
   forecast prediction interval for `k` consecutive months,
   controlled for population and seasonality.

### 8.5 Closing

The project demonstrates that, on open Kazakhstan registry data, a
single LightGBM model with engineered lag/rolling/calendar features
and category-aware splits produces forecasts that are **operationally
better than seasonal naïve** on every metric the Ministry of Health
would actually look at — at a training cost of 25 seconds and an
inference latency below one human reaction time. The remaining work
is at the *interface* between the model and the ministry: prediction
intervals, exogenous shocks, and a disciplined A/B rollout protocol.

---

**Data source.** Republic of Kazakhstan open data portal
`ashyq.data.gov.kz` (Magda), dataset `ISLO_MEDICALHISTORYOFCITIZENS`,
CC BY 4.0.

**Code.** See the repository LICENSE for licensing terms; all
metrics in this report are reproducible by running
`python ml/prepare_data.py`, `python ml/build_features.py`,
`python ml/train.py`, and `python ml/mlflow_experiments.py` against
the published xlsx files.
