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
            formatter={(v: number, name: string) => [fmtInt(v), name === "actual" ? "Факт" : "Прогноз"]}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: "#64748b" }}
            formatter={(v) => (v === "actual" ? "Факт" : "Прогноз")}
          />
          {splitAt && (
            <ReferenceLine
              x={splitAt}
              stroke="#f59e0b"
              strokeDasharray="4 4"
              label={{ value: "→ прогноз", fill: "#b45309", fontSize: 10, position: "top" }}
            />
          )}
          <Area type="monotone" dataKey="actual" stroke="#2563eb" fill="url(#hist)" strokeWidth={2.2} />
          <Area type="monotone" dataKey="predicted" stroke="#d97706" fill="url(#pred)" strokeWidth={2.2} strokeDasharray="6 3" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
