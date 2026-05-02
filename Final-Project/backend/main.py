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
  POST /api/forecast {region, icd, horizon}     -> recursive multi-step forecast
  GET /api/model-metrics                        -> training metadata + holdout metrics
  GET /api/eval-sample?n=                       -> sample of holdout actual vs predicted
  GET /api/global-stats                         -> high-level dataset stats
"""
from __future__ import annotations
import os, json, threading
from datetime import datetime
from typing import Optional

import duckdb
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from inference import get_forecaster
from report import build_forecast_rows, llm_executive_summary, render_docx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "ml", "data")
MODEL_DIR = os.path.join(ROOT, "ml", "models")
PANEL = os.path.join(DATA_DIR, "monthly_panel.parquet")
META = os.path.join(MODEL_DIR, "metadata.json")
EVAL = os.path.join(MODEL_DIR, "eval_predictions.parquet")
SERIES_META = os.path.join(DATA_DIR, "series_meta.parquet")

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
):
    where, params, cte = _date_filter(start, end, months)
    extras = []
    if icd:
        extras.append("icdid = ?"); params.append(icd)
    if chapter:
        extras.append("substr(icdid,1,1) = ?"); params.append(chapter)
    extra_str = (" AND " + " AND ".join(extras)) if extras else ""
    if not (start or end):
        sql = f"{cte}SELECT region, SUM(recipe_count) AS total FROM panel, last_m WHERE {where}{extra_str} GROUP BY region ORDER BY total DESC"
    else:
        sql = f"SELECT region, SUM(recipe_count) AS total FROM panel WHERE {where}{extra_str} GROUP BY region ORDER BY total DESC"
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
):
    """Per-district totals filterable by region / icd / icd-chapter / period."""
    where, params, cte = _date_filter(start, end, months)
    extras = []
    if region:
        extras.append("region = ?"); params.append(region)
    if icd:
        extras.append("icdid = ?"); params.append(icd)
    if chapter:
        extras.append("substr(icdid,1,1) = ?"); params.append(chapter)
    extra_str = (" AND " + " AND ".join(extras)) if extras else ""
    if not (start or end):
        sql = (
            f"{cte}SELECT region, district, SUM(recipe_count) AS total "
            f"FROM panel, last_m WHERE {where}{extra_str} "
            f"GROUP BY region, district ORDER BY total DESC"
        )
    else:
        sql = (
            f"SELECT region, district, SUM(recipe_count) AS total "
            f"FROM panel WHERE {where}{extra_str} "
            f"GROUP BY region, district ORDER BY total DESC"
        )
    rows = query(sql, params)
    return [{"region": r[0], "district": r[1], "total": int(r[2])} for r in rows]


@app.get("/api/heatmap")
def heatmap(
    metric: str = "recipes",
    months: int = 24,
    start: Optional[str] = None,
    end: Optional[str] = None,
):
    where, params, cte = _date_filter(start, end, months)
    if not (start or end):
        sql = (
            f"{cte}SELECT region, substr(icdid,1,1) AS chapter, SUM(recipe_count) AS total "
            f"FROM panel, last_m WHERE {where} GROUP BY region, chapter ORDER BY region, chapter"
        )
    else:
        sql = (
            f"SELECT region, substr(icdid,1,1) AS chapter, SUM(recipe_count) AS total "
            f"FROM panel WHERE {where} GROUP BY region, chapter ORDER BY region, chapter"
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
