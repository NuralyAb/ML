import sqlite3

import pandas as pd

from config import DATASET_PATH, DB_PATH, FEATURES


SCHEMA = """
CREATE TABLE IF NOT EXISTS input_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distance_km REAL NOT NULL,
    departure_hour INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    target_duration_min INTEGER NOT NULL,
    transport_type INTEGER NOT NULL,
    is_peak_hour INTEGER NOT NULL,
    peak_motor INTEGER NOT NULL,
    peak_bus INTEGER NOT NULL,
    is_summer INTEGER NOT NULL,
    is_winter INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_id INTEGER NOT NULL,
    prediction INTEGER NOT NULL,
    prediction_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (input_id) REFERENCES input_data(id)
);

CREATE INDEX IF NOT EXISTS idx_predictions_input_id ON predictions(input_id);
"""


def init_db(seed: bool = True) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        conn.commit()

        if seed:
            existing = conn.execute("SELECT COUNT(*) FROM input_data").fetchone()[0]
            if existing == 0:
                df = pd.read_csv(DATASET_PATH)[FEATURES]
                df.to_sql("input_data", conn, if_exists="append", index=False)
                print(f"Seeded input_data with {len(df)} rows from {DATASET_PATH.name}")
            else:
                print(f"input_data already has {existing} rows; skipping seed")
        print(f"Database ready at {DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
