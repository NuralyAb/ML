import csv
from datetime import datetime, timedelta
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from threading import Lock

import httpx
import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import train as train_mod


app = FastAPI(title="Almaty On-Time Prediction API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent
FRONTEND_DIR = BASE_DIR / "frontend"
MODEL_PATH = BASE_DIR / "model.joblib"
FEEDBACK_PATH = BASE_DIR / "feedback.csv"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"

TRANSPORT_CODES = {"car": 0, "bus": 1, "walk": 2, "bike": 3}
TRANSPORT_PATTERN = "^(car|bus|walk|bike)$"

FEEDBACK_COLUMNS = [
    "timestamp",
    "distance_km",
    "departure_hour",
    "day_of_week",
    "target_duration_min",
    "transport_type",
    "is_peak_hour",
    "predicted_on_time",
    "on_time",
]

_model_cache = {"model": None}
_model_lock = Lock()


def is_peak_hour(hour: int) -> int:
    return int((8 <= hour <= 10) or (17 <= hour <= 20))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    lat1r, lat2r = radians(lat1), radians(lat2)
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(lat1r) * cos(lat2r) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


def manhattan_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    ns_leg = haversine_km(lat1, lon1, lat2, lon1)
    ew_leg = haversine_km(lat2, lon1, lat2, lon2)
    return ns_leg + ew_leg


def get_model():
    if _model_cache["model"] is None:
        with _model_lock:
            if _model_cache["model"] is None:
                _model_cache["model"] = joblib.load(MODEL_PATH)
    return _model_cache["model"]


def reload_model():
    with _model_lock:
        _model_cache["model"] = joblib.load(MODEL_PATH)


def build_features(
    distance_km: float,
    hour: int,
    day_of_week: int,
    target_duration_min: int,
    transport_encoded: int,
) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "distance_km": distance_km,
                "departure_hour": hour,
                "day_of_week": day_of_week,
                "target_duration_min": target_duration_min,
                "transport_type": transport_encoded,
                "is_peak_hour": is_peak_hour(hour),
            }
        ]
    )


class DistanceRequest(BaseModel):
    from_lat: float = Field(..., ge=-90, le=90)
    from_lon: float = Field(..., ge=-180, le=180)
    to_lat: float = Field(..., ge=-90, le=90)
    to_lon: float = Field(..., ge=-180, le=180)


class DistanceResponse(BaseModel):
    distance_km: float
    source: str
    geometry: list[list[float]] | None = None


class PredictionRequest(BaseModel):
    distance_km: float = Field(..., ge=1, le=25)
    departure_datetime: str = Field(..., description="ISO 8601 local datetime")
    target_duration_min: int = Field(..., ge=10, le=90)
    transport_type: str = Field(..., pattern=TRANSPORT_PATTERN)


class FeedbackRequest(BaseModel):
    distance_km: float = Field(..., ge=1, le=25)
    departure_datetime: str
    target_duration_min: int = Field(..., ge=10, le=90)
    transport_type: str = Field(..., pattern=TRANSPORT_PATTERN)
    predicted_on_time: bool
    actual_on_time: bool


class LatestDepartureRequest(BaseModel):
    arrival_datetime: str = Field(..., description="ISO 8601 desired arrival time")
    distance_km: float = Field(..., ge=1, le=25)
    transport_type: str = Field(..., pattern=TRANSPORT_PATTERN)
    threshold: float = Field(0.9, ge=0.5, le=0.99)


@app.get("/")
def root():
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"message": "ML API is running"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/distance", response_model=DistanceResponse)
async def distance(req: DistanceRequest):
    url = OSRM_URL.format(
        lon1=req.from_lon, lat1=req.from_lat, lon2=req.to_lon, lat2=req.to_lat
    )
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                url, params={"overview": "full", "geometries": "geojson"}
            )
            resp.raise_for_status()
            data = resp.json()
            route = data["routes"][0]
            meters = route["distance"]
            coords_lonlat = route["geometry"]["coordinates"]
            latlng = [[lat, lon] for lon, lat in coords_lonlat]
            return DistanceResponse(
                distance_km=round(meters / 1000, 2),
                source="osrm",
                geometry=latlng,
            )
    except Exception:
        km = manhattan_km(req.from_lat, req.from_lon, req.to_lat, req.to_lon)
        return DistanceResponse(distance_km=round(km, 2), source="manhattan")


@app.post("/predict")
def predict(payload: PredictionRequest):
    try:
        dt = datetime.fromisoformat(payload.departure_datetime)
    except ValueError:
        raise HTTPException(status_code=422, detail="departure_datetime must be ISO 8601")

    hour = dt.hour
    day_of_week = dt.weekday()
    transport_encoded = TRANSPORT_CODES[payload.transport_type]
    features = build_features(
        payload.distance_km, hour, day_of_week, payload.target_duration_min, transport_encoded
    )

    model = get_model()
    proba = None
    if hasattr(model, "predict_proba"):
        proba = float(model.predict_proba(features)[0][1])
    prediction = int(model.predict(features)[0])
    return {
        "on_time": bool(prediction),
        "on_time_label": prediction,
        "probability_on_time": proba,
        "derived": {
            "departure_hour": hour,
            "day_of_week": day_of_week,
            "is_peak_hour": is_peak_hour(hour),
        },
    }


@app.post("/latest-departure")
def latest_departure(req: LatestDepartureRequest):
    try:
        arrival = datetime.fromisoformat(req.arrival_datetime)
    except ValueError:
        raise HTTPException(status_code=422, detail="arrival_datetime must be ISO 8601")

    transport_encoded = TRANSPORT_CODES[req.transport_type]
    model = get_model()
    if not hasattr(model, "predict_proba"):
        raise HTTPException(status_code=500, detail="Model has no predict_proba")

    candidates = []
    for buffer_min in range(10, 91, 5):
        departure = arrival - timedelta(minutes=buffer_min)
        hour = departure.hour
        dow = departure.weekday()
        features = build_features(
            req.distance_km, hour, dow, buffer_min, transport_encoded
        )
        proba = float(model.predict_proba(features)[0][1])
        candidates.append(
            {
                "departure": departure.isoformat(timespec="minutes"),
                "buffer_min": buffer_min,
                "p_on_time": round(proba, 3),
                "departure_hour": hour,
                "is_peak_hour": is_peak_hour(hour),
            }
        )

    feasible = [c for c in candidates if c["p_on_time"] >= req.threshold]
    if feasible:
        best = min(feasible, key=lambda c: c["buffer_min"])
        return {
            "feasible_at_threshold": True,
            "threshold": req.threshold,
            "recommended": best,
            "all_candidates": candidates,
        }

    fallback = max(candidates, key=lambda c: c["p_on_time"])
    return {
        "feasible_at_threshold": False,
        "threshold": req.threshold,
        "recommended": fallback,
        "note": "Threshold not reachable in 10-90 min window; returning best available.",
        "all_candidates": candidates,
    }


@app.post("/feedback")
def feedback(payload: FeedbackRequest):
    try:
        dt = datetime.fromisoformat(payload.departure_datetime)
    except ValueError:
        raise HTTPException(status_code=422, detail="departure_datetime must be ISO 8601")

    hour = dt.hour
    dow = dt.weekday()
    transport_encoded = TRANSPORT_CODES[payload.transport_type]

    row = {
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "distance_km": payload.distance_km,
        "departure_hour": hour,
        "day_of_week": dow,
        "target_duration_min": payload.target_duration_min,
        "transport_type": transport_encoded,
        "is_peak_hour": is_peak_hour(hour),
        "predicted_on_time": int(payload.predicted_on_time),
        "on_time": int(payload.actual_on_time),
    }

    file_exists = FEEDBACK_PATH.exists()
    with open(FEEDBACK_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FEEDBACK_COLUMNS)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)

    return {"saved": True, "total": feedback_count()}


@app.get("/feedback/stats")
def feedback_stats():
    if not FEEDBACK_PATH.exists():
        return {"total": 0, "agreement": None, "on_time_rate": None}
    df = pd.read_csv(FEEDBACK_PATH)
    total = int(len(df))
    if total == 0:
        return {"total": 0, "agreement": None, "on_time_rate": None}
    agreement = float((df["predicted_on_time"] == df["on_time"]).mean())
    on_time_rate = float(df["on_time"].mean())
    return {
        "total": total,
        "agreement": round(agreement, 3),
        "on_time_rate": round(on_time_rate, 3),
    }


@app.post("/retrain")
def retrain():
    info = train_mod.train_and_save_model(
        model_path=str(MODEL_PATH),
        feedback_path=str(FEEDBACK_PATH),
        run_tag="retrain_with_feedback",
    )
    reload_model()
    return {"reloaded": True, **info}


def feedback_count() -> int:
    if not FEEDBACK_PATH.exists():
        return 0
    with open(FEEDBACK_PATH, "r", encoding="utf-8") as f:
        return max(0, sum(1 for _ in f) - 1)


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
