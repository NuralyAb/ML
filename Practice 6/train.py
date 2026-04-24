import os
from pathlib import Path

import joblib
import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split


EXPERIMENT_NAME = "almaty_on_time_prediction"
REGISTERED_MODEL_NAME = "almaty_on_time_rf"
FEATURES = [
    "distance_km",
    "departure_hour",
    "day_of_week",
    "target_duration_min",
    "transport_type",
    "is_peak_hour",
]
TARGET = "on_time"


def is_peak_hour(hour: int) -> int:
    return int((8 <= hour <= 10) or (17 <= hour <= 20))


def sample_speed_kmh(hour: int, transport_type: int) -> float:
    if transport_type == 2:  # walk
        return np.random.uniform(4, 6)
    if transport_type == 3:  # bike / scooter - bypasses traffic
        return np.random.uniform(14, 18)

    peak = is_peak_hour(hour)
    if peak:
        if transport_type == 1:  # bus with dedicated lane
            return np.random.uniform(16, 22)
        return np.random.uniform(10, 15)  # car

    if 0 <= hour <= 6 or 22 <= hour <= 23:
        return np.random.uniform(40, 50)

    return np.random.uniform(25, 30)


def generate_dataset(rows: int = 1000, random_state: int = 42) -> pd.DataFrame:
    np.random.seed(random_state)

    distance_km = np.random.uniform(1, 25, size=rows)
    departure_hour = np.random.randint(0, 24, size=rows)
    day_of_week = np.random.randint(0, 7, size=rows)
    target_duration_min = np.random.randint(10, 91, size=rows)
    transport_type = np.random.randint(0, 4, size=rows)

    speeds = np.array(
        [sample_speed_kmh(h, t) for h, t in zip(departure_hour, transport_type)]
    )
    predicted_minutes = (distance_km / speeds) * 60
    on_time = (predicted_minutes <= target_duration_min).astype(int)

    return pd.DataFrame(
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


def load_feedback(feedback_path: str = "feedback.csv") -> pd.DataFrame:
    path = Path(feedback_path)
    if not path.exists():
        return pd.DataFrame(columns=FEATURES + [TARGET])
    df = pd.read_csv(path)
    keep = [c for c in FEATURES + [TARGET] if c in df.columns]
    return df[keep].dropna()


def train_and_save_model(
    model_path: str = "model.joblib",
    feedback_path: str = "feedback.csv",
    run_tag: str = "base",
) -> dict:
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "file:./mlruns")
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(EXPERIMENT_NAME)

    params = {
        "n_estimators": 250,
        "max_depth": None,
        "random_state": 42,
        "dataset_rows": 1000,
    }

    synthetic = generate_dataset(
        rows=params["dataset_rows"], random_state=params["random_state"]
    )
    feedback = load_feedback(feedback_path)
    if len(feedback):
        synthetic["source"] = "synthetic"
        feedback = feedback.copy()
        feedback["source"] = "feedback"
        data = pd.concat([synthetic, feedback], ignore_index=True)
    else:
        data = synthetic
        data["source"] = "synthetic"

    X_train, X_test, y_train, y_test = train_test_split(
        data[FEATURES],
        data[TARGET],
        test_size=0.2,
        random_state=params["random_state"],
        stratify=data[TARGET] if data[TARGET].nunique() > 1 else None,
    )

    with mlflow.start_run() as run:
        mlflow.log_params(params)
        mlflow.log_param("feedback_rows", int(len(feedback)))
        mlflow.log_param("total_rows", int(len(data)))
        mlflow.set_tags(
            {
                "task": "binary_classification",
                "domain": "transport_eta",
                "city": "Almaty",
                "run_tag": run_tag,
            }
        )

        model = RandomForestClassifier(
            n_estimators=params["n_estimators"],
            max_depth=params["max_depth"],
            random_state=params["random_state"],
        )
        model.fit(X_train, y_train)

        y_pred = model.predict(X_test)
        metrics = {
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "f1": float(f1_score(y_test, y_pred)),
            "precision": float(precision_score(y_test, y_pred)),
            "recall": float(recall_score(y_test, y_pred)),
        }
        mlflow.log_metrics(metrics)

        joblib.dump(model, model_path)
        mlflow.log_artifact(model_path, artifact_path="model_joblib")

        try:
            mlflow.sklearn.log_model(
                sk_model=model,
                artifact_path="model",
                registered_model_name=REGISTERED_MODEL_NAME,
                input_example=X_train.head(2),
            )
        except Exception as exc:
            print(f"[warn] Model Registry step skipped: {exc}")
            mlflow.sklearn.log_model(sk_model=model, artifact_path="model")

        print(f"Model saved to {model_path}")
        print(f"MLflow run_id: {run.info.run_id}")
        print(f"Feedback rows used: {len(feedback)}")
        print(f"Metrics: {metrics}")

        return {
            "run_id": run.info.run_id,
            "metrics": metrics,
            "feedback_rows": int(len(feedback)),
            "total_rows": int(len(data)),
        }


if __name__ == "__main__":
    train_and_save_model(run_tag="cli")
