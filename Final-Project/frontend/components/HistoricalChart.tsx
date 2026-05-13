"use client";
import {
  Area, AreaChart, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import { fmtInt, fmtMonth } from "@/lib/format";

export type HistPoint = {
  month: string;
  actual?: number;
  predicted?: number;
  /** Pair of (lower, upper) quantile bounds for the forecast band. */
  band?: [number, number];
};

const LEGEND_LABELS: Record<string, string> = {
  actual: "Факт",
  predicted: "Прогноз",
  band: "Интервал 80% (P10–P90)",
};

export function HistoricalChart({
  data,
  splitAt,
  title,
}: {
  data: HistPoint[];
  splitAt?: string;
  title?: string;
}) {
  const hasBand = data.some((d) => Array.isArray(d.band));
  return (
    <div className="h-[330px]">
      {title && <div className="mb-1 text-sm text-ink-700 font-medium">{title}</div>}
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 10, right: 24, top: 8, bottom: 4 }}>
          <defs>
            <linearGradient id="hist" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="pred" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e6ebf3" vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={fmtMonth}
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={{ stroke: "#cbd5e1" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e6ebf3",
              borderRadius: 12,
              color: "#0f172a",
              fontSize: 12,
              boxShadow: "0 12px 32px -12px rgba(15,23,42,0.15)",
            }}
            labelFormatter={fmtMonth}
            formatter={(v: number | [number, number], name: string) => {
              if (name === "band" && Array.isArray(v)) {
                return [`${fmtInt(v[0])} – ${fmtInt(v[1])}`, LEGEND_LABELS.band];
              }
              return [fmtInt(v as number), LEGEND_LABELS[name] ?? name];
            }}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: "#64748b" }}
            formatter={(v) => LEGEND_LABELS[v] ?? v}
          />
          {splitAt && (
            <ReferenceLine
              x={splitAt}
              stroke="#f59e0b"
              strokeDasharray="4 4"
              label={{ value: "→ прогноз", fill: "#b45309", fontSize: 10, position: "top" }}
            />
          )}
          {/* Quantile band first so the point line + actuals draw on top. */}
          {hasBand && (
            <Area
              type="monotone"
              dataKey="band"
              stroke="none"
              fill="#fbbf24"
              fillOpacity={0.22}
              isAnimationActive={false}
            />
          )}
          <Area type="monotone" dataKey="actual" stroke="#2563eb" fill="url(#hist)" strokeWidth={2.2} />
          <Area type="monotone" dataKey="predicted" stroke="#d97706" fill="url(#pred)" strokeWidth={2.2} strokeDasharray="6 3" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
