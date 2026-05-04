"use client";
import { useEffect, useState } from "react";
import { Stethoscope } from "lucide-react";
import { api, IcdRow } from "@/lib/api";
import { fmtInt, ICD_CHAPTERS } from "@/lib/format";

export function TopDiseases({
  region,
  onPick,
}: {
  region?: string | null;
  onPick?: (icd: string) => void;
}) {
  const [rows, setRows] = useState<IcdRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.topDiseases(region ?? undefined, { months: 12 }, 12).then((r) => {
      setRows(r);
      setLoading(false);
    });
  }, [region]);

  const total = rows.reduce((s, r) => s + r.total, 0) || 1;

  return (
    <div className="panel p-5 h-full">
      <div className="flex items-center gap-2 mb-3">
        <Stethoscope className="h-4 w-4 text-rose-500" />
        <h2 className="font-display text-base font-semibold text-ink-900">
          Топ диагнозов · 12 мес.
        </h2>
        <span className="chip ml-auto truncate max-w-[60%]">{region ?? "Все регионы"}</span>
      </div>
      {loading && <div className="text-sm text-ink-500">Загрузка…</div>}
      <div className="space-y-1.5">
        {rows.map((r) => {
          const pct = (r.total / total) * 100;
          const ch = r.icdid?.[0]?.toUpperCase() || "?";
          return (
            <button
              key={r.icdid}
              onClick={() => onPick?.(r.icdid)}
              className="block w-full text-left rounded-lg px-2 py-1.5 hover:bg-ink-50 transition"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="chip-brand text-[10px] py-0.5 font-mono">{r.icdid}</span>
                <span className="text-ink-800 truncate flex-1">{r.nozology || ICD_CHAPTERS[ch]}</span>
                <span className="text-ink-900 font-semibold">{fmtInt(r.total)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                <div
                  className="h-full bg-gradient-to-r from-brand-500 via-cyan-400 to-amber-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
