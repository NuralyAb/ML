"""
Audit module: detect prescription anomalies on the supervised hold-out.

Why this exists
---------------
The project's problem statement (§1 of REPORT.md / REPORT_EN.md) lists three
business tasks: procurement, workforce allocation, and **audit of clinics —
detection of anomalous growth / drops in prescription issuance**. The
production LightGBM forecaster addresses the first two; this script closes
the third.

How it works
------------
We treat the LightGBM forecast on the *hold-out* months as an expectation
under the historical regime. A row whose actual diverges sharply from that
expectation is anomalous, regardless of whether the underlying cause is a
registry outage, an epidemic spike, or a fraudulent over-issuance pattern —
the audit team triages the cause later. We deliberately do not collapse the
score to a single direction: positive z-score = real demand exceeded model
("surge"); negative = real demand fell well below model ("drop").

Scoring
-------
1. Residual on the log-scale so long-tailed counts don't dominate:
       r = log1p(actual) - log1p(predicted)
2. Robust scale = median absolute deviation of ``r`` over the whole holdout
   panel. This is unit-free and resistant to a handful of extreme outliers.
3. ``z = r / (1.4826 * MAD)``  (1.4826 makes MAD a consistent estimator of σ
   for a normal distribution.)
4. Severity tiers:
       |z| >= 3.0   -> critical
       2.0..3.0     -> warning
       1.5..2.0     -> notice
       otherwise    -> normal (excluded from the saved artefact)

Output
------
``ml/data/anomalies.parquet`` with one row per flagged (region, icdid,
year_month) tuple, sorted by ``|z|`` descending. The dashboard consumes
this file via the FastAPI endpoints ``/api/anomalies`` and
``/api/anomaly-heatmap``.

Run from the project root:

    python ml/detect_anomalies.py
"""
from __future__ import annotations
import os, json
from typing import Tuple

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
MODELS = os.path.join(ROOT, "ml", "models")

EVAL_PATH = os.path.join(MODELS, "eval_predictions.parquet")
OUT_PATH = os.path.join(DATA, "anomalies.parquet")
META_OUT_PATH = os.path.join(MODELS, "anomalies_meta.json")

# Severity buckets in standard deviations of the panel residual distribution.
TIERS: list[Tuple[float, float, str]] = [
    (3.0, np.inf, "critical"),
    (2.0, 3.0, "warning"),
    (1.5, 2.0, "notice"),
]
MIN_Z_KEEP = 1.5         # rows with |z| below this are not saved


def icd_chapter(code: str) -> str:
    return code[0].upper() if isinstance(code, str) and code else "?"


def severity_for(absz: float) -> str:
    for lo, hi, name in TIERS:
        if lo <= absz < hi:
            return name
    return "normal"


def main() -> None:
    if not os.path.exists(EVAL_PATH):
        raise SystemExit(
            f"{EVAL_PATH} not found. Run ml/train.py to produce eval_predictions.parquet."
        )

    df = pd.read_parquet(EVAL_PATH)
    print(f"loaded eval rows: {len(df):,}")

    # Required columns: region, icdid, nozology, year_month, actual, predicted.
    for c in ("region", "icdid", "year_month", "actual", "predicted"):
        if c not in df.columns:
            raise SystemExit(f"eval_predictions.parquet is missing required column: {c}")

    df = df.copy()
    df["year_month"] = pd.to_datetime(df["year_month"])
    df["icd_chapter"] = df["icdid"].astype(str).map(icd_chapter)

    # Log-residual: handles long-tailed count distribution and zeros gracefully.
    actual_log = np.log1p(df["actual"].astype(float))
    pred_log = np.log1p(df["predicted"].astype(float))
    df["residual_log"] = actual_log - pred_log

    # MAD-based robust z-score over the full holdout panel.
    median_r = float(df["residual_log"].median())
    mad = float((df["residual_log"] - median_r).abs().median())
    sigma_hat = 1.4826 * mad if mad > 0 else float(df["residual_log"].std(ddof=0)) or 1.0
    df["z_score"] = (df["residual_log"] - median_r) / sigma_hat
    df["abs_z"] = df["z_score"].abs()
    df["direction"] = np.where(df["z_score"] >= 0, "surge", "drop")
    df["severity"] = df["abs_z"].map(severity_for)

    panel_n = len(df)
    flagged = df[df["abs_z"] >= MIN_Z_KEEP].copy()
    flagged = flagged.sort_values("abs_z", ascending=False).reset_index(drop=True)
    flagged["year_month"] = flagged["year_month"].dt.strftime("%Y-%m-%d")
    flagged["actual"] = flagged["actual"].astype(float).round(2)
    flagged["predicted"] = flagged["predicted"].astype(float).round(2)
    flagged["residual"] = (flagged["actual"] - flagged["predicted"]).round(2)
    flagged["residual_log"] = flagged["residual_log"].round(4)
    flagged["z_score"] = flagged["z_score"].round(3)
    flagged["abs_z"] = flagged["abs_z"].round(3)

    keep_cols = [
        "region", "icdid", "nozology", "icd_chapter", "year_month",
        "actual", "predicted", "residual", "residual_log",
        "z_score", "abs_z", "direction", "severity",
    ]
    flagged = flagged[[c for c in keep_cols if c in flagged.columns]]
    flagged.to_parquet(OUT_PATH, index=False)

    tier_counts = flagged.groupby("severity").size().to_dict()
    dir_counts = flagged.groupby("direction").size().to_dict()

    meta = {
        "n_panel_rows": int(panel_n),
        "n_flagged": int(len(flagged)),
        "share_flagged": float(len(flagged) / panel_n) if panel_n else 0.0,
        "median_residual_log": median_r,
        "mad_residual_log": mad,
        "sigma_hat_residual_log": sigma_hat,
        "tiers": {k: int(v) for k, v in tier_counts.items()},
        "directions": {k: int(v) for k, v in dir_counts.items()},
        "computed_at": pd.Timestamp.now(tz="UTC").isoformat(),
    }
    with open(META_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\nholdout rows scored: {panel_n:,}")
    print(f"flagged (|z| >= {MIN_Z_KEEP}): {len(flagged):,} ({len(flagged)/panel_n:.2%})")
    print(f"by severity: {tier_counts}")
    print(f"by direction: {dir_counts}")
    print(f"\nsaved anomalies:   {OUT_PATH}")
    print(f"saved meta:        {META_OUT_PATH}")


if __name__ == "__main__":
    main()
