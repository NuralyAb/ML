"use client";
import { useMemo } from "react";
import { HeatmapCell } from "@/lib/api";
import { fmtInt, heatColor, ICD_CHAPTERS, shortRegion } from "@/lib/format";

/** Region × ICD-chapter heatmap. Color encodes log(value) on a light scale. */
export function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  const { regions, chapters, matrix, max, total } = useMemo(() => {
    const r = Array.from(new Set(cells.map((c) => c.region))).sort();
    const ch = Array.from(new Set(cells.map((c) => c.chapter))).sort();
    const m: Record<string, Record<string, number>> = {};
    let mx = 0;
    let tot = 0;
    for (const c of cells) {
      m[c.region] ??= {};
      m[c.region][c.chapter] = c.value;
      if (c.value > mx) mx = c.value;
      tot += c.value;
    }
    return { regions: r, chapters: ch, matrix: m, max: mx, total: tot };
  }, [cells]);

  if (!cells.length) return <div className="text-ink-500 text-sm">Нет данных</div>;

  const norm = (v: number) => (v ? Math.log1p(v) / Math.log1p(max) : 0);

  return (
    <div>
      <div className="text-xs text-ink-500 mb-2">
        Тепловая карта: рецепты за последние 24 мес. по регионам и главам МКБ-10. Всего: {fmtInt(total)}.
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="text-xs select-none w-full">
          <thead>
            <tr className="bg-ink-50">
              <th className="sticky left-0 z-10 bg-ink-50 p-2 text-left font-semibold text-ink-600 border-r border-line">
                Регион ↓ / Гл. МКБ →
              </th>
              {chapters.map((c) => (
                <th
                  key={c}
                  className="px-2 py-1.5 text-center font-semibold text-ink-700"
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
                  const v = matrix[r]?.[c] ?? 0;
                  const t = norm(v);
                  return (
                    <td
                      key={c}
                      className="p-0.5"
                      title={`${r} · ${ICD_CHAPTERS[c] || c}: ${fmtInt(v)} рецептов`}
                    >
                      <div
                        className="h-7 w-9 rounded-md grid place-items-center text-[10px] font-semibold"
                        style={{
                          background: heatColor(t),
                          color: t > 0.6 ? "#0f172a" : "#1e293b",
                          opacity: v ? 1 : 0.35,
                        }}
                      >
                        {v ? formatCompact(v) : ""}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Legend max={max} />
    </div>
  );
}

function Legend({ max }: { max: number }) {
  const stops = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="mt-3 flex items-center gap-3 text-[11px] text-ink-500">
      <span>0</span>
      <div className="flex h-2 w-48 overflow-hidden rounded-full border border-line">
        {stops.map((t, i) => (
          <div key={i} className="flex-1" style={{ background: heatColor(t) }} />
        ))}
      </div>
      <span>{formatCompact(max)}+</span>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${n}`;
}
