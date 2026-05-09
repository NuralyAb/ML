"""
MLflow-tracked experiments for the prescription forecast model.

Five experiments are defined below — each varies one design dimension to
show its individual contribution against the production baseline:

  1. lgbm_baseline           production-tuned LightGBM (current default)
  2. lgbm_deep               more capacity (num_leaves=256, lr=0.03, 1500 rounds)
  3. lgbm_shallow            less capacity (num_leaves=32,  lr=0.10,  400 rounds)
  4. lgbm_no_log_target      identical to baseline but trained on raw counts (no log1p)
  5. lgbm_minimal_features   identical to baseline but only with lag features
                             (no rolling, no calendar, no region context)

For every run we log:
  - all hyperparameters (params)
  - hold-out metrics: MAE, RMSE, MAPE, sMAPE, R²        (vs the production target)
  - the trained booster file as an artifact
  - the feature-importance table as a CSV artifact

Run from the project root:
    python ml/mlflow_experiments.py

The MLflow tracking store lives at `./mlruns` (file-backend), so no
separate server is required. Inspect with:
    mlflow ui --backend-store-uri ./mlruns --port 5000
"""
from __future__ import annotations
import json, os, time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
import lightgbm as lgb
import mlflow
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import LabelEncoder

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
FEATURE_PATH = os.path.join(DATA, "feature_panel.parquet")
MLRUNS_DIR = os.path.join(ROOT, "mlruns")

EXPERIMENT = "med_forecast_kz"
HOLDOUT_MONTHS = 6

CAT_COLS = ["region", "icdid", "icd_chapter"]
FULL_NUM_COLS = [
    "lag_1", "lag_2", "lag_3", "lag_6", "lag_12",
    "roll_mean_3", "roll_mean_6", "roll_mean_12",
    "roll_std_3", "roll_std_6", "roll_std_12",
    "expanding_mean", "region_total_lag1",
    "month", "quarter", "month_idx", "month_sin", "month_cos",
    "n_clinics", "n_districts",
]
MINIMAL_NUM_COLS = ["lag_1", "lag_2", "lag_3", "lag_6", "lag_12"]


# ---------------------------------------------------------------------------
# Metric helpers
# ---------------------------------------------------------------------------

def smape(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    denom = np.abs(y_true) + np.abs(y_pred)
    mask = denom > 0
    if not mask.any():
        return float("nan")
    return float(np.mean(2.0 * np.abs(y_pred[mask] - y_true[mask]) / denom[mask]) * 100.0)


def mape(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    mask = y_true > 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100.0)


def metric_block(y_true, y_pred) -> dict:
    return {
        "MAE":   float(mean_absolute_error(y_true, y_pred)),
        "RMSE":  float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "MAPE":  mape(y_true, y_pred),
        "sMAPE": smape(y_true, y_pred),
        "R2":    float(r2_score(y_true, y_pred)),
    }


# ---------------------------------------------------------------------------
# Experiment configuration
# ---------------------------------------------------------------------------

@dataclass
class ExperimentConfig:
    name: str
    description: str
    params: dict = field(default_factory=dict)
    num_boost_round: int = 900
    log_target: bool = True
    feature_subset: str = "full"   # "full" | "minimal"


EXPERIMENTS: list[ExperimentConfig] = [
    ExperimentConfig(
        name="1_lgbm_baseline",
        description="Production-tuned LightGBM. 900 rounds, num_leaves=128, log1p target.",
        params=dict(
            objective="regression", metric="rmse",
            learning_rate=0.05, num_leaves=128, min_data_in_leaf=40,
            feature_fraction=0.9, bagging_fraction=0.9, bagging_freq=5,
            lambda_l2=1.0, verbose=-1,
        ),
        num_boost_round=900, log_target=True, feature_subset="full",
    ),
    ExperimentConfig(
        name="2_lgbm_deep",
        description="More capacity: num_leaves=256, lower lr=0.03, 1500 rounds.",
        params=dict(
            objective="regression", metric="rmse",
            learning_rate=0.03, num_leaves=256, min_data_in_leaf=20,
            feature_fraction=0.9, bagging_fraction=0.9, bagging_freq=5,
            lambda_l2=1.0, verbose=-1,
        ),
        num_boost_round=1500, log_target=True, feature_subset="full",
    ),
    ExperimentConfig(
        name="3_lgbm_shallow",
        description="Less capacity: num_leaves=32, higher lr=0.1, 400 rounds.",
        params=dict(
            objective="regression", metric="rmse",
            learning_rate=0.10, num_leaves=32, min_data_in_leaf=80,
            feature_fraction=0.9, bagging_fraction=0.9, bagging_freq=5,
            lambda_l2=1.0, verbose=-1,
        ),
        num_boost_round=400, log_target=True, feature_subset="full",
    ),
    ExperimentConfig(
        name="4_lgbm_no_log_target",
        description="Same as baseline but predicts raw counts (no log1p transform).",
        params=dict(
            objective="regression", metric="rmse",
            learning_rate=0.05, num_leaves=128, min_data_in_leaf=40,
            feature_fraction=0.9, bagging_fraction=0.9, bagging_freq=5,
            lambda_l2=1.0, verbose=-1,
        ),
        num_boost_round=900, log_target=False, feature_subset="full",
    ),
    ExperimentConfig(
        name="5_lgbm_minimal_features",
        description="Same hyperparameters as baseline but only lag_{1,2,3,6,12} as numeric features.",
        params=dict(
            objective="regression", metric="rmse",
            learning_rate=0.05, num_leaves=128, min_data_in_leaf=40,
            feature_fraction=0.9, bagging_fraction=0.9, bagging_freq=5,
            lambda_l2=1.0, verbose=-1,
        ),
        num_boost_round=900, log_target=True, feature_subset="minimal",
    ),
]


# ---------------------------------------------------------------------------
# Single experiment runner
# ---------------------------------------------------------------------------

def _split(df: pd.DataFrame):
    df = df.sort_values(["region", "icdid", "year_month"]).reset_index(drop=True)
    pos = df.groupby(["region", "icdid"]).cumcount(ascending=False)
    test_mask = pos < HOLDOUT_MONTHS
    return df[~test_mask].copy(), df[test_mask].copy()


def _encode(train: pd.DataFrame, test: pd.DataFrame):
    encs = {}
    for col in CAT_COLS:
        le = LabelEncoder()
        all_vals = pd.concat([train[col], test[col]]).astype(str).fillna("?")
        le.fit(all_vals)
        train[col + "_enc"] = le.transform(train[col].astype(str).fillna("?"))
        test[col + "_enc"] = le.transform(test[col].astype(str).fillna("?"))
        encs[col] = le
    return encs


def run_experiment(cfg: ExperimentConfig, df: pd.DataFrame) -> dict:
    num_cols = FULL_NUM_COLS if cfg.feature_subset == "full" else MINIMAL_NUM_COLS

    sub = df.dropna(subset=num_cols).reset_index(drop=True)
    train_df, test_df = _split(sub)
    _encode(train_df, test_df)

    feat_cols = num_cols + [c + "_enc" for c in CAT_COLS]
    cat_idx = [feat_cols.index(c + "_enc") for c in CAT_COLS]

    X_train, y_train = train_df[feat_cols], train_df["recipe_count"].astype(float)
    X_test, y_test = test_df[feat_cols], test_df["recipe_count"].astype(float)

    target_train = np.log1p(y_train) if cfg.log_target else y_train
    train_set = lgb.Dataset(X_train, label=target_train, categorical_feature=cat_idx)

    t0 = time.time()
    booster = lgb.train(cfg.params, train_set, num_boost_round=cfg.num_boost_round)
    duration = time.time() - t0

    raw_pred = booster.predict(X_test, num_iteration=booster.best_iteration)
    pred = np.clip(np.expm1(raw_pred) if cfg.log_target else raw_pred, 0, None)
    metrics = metric_block(y_test, pred)

    fi = pd.DataFrame({
        "feature": feat_cols,
        "gain": booster.feature_importance(importance_type="gain"),
        "split": booster.feature_importance(importance_type="split"),
    }).sort_values("gain", ascending=False)

    # ------- MLflow logging -------
    with mlflow.start_run(run_name=cfg.name) as run:
        mlflow.set_tag("description", cfg.description)
        mlflow.set_tag("feature_subset", cfg.feature_subset)
        mlflow.set_tag("log_target", str(cfg.log_target))
        mlflow.log_params({k: v for k, v in cfg.params.items() if k != "verbose"})
        mlflow.log_param("num_boost_round", cfg.num_boost_round)
        mlflow.log_param("n_features", len(feat_cols))
        mlflow.log_param("n_train_rows", int(len(train_df)))
        mlflow.log_param("n_test_rows", int(len(test_df)))
        mlflow.log_param("holdout_months", HOLDOUT_MONTHS)

        for k, v in metrics.items():
            mlflow.log_metric(k, v)
        mlflow.log_metric("training_seconds", duration)

        # Save artifacts.
        booster_path = os.path.join("/tmp", f"{cfg.name}.txt")
        booster.save_model(booster_path)
        mlflow.log_artifact(booster_path, artifact_path="model")

        fi_path = os.path.join("/tmp", f"{cfg.name}_feature_importance.csv")
        fi.to_csv(fi_path, index=False)
        mlflow.log_artifact(fi_path, artifact_path="feature_importance")

        run_id = run.info.run_id

    return {
        "name": cfg.name,
        "run_id": run_id,
        "metrics": metrics,
        "duration_s": duration,
        "n_features": len(feat_cols),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    os.makedirs(MLRUNS_DIR, exist_ok=True)
    mlflow.set_tracking_uri(f"file:{MLRUNS_DIR}")
    mlflow.set_experiment(EXPERIMENT)

    df = pd.read_parquet(FEATURE_PATH)
    print(f"loaded feature panel: {len(df):,} rows, {df.groupby(['region', 'icdid']).ngroups:,} series")

    summaries: list[dict] = []
    for cfg in EXPERIMENTS:
        print(f"\n=== Running {cfg.name} ===")
        print(f"    {cfg.description}")
        s = run_experiment(cfg, df)
        summaries.append(s)
        print(f"    MAE={s['metrics']['MAE']:.2f}  RMSE={s['metrics']['RMSE']:.2f}  "
              f"sMAPE={s['metrics']['sMAPE']:.1f}%  R2={s['metrics']['R2']:.3f}  "
              f"({s['duration_s']:.1f}s)")

    # Persist summary as ASCII-only CSV (Windows-console-safe).
    summary_path = os.path.join(ROOT, "ml", "models", "experiments_summary.csv")
    pd.DataFrame([
        {
            "experiment": s["name"],
            "MAE":   s["metrics"]["MAE"],
            "RMSE":  s["metrics"]["RMSE"],
            "MAPE":  s["metrics"]["MAPE"],
            "sMAPE": s["metrics"]["sMAPE"],
            "R2":    s["metrics"]["R2"],
            "training_seconds": s["duration_s"],
            "n_features": s["n_features"],
            "run_id": s["run_id"],
        } for s in summaries
    ]).to_csv(summary_path, index=False)

    # ASCII-only summary (no special characters that break Windows cp1251 stdout).
    print("\n\n" + "=" * 90)
    print(f"{'Experiment':<26}  {'MAE':>8}  {'RMSE':>10}  {'sMAPE':>8}  {'R2':>8}  {'time':>8}")
    print("-" * 90)
    for s in summaries:
        m = s["metrics"]
        print(f"{s['name']:<26}  {m['MAE']:>8.2f}  {m['RMSE']:>10.2f}  "
              f"{m['sMAPE']:>7.1f}%  {m['R2']:>8.4f}  {s['duration_s']:>7.1f}s")
    print("=" * 90)
    print(f"\nMLflow runs written to: {MLRUNS_DIR}")
    print(f"Summary CSV:            {summary_path}")
    print(f"Open the UI with:\n    mlflow ui --backend-store-uri file:{MLRUNS_DIR} --port 5000")


if __name__ == "__main__":
    main()
