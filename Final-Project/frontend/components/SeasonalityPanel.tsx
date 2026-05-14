"use client";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Stethoscope, AlertTriangle } from "lucide-react";
import { api, IcdRow, RegionRow, SeasonalityResponse } from "@/lib/api";
import { Combobox } from "./Combobox";
import { SeasonalityChart } from "./SeasonalityChart";
import { fmtInt } from "@/lib/format";

/**
 * Stand-alone "Disease seasonality" card. Shows the monthly profile of a
 * chosen ICD-10 code, optionally restricted to one region. Surfaces the
 * Coefficient-of-Variation of the monthly averages — a single number the
 * user can use to argue "this disease has measurable seasonality".
 *
 * The card also reminds the user which model features encode this signal
 * (month, month_sin/cos, lag_12, roll_mean_12) so the model's seasonal
 * behaviour can be tied back to the chart.
 */
export function SeasonalityPanel({
  regions,
  initialRegion,
  initialIcd,
}: {
  regions: RegionRow[];
  initialRegion?: string | null;
  initialIcd?: string | null;
}) {
  const [icdList, setIcdList] = useState<IcdRow[]>([]);
  const [icd, setIcd] = useState<IcdRow | null>(null);
  const [region, setRegion] = useState<RegionRow | null>(
    initialRegion ? regions.find((r) => r.region === initialRegion) ?? null : null
  );
  const [resp, setResp] = useState<SeasonalityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch top ICD codes (country-wide or per region).
  useEffect(() => {
    api.icd(region?.region, undefined, 200).then((rs) => {
      setIcdList(rs);
      // If nothing chosen yet, prefer initialIcd or fall back to top code.
      if (!icd) {
        const want = initialIcd ? rs.find((r) => r.icdid === initialIcd) : null;
        setIcd(want ?? rs[0] ?? null);
      } else if (!rs.find((r) => r.icdid === icd.icdid)) {
        setIcd(rs[0] ?? null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  useEffect(() => {
    if (!icd) return;
    setLoading(true);
    setError(null);
    api
      .seasonality(icd.icdid, region?.region)
      .then(setResp)
      .catch((e) => setError(e?.message ?? "request failed"))
      .finally(() => setLoading(false));
  }, [icd, region]);

  const titleSub = useMemo(() => {
    if (!resp) return "";
    return `${resp.icd} · ${resp.nozology}`;
  }, [resp]);

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-100 text-cyan-700">
          <CalendarClock className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">
          Disease seasonality
        </h2>
        <span className="chip ml-auto">{region ? region.region : "All regions"}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
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
        <div>
          <label className="label">Region (optional — leave blank for country)</label>
          <Combobox
            value={region}
            onChange={(r) => setRegion(r)}
            items={[{ region: "All regions", total_recipes: 0, n_icd: 0, n_districts: 0 } as RegionRow, ...regions]}
            itemKey={(it) => it.region}
            itemLabel={(it) => it.region}
            itemSubtitle={(it) =>
              it.region === "All regions"
                ? "Sum across all 18 regions"
                : `${fmtInt(it.total_recipes)} prescriptions · ${it.n_icd} ICD`
            }
            placeholder="All regions"
          />
        </div>
      </div>

      {titleSub && (
        <div className="text-xs text-ink-500 mb-2">{titleSub}</div>
      )}

      {loading && <div className="text-sm text-ink-500">Loading…</div>}
      {error && (
        <span className="chip-danger">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </span>
      )}

      {resp && !loading && <SeasonalityChart data={resp} />}

      <div className="mt-4 flex items-start gap-2 text-[11px] text-ink-500">
        <Stethoscope className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
        <span>
          The chart shows the average prescription count per calendar month
          across all available years. The grey range is min–max year-by-year.
          The forecasting model captures this signal through four explicit
          features: <b>month</b> and <b>quarter</b> (categorical), <b>sin(month)</b> +
          <b> cos(month)</b> (continuous, wraps Dec→Jan), <b>lag_12</b> (value one
          year ago at the same calendar month), and <b>roll_mean_12</b> (12-month
          smoothed level). Together these let LightGBM reproduce the pattern
          you see above without any per-diagnosis tuning.
        </span>
      </div>
    </div>
  );
}
