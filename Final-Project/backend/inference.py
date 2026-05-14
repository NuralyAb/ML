"""
Forecast logic: load the LightGBM model + metadata, expose helpers used by the
FastAPI routes. Recursive multi-step forecasting — each predicted month is
appended to the history, then features for the next month are recomputed.
"""
from __future__ import annotations
import os, json
from typing import Iterable

import numpy as np
import pandas as pd
import lightgbm as lgb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "ml", "data")
MODEL_DIR = os.path.join(ROOT, "ml", "models")

MODEL_FILE = os.path.join(MODEL_DIR, "lgbm_recipe_forecast.txt")
META_FILE = os.path.join(MODEL_DIR, "metadata.json")
FEATURES_FILE = os.path.join(DATA_DIR, "feature_panel.parquet")
# Optional quantile boosters produced by ml/train_quantile.py. When present,
# /api/forecast returns an 80% prediction interval (P10..P90) alongside the
# point estimate. When absent, the API gracefully degrades to point-only.
Q10_FILE = os.path.join(MODEL_DIR, "lgbm_recipe_forecast_q10.txt")
Q90_FILE = os.path.join(MODEL_DIR, "lgbm_recipe_forecast_q90.txt")


class Forecaster:
    """Wraps a trained LightGBM booster with the feature/encoding pipeline."""

    def __init__(self):
        with open(META_FILE, "r", encoding="utf-8") as f:
            self.meta = json.load(f)
        self.booster = lgb.Booster(model_file=MODEL_FILE)
        self.features = self.meta["feature_columns"]
        self.num_cols = self.meta["numeric_columns"]
        self.cat_cols = self.meta["categorical_columns"]
        self.encoders = {
            col: {v: i for i, v in enumerate(self.meta["encoder_classes"][col])}
            for col in self.cat_cols
        }
        # Quantile boosters are optional — load only if both files are present
        # so the API surface stays uniform (either both bounds or neither).
        self.booster_q10: lgb.Booster | None = None
        self.booster_q90: lgb.Booster | None = None
        if os.path.exists(Q10_FILE) and os.path.exists(Q90_FILE):
            self.booster_q10 = lgb.Booster(model_file=Q10_FILE)
            self.booster_q90 = lgb.Booster(model_file=Q90_FILE)
        # Cached history at (region, icdid, year_month) for fast lookups.
        self._history = pd.read_parquet(FEATURES_FILE)
        self._history["year_month"] = pd.to_datetime(self._history["year_month"])
        self.last_month = self._history["year_month"].max()

    @property
    def has_quantiles(self) -> bool:
        return self.booster_q10 is not None and self.booster_q90 is not None

    # --- public helpers -------------------------------------------------

    def history_for(self, region: str, icdid: str) -> pd.DataFrame:
        h = self._history[(self._history["region"] == region) &
                          (self._history["icdid"] == icdid)].copy()
        return h.sort_values("year_month").reset_index(drop=True)

    def forecast(self, region: str, icdid: str, horizon: int = 3) -> pd.DataFrame:
        """Return a dataframe with a `horizon`-step ahead forecast.

        Uses recursive prediction: the predicted value for month t+1 is
        appended to the history, then features for t+2 are derived from
        that augmented series, etc.
        """
        h = self.history_for(region, icdid)
        if h.empty:
            raise ValueError(f"no history for region={region!r} icd={icdid!r}")

        history_series = h[["year_month", "recipe_count"]].copy()
        nozology = h["nozology"].dropna().iloc[-1] if h["nozology"].dropna().size else ""
        n_clinics = float(h["n_clinics"].iloc[-1] or 0)
        n_districts = float(h["n_districts"].iloc[-1] or 0)
        region_total_lag1 = float(h["region_total_lag1"].iloc[-1] or 0)
        icd_chapter = str(icdid)[0].upper() if icdid else "?"

        out_rows = []
        last_month = history_series["year_month"].iloc[-1]
        values = list(history_series["recipe_count"].astype(float).values)

        for step in range(1, horizon + 1):
            target_month = last_month + pd.DateOffset(months=step)

            def lag(k):
                if k <= len(values):
                    return values[-k]
                return np.nan

            roll_mean = lambda w: float(np.mean(values[-w:])) if len(values) else 0.0
            roll_std = lambda w: float(np.std(values[-w:], ddof=1)) if len(values) >= 2 else 0.0
            expanding_mean = float(np.mean(values)) if values else 0.0

            row = {
                "lag_1": lag(1), "lag_2": lag(2), "lag_3": lag(3),
                "lag_6": lag(6), "lag_12": lag(12),
                "roll_mean_3": roll_mean(3),
                "roll_mean_6": roll_mean(6),
                "roll_mean_12": roll_mean(12),
                "roll_std_3": roll_std(3),
                "roll_std_6": roll_std(6),
                "roll_std_12": roll_std(12),
                "expanding_mean": expanding_mean,
                "region_total_lag1": region_total_lag1,
                "month": target_month.month,
                "quarter": (target_month.month - 1) // 3 + 1,
                "month_idx": (target_month.year - 2018) * 12 + target_month.month - 1,
                "month_sin": np.sin(2 * np.pi * target_month.month / 12),
                "month_cos": np.cos(2 * np.pi * target_month.month / 12),
                "n_clinics": n_clinics,
                "n_districts": n_districts,
                "region_enc": self._enc("region", region),
                "icdid_enc": self._enc("icdid", icdid),
                "icd_chapter_enc": self._enc("icd_chapter", icd_chapter),
            }
            X = pd.DataFrame([row])[self.features]
            yhat_log = float(self.booster.predict(X)[0])
            yhat = max(0.0, float(np.expm1(yhat_log)))
            row_out = {
                "year_month": target_month.strftime("%Y-%m-%d"),
                "predicted": round(yhat, 2),
                "nozology": nozology,
            }
            if self.has_quantiles:
                lo_log = float(self.booster_q10.predict(X)[0])
                hi_log = float(self.booster_q90.predict(X)[0])
                lo = max(0.0, float(np.expm1(lo_log)))
                hi = max(0.0, float(np.expm1(hi_log)))
                # Quantile bounds may cross when the boosters disagree on
                # very sparse series — clamp so lower <= point <= upper.
                lo = min(lo, yhat)
                hi = max(hi, yhat)
                row_out["lower"] = round(lo, 2)
                row_out["upper"] = round(hi, 2)
            out_rows.append(row_out)
            # Recursion uses the *point* prediction so future features aren't
            # biased toward an optimistic or pessimistic envelope.
            values.append(yhat)

        return pd.DataFrame(out_rows)

    def explain(self, region: str, icdid: str) -> dict:
        """SHAP-style explanation of the **1-step-ahead** prediction.

        LightGBM has native TreeSHAP via ``predict(pred_contrib=True)`` which
        returns one extra column (the bias) plus one contribution column per
        feature, all in log-space (the model was trained on log1p(y)).

        We return:
          * base_value, predicted_value (both in raw recipe-count units)
          * a list of contributions, sorted by absolute impact, with
            feature names, the feature value used by the model, and the
            log-space contribution. Categorical encodings are decoded back to
            human-readable region / icd / chapter strings.
        """
        h = self.history_for(region, icdid)
        if h.empty:
            raise ValueError(f"no history for region={region!r} icd={icdid!r}")

        # --- Build the t+1 feature row exactly the way forecast() does ---
        last_month = h["year_month"].iloc[-1]
        target_month = last_month + pd.DateOffset(months=1)
        values = list(h["recipe_count"].astype(float).values)
        nozology = h["nozology"].dropna().iloc[-1] if h["nozology"].dropna().size else ""
        n_clinics = float(h["n_clinics"].iloc[-1] or 0)
        n_districts = float(h["n_districts"].iloc[-1] or 0)
        region_total_lag1 = float(h["region_total_lag1"].iloc[-1] or 0)
        icd_chapter = str(icdid)[0].upper() if icdid else "?"

        def lag(k):
            return values[-k] if k <= len(values) else np.nan

        roll_mean = lambda w: float(np.mean(values[-w:])) if len(values) else 0.0
        roll_std = lambda w: float(np.std(values[-w:], ddof=1)) if len(values) >= 2 else 0.0
        expanding_mean = float(np.mean(values)) if values else 0.0

        row = {
            "lag_1": lag(1), "lag_2": lag(2), "lag_3": lag(3),
            "lag_6": lag(6), "lag_12": lag(12),
            "roll_mean_3": roll_mean(3),
            "roll_mean_6": roll_mean(6),
            "roll_mean_12": roll_mean(12),
            "roll_std_3": roll_std(3),
            "roll_std_6": roll_std(6),
            "roll_std_12": roll_std(12),
            "expanding_mean": expanding_mean,
            "region_total_lag1": region_total_lag1,
            "month": target_month.month,
            "quarter": (target_month.month - 1) // 3 + 1,
            "month_idx": (target_month.year - 2018) * 12 + target_month.month - 1,
            "month_sin": np.sin(2 * np.pi * target_month.month / 12),
            "month_cos": np.cos(2 * np.pi * target_month.month / 12),
            "n_clinics": n_clinics,
            "n_districts": n_districts,
            "region_enc": self._enc("region", region),
            "icdid_enc": self._enc("icdid", icdid),
            "icd_chapter_enc": self._enc("icd_chapter", icd_chapter),
        }
        X = pd.DataFrame([row])[self.features]

        # TreeSHAP: last column is the base value; the rest are per-feature.
        contrib = self.booster.predict(X, pred_contrib=True)[0]
        base_value_log = float(contrib[-1])
        feature_contribs_log = contrib[:-1]
        pred_log = float(base_value_log + feature_contribs_log.sum())
        pred = max(0.0, float(np.expm1(pred_log)))
        base_value = max(0.0, float(np.expm1(base_value_log)))

        # Decode categorical *_enc back to the human-readable label so the
        # explanation table is readable by a non-engineer.
        def display_value(feature_name: str, value):
            for cat in self.cat_cols:
                if feature_name == cat + "_enc":
                    classes = self.meta["encoder_classes"][cat]
                    idx = int(value)
                    return classes[idx] if 0 <= idx < len(classes) else str(value)
            return value

        contributions = []
        for fname, contrib_val in zip(self.features, feature_contribs_log):
            v = row[fname]
            disp = display_value(fname, v)
            contributions.append({
                "feature": fname,
                "value": float(v) if isinstance(v, (int, float, np.floating, np.integer)) else str(v),
                "display_value": str(disp) if not isinstance(disp, (int, float)) else round(float(disp), 2),
                "contribution_log": float(contrib_val),
            })
        contributions.sort(key=lambda c: abs(c["contribution_log"]), reverse=True)

        return {
            "region": region,
            "icd": icdid,
            "nozology": nozology,
            "target_month": target_month.strftime("%Y-%m-%d"),
            "base_value": round(base_value, 2),
            "base_value_log": round(base_value_log, 4),
            "predicted": round(pred, 2),
            "predicted_log": round(pred_log, 4),
            "contributions": contributions,
        }

    # --- internals ------------------------------------------------------

    def _enc(self, col: str, val: str) -> int:
        m = self.encoders[col]
        if val in m:
            return m[val]
        return m.get("?", 0)


_INSTANCE: Forecaster | None = None


def get_forecaster() -> Forecaster:
    global _INSTANCE
    if _INSTANCE is None:
        _INSTANCE = Forecaster()
    return _INSTANCE


def reset_forecaster() -> None:
    """Drop the cached Forecaster so the next ``get_forecaster()`` re-reads
    ``feature_panel.parquet`` and the booster files from disk. Called after
    ``/api/ingest`` so any retrained model on the host is picked up without
    a backend restart."""
    global _INSTANCE
    _INSTANCE = None
