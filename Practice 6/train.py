import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier


def is_peak_hour(hour: int) -> int:
    """Peak windows for Almaty traffic."""
    return int((8 <= hour <= 10) or (17 <= hour <= 20))


def sample_speed_kmh(hour: int, transport_type: int) -> float:
    """
    Sample realistic speed bands:
    - night: 40-50
    - midday: 25-30
    - peak: 10-15
    Exception: buses can use dedicated lanes and are faster in peak.
    """
    peak = is_peak_hour(hour)
    if peak:
        if transport_type == 1:  # bus
            return np.random.uniform(16, 22)
        return np.random.uniform(10, 15)

    if 0 <= hour <= 6 or 22 <= hour <= 23:
        return np.random.uniform(40, 50)

    return np.random.uniform(25, 30)


def generate_dataset(rows: int = 1000, random_state: int = 42) -> pd.DataFrame:
    np.random.seed(random_state)

    distance_km = np.random.uniform(1, 25, size=rows)
    departure_hour = np.random.randint(0, 24, size=rows)
    day_of_week = np.random.randint(0, 7, size=rows)
    target_duration_min = np.random.randint(10, 91, size=rows)
    transport_type = np.random.randint(0, 2, size=rows)  # 0 car, 1 bus

    speeds = np.array(
        [sample_speed_kmh(h, t) for h, t in zip(departure_hour, transport_type)]
    )
    predicted_minutes = (distance_km / speeds) * 60
    on_time = (predicted_minutes <= target_duration_min).astype(int)

    data = pd.DataFrame(
        {
            "distance_km": distance_km,
            "departure_hour": departure_hour,
            "day_of_week": day_of_week,
            "target_duration_min": target_duration_min,
            "transport_type": transport_type,
            "is_peak_hour": [is_peak_hour(h) for h in departure_hour],
            "on_time": on_time,
        }
    )
    return data


def train_and_save_model(model_path: str = "model.joblib") -> None:
    data = generate_dataset()
    features = [
        "distance_km",
        "departure_hour",
        "day_of_week",
        "target_duration_min",
        "transport_type",
        "is_peak_hour",
    ]
    target = "on_time"

    model = RandomForestClassifier(n_estimators=250, random_state=42)
    model.fit(data[features], data[target])
    joblib.dump(model, model_path)
    print(f"Model saved to {model_path}")


if __name__ == "__main__":
    train_and_save_model()
