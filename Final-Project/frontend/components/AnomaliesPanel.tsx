"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertOctagon, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import { AnomaliesResponse, AnomalyHeatCell, AnomalyRow, api } from "@/lib/api";
import { fmtInt, fmtMonth, fmtNum, ICD_CHAPTERS, shortRegion } from "@/lib/format";

const SEVERITY_STYLE: Record<AnomalyRow["severity"], { dot: string; chip: string; label: string }> = {
  critical: { dot: "bg-rose-500", chip: "bg-rose-100 text-rose-700 border-rose-200", label: "critical" },
  warning:  { dot: "bg-amber-500", chip: "bg-amber-100 text-amber-700 border-amber-200", label: "warning" },
  notice:   { dot: "bg-sky-500", chip: "bg-sky-100 text-sky-700 border-sky-200", label: "notice" },
};

type SeverityFilter = "all" | AnomalyRow["severity"];
type DirectionFilter = "all" | "surge" | "drop";

export function AnomaliesPanel() {
  const [data, setData] = useState<AnomaliesResponse | null>(null);
  const [heat, setHeat] = useState<AnomalyHeatCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      api.anomalies({
        limit: 80,
        min_z: 1.5,
        severity: severity === "all" ? undefined : severity,
        direction: direction === "all" ? undefined : direction,
      }),
      api.anomalyHeatmap(),
    ])
      .then(([rows, cells]) => {
        if (!live) return;
        setData(rows);
        setHeat(cells);
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [severity, direction]);

  const tiers = data?.meta.tiers ?? {};
  const directions = data?.meta.directions ?? {};

  if (data && !data.meta.available) {
    return (
      <div className="panel p-5">
        <Header />
        <div className="mt-4 text-sm text-ink-500">
          Аудит ещё не запускался — `ml/detect_anomalies.py` не сгенерировал
          <code className="mx-1 rounded bg-ink-100 px-1 text-[11px]">ml/data/anomalies.parquet</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <Header n={data?.meta.n_flagged} total={data?.meta.n_panel_rows} />

      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <Stat label="Critical" value={tiers.critical ?? 0} tone="rose" />
        <Stat label="Warning"  value={tiers.warning ?? 0}  tone="amber" />
        <Stat label="Notice"   value={tiers.notice ?? 0}   tone="sky" />
        <Stat label="Surge ↑"  value={directions.surge ?? 0} tone="emerald" />
        <Stat label="Drop ↓"   value={directions.drop ?? 0}  tone="fuchsia" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <FilterGroup
          label="Уровень"
          value={severity}
          onChange={(v) => setSeverity(v as SeverityFilter)}
          options={[
            { v: "all", l: "Все" },
            { v: "critical", l: "Critical" },
            { v: "warning",  l: "Warning" },
            { v: "notice",   l: "Notice" },
          ]}
        />
        <FilterGroup
          label="Направление"
          value={direction}
          onChange={(v) => setDirection(v as DirectionFilter)}
          options={[
            { v: "all", l: "Все" },
            { v: "surge", l: "Surge ↑" },
            { v: "drop",  l: "Drop ↓" },
          ]}
        />
      </div>

      <div className="mt-4 grid lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7">
          <div className="text-xs uppercase tracking-wider text-ink-500 font-semibold mb-2">
            Топ аномалий ({loading ? "…" : data?.rows.length ?? 0})
          </div>
          <AnomaliesTable rows={data?.rows ?? []} loading={loading} />
        </div>
        <div className="lg:col-span-5">
          <div className="text-xs uppercase tracking-wider text-ink-500 font-semibold mb-2">
            Карта тревог: регион × класс МКБ (max |z|)
          </div>
          <AnomalyHeat cells={heat} />
        </div>
      </div>
    </div>
  );
}

function Header({ n, total }: { n?: number; total?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-rose-100 text-rose-700">
        <ShieldAlert className="h-4 w-4" />
      </div>
      <h2 className="font-display text-base font-semibold text-ink-900">Аудит: аномалии в выписке</h2>
      {n !== undefined && total !== undefined && (
        <span className="chip ml-auto">
          <AlertOctagon className="h-3.5 w-3.5" />
          <span className="ml-1">
            <b className="text-ink-900">{fmtInt(n)}</b> из {fmtInt(total)} строк hold-out
          </span>
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "rose" | "amber" | "sky" | "emerald" | "fuchsia" }) {
  const bg = {
    rose:     "bg-rose-50 border-rose-200 text-rose-700",
    amber:    "bg-amber-50 border-amber-200 text-amber-700",
    sky:      "bg-sky-50 border-sky-200 text-sky-700",
    emerald:  "bg-emerald-50 border-emerald-200 text-emerald-700",
    fuchsia:  "bg-fuchsia-50 border-fuchsia-200 text-fuchsia-700",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${bg}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-lg font-bold leading-tight">{fmtInt(value)}</div>
    </div>
  );
}

function FilterGroup({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wider text-ink-500 font-semibold">{label}</span>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
              value === o.v
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-white text-ink-700 border-line hover:bg-ink-50"
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

function AnomaliesTable({ rows, loading }: { rows: AnomalyRow[]; loading: boolean }) {
  if (loading && !rows.length) {
    return <div className="text-sm text-ink-500">Загрузка…</div>;
  }
  if (!rows.length) {
    return <div className="text-sm text-ink-500">По текущим фильтрам аномалий не найдено.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line max-h-[420px]">
      <table className="w-full text-xs">
        <thead className="bg-ink-50 text-ink-500 uppercase tracking-wider sticky top-0">
          <tr>
            <th className="px-2 py-2 text-left">Регион</th>
            <th className="px-2 py-2 text-left">МКБ</th>
            <th className="px-2 py-2 text-left">Месяц</th>
            <th className="px-2 py-2 text-right">Факт</th>
            <th className="px-2 py-2 text-right">Прогноз</th>
            <th className="px-2 py-2 text-right">z</th>
            <th className="px-2 py-2 text-center">⚠</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const sev = SEVERITY_STYLE[r.severity];
            return (
              <tr key={`${r.region}-${r.icdid}-${r.year_month}-${i}`} className="border-t border-line">
                <td className="px-2 py-1.5 text-ink-800 whitespace-nowrap">{shortRegion(r.region)}</td>
                <td className="px-2 py-1.5 text-ink-800">
                  <span className="font-mono">{r.icdid}</span>
                  {r.nozology && (
                    <div className="text-[10px] text-ink-500 max-w-[160px] truncate" title={r.nozology}>
                      {r.nozology}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-ink-700 whitespace-nowrap">{fmtMonth(r.year_month)}</td>
                <td className="px-2 py-1.5 text-right text-ink-900 font-semibold">{fmtInt(r.actual)}</td>
                <td className="px-2 py-1.5 text-right text-ink-500">{fmtInt(r.predicted)}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  <span className={r.direction === "surge" ? "text-emerald-700" : "text-fuchsia-700"}>
                    {r.direction === "surge" ? <TrendingUp className="inline h-3 w-3 mr-0.5" /> : <TrendingDown className="inline h-3 w-3 mr-0.5" />}
                    {fmtNum(r.z_score, 2)}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${sev.chip}`}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${sev.dot}`} />
                    {sev.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AnomalyHeat({ cells }: { cells: AnomalyHeatCell[] }) {
  const { regions, chapters, matrix, max } = useMemo(() => {
    const r = Array.from(new Set(cells.map((c) => c.region))).sort();
    const ch = Array.from(new Set(cells.map((c) => c.icd_chapter))).sort();
    const m: Record<string, Record<string, AnomalyHeatCell>> = {};
    let mx = 0;
    for (const c of cells) {
      m[c.region] ??= {};
      m[c.region][c.icd_chapter] = c;
      if (c.max_abs_z > mx) mx = c.max_abs_z;
    }
    return { regions: r, chapters: ch, matrix: m, max: mx };
  }, [cells]);

  if (!cells.length) {
    return <div className="text-sm text-ink-500">Карта пустая — нет flagged строк.</div>;
  }

  const color = (z: number) => {
    if (!z) return "rgba(226,232,240,0.6)";
    const t = Math.min(z / Math.max(max, 1), 1);
    // From ink-50 -> amber -> rose, fixed scale.
    if (t < 0.5) {
      const k = t / 0.5;
      return `rgba(${248 - 18 * k}, ${234 - 30 * k}, ${214 - 80 * k}, ${0.55 + 0.45 * k})`;
    }
    const k = (t - 0.5) / 0.5;
    return `rgba(${244 - 60 * k}, ${94 - 30 * k}, ${94 - 30 * k}, ${0.85 + 0.15 * k})`;
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-line max-h-[420px]">
      <table className="text-[11px] select-none w-full">
        <thead className="bg-ink-50 sticky top-0">
          <tr>
            <th className="sticky left-0 z-10 bg-ink-50 px-2 py-1.5 text-left text-ink-600 border-r border-line">
              Регион ↓ / Гл. МКБ →
            </th>
            {chapters.map((c) => (
              <th
                key={c}
                className="px-1.5 py-1.5 text-center text-ink-700 font-semibold"
                title={ICD_CHAPTERS[c] || c}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {regions.map((r, i) => (
            <tr key={r} className={i % 2 ? "bg-white" : "bg-ink-50/40"}>
              <td className="sticky left-0 z-10 bg-inherit px-2 py-1 text-ink-800 whitespace-nowrap font-medium border-r border-line">
                {shortRegion(r)}
              </td>
              {chapters.map((c) => {
                const cell = matrix[r]?.[c];
                const z = cell?.max_abs_z ?? 0;
                return (
                  <td
                    key={c}
                    className="p-0.5"
                    title={cell
                      ? `${r} · ${ICD_CHAPTERS[c] || c}\nmax |z| = ${fmtNum(z, 2)} · ${cell.n} аномалий (↑${cell.n_surge} / ↓${cell.n_drop})`
                      : `${r} · ${ICD_CHAPTERS[c] || c}: норма`}
                  >
                    <div
                      className="h-6 w-7 rounded-md grid place-items-center text-[10px] font-semibold"
                      style={{ background: color(z), color: z > 2.5 ? "#7f1d1d" : "#334155" }}
                    >
                      {z ? fmtNum(z, 1) : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
