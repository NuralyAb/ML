"use client";
import { useEffect, useState } from "react";
import {
  ScanSearch, AlertTriangle, TrendingUp, TrendingDown, ChevronDown,
} from "lucide-react";
import { api, ExplainResponse, RegionRow, IcdRow } from "@/lib/api";
import { Combobox } from "./Combobox";
import { fmtInt, fmtNum } from "@/lib/format";

/**
 * Per-prediction explainability based on TreeSHAP.
 *
 * For any (region, ICD) the user picks, this panel calls /api/explain which
 * decomposes the next-month forecast into:
 *   base_value (population average)
 * + sum of per-feature contributions (in log-space)
 *   = final predicted recipe count (after expm1).
 *
 * The waterfall renders the top features pushing the prediction UP (red) and
 * DOWN (blue), with the feature value used by the model — so an auditor can
 * trace exactly why the model emitted a particular number.
 */

// Human-readable explanations for each feature name. Shown under the
// contribution row so a non-engineer can read the waterfall.
const FEATURE_DESCRIPTIONS: Record<string, string> = {
  lag_1:             "Prescription count one month ago.",
  lag_2:             "Prescription count two months ago.",
  lag_3:             "Prescription count three months ago.",
  lag_6:             "Prescription count six months ago.",
  lag_12:            "Prescription count exactly one year ago (annual seasonal anchor).",
  roll_mean_3:       "Average of the previous 3 months.",
  roll_mean_6:       "Average of the previous 6 months — short-term smoothed level.",
  roll_mean_12:      "Average of the previous 12 months — stable annual level.",
  roll_std_3:        "Volatility (std) of the previous 3 months.",
  roll_std_6:        "Volatility of the previous 6 months.",
  roll_std_12:       "Volatility of the previous 12 months.",
  expanding_mean:    "Long-run average of every observed month.",
  region_total_lag1: "Total prescriptions in the region last month (cross-series signal).",
  month:             "Calendar month (1–12).",
  quarter:           "Calendar quarter (1–4).",
  month_idx:         "Months since 2018-01 (long-term trend).",
  month_sin:         "Cyclic month encoding — sin(2π × month / 12).",
  month_cos:         "Cyclic month encoding — cos(2π × month / 12).",
  n_clinics:         "Number of distinct clinics in the region prescribing this ICD code.",
  n_districts:       "Number of districts in the region prescribing this ICD code.",
  region_enc:        "Region identifier (label-encoded categorical).",
  icdid_enc:         "ICD-10 code identifier (label-encoded categorical).",
  icd_chapter_enc:   "ICD-10 chapter (A, B, …, Z) — broad disease class.",
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtMonthShort(iso: string): string {
  const d = new Date(iso);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}


export function ExplainabilityPanel({
  regions,
  initialRegion,
  initialIcd,
}: {
  regions: RegionRow[];
  initialRegion?: string | null;
  initialIcd?: string | null;
}) {
  const [icdList, setIcdList] = useState<IcdRow[]>([]);
  const [region, setRegion] = useState<RegionRow | null>(
    initialRegion ? regions.find((r) => r.region === initialRegion) ?? regions[0] ?? null
                  : regions[0] ?? null
  );
  const [icd, setIcd] = useState<IcdRow | null>(null);
  const [resp, setResp] = useState<ExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!region) return;
    api.icd(region.region, undefined, 200).then((rs) => {
      setIcdList(rs);
      if (!icd || !rs.find((r) => r.icdid === icd.icdid)) {
        const want = initialIcd ? rs.find((r) => r.icdid === initialIcd) : null;
        setIcd(want ?? rs[0] ?? null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  useEffect(() => {
    if (!region || !icd) return;
    setLoading(true);
    setError(null);
    api.explain(region.region, icd.icdid)
      .then(setResp)
      .catch((e) => setError(e?.message ?? "request failed"))
      .finally(() => setLoading(false));
  }, [region, icd]);

  const visibleContribs = resp
    ? (showAll ? resp.contributions : resp.contributions.slice(0, 8))
    : [];
  const maxAbs = visibleContribs.length
    ? Math.max(...visibleContribs.map((c) => Math.abs(c.contribution_log)))
    : 0;

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
          <ScanSearch className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">
          Why this forecast? — per-prediction explainability
        </h2>
        <span className="chip ml-auto">TreeSHAP · {resp ? "loaded" : "—"}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="label">Region</label>
          <Combobox
            value={region}
            onChange={setRegion}
            items={regions}
            itemKey={(it) => it.region}
            itemLabel={(it) => it.region}
            itemSubtitle={(it) => `${fmtInt(it.total_recipes)} prescriptions · ${it.n_icd} ICD`}
            placeholder="Select region"
          />
        </div>
        <div>
          <label className="label">Diagnosis (ICD-10)</label>
          <Combobox
            value={icd}
            onChange={setIcd}
            items={icdList}
            itemKey={(it) => it.icdid}
            itemLabel={(it) => `${it.icdid} · ${it.nozology ?? ""}`}
            itemSubtitle={(it) => `${fmtInt(it.total)} prescriptions total`}
            placeholder="Choose ICD code"
          />
        </div>
      </div>

      {loading && <div className="text-sm text-ink-500">Computing SHAP contributions…</div>}
      {error && (
        <span className="chip-danger">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </span>
      )}

      {resp && !loading && (
        <>
          {/* Headline numbers */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="rounded-xl border border-line bg-ink-50/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                Population baseline
              </div>
              <div className="font-display text-xl font-bold text-ink-900">
                {fmtInt(resp.base_value)}
              </div>
              <div className="text-[11px] text-ink-500">
                Average across the entire training set.
              </div>
            </div>
            <div className="rounded-xl border border-line bg-ink-50/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                Sum of feature pushes
              </div>
              <div className="font-display text-xl font-bold text-ink-900">
                {resp.predicted_log - resp.base_value_log >= 0 ? "+" : ""}
                {fmtNum(resp.predicted_log - resp.base_value_log, 3)}
              </div>
              <div className="text-[11px] text-ink-500">
                In log-space (model is trained on log1p(y)).
              </div>
            </div>
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-violet-700 font-semibold">
                Forecast — {fmtMonthShort(resp.target_month)}
              </div>
              <div className="font-display text-xl font-bold text-ink-900">
                {fmtInt(resp.predicted)}
              </div>
              <div className="text-[11px] text-ink-500">
                {resp.region} · {resp.icd}
              </div>
            </div>
          </div>

          {/* Waterfall: per-feature horizontal bars */}
          <div className="rounded-xl border border-line bg-white p-3">
            <div className="flex items-center gap-2 text-xs text-ink-500 mb-3">
              <TrendingUp className="h-3.5 w-3.5 text-rose-600" />
              <span>Red bars push the forecast UP.</span>
              <TrendingDown className="h-3.5 w-3.5 text-sky-700 ml-3" />
              <span>Blue bars pull it DOWN.</span>
              <span className="ml-auto text-[11px]">
                bar length ∝ |contribution| in log-space
              </span>
            </div>

            <div className="space-y-2">
              {visibleContribs.map((c) => {
                const isPos = c.contribution_log >= 0;
                const widthPct = maxAbs > 0 ? (Math.abs(c.contribution_log) / maxAbs) * 50 : 0;
                return (
                  <div key={c.feature} className="grid grid-cols-12 items-start gap-2 text-xs">
                    <div className="col-span-3 md:col-span-3 pt-0.5">
                      <div className="font-mono font-semibold text-ink-900">{c.feature}</div>
                      <div className="text-[10px] text-ink-500">
                        value: <span className="font-mono">{String(c.display_value)}</span>
                      </div>
                    </div>
                    <div className="col-span-7 md:col-span-7">
                      <div className="relative h-5">
                        {/* center line */}
                        <div className="absolute inset-y-0 left-1/2 w-px bg-ink-200" />
                        {isPos ? (
                          <div
                            className="absolute top-0.5 bottom-0.5 left-1/2 rounded-r-sm bg-rose-500/85"
                            style={{ width: `${widthPct}%` }}
                          />
                        ) : (
                          <div
                            className="absolute top-0.5 bottom-0.5 rounded-l-sm bg-sky-600/85"
                            style={{ left: `${50 - widthPct}%`, width: `${widthPct}%` }}
                          />
                        )}
                      </div>
                      <div className="mt-1 text-[10px] text-ink-500">
                        {FEATURE_DESCRIPTIONS[c.feature] || "—"}
                      </div>
                    </div>
                    <div className="col-span-2 md:col-span-2 text-right pt-0.5">
                      <span className={`font-mono font-bold ${isPos ? "text-rose-700" : "text-sky-800"}`}>
                        {isPos ? "+" : ""}{fmtNum(c.contribution_log, 3)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {resp.contributions.length > 8 && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-3 flex items-center gap-1 text-xs text-violet-700 hover:underline"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition ${showAll ? "rotate-180" : ""}`} />
                {showAll ? "Show top 8 only" : `Show all ${resp.contributions.length} features`}
              </button>
            )}
          </div>

          <div className="mt-3 text-[11px] text-ink-500">
            <b>How to read this.</b>{" "}
            The model starts from a population baseline of {fmtInt(resp.base_value)} prescriptions (the
            average across all 18,881 series). Each feature then pushes the
            prediction either UP (red) or DOWN (blue) in log-space; the sum of
            all pushes plus the baseline, transformed by expm1, equals the
            final forecast of <b>{fmtInt(resp.predicted)}</b> for{" "}
            <b>{fmtMonthShort(resp.target_month)}</b>. This decomposition is
            exact (TreeSHAP) — the same calculation a regulator or auditor can
            independently reproduce from the booster artefact.
          </div>
        </>
      )}
    </div>
  );
}
