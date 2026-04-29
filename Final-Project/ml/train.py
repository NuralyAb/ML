"""
Train a LightGBM regressor that forecasts monthly prescription counts at
(region, icd_code, year_month) granularity. Uses time-based hold-out.

Baselines compared:
  * Naive last value         (y_t-1)
  * Seasonal naive (lag-12)  (y_t-12)
  * Rolling mean (3 months)
  * LightGBM with lag/rolling/calendar features (the production model)

Metrics: MAE, RMSE, MAPE (excluding zero targets), R^2.

Outputs (under ml/models/):
  * lgbm_recipe_forecast.txt   - LightGBM booster
  * metadata.json              - feature list, label encoders, training info,
                                 metrics, last available month
  * eval_predictions.parquet   - per-row predictions on the holdout (for the
                                 frontend "model evaluation" panel)
"""
from __future__ import annotations
import os, json, time
from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import LabelEncoder

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
MODELS = os.path.join(ROOT, "ml", "models")
os.makedirs(MODELS, exist_ok=True)

FEATURE_PATH = os.path.join(DATA, "feature_panel.parquet")
MODEL_PATH = os.path.join(MODELS, "lgbm_recipe_forecast.txt")
META_PATH = os.path.join(MODELS, "metadata.json")
PRED_PATH = os.path.join(MODELS, "eval_predictions.parquet")

# Last `HOLDOUT_MONTHS` of every series form the test set (real
# walk-forward style — the model never sees future months).
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


def smape(y_true, y_pred):
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    denom = (np.abs(y_true) + np.abs(y_pred))
    mask = denom > 0
    if not mask.any():
        return float("nan")
    return float(np.mean(2.0 * np.abs(y_pred[mask] - y_true[mask]) / denom[mask]) * 100.0)


def mape(y_true, y_pred):
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    mask = y_true > 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100.0)


def metric_block(y_true, y_pred) -> dict:
    return {
        "MAE": float(mean_absolute_error(y_true, y_pred)),
        "RMSE": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "MAPE": mape(y_true, y_pred),
        "sMAPE": smape(y_true, y_pred),
        "R2": float(r2_score(y_true, y_pred)),
    }


def main():
    df = pd.read_parquet(FEATURE_PATH)
    print(f"feature rows: {len(df):,}, series: {df.groupby(['region','icdid']).ngroups:,}")

    # Drop rows where lag features can't be computed (early months).
    needed = NUM_COLS
    df = df.dropna(subset=needed).reset_index(drop=True)
    print(f"after dropna: {len(df):,}")

    # Per-series hold-out: the last `HOLDOUT_MONTHS` observations of every
    # (region, icd) series are reserved for testing. A single global cutoff
    # would test only the few regions whose data extends furthest in time.
    df = df.sort_values(["region", "icdid", "year_month"]).reset_index(drop=True)
    df["_pos_from_end"] = (
        df.groupby(["region", "icdid"]).cumcount(ascending=False)
    )
    test_mask = df["_pos_from_end"] < HOLDOUT_MONTHS
    train_mask = ~test_mask

    train_df = df[train_mask].copy()
    test_df = df[test_mask].copy()
    train_df = train_df.drop(columns=["_pos_from_end"])
    test_df = test_df.drop(columns=["_pos_from_end"])
    df = df.drop(columns=["_pos_from_end"])
    print(f"train rows: {len(train_df):,} | test rows: {len(test_df):,}")
    print(f"train period: {train_df['year_month'].min().date()} -> {train_df['year_month'].max().date()}")
    print(f"test  period: {test_df['year_month'].min().date()} -> {test_df['year_month'].max().date()}")
    print(f"test regions: {test_df['region'].nunique()} | series: {test_df.groupby(['region','icdid']).ngroups}")

    # Encode categoricals with shared label encoders.
    encoders: dict[str, LabelEncoder] = {}
    for col in CAT_COLS:
        le = LabelEncoder()
        all_vals = pd.concat([train_df[col], test_df[col]]).astype(str).fillna("?")
        le.fit(all_vals)
        train_df[col + "_enc"] = le.transform(train_df[col].astype(str).fillna("?"))
        test_df[col + "_enc"] = le.transform(test_df[col].astype(str).fillna("?"))
        encoders[col] = le

    feat_cols = NUM_COLS + [c + "_enc" for c in CAT_COLS]

    X_train, y_train = train_df[feat_cols], train_df["recipe_count"].astype(float)
    X_test, y_test = test_df[feat_cols], test_df["recipe_count"].astype(float)

    # log1p target stabilises a long-tailed count distribution.
    y_train_log = np.log1p(y_train)

    cat_idx = [feat_cols.index(c + "_enc") for c in CAT_COLS]

    train_set = lgb.Dataset(X_train, label=y_train_log, categorical_feature=cat_idx)
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
    t0 = time.time()
    booster = lgb.train(
        params,
        train_set,
        num_boost_round=900,
        valid_sets=[train_set],
        valid_names=["train"],
        callbacks=[lgb.log_evaluation(period=100)],
    )
    print(f"training: {time.time() - t0:.1f}s")

    # Predict.
    pred_log = booster.predict(X_test, num_iteration=booster.best_iteration)
    pred = np.clip(np.expm1(pred_log), 0, None)

    # Baselines (computed from features without leaking).
    base_naive = test_df["lag_1"].clip(lower=0).fillna(0).values
    base_seasonal = test_df["lag_12"].fillna(test_df["lag_1"]).clip(lower=0).fillna(0).values
    base_roll3 = test_df["roll_mean_3"].clip(lower=0).fillna(0).values

    metrics = {
        "lightgbm": metric_block(y_test, pred),
        "naive_last": metric_block(y_test, base_naive),
        "seasonal_naive_12": metric_block(y_test, base_seasonal),
        "rolling_mean_3": metric_block(y_test, base_roll3),
    }
    print("\n=== METRICS (holdout) ===")
    print(json.dumps(metrics, indent=2))

    # Save artifacts.
    booster.save_model(MODEL_PATH, num_iteration=booster.best_iteration)

    feat_imp = pd.DataFrame({
        "feature": feat_cols,
        "gain": booster.feature_importance(importance_type="gain"),
        "split": booster.feature_importance(importance_type="split"),
    }).sort_values("gain", ascending=False)

    encoder_classes = {
        col: list(le.classes_) for col, le in encoders.items()
    }

    last_month = df["year_month"].max().strftime("%Y-%m-%d")
    metadata = {
        "model": "lightgbm",
        "trained_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "holdout_months": HOLDOUT_MONTHS,
        "feature_columns": feat_cols,
        "numeric_columns": NUM_COLS,
        "categorical_columns": CAT_COLS,
        "encoder_classes": encoder_classes,
        "metrics": metrics,
        "feature_importance": feat_imp.to_dict(orient="records"),
        "last_observed_month": last_month,
        "n_train_rows": int(len(train_df)),
        "n_test_rows": int(len(test_df)),
        "n_series": int(df.groupby(["region", "icdid"]).ngroups),
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2, default=str)

    eval_df = test_df[["region", "icdid", "nozology", "year_month"]].copy()
    eval_df["actual"] = y_test.values
    eval_df["predicted"] = pred
    eval_df["naive_last"] = base_naive
    eval_df["seasonal_naive"] = base_seasonal
    eval_df.to_parquet(PRED_PATH, index=False)

    print(f"saved model:    {MODEL_PATH}")
    print(f"saved metadata: {META_PATH}")
    print(f"saved eval:     {PRED_PATH}")


if __name__ == "__main__":
    main()
