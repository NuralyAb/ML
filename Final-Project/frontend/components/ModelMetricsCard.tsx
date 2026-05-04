"use client";
import { useEffect, useState } from "react";
import { Brain, Cpu } from "lucide-react";
import { api, ModelMetrics } from "@/lib/api";
import { fmtInt, fmtNum } from "@/lib/format";

export function ModelMetricsCard() {
  const [m, setM] = useState<ModelMetrics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.modelMetrics().then(setM).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="panel p-4 text-sm text-rose-700">Модель ещё не обучена</div>;
  if (!m) return <div className="panel p-4 text-sm text-ink-500">Загрузка метрик…</div>;

  const rows: [string, string][] = [
    ["LightGBM", "lightgbm"],
    ["Naive (lag-1)", "naive_last"],
    ["Seasonal (lag-12)", "seasonal_naive_12"],
    ["Roll. mean (3 мес.)", "rolling_mean_3"],
  ];

  return (
    <div className="panel p-5 h-full">
      <div className="flex items-center gap-2 mb-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-100 text-cyan-700">
          <Brain className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">Качество модели</h2>
        <span className="chip ml-auto">
          <Cpu className="h-3.5 w-3.5" /> hold-out: {m.holdout_months ?? 6} мес.
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-ink-500 bg-ink-50">
            <tr>
              <th className="text-left px-3 py-2">Модель</th>
              <th className="text-right px-3 py-2">MAE</th>
              <th className="text-right px-3 py-2">RMSE</th>
              <th className="text-right px-3 py-2">sMAPE</th>
              <th className="text-right px-3 py-2">R²</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, key]) => {
              const r = m.metrics[key] || {};
              const isMain = key === "lightgbm";
              return (
                <tr key={key} className={`border-t border-line ${isMain ? "bg-emerald-50/40" : ""}`}>
                  <td className={`px-3 py-2 ${isMain ? "font-semibold text-ink-900" : "text-ink-700"}`}>
                    {label}
                    {isMain && <span className="ml-2 chip-success">production</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-900">{fmtNum(r.MAE, 2)}</td>
                  <td className="px-3 py-2 text-right text-ink-900">{fmtNum(r.RMSE, 2)}</td>
                  <td className="px-3 py-2 text-right text-ink-900">{fmtNum(r.sMAPE, 1)}%</td>
                  <td className="px-3 py-2 text-right text-ink-900">{fmtNum(r.R2, 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <Tile label="Серий" value={fmtInt(m.n_series)} />
        <Tile label="Train rows" value={fmtInt(m.n_train_rows)} />
        <Tile label="Test rows" value={fmtInt(m.n_test_rows)} />
      </div>

      <div className="mt-4">
        <div className="text-xs uppercase tracking-wider text-ink-500 font-semibold mb-2">Топ признаков по gain</div>
        <div className="space-y-1.5">
          {m.top_features.slice(0, 8).map((f) => {
            const max = m.top_features[0].gain || 1;
            const pct = (f.gain / max) * 100;
            return (
              <div key={f.feature} className="text-xs">
                <div className="flex items-center justify-between text-ink-700">
                  <span className="font-mono">{f.feature}</span>
                  <span className="text-ink-500">{fmtInt(f.gain)}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full bg-gradient-to-r from-brand-500 to-cyan-400"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-line px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">{label}</div>
      <div className="font-bold text-ink-900">{value}</div>
    </div>
  );
}
