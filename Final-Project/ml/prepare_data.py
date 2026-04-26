"""
ETL: read every regional xlsx file under datasets/, aggregate prescriptions to
the monthly panel (region, district, icd_code, year_month) and save a single
parquet file. Preview CSVs are skipped (duplicates of 2024Q3 xlsx).
"""
from __future__ import annotations
import os, re, sys, time, glob
from concurrent.futures import ProcessPoolExecutor, as_completed
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASETS_DIR = os.path.join(ROOT, "datasets")
OUT_DIR = os.path.join(ROOT, "ml", "data")
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PARQUET = os.path.join(OUT_DIR, "monthly_panel.parquet")

USECOLS = [
    "recipedate", "icdid", "nozology",
    "region_med_organ", "raion_med_organ",
    "recipepackqty", "polyclid",
]


def _norm_str(s: pd.Series) -> pd.Series:
    return s.astype("string").str.strip()


def _read_xlsx(path: str) -> pd.DataFrame:
    """Try the fast (and memory-friendly) calamine engine, fall back to openpyxl."""
    try:
        return pd.read_excel(path, usecols=lambda c: c in USECOLS, engine="calamine")
    except Exception:
        return pd.read_excel(path, usecols=lambda c: c in USECOLS, engine="openpyxl")


def aggregate_file(path: str) -> pd.DataFrame:
    """Read one xlsx and return a monthly aggregate dataframe."""
    df = _read_xlsx(path)
    if df.empty:
        return df
    df["recipedate"] = pd.to_datetime(df["recipedate"], errors="coerce")
    df = df.dropna(subset=["recipedate", "icdid", "region_med_organ"]).copy()
    df["year_month"] = df["recipedate"].dt.to_period("M").dt.to_timestamp()
    df["icdid"] = _norm_str(df["icdid"])
    df["nozology"] = _norm_str(df["nozology"]).fillna("Unknown")
    df["region"] = _norm_str(df["region_med_organ"])
    df["district"] = _norm_str(df["raion_med_organ"]).fillna("Unknown")
    df["recipepackqty"] = pd.to_numeric(df["recipepackqty"], errors="coerce").fillna(1)

    grp = (
        df.groupby(["region", "district", "icdid", "nozology", "year_month"], dropna=False)
          .agg(
              recipe_count=("icdid", "size"),
              total_packs=("recipepackqty", "sum"),
              n_clinics=("polyclid", "nunique"),
          )
          .reset_index()
    )
    return grp


def list_input_files() -> list[str]:
    paths = []
    for region_dir in sorted(os.listdir(DATASETS_DIR)):
        full = os.path.join(DATASETS_DIR, region_dir)
        if not os.path.isdir(full):
            continue
        for f in os.listdir(full):
            if f.endswith(".xlsx"):
                paths.append(os.path.join(full, f))
    return paths


def main():
    files = list_input_files()
    print(f"input files: {len(files)}", flush=True)

    # Conservative worker count — xlsx decompression is memory-hungry.
    workers = max(2, min(4, (os.cpu_count() or 4) - 2))
    print(f"workers: {workers}", flush=True)

    parts: list[pd.DataFrame] = []
    failed: list[str] = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(aggregate_file, p): p for p in files}
        for i, fut in enumerate(as_completed(futures), 1):
            p = futures[fut]
            try:
                part = fut.result()
                parts.append(part)
                print(f"[{i}/{len(files)}] {os.path.basename(p)} -> rows={len(part)}", flush=True)
            except Exception as e:
                failed.append(p)
                print(f"FAIL {os.path.basename(p)}: {e}", flush=True)

    # Retry failed files serially (low memory pressure).
    if failed:
        print(f"\nretrying {len(failed)} files serially...", flush=True)
        for p in failed:
            try:
                part = aggregate_file(p)
                parts.append(part)
                print(f"retry-OK {os.path.basename(p)} -> rows={len(part)}", flush=True)
            except Exception as e:
                print(f"retry-FAIL {os.path.basename(p)}: {e}", flush=True)

    panel = pd.concat(parts, ignore_index=True)
    # Final aggregate (since same (region,district,icd,month) may appear in
    # multiple quarter files only on edge days; sum to be safe).
    panel = (
        panel.groupby(["region", "district", "icdid", "nozology", "year_month"], as_index=False)
             .agg(recipe_count=("recipe_count", "sum"),
                  total_packs=("total_packs", "sum"),
                  n_clinics=("n_clinics", "max"))
    )
    panel = panel.sort_values(["region", "district", "icdid", "year_month"]).reset_index(drop=True)
    panel.to_parquet(OUT_PARQUET, index=False)
    dt = time.time() - t0
    print(f"\nETL done in {dt/60:.1f} min")
    print(f"panel rows: {len(panel):,}")
    print(f"unique series (region,district,icd): {panel.groupby(['region','district','icdid']).ngroups:,}")
    print(f"date range: {panel['year_month'].min()} -> {panel['year_month'].max()}")
    print(f"saved: {OUT_PARQUET}")


if __name__ == "__main__":
    main()
