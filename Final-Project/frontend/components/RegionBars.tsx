"use client";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";
import { fmtInt, shortRegion } from "@/lib/format";

export function RegionBars({
  rows,
  selected,
  onSelect,
}: {
  rows: { region: string; total: number }[];
  selected?: string | null;
  onSelect?: (r: string) => void;
}) {
  const data = rows.map((r) => ({ ...r, short: shortRegion(r.region) }));
  return (
    <div className="h-[330px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 24 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="short"
            width={120}
            tick={{ fill: "#475569", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(15,23,42,0.04)" }}
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e6ebf3",
              borderRadius: 12,
              color: "#0f172a",
              fontSize: 12,
              boxShadow: "0 12px 32px -12px rgba(15,23,42,0.15)",
            }}
            formatter={(v: number) => [fmtInt(v), "Рецептов"]}
            labelFormatter={(_, p: any) => p?.[0]?.payload?.region}
          />
          <defs>
            <linearGradient id="bar-default" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.95} />
            </linearGradient>
            <linearGradient id="bar-active" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.95} />
            </linearGradient>
          </defs>
          <Bar
            dataKey="total"
            radius={[8, 8, 8, 8]}
            onClick={(d: any) => onSelect?.(d.region)}
            style={{ cursor: onSelect ? "pointer" : "default" }}
          >
            {data.map((d) => (
              <Cell
                key={d.region}
                fill={selected === d.region ? "url(#bar-active)" : "url(#bar-default)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
