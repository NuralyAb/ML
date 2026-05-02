# Practice 7 — Batch Prediction Pipeline

Reads input rows from a SQLite database, runs a trained Random Forest model,
and writes predictions back to the database on a 5‑minute schedule.

## Database (SQLite)

`pipeline.db` with two tables:

- `input_data(id, distance_km, departure_hour, day_of_week, target_duration_min,
  transport_type, is_peak_hour, peak_motor, peak_bus, is_summer, is_winter)`
- `predictions(id, input_id, prediction, prediction_timestamp)`

Seeded from `../Practice 6/synthetic_dataset.csv`.

## Files

- `config.py` — paths, feature list, schedule interval
- `db_init.py` — creates schema and seeds `input_data`
- `train.py` — trains the RF model and saves `model.joblib`
- `batch_predict.py` — selects rows from `input_data` that have no row in
  `predictions`, runs the model, inserts into `predictions`
- `scheduler.py` — runs `batch_predict.run_batch()` every 5 minutes using
  the `schedule` library

## Run

```bash
pip install -r requirements.txt
python db_init.py     # create DB and seed input_data
python train.py       # produce model.joblib
python scheduler.py   # run batch every 5 minutes
```

To run a single batch without the scheduler:

```bash
python batch_predict.py
```

## Inspect results

```bash
sqlite3 pipeline.db "SELECT COUNT(*) FROM predictions;"
sqlite3 pipeline.db "SELECT * FROM predictions ORDER BY id DESC LIMIT 5;"
```

## Cron alternative (Linux/macOS)

```
*/5 * * * * cd /path/to/Practice\ 7 && /usr/bin/python3 batch_predict.py >> batch.log 2>&1
```

## Windows Task Scheduler alternative

```
schtasks /Create /SC MINUTE /MO 5 /TN "ML_Batch_Predict" ^
  /TR "python C:\Users\user\Desktop\ML dist\Practice 7\batch_predict.py"
```
