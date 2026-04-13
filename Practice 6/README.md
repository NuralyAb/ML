# ML FastAPI Docker - Practice 6 (Advanced README)

## Project Goal

This project trains and deploys a classification model for the use case:
**"Will a driver in Almaty arrive on time?"**

The API predicts `on_time` using trip context and expected arrival constraints.

## Problem Formulation

- **Type:** Binary classification
- **Target:** `on_time`
  - `1` (`true`) - likely arrives within requested time
  - `0` (`false`) - likely does not arrive within requested time
- **Model:** `RandomForestClassifier` from scikit-learn

## Input Features Required by the Model

The `/predict` endpoint requires the following JSON fields:

1. `distance_km` (`float`)
   - Meaning: trip distance in kilometers
   - Allowed range: `1` to `25`
   - Impact: higher distance increases risk of being late

2. `departure_hour` (`int`)
   - Meaning: hour of departure (24-hour format)
   - Allowed range: `0` to `23`
   - Impact: determines traffic regime and peak-hour effect

3. `day_of_week` (`int`)
   - Meaning: day index
   - Allowed range: `0` to `6`
   - Example mapping: `0=Monday ... 6=Sunday` (or any consistent mapping)
   - Impact: adds weekly behavior patterns to model decision boundaries

4. `target_duration_min` (`int`)
   - Meaning: desired arrival time budget in minutes
   - Allowed range: `10` to `90`
   - Impact: lower target time makes positive prediction harder

5. `transport_type` (`string`)
   - Allowed values: `"car"` or `"bus"`
   - Impact: in peak traffic, buses are modeled as faster due to dedicated lanes

### Derived Feature (Calculated Internally)

- `is_peak_hour` (`0` or `1`)
  - Computed from `departure_hour`
  - Peak windows: `08:00-10:59` and `17:00-20:59`
  - Not sent by client directly; derived inside API and during training

## How the Model "Thinks" (Decision Logic)

During dataset generation (`train.py`), each sample estimates travel speed by time window:

- **Night (00:00-06:59, 22:00-23:59):** `40-50 km/h`
- **Daytime (non-peak):** `25-30 km/h`
- **Peak hour, car:** `10-15 km/h`
- **Peak hour, bus:** `16-22 km/h`

Then synthetic travel time is estimated:

- `estimated_time_min = (distance_km / speed_kmh) * 60`

Label generation:

- if `estimated_time_min <= target_duration_min` -> `on_time = 1`
- else -> `on_time = 0`

The model learns these nonlinear relations from data and later generalizes on API requests.

## API Contract

### `GET /`

Health endpoint.

**Response**

```json
{
  "message": "ML API is running"
}
```

### `POST /predict`

Prediction endpoint.

**Request body example**

```json
{
  "distance_km": 10,
  "departure_hour": 18,
  "day_of_week": 2,
  "target_duration_min": 20,
  "transport_type": "car"
}
```

**Response body example**

```json
{
  "on_time": false,
  "on_time_label": 0
}
```

## Why These Fields Matter

- `distance_km` and `target_duration_min` define physical feasibility.
- `departure_hour` and derived `is_peak_hour` model traffic intensity.
- `transport_type` differentiates vehicle behavior in congestion.
- `day_of_week` helps represent weekly demand variability.

Together they approximate real city traffic constraints and make predictions more realistic than distance-only heuristics.

## Project Structure

- `train.py` - generates synthetic data, trains model, saves `model.joblib`
- `main.py` - FastAPI app (`/`, `/predict`)
- `model.joblib` - trained model artifact
- `requirements.txt` - Python dependencies
- `Dockerfile` - container instructions
- `README.md` - documentation and run instructions

## Local Run

### 1) Install Dependencies

```bash
python -m pip install -r requirements.txt
```

### 2) Train and Save Model

```bash
python train.py
```

Expected output:

```text
Model saved to model.joblib
```

### 3) Start API

```bash
uvicorn main:app --reload
```

Open:

- Root: `http://127.0.0.1:8000/`
- Docs: `http://127.0.0.1:8000/docs`

## Docker Run

### 1) Build Image

```bash
docker build -t ml-fastapi-docker .
```

### 2) Run Container

```bash
docker run -p 8000:8000 ml-fastapi-docker
```

Test again:

- `http://127.0.0.1:8000/`
- `http://127.0.0.1:8000/docs`
- `POST http://127.0.0.1:8000/predict`

## Validation and Testing Checklist

- `model.joblib` exists after training
- `/` returns running status
- `/predict` accepts valid JSON and returns prediction
- `/docs` is accessible
- Docker image builds without errors
- Container serves same endpoints as local run

## Potential Extensions

- Add weather and precipitation as extra features
- Add district/route category features (city zones)
- Store model metadata and training metrics
- Add request logging and monitoring
- Version model artifacts for reproducible ML deployment

## Practical Relevance

The model captures typical megapolis traffic behavior and can be used as a baseline decision engine for:

- courier ETA pre-check,
- dispatch route triage,
- simple navigation advisory systems.
