"""
Feature engineering on the monthly panel.

Strategy
--------
We forecast monthly prescription counts at the most informative grain that
still produces enough history per series. We aggregate at the
**(region, icd_code, month)** level for the model — district granularity is
preserved separately for the dashboard but is too sparse to forecast directly
(many district × icd combinations have <12 observations).

For each (region, icd) series we generate:
* lagged target (1, 2, 3, 6, 12 months)
* rolling mean / std over 3, 6, 12 months
* expanding mean
* calendar features (month, quarter, sin/cos of month, year, month_idx)
* relative share of icd inside region (rolling 12m)
* region-level totals (lagged)
* simple text-derived ICD chapter (first letter / first 3 chars)

Output:
    ml/data/feature_panel.parquet      - model-ready features
    ml/data/series_meta.parquet        - per-series statistics for the API
"""
from __future__ import annotations
import os, numpy as np, pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
PANEL = os.path.join(DATA, "monthly_panel.parquet")
OUT_FEATURES = os.path.join(DATA, "feature_panel.parquet")
OUT_META = os.path.join(DATA, "series_meta.parquet")
OUT_DISTRICT = os.path.join(DATA, "district_panel.parquet")


def icd_chapter(code: str) -> str:
    """Map an ICD-10 code to its broad chapter letter (A,B,C,...)."""
    if not isinstance(code, str) or len(code) == 0:
        return "?"
    return code[0].upper()


def main():
    panel = pd.read_parquet(PANEL)
    print(f"loaded panel rows={len(panel):,}")

    # Keep district-level slice for the dashboard (read-only, no FE).
    panel.to_parquet(OUT_DISTRICT, index=False)

    # Aggregate to region × icd × month for forecasting.
    region_panel = (
        panel.groupby(["region", "icdid", "year_month"], as_index=False)
             .agg(recipe_count=("recipe_count", "sum"),
                  total_packs=("total_packs", "sum"),
                  n_clinics=("n_clinics", "sum"),
                  n_districts=("district", "nunique") if "district" in panel.columns else ("region", "size"))
    )
    # nozology -> most frequent name per icd code (for nicer labels)
    nz_map = (
        panel.groupby("icdid")["nozology"].agg(lambda s: s.mode().iloc[0] if len(s.mode()) else "")
        .to_dict()
    )
    region_panel["nozology"] = region_panel["icdid"].map(nz_map)

    # Build complete monthly grid per (region, icd) so missing months become 0.
    grid_parts = []
    for (region, icd), g in region_panel.groupby(["region", "icdid"]):
        full_idx = pd.date_range(g["year_month"].min(), g["year_month"].max(), freq="MS")
        sub = (
            g.set_index("year_month").reindex(full_idx)
             .rename_axis("year_month").reset_index()
        )
        sub["region"] = region
        sub["icdid"] = icd
        sub["nozology"] = sub["nozology"].ffill().bfill()
        for col in ("recipe_count", "total_packs", "n_clinics", "n_districts"):
            if col in sub.columns:
                sub[col] = sub[col].fillna(0)
        grid_parts.append(sub)
    df = pd.concat(grid_parts, ignore_index=True)
    df = df.sort_values(["region", "icdid", "year_month"]).reset_index(drop=True)

    # Drop very short series — need at least 13 months for lag-12 + 1 train.
    keep = df.groupby(["region", "icdid"])["recipe_count"].transform("count") >= 18
    df = df[keep].reset_index(drop=True)

    # Lags & rolling features. We compute on the per-group shifted series.
    g = df.groupby(["region", "icdid"], group_keys=False, sort=False)
    for lag in (1, 2, 3, 6, 12):
        df[f"lag_{lag}"] = g["recipe_count"].shift(lag)
    shifted = g["recipe_count"].shift(1)
    df["_shifted"] = shifted
    g2 = df.groupby(["region", "icdid"], group_keys=False, sort=False)["_shifted"]
    for w in (3, 6, 12):
        df[f"roll_mean_{w}"] = g2.transform(lambda s, w=w: s.rolling(w, min_periods=1).mean())
        df[f"roll_std_{w}"]  = g2.transform(lambda s, w=w: s.rolling(w, min_periods=2).std())
    df["expanding_mean"] = g2.transform(lambda s: s.expanding().mean())
    df = df.drop(columns=["_shifted"])

    # Region-wide signal (total prescriptions in the region, lagged).
    region_totals = df.groupby(["region", "year_month"], as_index=False)["recipe_count"].sum().rename(columns={"recipe_count": "region_total"})
    region_totals["region_total_lag1"] = region_totals.groupby("region")["region_total"].shift(1)
    df = df.merge(region_totals[["region", "year_month", "region_total_lag1"]], on=["region", "year_month"], how="left")

    # Calendar features.
    ym = df["year_month"]
    df["month"] = ym.dt.month
    df["quarter"] = ym.dt.quarter
    df["year"] = ym.dt.year
    df["month_idx"] = (ym.dt.year - ym.dt.year.min()) * 12 + ym.dt.month - 1
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)

    # ICD chapter.
    df["icd_chapter"] = df["icdid"].astype(str).map(icd_chapter)

    # Series stats (for the API: surface popular series, baseline values).
    meta = (
        df.groupby(["region", "icdid", "nozology"], as_index=False)
          .agg(months=("recipe_count", "count"),
               total_recipes=("recipe_count", "sum"),
               mean_recipes=("recipe_count", "mean"),
               last_value=("recipe_count", "last"))
    )
    meta["icd_chapter"] = meta["icdid"].astype(str).map(icd_chapter)
    meta = meta.sort_values("total_recipes", ascending=False)
    meta.to_parquet(OUT_META, index=False)

    df.to_parquet(OUT_FEATURES, index=False)

    print(f"feature rows: {len(df):,}")
    print(f"series: {df.groupby(['region','icdid']).ngroups:,}")
    print(f"saved features: {OUT_FEATURES}")
    print(f"saved meta:     {OUT_META}")
    print(f"saved district: {OUT_DISTRICT}")


if __name__ == "__main__":
    main()
