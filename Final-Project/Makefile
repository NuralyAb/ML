PY ?= python

.PHONY: install etl features train cluster backend frontend all

install:
	$(PY) -m pip install -r backend/requirements.txt python-calamine

etl:
	$(PY) ml/prepare_data.py

features:
	$(PY) ml/build_features.py

train:
	$(PY) ml/train.py

cluster:
	$(PY) ml/cluster_series.py

pipeline: etl features train cluster

backend:
	cd backend && uvicorn main:app --host 0.0.0.0 --port 8000 --reload

frontend:
	cd frontend && npm run dev

all: install pipeline
