"use client";
import { useEffect, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";
import { Target } from "lucide-react";
import { fmtInt } from "@/lib/format";

export function EvalScatter() {
  const [rows, setRows] = useState<{ actual: number; predicted: number; region: string; icdid: string; nozology: string }[]>([]);
  useEffect(() => {
    fetch("/api/eval-sample?n=400").then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, []);

  const max = rows.reduce((m, r) => Math.max(m, r.actual, r.predicted), 1);

  return (
    <div className="panel p-5 h-full">
      <div className="flex items-center gap-2 mb-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
          <Target className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">Факт vs прогноз (hold-out)</h2>
        <span className="chip ml-auto text-[11px]">случайная выборка {rows.length}</span>
      </div>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="#e6ebf3" />
            <XAxis
              dataKey="actual"
              name="actual"
              type="number"
              tick={{ fill: "#64748b", fontSize: 11 }}
              axisLine={{ stroke: "#cbd5e1" }}
              tickLine={false}
              label={{ value: "Факт", fill: "#64748b", fontSize: 11, position: "insideBottom", offset: -10 }}
            />
            <YAxis
              dataKey="predicted"
              name="predicted"
              type="number"
              tick={{ fill: "#64748b", fontSize: 11 }}
              axisLine={{ stroke: "#cbd5e1" }}
              tickLine={false}
              label={{ value: "Прогноз", fill: "#64748b", fontSize: 11, angle: -90, position: "insideLeft" }}
            />
            <ZAxis range={[40, 80]} />
            <Tooltip
              cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
              content={(p: any) => {
                if (!p?.payload?.[0]) return null;
                const d = p.payload[0].payload;
                return (
                  <div className="rounded-lg border border-line bg-white p-2 text-xs shadow-cardLg">
                    <div className="font-semibold text-ink-900">{d.icdid} — {d.region}</div>
                    <div className="text-ink-500 truncate max-w-[260px]">{d.nozology}</div>
                    <div className="mt-1 text-ink-700">Факт: <b>{fmtInt(d.actual)}</b></div>
                    <div className="text-ink-700">Прогноз: <b>{fmtInt(d.predicted)}</b></div>
                  </div>
                );
              }}
            />
            <ReferenceLine
              segment={[{ x: 0, y: 0 }, { x: max, y: max }]}
              stroke="#f59e0b"
              strokeDasharray="4 4"
            />
            <Scatter data={rows} fill="#3b82f6" fillOpacity={0.55} stroke="#1d4ed8" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[11px] text-ink-500 mt-2">
        Идеальная модель — точки на пунктирной диагонали (y = x).
      </div>
    </div>
  );
}
