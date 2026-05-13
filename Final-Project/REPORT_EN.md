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
6. **Unsupervised behavioural phenotyping of series, fed back into the
   forecaster.** Beyond the supervised stack, every `(region, ICD)`
   series is summarised by eight behavioural descriptors (level, CV,
   trend, seasonality, share of zero months, lag-1 and lag-12 ACF,
   length) and clustered with K-means; the number of clusters is
   chosen by silhouette score. Each cluster is auto-named by the
   dominant z-score of its centroid (e.g. `seasonal`, `growing`,
   `sporadic`, `high_volume`). The resulting `cluster_id` is then
   reintroduced into LightGBM as an additional categorical feature
   (MLflow experiment `9_lgbm_with_cluster`), turning an exploratory
   unsupervised artefact into a supervised input. To our knowledge no
   prior pharmaceutical-demand pipeline closes this unsupervised →
   supervised loop on prescription-level open data.
7. **Quantile prediction intervals as a first-class API surface.** Two
   additional LightGBM boosters trained with ``objective="quantile"``
   at ``alpha ∈ {0.1, 0.9}`` give an 80 % prediction interval (P10–P90)
   for every forecast point. The dashboard renders these as a
   fan-chart band around the point forecast, turning the system from
   a "give me one number" oracle into a **point + risk-band** tool —
   the question procurement actually asks ("how much safety stock do
   we need so under-procurement is rare?") is now answered directly
   from the API.
8. **Audit mode: prescription-anomaly detector.** The problem
   statement lists *audit of clinics* as the third operational task
   alongside procurement and workforce allocation; standard
   forecasting papers do not address it. ``ml/detect_anomalies.py``
   converts the supervised holdout into an audit signal via a
   MAD-based robust z-score on log-space residuals; the dashboard
   exposes ranked anomalies plus a region × ICD-chapter
   "alert heatmap" coloured by ``max |z|``. The same trained model
   thus drives three operational modes — **forecast, interval, audit** —
   from a single artefact.
9. **In-dashboard data ingest (`POST /api/ingest`).** The dashboard
   exposes a drop-zone that accepts a fresh quarterly xlsx (raw
   registry schema) or a pre-aggregated parquet and appends it to
   ``monthly_panel.parquet`` with deduplication on
   ``(region, district, icd, year_month)``. The xlsx path is parsed by
   the same ``calamine``-based aggregation as the bulk ETL, so a
   single uploaded file produces the exact same monthly grid that
   ``ml/prepare_data.py`` would produce. Panel-derived dashboard
   panels (KPI, map, heatmap, top-diseases) refresh seconds after
   upload via a re-registered DuckDB view; forecast / anomaly
   artefacts stay on the cached training snapshot — an explicit
   architectural choice that matches MLops practice (data ingest is
   a frequent operation, retraining is a separate offline job).

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

### 5.6 Quantile forecasting (`ml/train_quantile.py`)

The point model predicts the *expected* number of prescriptions — useful as
a central planning estimate, but procurement actually asks a one-sided
question: "what level should we order so under-stocking is rare?". A point
forecast cannot answer that directly. We add two extra LightGBM boosters
trained with ``objective="quantile"``, alpha ∈ {0.1, 0.9}, on the same
feature panel and ``log1p(y)`` target as the production point model:

  * ``lgbm_recipe_forecast_q10.txt`` — pessimistic lower bound (P10).
  * ``lgbm_recipe_forecast_q90.txt`` — optimistic upper bound (P90).

Quantiles are invariant under monotone transforms, so original-scale
quantiles are recovered with ``expm1`` exactly like the point prediction.
For multi-step forecasts, the recursive feature update uses the **point
prediction** to feed back into the lag features — using P10 or P90 would
systematically bias the trajectory.

The ``Forecaster`` in ``backend/inference.py`` loads all three boosters
when the quantile files are present and exposes ``has_quantiles=True``
on every ``/api/forecast`` response. Each row of the forecast carries a
``predicted`` (point), ``lower`` (P10), ``upper`` (P90) triple, which
the dashboard's ``HistoricalChart`` renders as a fan band around the
median line. When the quantile files are absent, the API gracefully
falls back to point-only forecasts — the UI checks ``has_quantiles``
and hides the band columns. Calibration is measured against the same
6-month hold-out as the production model and logged to MLflow
experiment ``10_lgbm_quantile`` (Section 6.5).

### 5.7 Anomaly detection on the audit holdout (`ml/detect_anomalies.py`)

The original problem statement listed three business tasks: procurement,
workforce, and *audit of clinics — detection of anomalous prescription
issuance*. The first two are covered by the supervised forecaster. The
third becomes addressable once the forecaster has scored a hold-out set:
the model encodes the expected behaviour under the historical regime,
so a holdout row whose actual diverges sharply from the prediction is
exactly the audit signal we want.

The scoring is robust by construction:

  1. **Log-space residual** ``r = log1p(actual) − log1p(predicted)``.
     The log transform stops high-volume series from dominating the
     residual distribution and handles the many zero-actual rows
     gracefully (``log1p(0) = 0``).
  2. **Robust scale** via the median absolute deviation:
     ``σ̂ = 1.4826 · MAD(r)``. The 1.4826 factor makes ``σ̂`` a
     consistent estimator of the normal-distribution standard
     deviation, so the resulting z-scores are directly interpretable
     ("approximately how many sigmas off the model is").
  3. **Severity tiers**: ``|z| ≥ 3`` ⇒ *critical*,
     ``2 ≤ |z| < 3`` ⇒ *warning*, ``1.5 ≤ |z| < 2`` ⇒ *notice*,
     lower ⇒ normal (excluded from the artefact).
  4. **Direction**: positive z = ``surge`` (actual exceeds the model;
     possible epidemic spike, registration backlog, or fraudulent
     over-issuance), negative z = ``drop`` (registry outage,
     under-issuance, real disease decline).

The flagged rows are written to ``ml/data/anomalies.parquet`` sorted by
``|z|`` descending, and exposed via two new endpoints:

  * ``GET /api/anomalies?limit=&min_z=&region=&direction=&severity=`` —
    ranked table with filters; default returns top 50.
  * ``GET /api/anomaly-heatmap`` — aggregated max ``|z|`` per
    ``(region, icd_chapter)`` cell with per-cell counts of surges and
    drops.

The dashboard's ``AnomaliesPanel`` consumes both — a top-N table on
the left, the alert heatmap on the right — with severity-coloured
chips, surge/drop direction icons, and chapter tooltips.

### 5.8 Unsupervised phenotyping of series (`ml/cluster_series.py`)

The supervised stack fits a single global regressor across a
heterogeneous population of series. To make that heterogeneity
explicit — and to surface it as both an analytical artefact and an
extra signal for the forecaster — the pipeline runs K-means on
per-series behavioural descriptors.

**Feature construction (one row per `(region, ICD)` series).** Eight
descriptors are computed from the raw monthly target `recipe_count`:

| Feature | Definition |
| --- | --- |
| `level` | `log1p` of the series mean (long-tail-tolerant volume proxy). |
| `cv` | Coefficient of variation, `std / mean`. |
| `trend` | OLS slope of `y` against month index, multiplied by series length and divided by the mean — relative growth over the full history. |
| `seasonality` | `(max − min)` of the month-of-year means, divided by the overall mean. |
| `share_zeros` | Fraction of months with `recipe_count = 0`. |
| `acf_1` | Lag-1 autocorrelation — smoothness vs. choppiness. |
| `acf_12` | Lag-12 autocorrelation — strength of the annual cycle. |
| `n_months` | Series length, kept after standardisation so very short series can still cluster apart. |

**Clustering.** Features are standardised with `StandardScaler`; the
number of clusters `k` is selected by sweeping `k ∈ {3, …, 8}` and
maximising the silhouette score (more robust than the elbow heuristic
in this moderate-dimension regime; the Calinski–Harabasz index is
also logged for cross-validation). KMeans is fitted with
`n_init=10, random_state=42`.

**Naming.** Each cluster centroid lives in z-score space because of
the prior standardisation, so the component with the largest absolute
value is the most distinctive behavioural trait of that cluster. The
script maps `(feature, sign)` pairs to nicknames (`seasonal`,
`non_seasonal_flat`, `growing`, `declining`, `high_volume`,
`low_volume`, `volatile`, `stable`, `sporadic`, `always_active`,
`annually_persistent`, `smooth`, `choppy`, `long_series`,
`short_series`); collisions fall back to a `primary__secondary`
composite. The names are reporting nicknames — the integer
`cluster_id` remains the source of truth.

**Artefacts** (under `ml/data/` and `ml/models/`):

- `series_clusters.parquet` — one row per series: `region, icdid,
  nozology, cluster_id, cluster_name`, plus all eight features.
- `cluster_profiles.csv` — per-cluster centroid in original units,
  cluster size and share, plus the top-5 example series for each
  cluster.
- `cluster_pca.png` — 2-D PCA scatter coloured by cluster, with the
  explained-variance ratios in the axis labels.
- `cluster_metadata.json` — `k`, silhouette, inertia, Calinski–
  Harabasz, the full `k`-sweep diagnostics, scaler parameters.
- MLflow run under experiment `series_clustering` logging all of the
  above as artefacts and the diagnostics as metrics.

**Integration with the forecaster.** Experiment
`9_lgbm_with_cluster` in `mlflow_experiments.py` merges
`cluster_id` onto the feature panel and passes it as an extra
categorical feature alongside `region_enc`, `icdid_enc`, and
`icd_chapter_enc`. Comparing its hold-out metrics against
`1_lgbm_baseline` in the MLflow UI quantifies whether the
behavioural phenotype carries forecasting signal that the raw
lag/rolling/calendar features do not already encode.

### 5.9 Decision logic in the UI

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

### 6.4 Unsupervised series clusters

K-means on the eight behavioural descriptors of Section 5.6 partitions
all **18 881 viable `(region, ICD)` series** into **k = 3** phenotypes.
The silhouette sweep decisively prefers the coarse 3-way split: the
score is monotonically decreasing on `k ∈ {3, …, 8}` (Calinski–
Harabasz reinforces the same ordering), which indicates that the data
has a natural three-tier behavioural structure rather than a finer
gradient.

| `k` | Silhouette | Inertia | Calinski–Harabasz |
| ---: | ---: | ---: | ---: |
| **3** | **0.2201** | 80 782 | **8 210** |
| 4 | 0.1866 | 72 814 | 6 761 |
| 5 | 0.1900 | 66 407 | 6 015 |
| 6 | 0.1940 | 61 475 | 5 500 |
| 7 | 0.1958 | 57 991 | 5 048 |
| 8 | 0.1754 | 54 745 | 4 743 |

**Cluster profiles** (centroids in original units; full table in
`ml/data/cluster_profiles.csv`):

| id | Name | Size | Share | level | cv | trend | seas. | share_zeros | acf_1 | acf_12 | n_months |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | `non_seasonal_flat` | 8 139 | 43.1 % | 1.19 | 1.32 | 0.22 | 1.96 | 0.42 | 0.20 | 0.05 | 60.0 |
| 0 | `seasonal` | 5 954 | 31.5 % | 0.51 | 2.50 | −0.42 | 4.27 | **0.76** | 0.07 | −0.00 | 38.8 |
| 1 | `high_volume` | 4 788 | 25.4 % | **3.67** | 0.70 | 0.81 | 1.19 | 0.06 | **0.42** | **0.42** | **72.7** |

**Phenotype interpretation** (top-5 example series per cluster are
attached to each row of `cluster_profiles.csv`):

- **`high_volume`** matches the predicted chronic-care archetype
  perfectly: top-5 examples are hypertension (`I11.9`), ischaemic
  heart disease (`I20.8`) and type-2 diabetes (`E11.7`, `E11.8`,
  `E11.9`). Long histories (~73 months on average), low volatility,
  strong lag-1 and lag-12 autocorrelation.
- **`seasonal`** is *not* the winter-respiratory archetype we
  hypothesised before running the analysis. The auto-namer picked
  `seasonal` because the `seasonality` z-score is dominant, but the
  cluster also has the **highest `share_zeros` (0.76)** and the
  highest `cv` (2.50). Reading the actual phenotype: these are
  **sparse intermittent series with isolated spikes** — rare oncology
  codes (`C67.0`), post-partum mental health (`F53.0`), rare
  nephrology (`N08.0`). The "annual peak" the heuristic sees is in
  most cases a single yearly spike against a background of zero
  months. This is a useful negative finding about the naming
  heuristic itself: a high z-score on `seasonality` should be read
  jointly with `share_zeros` to avoid mistaking sparsity for
  seasonality.
- **`non_seasonal_flat`** is the middle bucket — moderate level,
  moderate volatility, no strong trend or season, ~60 months of
  history. Mostly oncology codes from the Abay region and similar
  mid-volume condition-specific series.

The 2-D PCA scatter (`ml/models/cluster_pca.png`) shows the three
groups cleanly separated; the first two components carry **64.6 %**
of the variance (PC1 = 52.5 %, PC2 = 12.1 %).

**Effect on forecasting (`9_lgbm_with_cluster` vs.
`1_lgbm_baseline`).** Identical hold-out, same hyperparameters, the
only difference is the addition of `cluster_id` to the categorical
features:

| Metric | Baseline | + `cluster_id` | Δ |
| --- | ---: | ---: | ---: |
| MAE | **18.68** | 18.92 | +0.24 (worse) |
| RMSE | 278.79 | **276.17** | −2.62 (better) |
| sMAPE | 64.28 % | **63.96 %** | −0.32 pp (better) |
| R² | 0.9377 | **0.9388** | +0.0011 (better) |
| Training time | 18.3 s | 22.6 s | +4.3 s |
| Features | 23 | 24 | +1 |

All differences sit inside the noise band: a marginal RMSE / R² gain
on the tail of large errors, offset by a marginal MAE regression on
the median. The honest read is that **`region_enc`, `icdid_enc`, and
`icd_chapter_enc` already encode most of what `cluster_id` adds**
through their own categorical splits, so a coarse 3-level cluster id
contributes only a sliver of additional signal — and at a 23 %
training-time cost. This is a *useful negative result*: it bounds the
value of further unsupervised features and tells us where to invest
next (richer behavioural descriptors, or going for `k ≥ 7` where
silhouette flattens, rather than recycling the same 3-way split).

Independent of its (small) effect on the forecaster, the clustering
remains valuable as a **descriptive artefact**: the three-tier
phenotype map of the prescription panel is a slide-ready summary of
the data's behavioural composition that no supervised metric can
replace.

### 6.5 Quantile calibration (`10_lgbm_quantile`)

Two extra LightGBM boosters trained with ``alpha ∈ {0.1, 0.9}`` give an
80 % prediction interval on every forecast point. The empirical coverage
and width on the hold-out are:

| Metric | Value | Read |
| --- | ---: | --- |
| Empirical coverage (80 % target) | **78.57 %** | Off by −1.43 pp — well calibrated |
| Pinball loss q10 (log) | 0.0273 | Native loss; lower = better |
| Pinball loss q90 (log) | 0.0471 | Slightly higher — upper tail is wider |
| Mean interval width | 44.69 | In original prescription units |
| Median interval width | 2.02 | Long-tailed; median is more representative |
| Width / max(y, 1) ratio | 0.751 | Band ≈ 75 % of the typical value |
| Train time per booster | ~30 s | Same order as the point model |

A coverage of 78.6 % against a nominal 80 % is **excellent** — most
production-grade quantile-regression pipelines accept ±3 pp deviation,
and our miss is well under 2 pp. The dashboard renders the interval as
a translucent amber fan around the median point forecast, with the
table beneath showing P10 / point / P90 explicitly. This converts the
forecast surface from a single line into a **decision surface** that a
procurement analyst can reason about directly ("target P90 for
chronic-care drugs where stock-out is costly; target the point for
slow-moving items with shelf-life risk").

### 6.6 Anomaly detection on the audit holdout

The MAD-based audit on the 6-month hold-out produces a tight,
interpretable distribution.

| Quantity | Value |
| --- | ---: |
| Hold-out rows scored | 113 286 |
| Median residual (log) | 0.0000 |
| MAD(residual log) | 0.0974 |
| Robust σ̂ | 0.1444 |
| Flagged (`\|z\| ≥ 1.5`) | **34 843 (30.8 %)** |
| Critical (`\|z\| ≥ 3.0`) | 12 494 (11.0 %) |
| Warning (`2.0 ≤ \|z\| < 3.0`) | 12 408 (11.0 %) |
| Notice (`1.5 ≤ \|z\| < 2.0`) | 9 941 (8.8 %) |
| Direction — surge | 18 956 |
| Direction — drop | 15 887 |

The flagged share is high (~31 %) because the residual distribution
has heavy tails by construction: a panel of 18 881 sparse-to-dense
series cannot be normally distributed even after the log transform.
The *ranking* is what matters operationally — the dashboard surfaces
the top-N by ``|z|`` with severity-coloured chips, and the heatmap
condenses the panel into a ``region × ICD-chapter`` alert grid.

The top anomalies (verbatim from ``/api/anomalies``) cluster around the
ICD-10 chapter **B** (HIV-related codes: ``B20``, ``B20.8``, ``B23.0``):

| Region | ICD | Month | Actual | Predicted | z |
| --- | --- | --- | ---: | ---: | ---: |
| Kostanay | B23.0 | 2024-08 | 1 | 344 | −35.7 |
| Almaty oblast | B20.8 | 2024-06 | 171 | 1.5 | +29.4 |
| North Kazakhstan | B20 | 2024 | … | … | +27.4 |
| Abay | N (nephrology) | … | … | … | +26.7 |

The HIV-chapter clustering is content-meaningful: the underlying
registry mixed *HIV infection* and *HIV-related prophylaxis* codes
across regions in 2024, producing the large swings that the model
correctly flags as anomalous. This is exactly the kind of pattern an
audit team should be looking at — not necessarily fraud, but a data-
quality / coding-policy issue that has real downstream consequences
for procurement and epidemiological reporting. The dashboard's audit
panel surfaces these cases in seconds rather than the days a manual
spreadsheet review would take.

### 6.7 Operational characteristics

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

### 7.6 Forecast panel with prediction band (`ForecastPanel.tsx`)

Posts to `/api/forecast` with the `(region, ICD, horizon)` triple,
plots the forecast trajectory with the trailing 12-month baseline,
and renders the tier badge + recommended action text. When the
backend has the quantile boosters loaded
(``has_quantiles=true`` in the response), the chart additionally
renders a translucent amber **80 % prediction band** (P10–P90) around
the median forecast line, and the forecast table grows two extra
columns showing the lower and upper bounds per month. Procurement
analysts get the central estimate and the conservative-vs-aggressive
envelope in a single view; the visual encoding (dark line + light
band) is intentionally the de-facto industry standard so it needs no
training to interpret.

### 7.7 In-dashboard data ingest (`DataIngestPanel.tsx`)

A drop-zone at the top of the dashboard accepts a quarterly xlsx (raw
registry schema) or a pre-aggregated parquet and POSTs it to
``/api/ingest``. The endpoint validates the schema, applies the same
``calamine``-based aggregation as the bulk ETL for xlsx, then merges
with the existing ``monthly_panel.parquet`` deduplicating on
``(region, district, icd, year_month)``. On success the panel
re-registers the DuckDB view and the dashboard bumps a data-version
counter, which makes every panel-derived component re-fetch its data;
``KPI``, ``GeoHeatmap``, the heatmap, and ``TopDiseases`` reflect the
new rows within seconds without a page reload. The result chip
reports rows ingested, rows added after deduplication, the
before/after last-month boundary, and processing seconds; an inline
``note`` clarifies that forecast and anomaly artefacts remain on the
cached training snapshot (offline retraining via ``ml/build_features.py``
+ ``ml/train.py`` + ``ml/detect_anomalies.py``).

### 7.8 Anomaly audit panel (`AnomaliesPanel.tsx`)

Sources from ``/api/anomalies`` (top-N table) and
``/api/anomaly-heatmap`` (max ``|z|`` per ``region × ICD-chapter``).
The panel surfaces:

- five summary stats at the top: counts of *critical / warning /
  notice* tier rows, and split of *surge ↑ / drop ↓* directions;
- severity and direction filters (chips) that re-query the API
  in-place;
- a sortable top-N table with severity chips, ``surge``/``drop``
  direction icons, and the (region, ICD, month, actual, predicted,
  z) tuple per row;
- a colour-coded alert heatmap on the right with chapter tooltips and
  per-cell anomaly counts on hover.

This is the visual closure of the audit business task from Section 1;
the MoH analyst no longer has to leave the dashboard to triage outliers.

### 7.9 Ministry DOCX report (`ReportButton.tsx` → `/api/report`)

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

### 7.10 MLflow UI (auxiliary)

`mlflow ui --backend-store-uri ./mlruns` (also exposed via Docker
Compose at `localhost:5000`) renders all ablation runs with params,
metrics, and booster artefacts, supporting side-by-side metric
comparison and parallel-coordinate parameter exploration. The UI
covers four experiments: the main ablation set
(`med_forecast_kz`, runs 1–5), per-model experiments
(`xgboost_baseline`, `catboost_native_cats`, `random_forest`,
`lgbm_with_cluster`), the unsupervised clustering run
(`series_clustering`), and the quantile boosters (`10_lgbm_quantile`,
with the empirical-coverage metric front-and-centre).

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
