from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

DB_PATH = BASE_DIR / "pipeline.db"
MODEL_PATH = BASE_DIR / "model.joblib"
DATASET_PATH = BASE_DIR.parent / "Practice 6" / "synthetic_dataset.csv"

FEATURES = [
    "distance_km",
    "departure_hour",
    "day_of_week",
    "target_duration_min",
    "transport_type",
    "is_peak_hour",
    "peak_motor",
    "peak_bus",
    "is_summer",
    "is_winter",
]
TARGET = "on_time"

SCHEDULE_INTERVAL_MINUTES = 5
BATCH_SIZE = 200
