import sqlite3
from datetime import datetime

import joblib
import pandas as pd

from config import BATCH_SIZE, DB_PATH, FEATURES, MODEL_PATH


SELECT_UNPREDICTED = f"""
SELECT i.id, {", ".join(f"i.{c}" for c in FEATURES)}
FROM input_data i
LEFT JOIN predictions p ON p.input_id = i.id
WHERE p.id IS NULL
ORDER BY i.id
LIMIT ?
"""


def run_batch() -> int:
    started = datetime.now().isoformat(timespec="seconds")
    print(f"[{started}] batch run started")

    model = joblib.load(MODEL_PATH)
    conn = sqlite3.connect(DB_PATH)
    try:
        df = pd.read_sql_query(SELECT_UNPREDICTED, conn, params=(BATCH_SIZE,))
        if df.empty:
            print("no new rows to predict")
            return 0

        preds = model.predict(df[FEATURES]).astype(int)
        rows = [(int(input_id), int(pred)) for input_id, pred in zip(df["id"], preds)]

        conn.executemany(
            "INSERT INTO predictions (input_id, prediction) VALUES (?, ?)",
            rows,
        )
        conn.commit()
        print(f"wrote {len(rows)} predictions")
        return len(rows)
    finally:
        conn.close()


if __name__ == "__main__":
    run_batch()
