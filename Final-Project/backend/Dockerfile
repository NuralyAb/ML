# --- Backend image: FastAPI + DuckDB + LightGBM forecaster + DOCX report ---
FROM python:3.11-slim

# Build deps for native wheels (lightgbm, pyarrow). Removed after install
# to keep the final image small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libgomp1 build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for better Docker layer caching.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /app/backend/requirements.txt

# Project source. Datasets are mounted at runtime; model + parquet ship
# inside the image so the API works out of the box.
COPY backend /app/backend
COPY ml/models /app/ml/models
COPY ml/data   /app/ml/data

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

EXPOSE 8000

WORKDIR /app/backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
