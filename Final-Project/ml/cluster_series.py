"""
Unsupervised phenotyping of (region, icd) prescription series.

Why
---
The supervised stack (LightGBM / XGB / CatBoost / RF) treats every series as a
point in a feature space and learns a single global mapping. That hides the
fact that the panel is a mixture of fundamentally different *behaviours*:
some nozologies are strongly seasonal, others trend up year-over-year, others
are sporadic with many zero months. K-means on per-series behavioural features
gives an interpretable phenotype per series, which we

  1. surface as an analytical artefact (cluster_profiles.csv + PCA plot), and
  2. feed back into the forecaster as a categorical feature (see
     experiment ``9_lgbm_with_cluster`` in ``mlflow_experiments.py``).

What gets clustered
-------------------
For each (region, icdid) series we compute 8 behavioural descriptors from the
raw monthly target ``recipe_count``:

  * level                log1p of mean prescription count
  * cv                   coefficient of variation (std / mean)
  * trend                relative slope over the full series length
  * seasonality          (max - min) of month-of-year means, scaled by mean
  * share_zeros          fraction of months with 0 prescriptions
  * acf_1                lag-1 autocorrelation
  * acf_12               lag-12 autocorrelation (seasonal persistence)
  * n_months             series length (kept so very short series can be
                         distinguished, but standardised like the rest)

These describe *shape*, not absolute identity — two regions with identical
seasonal flu-like patterns end up in the same cluster regardless of their
ICD code or population size.

Pipeline
--------
features -> StandardScaler -> KMeans (k chosen by max silhouette over 3..8)
        -> auto-named clusters (by dominant z-score of the centroid)
        -> PCA(2) for visualisation
        -> MLflow run logged under experiment ``series_clustering``

Outputs (under ml/data/ and ml/models/)
  * series_clusters.parquet    region, icdid, cluster_id, cluster_name + features
  * cluster_profiles.csv       per-cluster centroid + size + top example codes
  * cluster_pca.png            PCA-2D scatter, coloured by cluster
  * cluster_metadata.json      k, silhouette, feature names, run info

Run from the project root:

    python ml/cluster_series.py
"""
from __future__ import annotations
import os, json, warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import mlflow
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score, calinski_harabasz_score
from sklearn.preprocessing import StandardScaler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "ml", "data")
MODELS = os.path.join(ROOT, "ml", "models")
MLRUNS_DIR = os.path.join(ROOT, "mlruns")

# Canonical path produced by build_features.py. Fall back to the root copy
# the user keeps for sharing.
CANDIDATE_FEATURE_PATHS = [
    os.path.join(DATA, "feature_panel.parquet"),
    os.path.join(ROOT, "feature_panel.parquet"),
]

OUT_CLUSTERS = os.path.join(DATA, "series_clusters.parquet")
OUT_PROFILES = os.path.join(DATA, "cluster_profiles.csv")
OUT_PCA_PNG = os.path.join(MODELS, "cluster_pca.png")
OUT_METADATA = os.path.join(MODELS, "cluster_metadata.json")

EXPERIMENT = "series_clustering"
K_GRID = list(range(3, 9))                  # try k = 3..8
RANDOM_STATE = 42

FEATURE_COLS = [
    "level", "cv", "trend", "seasonality",
    "share_zeros", "acf_1", "acf_12", "n_months",
]


# ---------------------------------------------------------------------------
# Per-series behavioural features
# ---------------------------------------------------------------------------

def _safe_corr(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 2 or np.std(a) == 0 or np.std(b) == 0:
        return 0.0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        c = np.corrcoef(a, b)[0, 1]
    return 0.0 if np.isnan(c) else float(c)


def _series_features(g: pd.DataFrame) -> dict:
    """Compute behavioural descriptors for a single (region, icd) series.

    The input is assumed already sorted by ``year_month`` ascending.
    """
    y = g["recipe_count"].astype(float).to_numpy()
    n = len(y)
    mean = float(y.mean()) if n else 0.0
    std = float(y.std(ddof=0)) if n else 0.0

    level = float(np.log1p(mean))
    cv = (std / mean) if mean > 0 else 0.0

    # Trend: slope of an OLS line on (index, y), normalised by the series mean
    # and scaled by length so it expresses relative growth over the whole span.
    if n >= 4 and std > 0:
        slope = float(np.polyfit(np.arange(n), y, 1)[0])
        trend = (slope * n) / mean if mean > 0 else 0.0
    else:
        trend = 0.0

    # Seasonality strength: spread of month-of-year means relative to mean.
    if n >= 12 and mean > 0:
        months = g["year_month"].dt.month.to_numpy()
        by_month = pd.Series(y).groupby(months).mean()
        seasonality = float((by_month.max() - by_month.min()) / mean)
    else:
        seasonality = 0.0

    share_zeros = float((y == 0).mean()) if n else 0.0
    acf_1 = _safe_corr(y[:-1], y[1:]) if n >= 3 else 0.0
    acf_12 = _safe_corr(y[:-12], y[12:]) if n >= 13 else 0.0

    return dict(
        n_months=float(n),
        level=level, cv=cv, trend=trend, seasonality=seasonality,
        share_zeros=share_zeros, acf_1=acf_1, acf_12=acf_12,
    )


def build_series_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["region", "icdid", "year_month"])
    rows = []
    for (region, icdid), g in df.groupby(["region", "icdid"], sort=False):
        feats = _series_features(g)
        feats["region"] = region
        feats["icdid"] = icdid
        feats["nozology"] = g["nozology"].iloc[-1] if "nozology" in g.columns else ""
        rows.append(feats)
    out = pd.DataFrame(rows)
    cols = ["region", "icdid", "nozology"] + FEATURE_COLS
    return out[cols].reset_index(drop=True)


# ---------------------------------------------------------------------------
# K selection + clustering
# ---------------------------------------------------------------------------

@dataclass
class FitResult:
    k: int
    model: KMeans
    silhouette: float
    inertia: float
    calinski: float
    scores: pd.DataFrame              # per-k diagnostics


def select_k(X: np.ndarray, k_grid: list[int] = K_GRID) -> FitResult:
    """Fit KMeans for each k in ``k_grid`` and pick the one with the highest
    silhouette score. Silhouette balances cohesion vs separation and is more
    robust than elbow-on-inertia for picking k in modest-dimension data.
    """
    diagnostics = []
    best: FitResult | None = None
    for k in k_grid:
        km = KMeans(n_clusters=k, n_init=10, random_state=RANDOM_STATE)
        labels = km.fit_predict(X)
        sil = float(silhouette_score(X, labels))
        cal = float(calinski_harabasz_score(X, labels))
        diagnostics.append(dict(k=k, silhouette=sil, inertia=float(km.inertia_), calinski=cal))
        if best is None or sil > best.silhouette:
            best = FitResult(k=k, model=km, silhouette=sil,
                             inertia=float(km.inertia_), calinski=cal,
                             scores=pd.DataFrame(diagnostics))
    best.scores = pd.DataFrame(diagnostics)
    return best


# ---------------------------------------------------------------------------
# Cluster naming
# ---------------------------------------------------------------------------

# Map "dominant feature + sign" -> human-readable label. The label is just a
# nickname for the report; the cluster_id is the source of truth.
_LABELS = {
    ("seasonality", +1): "seasonal",
    ("seasonality", -1): "non_seasonal_flat",
    ("trend",       +1): "growing",
    ("trend",       -1): "declining",
    ("level",       +1): "high_volume",
    ("level",       -1): "low_volume",
    ("cv",          +1): "volatile",
    ("cv",          -1): "stable",
    ("share_zeros", +1): "sporadic",
    ("share_zeros", -1): "always_active",
    ("acf_12",      +1): "annually_persistent",
    ("acf_12",      -1): "no_annual_pattern",
    ("acf_1",       +1): "smooth",
    ("acf_1",       -1): "choppy",
    ("n_months",    +1): "long_series",
    ("n_months",    -1): "short_series",
}


def name_clusters(scaled_centroids: np.ndarray, feature_names: list[str]) -> list[str]:
    """Pick a nickname per cluster from the dominant z-scored centroid component.

    Since features are standardised, centroid components are z-scores. The
    component with the largest absolute value is the most distinctive trait
    of that cluster. We disambiguate duplicates by appending the runner-up.
    """
    used: dict[str, int] = {}
    names: list[str] = []
    for c in scaled_centroids:
        order = np.argsort(-np.abs(c))           # most extreme first
        primary_idx = int(order[0])
        sign = 1 if c[primary_idx] >= 0 else -1
        primary = _LABELS.get((feature_names[primary_idx], sign),
                              f"{feature_names[primary_idx]}_{'hi' if sign > 0 else 'lo'}")
        # If another cluster already took this primary label, append the
        # secondary trait so the names stay unique.
        if primary in used:
            secondary_idx = int(order[1])
            sec_sign = 1 if c[secondary_idx] >= 0 else -1
            secondary = _LABELS.get((feature_names[secondary_idx], sec_sign),
                                    feature_names[secondary_idx])
            primary = f"{primary}__{secondary}"
        used[primary] = used.get(primary, 0) + 1
        names.append(primary)
    return names


# ---------------------------------------------------------------------------
# Visualisation
# ---------------------------------------------------------------------------

def plot_pca(X_scaled: np.ndarray, labels: np.ndarray, names: list[str], out_path: str) -> dict:
    pca = PCA(n_components=2, random_state=RANDOM_STATE)
    xy = pca.fit_transform(X_scaled)
    fig, ax = plt.subplots(figsize=(9, 6))
    for cid in sorted(set(labels)):
        m = labels == cid
        ax.scatter(xy[m, 0], xy[m, 1], s=14, alpha=0.55, label=f"{cid}: {names[cid]}")
    ax.set_xlabel(f"PC1 ({pca.explained_variance_ratio_[0]*100:.1f}% var)")
    ax.set_ylabel(f"PC2 ({pca.explained_variance_ratio_[1]*100:.1f}% var)")
    ax.set_title(f"Series clusters in PCA-2D (k={len(set(labels))})")
    ax.legend(loc="best", fontsize=8, framealpha=0.85)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fig.savefig(out_path, dpi=140)
    plt.close(fig)
    return {
        "pc1_explained": float(pca.explained_variance_ratio_[0]),
        "pc2_explained": float(pca.explained_variance_ratio_[1]),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _resolve_feature_path() -> str:
    for p in CANDIDATE_FEATURE_PATHS:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(
        "feature_panel.parquet not found. Run ml/build_features.py first, "
        f"or place the file at one of: {CANDIDATE_FEATURE_PATHS}"
    )


def main() -> None:
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(MODELS, exist_ok=True)

    feature_path = _resolve_feature_path()
    print(f"loading feature panel: {feature_path}")
    panel = pd.read_parquet(feature_path)
    print(f"  rows={len(panel):,}  series={panel.groupby(['region', 'icdid']).ngroups:,}")

    print("computing per-series behavioural features ...")
    series_df = build_series_features(panel)
    print(f"  series feature matrix: {series_df.shape}")

    X = series_df[FEATURE_COLS].to_numpy()
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    print(f"selecting k by silhouette over {K_GRID} ...")
    fit = select_k(X_scaled, K_GRID)
    print(fit.scores.to_string(index=False))
    print(f"  picked k={fit.k}  silhouette={fit.silhouette:.4f}  inertia={fit.inertia:.1f}")

    labels = fit.model.predict(X_scaled)
    names = name_clusters(fit.model.cluster_centers_, FEATURE_COLS)
    print("cluster names:")
    for i, n in enumerate(names):
        print(f"  {i}: {n}")

    series_df["cluster_id"] = labels.astype(int)
    series_df["cluster_name"] = [names[c] for c in labels]
    series_df.to_parquet(OUT_CLUSTERS, index=False)

    # Per-cluster profile: centroid in original units + size + top example codes.
    centroids_original = scaler.inverse_transform(fit.model.cluster_centers_)
    profile_rows = []
    for cid in range(fit.k):
        m = labels == cid
        sub = series_df[m]
        top_codes = (
            sub.assign(n_obs=sub["n_months"])
               .sort_values("n_obs", ascending=False)
               .head(5)[["region", "icdid", "nozology"]]
               .to_dict(orient="records")
        )
        row = dict(
            cluster_id=cid,
            cluster_name=names[cid],
            size=int(m.sum()),
            share=float(m.mean()),
            **{f: float(centroids_original[cid, i]) for i, f in enumerate(FEATURE_COLS)},
            top_examples=json.dumps(top_codes, ensure_ascii=False),
        )
        profile_rows.append(row)
    profiles_df = pd.DataFrame(profile_rows).sort_values("size", ascending=False)
    profiles_df.to_csv(OUT_PROFILES, index=False)
    print("\ncluster profiles (centroid in original units):")
    show_cols = ["cluster_id", "cluster_name", "size", "share"] + FEATURE_COLS
    print(profiles_df[show_cols].to_string(index=False))

    print("\nrendering PCA scatter ...")
    pca_info = plot_pca(X_scaled, labels, names, OUT_PCA_PNG)

    metadata = {
        "k": int(fit.k),
        "silhouette": float(fit.silhouette),
        "inertia": float(fit.inertia),
        "calinski_harabasz": float(fit.calinski),
        "feature_columns": FEATURE_COLS,
        "n_series": int(len(series_df)),
        "random_state": RANDOM_STATE,
        "k_grid": K_GRID,
        "k_scores": fit.scores.to_dict(orient="records"),
        "pca": pca_info,
        "cluster_names": {int(i): n for i, n in enumerate(names)},
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "trained_at": pd.Timestamp.now(tz="UTC").isoformat(),
    }
    with open(OUT_METADATA, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    # ------- MLflow logging -------
    os.makedirs(MLRUNS_DIR, exist_ok=True)
    mlflow.set_tracking_uri(f"file:{MLRUNS_DIR}")
    mlflow.set_experiment(EXPERIMENT)
    with mlflow.start_run(run_name=f"kmeans_k{fit.k}"):
        mlflow.set_tag("description",
                       "K-means phenotyping of (region, icd) series on 8 behavioural features.")
        mlflow.set_tag("algo", "kmeans")
        mlflow.log_param("k", fit.k)
        mlflow.log_param("k_grid", str(K_GRID))
        mlflow.log_param("n_series", int(len(series_df)))
        mlflow.log_param("random_state", RANDOM_STATE)
        mlflow.log_param("feature_columns", ",".join(FEATURE_COLS))
        mlflow.log_metric("silhouette", fit.silhouette)
        mlflow.log_metric("inertia", fit.inertia)
        mlflow.log_metric("calinski_harabasz", fit.calinski)
        mlflow.log_metric("pc1_explained", pca_info["pc1_explained"])
        mlflow.log_metric("pc2_explained", pca_info["pc2_explained"])
        mlflow.log_artifact(OUT_CLUSTERS, artifact_path="clusters")
        mlflow.log_artifact(OUT_PROFILES, artifact_path="clusters")
        mlflow.log_artifact(OUT_PCA_PNG,  artifact_path="clusters")
        mlflow.log_artifact(OUT_METADATA, artifact_path="clusters")

    print(f"\nsaved clusters:  {OUT_CLUSTERS}")
    print(f"saved profiles:  {OUT_PROFILES}")
    print(f"saved PCA plot:  {OUT_PCA_PNG}")
    print(f"saved metadata:  {OUT_METADATA}")
    print(f"MLflow:          experiment='{EXPERIMENT}' at file:{MLRUNS_DIR}")


if __name__ == "__main__":
    main()
