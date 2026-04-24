# Almaty On-Time Prediction — SIS-3

Practice 6 reworked into a small end-to-end ML system for the question
**"Will a trip in Almaty arrive on time?"**

Stack:

- **Model:** `RandomForestClassifier` (scikit-learn), binary classification with `predict_proba`
- **API:** FastAPI
- **Container:** Docker
- **Frontend:** Leaflet + OpenStreetMap tiles, vanilla JS
- **Routing / distance:** OSRM public routing API (real driving route geometry), **Manhattan-distance** fallback on the sphere (north-south + east-west legs — close to real distances on Almaty's grid-like layout)
- **Experiment tracking / registry:** MLflow (experiments + Model Registry, auto-incrementing versions)
- **Feedback loop:** `feedback.csv` + on-demand retrain that merges feedback into the synthetic dataset and registers a new model version

## What's in SIS-3 (delta vs. the Practice 6 baseline)

1. **MLflow**
   - Experiment `almaty_on_time_prediction`
   - Params logged: `n_estimators`, `max_depth`, `random_state`, `dataset_rows`, `feedback_rows`, `total_rows`
   - Metrics: `accuracy`, `f1`, `precision`, `recall` (on an 80/20 split)
   - Artifacts: `model.joblib` + sklearn MLmodel flavor
   - Registered model `almaty_on_time_rf`, new version on every retrain
2. **Frontend with map**
   - Two-click pick: **A** (from) → **B** (to)
   - `POST /distance` auto-fills `distance_km`; route drawn as a polyline using the actual OSRM geometry, or as a dashed straight line if OSRM is unavailable and Manhattan is used
3. **Better time UX**
   - No raw `departure_hour` input; a single `datetime-local` picker
   - Server derives `hour`, `day_of_week`, `is_peak_hour` and returns them in `derived`
4. **Probabilistic output**
   - `POST /predict` returns `probability_on_time` in addition to the yes/no label
5. **Reverse mode — *When to leave?***
   - New endpoint `POST /latest-departure` — user enters the desired arrival time + confidence threshold; server sweeps buffers 10-90 min in 5-min steps and returns the latest departure time that still clears the threshold
6. **Feedback loop**
   - After a prediction the UI shows *"I arrived on time / I was late"* buttons
   - `POST /feedback` appends a labelled row to `feedback.csv`
   - `GET /feedback/stats` exposes `total / agreement / on_time_rate`
   - `POST /retrain` merges synthetic + feedback, logs a new MLflow run tagged `retrain_with_feedback`, registers a new model version, and hot-swaps the model in the live process
7. **Four transport classes** (instead of two)
   - `car` (0), `bus` (1), `walk` (2), `bike/scooter` (3)
   - Walking is 4-6 km/h regardless of hour; bike/scooter is 14-18 km/h and bypasses traffic, so it beats cars in peak hours

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Serves the frontend (`frontend/index.html`) |
| GET | `/health` | Liveness check |
| POST | `/distance` | `{from_lat, from_lon, to_lat, to_lon}` → `{distance_km, source, geometry}` |
| POST | `/predict` | Predict on-time for a given trip (returns label + probability) |
| POST | `/latest-departure` | Reverse search — find the latest departure meeting a confidence threshold |
| POST | `/feedback` | Append labelled feedback row to `feedback.csv` |
| GET | `/feedback/stats` | Aggregate feedback stats |
| POST | `/retrain` | Retrain on synthetic + feedback, register new MLflow version, hot-reload |
| GET | `/static/*` | Static frontend assets |

### `POST /predict`

```json
{
  "distance_km": 6.4,
  "departure_datetime": "2026-04-24T18:30",
  "target_duration_min": 25,
  "transport_type": "car"
}
```

Response:

```json
{
  "on_time": false,
  "on_time_label": 0,
  "probability_on_time": 0.38,
  "derived": { "departure_hour": 18, "day_of_week": 4, "is_peak_hour": 1 }
}
```

`transport_type` ∈ `{"car", "bus", "walk", "bike"}`.

### `POST /latest-departure`

```json
{
  "arrival_datetime": "2026-04-25T19:00",
  "distance_km": 8,
  "transport_type": "car",
  "threshold": 0.9
}
```

Response:

```json
{
  "feasible_at_threshold": true,
  "threshold": 0.9,
  "recommended": {
    "departure": "2026-04-25T18:05",
    "buffer_min": 55,
    "p_on_time": 0.908,
    "departure_hour": 18,
    "is_peak_hour": 1
  },
  "all_candidates": [ ... ]
}
```

If no buffer in 10-90 min reaches the threshold, `feasible_at_threshold` is `false` and `recommended` contains the best attempt.

### `POST /feedback`

```json
{
  "distance_km": 6.4,
  "departure_datetime": "2026-04-24T18:30",
  "target_duration_min": 25,
  "transport_type": "car",
  "predicted_on_time": false,
  "actual_on_time": false
}
```

Response: `{"saved": true, "total": N}`.

### `POST /retrain`

No body. Response includes the new MLflow `run_id`, `feedback_rows`, `total_rows`, and test metrics. The live FastAPI process reloads `model.joblib` after training.

## Model features

Internally the model always takes six features. The UI doesn't ask for all of them directly — several are derived server-side.

| Feature | Type | Source |
| --- | --- | --- |
| `distance_km` | float (1-25) | 2 clicks on the map → `/distance` |
| `departure_hour` | int (0-23) | derived on the server from `departure_datetime` |
| `day_of_week` | int (0=Mon … 6=Sun) | derived on the server from `departure_datetime` |
| `target_duration_min` | int (10-90) | slider (or the sweeping buffer in reverse mode) |
| `transport_type` | int (0 car / 1 bus / 2 walk / 3 bike) | radio |
| `is_peak_hour` | 0 / 1 | derived from `departure_hour` (08-10 or 17-20) |

## Dataset logic (`train.py`)

Synthetic data with hand-tuned speed bands per hour and transport type:

- Walk: 4-6 km/h (any hour)
- Bike / scooter: 14-18 km/h (any hour, bypasses traffic)
- Car peak hour: 10-15 km/h
- Bus peak hour (dedicated lane): 16-22 km/h
- Any vehicle at night (00-06, 22-23): 40-50 km/h
- Any vehicle daytime non-peak: 25-30 km/h

Label: `(distance_km / speed) * 60 <= target_duration_min` → `on_time = 1`.

On retrain, `feedback.csv` rows are concatenated with the freshly generated synthetic dataset before fitting.

## Project structure

```
Practice 6/
  main.py            FastAPI app (all endpoints + static frontend serving)
  train.py           Data gen + training + MLflow logging + registry + retrain hook
  model.joblib       Current model artifact (hot-reloaded on /retrain)
  feedback.csv       (generated) feedback-loop dataset
  requirements.txt
  Dockerfile
  .dockerignore
  README.md
  frontend/
    index.html
    styles.css
    app.js
  mlruns/            (generated) local MLflow tracking + registry store
```

## Run locally

```bash
python -m pip install -r requirements.txt
python train.py                 # trains + logs to MLflow, creates model.joblib
uvicorn main:app --reload
# open http://127.0.0.1:8000/
```

MLflow UI (in a separate terminal):

```bash
mlflow ui
# http://127.0.0.1:5000
```

You should see the `almaty_on_time_prediction` experiment with runs and the `almaty_on_time_rf` registered model with one or more versions.

To point at a remote tracking server:

```bash
# PowerShell
$env:MLFLOW_TRACKING_URI="http://<host>:5000"
python train.py
```

## Run in Docker

```bash
docker build -t ml-fastapi-docker .
docker run -p 8000:8000 ml-fastapi-docker
```

To persist MLflow runs and feedback between container runs:

```bash
docker run -p 8000:8000 \
  -v $PWD/mlruns:/app/mlruns \
  -v $PWD/feedback.csv:/app/feedback.csv \
  ml-fastapi-docker
```

## Notes and caveats

- OSRM public demo is rate-limited and best-effort. For production, host your own OSRM / OpenRouteService instance.
- The model was trained on synthetic distances 1-25 km; the UI clamps longer routes to 25 km and warns.
- `file:./mlruns` backend is local and not thread-safe across machines. For teamwork, set `MLFLOW_TRACKING_URI` to a shared server.
- `transport_type` is encoded as an integer; RandomForest handles this fine, but if you swap in a linear model, consider one-hot encoding.

## Validation checklist

- `python train.py` creates `model.joblib` and a run under `mlruns/`
- `mlflow ui` shows the run with params, metrics, artifacts, and a registered model version
- `GET /` serves the HTML UI
- Two clicks on the map fill `distance_km` via `/distance` (OSRM route or Manhattan fallback)
- Predict mode returns both a label and `probability_on_time`
- Reverse mode returns a concrete "Leave at HH:MM" at the requested confidence
- Feedback buttons append rows to `feedback.csv` and `/feedback/stats` updates
- `POST /retrain` logs a new MLflow run tagged `retrain_with_feedback` and bumps the Model Registry version
- Docker image builds and serves the same endpoints
