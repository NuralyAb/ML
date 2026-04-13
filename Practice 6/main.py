from functools import lru_cache

import joblib
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field


app = FastAPI(title="Almaty On-Time Prediction API")


def is_peak_hour(hour: int) -> int:
    return int((8 <= hour <= 10) or (17 <= hour <= 20))


@lru_cache(maxsize=1)
def get_model():
    return joblib.load("model.joblib")


class PredictionRequest(BaseModel):
    distance_km: float = Field(..., ge=1, le=25)
    departure_hour: int = Field(..., ge=0, le=23)
    day_of_week: int = Field(..., ge=0, le=6)
    target_duration_min: int = Field(..., ge=10, le=90)
    transport_type: str = Field(..., pattern="^(car|bus)$")


@app.get("/")
def root():
    return {"message": "ML API is running"}


@app.post("/predict")
def predict(payload: PredictionRequest):
    transport_encoded = 1 if payload.transport_type == "bus" else 0
    features = pd.DataFrame(
        [
            {
                "distance_km": payload.distance_km,
                "departure_hour": payload.departure_hour,
                "day_of_week": payload.day_of_week,
                "target_duration_min": payload.target_duration_min,
                "transport_type": transport_encoded,
                "is_peak_hour": is_peak_hour(payload.departure_hour),
            }
        ]
    )

    model = get_model()
    prediction = int(model.predict(features)[0])
    return {"on_time": bool(prediction), "on_time_label": prediction}
