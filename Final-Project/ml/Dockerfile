# --- ML image: lightweight runtime for ml/*.py scripts ---
# Used for one-shot jobs: build_features, train, cluster_series, mlflow_experiments.
# Unlike backend/Dockerfile this image does NOT bake in ml/data or ml/models —
# they are mounted from the host at runtime so outputs persist on disk.
#
#   docker build -t med-forecast-ml -f ml/Dockerfile .
#   docker run --rm -v ${PWD}:/app -w /app med-forecast-ml \
#       python ml/cluster_series.py
#
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libgomp1 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps from the canonical backend requirements file (same
# environment as production) so cluster_series.py and the MLflow runner
# get exactly the versions the API uses.
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

# No CMD — the image is meant to be run with an explicit `python ml/...`
# command. WORKDIR is /app so relative paths in the scripts resolve.
