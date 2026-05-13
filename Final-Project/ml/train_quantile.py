"""
Train quantile LightGBM forecasters (P10 and P90) alongside the production
mean-regression model.

Why
---
The production model (`ml/train.py`) returns a point forecast — useful for the
central planning estimate, but it gives no answer to the budget-risk question
*"how much safety stock do we need so that under-procurement is rare?"*.
Quantile regression gives that directly: training two extra LightGBM boosters
with ``objective="quantile"`` and ``alpha ∈ {0.1, 0.9}`` produces P10 and P90
predictions, i.e. an **80% prediction interval** at every forecast point.

  * P10 = pessimistic / lower bound — under-stocking risk if procurement
    targets this level.
  * P90 = optimistic / upper bound — over-stocking risk above this level.
  * The existing baseline serves as the central estimate.

The quantile transform is monotone with ``log1p``, so we train on the same
``log1p(recipe_count)`` target as the baseline and recover original-scale
quantiles via ``expm1``.

Outputs (under ml/models/)
  * lgbm_recipe_forecast_q10.txt   LightGBM booster, alpha=0.1
  * lgbm_recipe_forecast_q90.txt   LightGBM booster, alpha=0.9

Reported metrics (MLflow experiment ``10_lgbm_quantile``)
  * pinball_loss_q10 / pinball_loss_q90   per-quantile native loss
  * empirical_coverage_80                 share of holdout rows with q10 <= y <= q90
  * mean_interval_width                   mean(q90 - q10) in original units
  * median_interval_width                 robust version of the same
  * width_to_value_ratio                  mean((q90 - q10) / max(y, 1)) — relative

Run from the project root:

    python ml/train_quantile.py
"""
from __future__ import annotations
import os, json, time

import numpy as np
import pandas as pd
import lightgbm as lgb
import mlflow
from sklearn.preprocessing import LabelEncoder

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
MODELS = os.path.join(ROOT, "ml", "models")
MLRUNS_DIR = os.path.join(ROOT, "mlruns")
os.makedirs(MODELS, exist_ok=True)
os.makedirs(MLRUNS_DIR, exist_ok=True)

FEATURE_PATH = os.path.join(DATA, "feature_panel.parquet")
META_PATH = os.path.join(MODELS, "metadata.json")
Q10_PATH = os.path.join(MODELS, "lgbm_recipe_forecast_q10.txt")
Q90_PATH = os.path.join(MODELS, "lgbm_recipe_forecast_q90.txt")

# Mirror train.py exactly so the quantile models are directly comparable to
# the production point model.
HOLDOUT_MONTHS = 6
CAT_COLS = ["region", "icdid", "icd_chapter"]
NUM_COLS = [
    "lag_1", "lag_2", "lag_3", "lag_6", "lag_12",
    "roll_mean_3", "roll_mean_6", "roll_mean_12",
    "roll_std_3", "roll_std_6", "roll_std_12",
    "expanding_mean", "region_total_lag1",
    "month", "quarter", "month_idx", "month_sin", "month_cos",
    "n_clinics", "n_districts",
]
BASE_PARAMS = dict(
    objective="quantile",        # overridden per-alpha below — kept for clarity
    metric="quantile",
    learning_rate=0.05,
    num_leaves=128,
    min_data_in_leaf=40,
    feature_fraction=0.9,
    bagging_fraction=0.9,
    bagging_freq=5,
    lambda_l2=1.0,
    verbose=-1,
)
NUM_BOOST_ROUND = 900
EXPERIMENT = "10_lgbm_quantile"


def pinball_loss(y_true: np.ndarray, y_pred: np.ndarray, alpha: float) -> float:
    """Native loss for quantile regression. Lower = better calibrated."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    diff = y_true - y_pred
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1.0) * diff)))


def main() -> None:
    df = pd.read_parquet(FEATURE_PATH)
    print(f"feature rows: {len(df):,}  series: {df.groupby(['region','icdid']).ngroups:,}")

    df = df.dropna(subset=NUM_COLS).reset_index(drop=True)
    print(f"after dropna: {len(df):,}")

    df = df.sort_values(["region", "icdid", "year_month"]).reset_index(drop=True)
    pos = df.groupby(["region", "icdid"]).cumcount(ascending=False)
    test_mask = pos < HOLDOUT_MONTHS
    train_df = df[~test_mask].copy()
    test_df = df[test_mask].copy()
    print(f"train rows: {len(train_df):,} | test rows: {len(test_df):,}")

    # Reuse the production encoders so categorical splits land on the same
    # bin boundaries as the baseline — apples-to-apples comparison.
    encoders: dict[str, LabelEncoder] = {}
    if os.path.exists(META_PATH):
        with open(META_PATH, "r", encoding="utf-8") as f:
            meta = json.load(f)
        for col, classes in meta.get("encoder_classes", {}).items():
            le = LabelEncoder()
            le.classes_ = np.array(classes)
            encoders[col] = le
        print(f"reused encoders from {META_PATH}")
    else:
        encoders = {}

    for col in CAT_COLS:
        le = encoders.get(col)
        if le is None or set(train_df[col].astype(str).unique()).difference(set(le.classes_)):
            # Fresh encoder when the cached one is missing or doesn't cover all
            # categories (e.g. retraining on a newer panel).
            le = LabelEncoder()
            all_vals = pd.concat([train_df[col], test_df[col]]).astype(str).fillna("?")
            le.fit(all_vals)
        encoders[col] = le

        def safe_transform(s: pd.Series) -> np.ndarray:
            vals = s.astype(str).fillna("?")
            known = set(le.classes_)
            vals = vals.where(vals.isin(known), other="?" if "?" in known else le.classes_[0])
            return le.transform(vals)

        train_df[col + "_enc"] = safe_transform(train_df[col])
        test_df[col + "_enc"] = safe_transform(test_df[col])

    feat_cols = NUM_COLS + [c + "_enc" for c in CAT_COLS]
    cat_idx = [feat_cols.index(c + "_enc") for c in CAT_COLS]

    X_train = train_df[feat_cols]
    X_test = test_df[feat_cols]
    y_train = train_df["recipe_count"].astype(float)
    y_test = test_df["recipe_count"].astype(float).to_numpy()

    # log1p-target — preserves quantile relationships under monotone transform.
    y_train_log = np.log1p(y_train)
    y_test_log = np.log1p(y_test)

    # Keep the raw data on the Dataset so it can be reused across both alpha
    # runs — LightGBM otherwise frees the buffer after the first lgb.train()
    # and the second call raises "Cannot set categorical feature after freed
    # raw data".
    train_set = lgb.Dataset(X_train, label=y_train_log,
                            categorical_feature=cat_idx, free_raw_data=False)

    mlflow.set_tracking_uri(f"file:{MLRUNS_DIR}")
    mlflow.set_experiment(EXPERIMENT)

    results: dict[float, dict] = {}
    for alpha, out_path in [(0.1, Q10_PATH), (0.9, Q90_PATH)]:
        params = dict(BASE_PARAMS)
        params["objective"] = "quantile"
        params["alpha"] = alpha

        t0 = time.time()
        booster = lgb.train(
            params,
            train_set,
            num_boost_round=NUM_BOOST_ROUND,
        )
        duration = time.time() - t0

        pred_log = booster.predict(X_test, num_iteration=booster.best_iteration)
        pred = np.clip(np.expm1(pred_log), 0, None)
        loss_log = pinball_loss(y_test_log, pred_log, alpha)

        booster.save_model(out_path, num_iteration=booster.best_iteration)
        results[alpha] = dict(pred=pred, booster=booster, duration=duration, loss_log=loss_log)
        print(f"alpha={alpha:>4} -> pinball_loss(log)={loss_log:.4f}  trained in {duration:.1f}s  saved {out_path}")

    q10 = results[0.1]["pred"]
    q90 = results[0.9]["pred"]
    inside = ((q10 <= y_test) & (y_test <= q90)).mean()
    widths = q90 - q10
    rel_widths = widths / np.maximum(y_test, 1.0)
    print("\n=== Holdout calibration ===")
    print(f"empirical coverage (80% target): {inside:.4f}")
    print(f"mean interval width:             {widths.mean():.2f}")
    print(f"median interval width:           {np.median(widths):.2f}")
    print(f"mean width / max(y,1) ratio:     {rel_widths.mean():.3f}")

    metadata_addendum = {
        "quantile_model_paths": {
            "q10": os.path.basename(Q10_PATH),
            "q90": os.path.basename(Q90_PATH),
        },
        "quantile_metrics": {
            "pinball_loss_q10_log": results[0.1]["loss_log"],
            "pinball_loss_q90_log": results[0.9]["loss_log"],
            "empirical_coverage_80": float(inside),
            "mean_interval_width": float(widths.mean()),
            "median_interval_width": float(np.median(widths)),
            "width_to_value_ratio": float(rel_widths.mean()),
        },
        "quantile_trained_at": pd.Timestamp.now(tz="UTC").isoformat(),
    }
    if os.path.exists(META_PATH):
        with open(META_PATH, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta.update(metadata_addendum)
        with open(META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2, default=str)
        print(f"\nupdated {META_PATH} with quantile_metrics + quantile_model_paths")
    else:
        print(f"\n{META_PATH} missing — quantile metadata not merged (run ml/train.py first)")

    with mlflow.start_run(run_name="lgbm_quantile_p10_p90"):
        mlflow.set_tag("description",
                       "Quantile LightGBM boosters at alpha=0.1 and alpha=0.9 for 80% prediction intervals.")
        mlflow.log_params({
            **{k: v for k, v in BASE_PARAMS.items() if k != "verbose"},
            "num_boost_round": NUM_BOOST_ROUND,
            "holdout_months": HOLDOUT_MONTHS,
            "n_train_rows": int(len(train_df)),
            "n_test_rows": int(len(test_df)),
            "alpha_low": 0.1,
            "alpha_high": 0.9,
        })
        mlflow.log_metric("pinball_loss_q10_log", results[0.1]["loss_log"])
        mlflow.log_metric("pinball_loss_q90_log", results[0.9]["loss_log"])
        mlflow.log_metric("empirical_coverage_80", float(inside))
        mlflow.log_metric("mean_interval_width", float(widths.mean()))
        mlflow.log_metric("median_interval_width", float(np.median(widths)))
        mlflow.log_metric("width_to_value_ratio", float(rel_widths.mean()))
        mlflow.log_metric("training_seconds_q10", float(results[0.1]["duration"]))
        mlflow.log_metric("training_seconds_q90", float(results[0.9]["duration"]))
        mlflow.log_artifact(Q10_PATH, artifact_path="model")
        mlflow.log_artifact(Q90_PATH, artifact_path="model")

    print(f"\nsaved P10 booster: {Q10_PATH}")
    print(f"saved P90 booster: {Q90_PATH}")
    print(f"MLflow experiment '{EXPERIMENT}' at file:{MLRUNS_DIR}")


if __name__ == "__main__":
    main()
