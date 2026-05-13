# Convenience script to run the full pipeline on Windows.
# Usage:
#   .\run.ps1 install   # install backend deps
#   .\run.ps1 etl       # ETL: xlsx → parquet
#   .\run.ps1 features  # build feature panel
#   .\run.ps1 train     # train LightGBM
#   .\run.ps1 cluster   # K-means phenotyping of (region, icd) series
#   .\run.ps1 backend   # start FastAPI on :8000
#   .\run.ps1 frontend  # start Next.js on :3000
#   .\run.ps1 pipeline  # etl + features + train + cluster

param([string]$cmd = "help")

switch ($cmd) {
    "install"  { python -m pip install -r backend/requirements.txt python-calamine }
    "etl"      { python ml/prepare_data.py }
    "features" { python ml/build_features.py }
    "train"    { python ml/train.py }
    "cluster"  { python ml/cluster_series.py }
    "pipeline" {
        python ml/prepare_data.py
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        python ml/build_features.py
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        python ml/train.py
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        python ml/cluster_series.py
    }
    "backend"  { Push-Location backend; uvicorn main:app --host 0.0.0.0 --port 8000 --reload; Pop-Location }
    "frontend" { Push-Location frontend; npm run dev; Pop-Location }
    default {
        Write-Host "Usage: .\run.ps1 [install|etl|features|train|cluster|pipeline|backend|frontend]"
    }
}
