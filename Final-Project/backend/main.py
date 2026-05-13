"""
FastAPI entry point. Endpoints power the Next.js dashboard:

  GET /api/health
  GET /api/regions                              -> list of regions
  GET /api/icd?region=&q=&limit=                -> top ICD codes (optionally filtered)
  GET /api/districts?region=                    -> districts in a region
  GET /api/historical?region=&icd=              -> monthly time series for one (region, icd)
  GET /api/region-summary?icd=                  -> per-region totals (latest 12 months)
  GET /api/heatmap?metric=&period=              -> heatmap matrix region × icd_chapter
  GET /api/top-diseases?region=&period=         -> ranked ICD codes
  POST /api/forecast {region, icd, horizon}     -> recursive multi-step forecast (+ P10/P90 band)
  GET /api/model-metrics                        -> training metadata + holdout metrics
  GET /api/eval-sample?n=                       -> sample of holdout actual vs predicted
  GET /api/global-stats                         -> high-level dataset stats
  GET /api/anomalies                            -> ranked (region, icd, month) outliers on holdout
  GET /api/anomaly-heatmap                      -> max |z| per (region, icd-chapter) cell
  POST /api/ingest  (multipart file)            -> append fresh xlsx/parquet into monthly_panel
"""
from __future__ import annotations
import io, os, json, time, threading
from datetime import datetime
from typing import Optional

import duckdb
import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from inference import get_forecaster, reset_forecaster
from report import build_forecast_rows, llm_executive_summary, render_docx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "ml", "data")
MODEL_DIR = os.path.join(ROOT, "ml", "models")
PANEL = os.path.join(DATA_DIR, "monthly_panel.parquet")
META = os.path.join(MODEL_DIR, "metadata.json")
EVAL = os.path.join(MODEL_DIR, "eval_predictions.parquet")
SERIES_META = os.path.join(DATA_DIR, "series_meta.parquet")
ANOMALIES_FILE = os.path.join(DATA_DIR, "anomalies.parquet")
ANOMALIES_META = os.path.join(MODEL_DIR, "anomalies_meta.json")

app = FastAPI(title="Kazakhstan Prescription Forecasting API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# A single DuckDB connection isn't thread-safe; FastAPI handlers run in a
# worker threadpool, so each query goes through a fresh cursor under a lock.
_con = duckdb.connect()
_con.execute(f"CREATE OR REPLACE VIEW panel AS SELECT * FROM '{PANEL.replace(chr(92), '/')}'")
if os.path.exists(SERIES_META):
    _con.execute(f"CREATE OR REPLACE VIEW series_meta AS SELECT * FROM '{SERIES_META.replace(chr(92), '/')}'")
_db_lock = threading.Lock()


def query(sql: str, params: list | None = None):
    """Run an SQL query through a fresh cursor under a lock."""
    with _db_lock:
        cur = _con.cursor()
        if params:
            cur.execute(sql, params)
        else:
            cur.execute(sql)
        return cur.fetchall()


@app.get("/api/health")
def health():
    return {"status": "ok", "now": datetime.utcnow().isoformat()}


@app.get("/api/regions")
def regions():
    rows = query(
        "SELECT region, SUM(recipe_count) AS total, COUNT(DISTINCT icdid) AS n_icd, "
        "COUNT(DISTINCT district) AS n_districts FROM panel GROUP BY region ORDER BY total DESC"
    )
    return [
        {"region": r[0], "total_recipes": int(r[1]), "n_icd": int(r[2]), "n_districts": int(r[3])}
        for r in rows
    ]


@app.get("/api/icd")
def icd_codes(region: Optional[str] = None, q: Optional[str] = None, limit: int = 50):
    where = ["1=1"]
    params: list = []
    if region:
        where.append("region = ?")
        params.append(region)
    if q:
        where.append("(icdid ILIKE ? OR nozology ILIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    sql = f"""
        SELECT icdid, ANY_VALUE(nozology) AS nozology,
               SUM(recipe_count)::BIGINT AS total
        FROM panel
        WHERE {' AND '.join(where)}
        GROUP BY icdid
        ORDER BY total DESC
        LIMIT {int(limit)}
    """
    rows = query(sql, params)
    return [{"icdid": r[0], "nozology": r[1], "total": int(r[2])} for r in rows]


@app.get("/api/districts")
def districts(region: str):
    rows = query(
        "SELECT district, SUM(recipe_count) AS total FROM panel WHERE region = ? "
        "GROUP BY district ORDER BY total DESC",
        [region],
    )
    return [{"district": r[0], "total": int(r[1])} for r in rows]


@app.get("/api/historical")
def historical(region: str, icd: str):
    rows = query(
        "SELECT year_month, SUM(recipe_count) AS recipes, SUM(total_packs) AS packs "
        "FROM panel WHERE region = ? AND icdid = ? GROUP BY year_month ORDER BY year_month",
        [region, icd],
    )
    if not rows:
        raise HTTPException(404, "no data for this region/icd")
    series = [
        {"month": r[0].strftime("%Y-%m-%d"), "recipes": int(r[1]), "packs": int(r[2])}
        for r in rows
    ]
    nz = query(
        "SELECT ANY_VALUE(nozology) FROM panel WHERE region = ? AND icdid = ?",
        [region, icd],
    )
    return {
        "region": region,
        "icd": icd,
        "nozology": nz[0][0] if nz and nz[0] else "",
        "series": series,
    }


def _date_filter(start: Optional[str], end: Optional[str], months: Optional[int]):
    """Build a WHERE clause + params for `year_month` based on start/end (YYYY-MM-DD)
    or, if both are absent, fall back to "last `months` months relative to MAX".
    """
    if start or end:
        clauses = []
        params: list = []
        if start:
            clauses.append("year_month >= ?")
            params.append(start)
        if end:
            clauses.append("year_month <= ?")
            params.append(end)
        return " AND ".join(clauses), params, ""
    m = int(months or 12)
    cte = "WITH last_m AS (SELECT MAX(year_month) AS mx FROM panel) "
    where = f"year_month >= mx - INTERVAL '{m} months'"
    return where, [], cte


# 8 June 2022 — the day Abay, Zhetysu and Ulytau were established by
# presidential decree (Kazakhstan territorial reform).
REFORM_DATE = "2022-06-08"

# Pre-2022 administrative regions: Abay was carved out of East Kazakhstan,
# Zhetysu out of Almaty Region, Ulytau out of Karaganda. In our source
# data MoH already pre-attributed Abay's records to a separate region
# from day one, but the boundaries the public knew before June 2022 had
# Abay merged into East Kazakhstan. Zhetysu and Ulytau records were
# never split out at the source, so they sit inside Almaty / Karaganda
# either way — the only meaningful "merge" for the OLD view is Abay.
OLD_REGION_MERGES = {
    "Область Абай": "Восточно-Казахстанская область",
}


def _region_expr(view: str) -> str:
    """SQL expression that produces the effective region name for a given view.

    view = "new" — return `region` unchanged.
    view = "old" — collapse 2022-reform children back into their parents.
    """
    if view != "old":
        return "region"
    cases = []
    for child, parent in OLD_REGION_MERGES.items():
        cases.append(f"WHEN region = '{child}' THEN '{parent}'")
    return "CASE " + " ".join(cases) + " ELSE region END"


def _resolve_view(view: Optional[str], start: Optional[str], end: Optional[str], months: Optional[int]) -> str:
    """Decide the effective view ("old" | "new").

    Explicit ?view=old|new wins. If view=auto (or unset) we look at the end of
    the period: a period entirely before 2022-06-08 → "old", everything else
    → "new".
    """
    if view in ("old", "new"):
        return view
    end_str = end
    if not end_str and not start:
        # Fallback to "last N months". Since "last" rolls relative to MAX
        # year_month — which is in 2025 for our data — the period is always
        # recent, so "new" is the right default.
        return "new"
    end_str = end_str or "9999-12-31"
    return "old" if end_str < REFORM_DATE else "new"


@app.get("/api/data-range")
def data_range():
    """Min/max month available in the panel — used by the UI date selector."""
    rows = query("SELECT MIN(year_month), MAX(year_month) FROM panel")
    if not rows or rows[0][0] is None:
        raise HTTPException(503, "no data")
    mn, mx = rows[0]
    return {
        "min": mn.strftime("%Y-%m-%d"),
        "max": mx.strftime("%Y-%m-%d"),
    }


@app.get("/api/region-summary")
def region_summary(
    icd: Optional[str] = None,
    chapter: Optional[str] = None,
    months: int = 12,
    start: Optional[str] = None,
    end: Optional[str] = None,
    view: Optional[str] = None,
):
    where, params, cte = _date_filter(start, end, months)
    effective_view = _resolve_view(view, start, end, months)
    region_expr = _region_expr(effective_view)
    extras = []
    if icd:
        extras.append("icdid = ?"); params.append(icd)
    if chapter:
        extras.append("substr(icdid,1,1) = ?"); params.append(chapter)
    extra_str = (" AND " + " AND ".join(extras)) if extras else ""
    if not (start or end):
        sql = (
            f"{cte}SELECT {region_expr} AS region, SUM(recipe_count) AS total "
            f"FROM panel, last_m WHERE {where}{extra_str} "
            f"GROUP BY {region_expr} ORDER BY total DESC"
        )
    else:
        sql = (
            f"SELECT {region_expr} AS region, SUM(recipe_count) AS total "
            f"FROM panel WHERE {where}{extra_str} "
            f"GROUP BY {region_expr} ORDER BY total DESC"
        )
    rows = query(sql, params)
    return [{"region": r[0], "total": int(r[1])} for r in rows]


@app.get("/api/district-summary")
def district_summary(
    region: Optional[str] = None,
    icd: Optional[str] = None,
    chapter: Optional[str] = None,
    months: int = 12,
    start: Optional[str] = None,
    end: Optional[str] = None,
    view: Optional[str] = None,
):
    """Per-district totals filterable by region / icd / icd-chapter / period."""
    where, params, cte = _date_filter(start, end, months)
    effective_view = _resolve_view(view, start, end, months)
    region_expr = _region_expr(effective_view)
    extras = []
    if region:
        # In OLD view the caller may pass the parent name (e.g. ВКО); we filter
        # on the *effective* (mapped) region so the child rows are included.
        extras.append(f"{region_expr} = ?"); params.append(region)
    if icd:
        extras.append("icdid = ?"); params.append(icd)
    if chapter:
        extras.append("substr(icdid,1,1) = ?"); params.append(chapter)
    extra_str = (" AND " + " AND ".join(extras)) if extras else ""
    if not (start or end):
        sql = (
            f"{cte}SELECT {region_expr} AS region, district, SUM(recipe_count) AS total "
            f"FROM panel, last_m WHERE {where}{extra_str} "
            f"GROUP BY {region_expr}, district ORDER BY total DESC"
        )
    else:
        sql = (
            f"SELECT {region_expr} AS region, district, SUM(recipe_count) AS total "
            f"FROM panel WHERE {where}{extra_str} "
            f"GROUP BY {region_expr}, district ORDER BY total DESC"
        )
    rows = query(sql, params)
    return [{"region": r[0], "district": r[1], "total": int(r[2])} for r in rows]


@app.get("/api/heatmap")
def heatmap(
    metric: str = "recipes",
    months: int = 24,
    start: Optional[str] = None,
    end: Optional[str] = None,
    view: Optional[str] = None,
):
    where, params, cte = _date_filter(start, end, months)
    effective_view = _resolve_view(view, start, end, months)
    region_expr = _region_expr(effective_view)
    if not (start or end):
        sql = (
            f"{cte}SELECT {region_expr} AS region, substr(icdid,1,1) AS chapter, "
            f"SUM(recipe_count) AS total FROM panel, last_m WHERE {where} "
            f"GROUP BY {region_expr}, chapter ORDER BY {region_expr}, chapter"
        )
    else:
        sql = (
            f"SELECT {region_expr} AS region, substr(icdid,1,1) AS chapter, "
            f"SUM(recipe_count) AS total FROM panel WHERE {where} "
            f"GROUP BY {region_expr}, chapter ORDER BY {region_expr}, chapter"
        )
    rows = query(sql, params)
    return [{"region": r[0], "chapter": r[1], "value": int(r[2])} for r in rows]


@app.get("/api/top-diseases")
def top_diseases(
    region: Optional[str] = None,
    months: int = 12,
    limit: int = 15,
    start: Optional[str] = None,
    end: Optional[str] = None,
):
    where, params, cte = _date_filter(start, end, months)
    if region:
        where += " AND region = ?"
        params.append(region)
    if not (start or end):
        sql = (
            f"{cte}SELECT icdid, ANY_VALUE(nozology) AS nozology, SUM(recipe_count) AS total "
            f"FROM panel, last_m WHERE {where} GROUP BY icdid ORDER BY total DESC LIMIT {int(limit)}"
        )
    else:
        sql = (
            f"SELECT icdid, ANY_VALUE(nozology) AS nozology, SUM(recipe_count) AS total "
            f"FROM panel WHERE {where} GROUP BY icdid ORDER BY total DESC LIMIT {int(limit)}"
        )
    rows = query(sql, params)
    return [{"icdid": r[0], "nozology": r[1], "total": int(r[2])} for r in rows]


@app.get("/api/timeseries-overview")
def timeseries_overview(region: Optional[str] = None):
    where = "WHERE region = ?" if region else ""
    params: list = [region] if region else []
    rows = query(
        f"SELECT year_month, SUM(recipe_count) AS total FROM panel {where} "
        f"GROUP BY year_month ORDER BY year_month",
        params,
    )
    return [{"month": r[0].strftime("%Y-%m-%d"), "total": int(r[1])} for r in rows]


class ForecastRequest(BaseModel):
    region: str = Field(..., description="Region name (e.g. 'Атырауская область')")
    icd: str = Field(..., description="ICD-10 code (e.g. 'I20.8')")
    horizon: int = Field(3, ge=1, le=12, description="months ahead, 1..12")


@app.post("/api/forecast")
def forecast(req: ForecastRequest):
    fc = get_forecaster()
    try:
        history = fc.history_for(req.region, req.icd)
    except Exception as e:
        raise HTTPException(404, str(e))
    if history.empty:
        raise HTTPException(404, "no history for the requested series")

    pred_df = fc.forecast(req.region, req.icd, req.horizon)
    history_out = (
        history[["year_month", "recipe_count"]]
        .assign(year_month=lambda d: d["year_month"].dt.strftime("%Y-%m-%d"))
        .rename(columns={"recipe_count": "actual"})
        .to_dict(orient="records")
    )
    return {
        "region": req.region,
        "icd": req.icd,
        "nozology": pred_df["nozology"].iloc[0] if not pred_df.empty else "",
        "horizon": req.horizon,
        "history": history_out,
        "forecast": pred_df.drop(columns=["nozology"]).to_dict(orient="records"),
        # True iff quantile boosters are loaded — UI can render the fan band.
        "has_quantiles": fc.has_quantiles,
    }


@app.get("/api/model-metrics")
def model_metrics():
    if not os.path.exists(META):
        raise HTTPException(503, "model not trained yet")
    with open(META, "r", encoding="utf-8") as f:
        meta = json.load(f)
    # Slim payload — drop the giant feature_importance for the default response.
    payload = {k: v for k, v in meta.items() if k not in ("feature_importance", "encoder_classes")}
    payload["top_features"] = meta.get("feature_importance", [])[:15]
    return payload


@app.get("/api/eval-sample")
def eval_sample(n: int = 200, region: Optional[str] = None):
    if not os.path.exists(EVAL):
        return []
    df = pd.read_parquet(EVAL)
    if region:
        df = df[df["region"] == region]
    df = df.sample(min(n, len(df)), random_state=0).copy()
    df["year_month"] = pd.to_datetime(df["year_month"]).dt.strftime("%Y-%m-%d")
    return df.to_dict(orient="records")


@app.get("/api/anomalies")
def anomalies(
    limit: int = 50,
    min_z: float = 1.5,
    region: Optional[str] = None,
    direction: Optional[str] = None,
    severity: Optional[str] = None,
):
    """Top-N anomalies from the holdout audit (see ml/detect_anomalies.py).

    Filters are AND-combined. ``direction`` is one of ``surge`` / ``drop``
    (positive vs negative residual). ``severity`` is ``critical`` /
    ``warning`` / ``notice``.
    """
    if not os.path.exists(ANOMALIES_FILE):
        return {"meta": {"available": False}, "rows": []}
    df = pd.read_parquet(ANOMALIES_FILE)
    if region:
        df = df[df["region"] == region]
    if direction:
        df = df[df["direction"] == direction]
    if severity:
        df = df[df["severity"] == severity]
    df = df[df["abs_z"] >= float(min_z)]
    df = df.sort_values("abs_z", ascending=False).head(int(limit)).copy()
    meta = {"available": True}
    if os.path.exists(ANOMALIES_META):
        with open(ANOMALIES_META, "r", encoding="utf-8") as f:
            meta.update(json.load(f))
    return {"meta": meta, "rows": df.to_dict(orient="records")}


@app.get("/api/anomaly-heatmap")
def anomaly_heatmap():
    """Aggregate audit signal across (region, icd_chapter) cells: returns the
    maximum |z| per cell so the dashboard can colour the grid by the most
    severe anomaly observed in each combination.
    """
    if not os.path.exists(ANOMALIES_FILE):
        return []
    df = pd.read_parquet(ANOMALIES_FILE)
    if df.empty:
        return []
    grid = (
        df.groupby(["region", "icd_chapter"], as_index=False)
          .agg(
              max_abs_z=("abs_z", "max"),
              n=("abs_z", "size"),
              n_surge=("direction", lambda s: int((s == "surge").sum())),
              n_drop=("direction", lambda s: int((s == "drop").sum())),
          )
          .sort_values("max_abs_z", ascending=False)
    )
    return grid.to_dict(orient="records")


# ---------------------------------------------------------------------------
# Data ingestion (UI upload → append to monthly_panel)
# ---------------------------------------------------------------------------

# Cap upload size to keep the request synchronous and bound memory use.
INGEST_MAX_BYTES = 100 * 1024 * 1024              # 100 MB
INGEST_REQUIRED_COLS = {"region", "icdid", "year_month", "recipe_count"}
INGEST_RAW_COLS = {
    "recipedate", "icdid", "nozology",
    "region_med_organ", "raion_med_organ",
    "recipepackqty", "polyclid",
}


def _aggregate_raw(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate a raw prescription dataframe to monthly_panel schema.

    Mirrors ml/prepare_data.py::aggregate_file so a single uploaded xlsx is
    processed identically to the bulk ETL. Kept inline so backend/ stays
    self-contained (the ml/ scripts are not in the backend image).
    """
    df = df.copy()
    df["recipedate"] = pd.to_datetime(df["recipedate"], errors="coerce")
    df = df.dropna(subset=["recipedate", "icdid", "region_med_organ"])
    df["year_month"] = df["recipedate"].dt.to_period("M").dt.to_timestamp()
    df["icdid"] = df["icdid"].astype("string").str.strip()
    df["nozology"] = df.get("nozology", pd.Series(dtype="string")).astype("string").str.strip().fillna("Unknown")
    df["region"] = df["region_med_organ"].astype("string").str.strip()
    df["district"] = df.get("raion_med_organ", pd.Series(dtype="string")).astype("string").str.strip().fillna("Unknown")
    df["recipepackqty"] = pd.to_numeric(df.get("recipepackqty"), errors="coerce").fillna(1)
    if "polyclid" not in df.columns:
        df["polyclid"] = 0
    return (
        df.groupby(["region", "district", "icdid", "nozology", "year_month"], dropna=False)
          .agg(
              recipe_count=("icdid", "size"),
              total_packs=("recipepackqty", "sum"),
              n_clinics=("polyclid", "nunique"),
          )
          .reset_index()
    )


def _refresh_duckdb_panel():
    """Re-register the parquet view so subsequent SELECTs see the new file."""
    with _db_lock:
        _con.execute(f"CREATE OR REPLACE VIEW panel AS SELECT * FROM '{PANEL.replace(chr(92), '/')}'")
        if os.path.exists(SERIES_META):
            _con.execute(f"CREATE OR REPLACE VIEW series_meta AS SELECT * FROM '{SERIES_META.replace(chr(92), '/')}'")


@app.post("/api/ingest")
async def ingest(file: UploadFile = File(...)):
    """Append a fresh xlsx or parquet snapshot to the monthly panel.

    Accepts:
      * raw quarterly xlsx with the source registry schema
        (columns: ``recipedate, icdid, nozology, region_med_organ,
        raion_med_organ, recipepackqty, polyclid``) — aggregated inline
        with the same logic as ``ml/prepare_data.py``.
      * pre-aggregated parquet with the monthly_panel schema
        (``region, district, icdid, nozology, year_month, recipe_count,
        total_packs, n_clinics``).

    Dedupes by ``(region, district, icdid, year_month)``, summing counts
    so that an overlapping upload doesn't double-count. Returns a JSON
    summary of the operation.

    Note: ``feature_panel.parquet``, the LightGBM booster, and the
    anomaly artefact are **not** rebuilt here — those are offline jobs
    triggered via ``ml/build_features.py`` + ``ml/train.py`` +
    ``ml/detect_anomalies.py``. The dashboard's KPI / map / heatmap /
    top-diseases panels (which read ``monthly_panel`` directly) update
    immediately; the forecast / anomaly panels stay on the cached
    training snapshot until a retraining run.
    """
    if not os.path.exists(PANEL):
        raise HTTPException(503, "monthly_panel.parquet not found on server")

    filename = (file.filename or "upload").lower()
    body = await file.read()
    if len(body) > INGEST_MAX_BYTES:
        raise HTTPException(413, f"file too large ({len(body)/1e6:.1f} MB, limit {INGEST_MAX_BYTES/1e6:.0f} MB)")
    if len(body) == 0:
        raise HTTPException(400, "empty upload")

    t0 = time.time()
    # ---- 1. Parse upload into the monthly_panel schema ----
    try:
        if filename.endswith(".parquet"):
            uploaded = pd.read_parquet(io.BytesIO(body))
            missing = INGEST_REQUIRED_COLS.difference(uploaded.columns)
            if missing:
                raise HTTPException(400, f"parquet missing required columns: {sorted(missing)}")
            uploaded["year_month"] = pd.to_datetime(uploaded["year_month"], errors="coerce")
            uploaded = uploaded.dropna(subset=["year_month", "icdid", "region"]).copy()
            for col, default in (("district", "Unknown"), ("nozology", "Unknown"),
                                 ("total_packs", uploaded.get("recipe_count")),
                                 ("n_clinics", 0)):
                if col not in uploaded.columns:
                    uploaded[col] = default
            uploaded = uploaded[["region", "district", "icdid", "nozology", "year_month",
                                 "recipe_count", "total_packs", "n_clinics"]]
            source_kind = "parquet"
        elif filename.endswith(".xlsx") or filename.endswith(".xls"):
            try:
                raw = pd.read_excel(io.BytesIO(body),
                                    usecols=lambda c: c in INGEST_RAW_COLS,
                                    engine="calamine")
            except Exception:
                raw = pd.read_excel(io.BytesIO(body),
                                    usecols=lambda c: c in INGEST_RAW_COLS,
                                    engine="openpyxl")
            missing = {"recipedate", "icdid", "region_med_organ"}.difference(raw.columns)
            if missing:
                raise HTTPException(400, f"xlsx missing required columns: {sorted(missing)}")
            uploaded = _aggregate_raw(raw)
            source_kind = "xlsx"
        else:
            raise HTTPException(415, f"unsupported file type: {filename!r}; accept .xlsx / .parquet")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"failed to parse {source_kind if 'source_kind' in locals() else 'file'}: {e}")

    if uploaded.empty:
        raise HTTPException(400, "upload produced 0 valid rows after cleaning")

    # ---- 2. Merge with the existing panel ----
    existing = pd.read_parquet(PANEL)
    rows_before = int(len(existing))
    last_before = pd.to_datetime(existing["year_month"]).max()
    uploaded["year_month"] = pd.to_datetime(uploaded["year_month"])

    combined = pd.concat([existing, uploaded], ignore_index=True)
    merged = (
        combined.groupby(["region", "district", "icdid", "nozology", "year_month"], as_index=False)
                .agg(recipe_count=("recipe_count", "sum"),
                     total_packs=("total_packs", "sum"),
                     n_clinics=("n_clinics", "max"))
                .sort_values(["region", "district", "icdid", "year_month"])
                .reset_index(drop=True)
    )
    rows_after = int(len(merged))
    rows_added = rows_after - rows_before
    last_after = merged["year_month"].max()
    regions_in_upload = sorted(uploaded["region"].dropna().unique().tolist())

    # ---- 3. Atomic write + view refresh ----
    tmp = PANEL + ".tmp"
    merged.to_parquet(tmp, index=False)
    os.replace(tmp, PANEL)
    _refresh_duckdb_panel()
    # The Forecaster also caches feature_panel.parquet in memory and would
    # miss the new rows; reset so the next /api/forecast call re-loads.
    try:
        reset_forecaster()
    except Exception:
        pass

    return {
        "ok": True,
        "source_kind": source_kind,
        "filename": file.filename,
        "size_bytes": len(body),
        "rows_in_upload": int(len(uploaded)),
        "rows_before": rows_before,
        "rows_added": rows_added,
        "rows_after": rows_after,
        "last_month_before": last_before.strftime("%Y-%m-%d") if pd.notna(last_before) else None,
        "last_month_after": last_after.strftime("%Y-%m-%d") if pd.notna(last_after) else None,
        "regions_in_upload": regions_in_upload,
        "processing_seconds": round(time.time() - t0, 2),
        "note": (
            "monthly_panel updated; KPI/map/heatmap/top-diseases reflect new "
            "data immediately. Forecast and anomaly artefacts stay on the "
            "cached training snapshot until ml/build_features.py + ml/train.py "
            "+ ml/detect_anomalies.py are rerun."
        ),
    }


@app.get("/api/global-stats")
def global_stats():
    rows = query(
        "SELECT COUNT(*) AS rows, SUM(recipe_count) AS total_recipes, "
        "COUNT(DISTINCT region) AS regions, COUNT(DISTINCT district) AS districts, "
        "COUNT(DISTINCT icdid) AS icd_codes, MIN(year_month) AS start, MAX(year_month) AS end "
        "FROM panel"
    )
    if not rows:
        raise HTTPException(503, "panel is empty")
    row = rows[0]
    return {
        "panel_rows": int(row[0]),
        "total_recipes": int(row[1] or 0),
        "regions": int(row[2]),
        "districts": int(row[3]),
        "icd_codes": int(row[4]),
        "period_start": row[5].strftime("%Y-%m-%d") if row[5] else None,
        "period_end": row[6].strftime("%Y-%m-%d") if row[6] else None,
    }


_RU2LAT = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh","з":"z","и":"i",
    "й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t",
    "у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y",
    "ь":"","э":"e","ю":"yu","я":"ya",
}


def _translit(s: str) -> str:
    return "".join(_RU2LAT.get(c, c) if c.isalpha() and ord(c) > 127 else c for c in s.lower())


def _rfc5987(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe="")


def _build_filename(region: Optional[str]) -> tuple[str, str]:
    today = datetime.utcnow().strftime("%Y%m%d")
    if not region:
        full = f"med_forecast_KZ_{today}.docx"
        return full, full
    slug = _translit(region).replace(" область", "").replace("область ", "")
    slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in slug).strip("_")
    ascii_fname = f"med_forecast_KZ_{slug}_{today}.docx"
    full_fname = f"Прогноз_{region}_{today}.docx"
    return ascii_fname, full_fname


@app.get("/api/report")
def report(
    region: Optional[str] = None,
    horizon: int = 6,
    top_n: int = 10,
):
    """Generate a Russian-language ministry report (.docx) with ML forecasts
    and an LLM-generated executive summary."""
    if horizon < 1 or horizon > 12:
        raise HTTPException(400, "horizon must be in 1..12")
    if top_n < 1 or top_n > 30:
        raise HTTPException(400, "top_n must be in 1..30")

    panel_path = PANEL.replace(chr(92), "/")
    panel_df = pd.read_parquet(panel_path)
    forecaster = get_forecaster()

    rows = build_forecast_rows(panel_df, forecaster, region, horizon, top_n)
    summary = llm_executive_summary(rows, region, horizon)
    docx_bytes = render_docx(rows, summary, region, horizon, panel_df)

    fname_ascii, fname_full = _build_filename(region)
    # RFC 5987: ASCII filename for old clients + filename* with UTF-8 for modern ones.
    cd = (
        f'attachment; filename="{fname_ascii}"; '
        f"filename*=UTF-8''" + _rfc5987(fname_full)
    )
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": cd},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
