// Tiny client wrapper around the FastAPI backend. The Next dev server proxies
// /api/* to the backend (see next.config.js).

export type RegionRow = {
  region: string;
  total_recipes: number;
  n_icd: number;
  n_districts: number;
};

export type IcdRow = { icdid: string; nozology: string | null; total: number };

export type DistrictRow = { district: string; total: number };

export type DistrictSummaryRow = { region: string; district: string; total: number };

export type DataRange = { min: string; max: string };

export type Period = {
  start?: string; // YYYY-MM-DD
  end?: string;
  months?: number; // fallback: last-N-months
};

export type HistoricalSeries = {
  region: string;
  icd: string;
  nozology: string;
  series: { month: string; recipes: number; packs: number }[];
};

export type RegionTotal = { region: string; total: number };

export type HeatmapCell = { region: string; chapter: string; value: number };

export type ForecastResponse = {
  region: string;
  icd: string;
  nozology: string;
  horizon: number;
  history: { year_month: string; actual: number }[];
  forecast: { year_month: string; predicted: number }[];
};

export type ModelMetrics = {
  metrics: Record<string, Record<string, number>>;
  feature_columns: string[];
  trained_at: string;
  last_observed_month: string;
  holdout_months?: number;
  n_train_rows: number;
  n_test_rows: number;
  n_series: number;
  top_features: { feature: string; gain: number; split: number }[];
};

export type GlobalStats = {
  panel_rows: number;
  total_recipes: number;
  regions: number;
  districts: number;
  icd_codes: number;
  period_start: string | null;
  period_end: string | null;
};

const base = ""; // Same-origin via the rewrite proxy.

async function get<T>(url: string): Promise<T> {
  const r = await fetch(`${base}${url}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

function periodQuery(p?: Period): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.start) parts.push(`start=${encodeURIComponent(p.start)}`);
  if (p.end) parts.push(`end=${encodeURIComponent(p.end)}`);
  if (p.months !== undefined && !p.start && !p.end) parts.push(`months=${p.months}`);
  return parts.length ? "&" + parts.join("&") : "";
}

export const api = {
  health:           () => get<{ status: string }>("/api/health"),
  dataRange:        () => get<DataRange>("/api/data-range"),
  regions:          () => get<RegionRow[]>("/api/regions"),
  icd:              (region?: string, q?: string, limit = 50) =>
    get<IcdRow[]>(
      `/api/icd?limit=${limit}${region ? `&region=${encodeURIComponent(region)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`
    ),
  districts:        (region: string) =>
    get<DistrictRow[]>(`/api/districts?region=${encodeURIComponent(region)}`),
  historical:       (region: string, icd: string) =>
    get<HistoricalSeries>(
      `/api/historical?region=${encodeURIComponent(region)}&icd=${encodeURIComponent(icd)}`
    ),
  regionSummary:    (opts?: { icd?: string; chapter?: string; period?: Period } | string, periodOrUndef?: Period) => {
    // Back-compat: accept (icd, period) signature too.
    let icd: string | undefined; let chapter: string | undefined; let period: Period | undefined;
    if (typeof opts === "string" || opts === undefined) {
      icd = opts; period = periodOrUndef;
    } else {
      icd = opts.icd; chapter = opts.chapter; period = opts.period;
    }
    const parts = ["_=1"];
    if (icd) parts.push(`icd=${encodeURIComponent(icd)}`);
    if (chapter) parts.push(`chapter=${encodeURIComponent(chapter)}`);
    return get<RegionTotal[]>(`/api/region-summary?${parts.join("&")}${periodQuery(period)}`);
  },
  districtSummary:  (opts?: { region?: string; icd?: string; chapter?: string; period?: Period }) => {
    const { region, icd, chapter, period } = opts || {};
    const parts = ["_=1"];
    if (region) parts.push(`region=${encodeURIComponent(region)}`);
    if (icd) parts.push(`icd=${encodeURIComponent(icd)}`);
    if (chapter) parts.push(`chapter=${encodeURIComponent(chapter)}`);
    return get<DistrictSummaryRow[]>(`/api/district-summary?${parts.join("&")}${periodQuery(period)}`);
  },
  heatmap:          (p?: Period) =>
    get<HeatmapCell[]>(`/api/heatmap?_=1${periodQuery(p)}`),
  topDiseases:      (region?: string, p?: Period, limit = 15) =>
    get<IcdRow[]>(
      `/api/top-diseases?limit=${limit}${region ? `&region=${encodeURIComponent(region)}` : ""}${periodQuery(p)}`
    ),
  timeseriesOverview: (region?: string) =>
    get<{ month: string; total: number }[]>(
      `/api/timeseries-overview${region ? `?region=${encodeURIComponent(region)}` : ""}`
    ),
  forecast:         (region: string, icd: string, horizon: number) =>
    post<ForecastResponse>("/api/forecast", { region, icd, horizon }),
  modelMetrics:     () => get<ModelMetrics>("/api/model-metrics"),
  globalStats:      () => get<GlobalStats>("/api/global-stats"),
};
