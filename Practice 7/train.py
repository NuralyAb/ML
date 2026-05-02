import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split

from config import DATASET_PATH, FEATURES, MODEL_PATH, TARGET


def train() -> None:
    df = pd.read_csv(DATASET_PATH)

    X_train, X_test, y_train, y_test = train_test_split(
        df[FEATURES],
        df[TARGET],
        test_size=0.2,
        random_state=42,
        stratify=df[TARGET],
    )

    model = RandomForestClassifier(n_estimators=200, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    print(f"accuracy: {accuracy_score(y_test, y_pred):.4f}")
    print(f"f1:       {f1_score(y_test, y_pred):.4f}")

    joblib.dump(model, MODEL_PATH)
    print(f"Model saved to {MODEL_PATH}")


if __name__ == "__main__":
    train()
