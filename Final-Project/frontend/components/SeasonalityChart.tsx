"use client";
import { useMemo } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend, ResponsiveContainer,
} from "recharts";
import type { SeasonalityResponse } from "@/lib/api";
import { fmtInt } from "@/lib/format";

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Monthly seasonal profile of a diagnosis. Bars = averages across years.
 * The light grey range shows min/max across years. The dashed horizontal
 * line is the overall mean — months above it are "peak", below it are
 * "trough".
 */
export function SeasonalityChart({ data }: { data: SeasonalityResponse }) {
  const chartData = useMemo(() => {
    return data.monthly.map((m) => ({
      month: MONTH_LABELS[m.month - 1],
      avg: Math.round(m.avg),
      median: Math.round(m.median),
      min: m.min,
      max: m.max,
      // Make the range visible as a "candle" using bottom + height
      rangeBase: m.min,
      rangeSize: Math.max(0, m.max - m.min),
    }));
  }, [data]);

  const overallMean = useMemo(() => {
    const vals = data.monthly.map((m) => m.avg).filter((v) => v > 0);
    if (!vals.length) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [data]);

  const peakMonth = useMemo(() => {
    let best = data.monthly[0];
    for (const m of data.monthly) if (m.avg > best.avg) best = m;
    return best;
  }, [data]);
  const troughMonth = useMemo(() => {
    let worst = data.monthly[0];
    for (const m of data.monthly) if (m.avg < worst.avg) worst = m;
    return worst;
  }, [data]);

  return (
    <div className="h-[340px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 20, left: 10, bottom: 6 }}>
          <CartesianGrid stroke="#e6ebf3" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fill: "#475569", fontSize: 11 }}
            axisLine={{ stroke: "#cbd5e1" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#475569", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          />
          <Tooltip
            cursor={{ fill: "rgba(15,23,42,0.04)" }}
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e6ebf3",
              borderRadius: 12,
              fontSize: 12,
              boxShadow: "0 12px 32px -12px rgba(15,23,42,0.15)",
            }}
            content={(p: any) => {
              if (!p?.payload?.[0]) return null;
              const d = p.payload[0].payload;
              return (
                <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs">
                  <div className="font-semibold text-ink-900">{d.month}</div>
                  <div className="mt-1 text-ink-700">Average: <b>{fmtInt(d.avg)}</b></div>
                  <div className="text-ink-700">Median: {fmtInt(d.median)}</div>
                  <div className="text-ink-500">Range: {fmtInt(d.min)} – {fmtInt(d.max)}</div>
                </div>
              );
            }}
          />
          <Legend
            iconType="square"
            wrapperStyle={{ fontSize: 11, color: "#475569" }}
            payload={[
              { value: "Range (min–max across years)", type: "rect", color: "#cbd5e1", id: "range" },
              { value: "Monthly average", type: "rect", color: "#2563eb", id: "avg" },
              { value: "Overall mean (dashed)", type: "rect", color: "#c47c1b", id: "mean" },
            ]}
          />
          {/* The light-grey range (min..max). We use a stacked bar where the
              first segment is transparent (base) and the second is the visible
              range. */}
          <Bar dataKey="rangeBase" stackId="range" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="rangeSize" stackId="range" fill="#cbd5e1" radius={[2, 2, 0, 0]} isAnimationActive={false} name="Range" />
          {/* The actual monthly average on top of the range. */}
          <Bar dataKey="avg" fill="#2563eb" barSize={18} radius={[3, 3, 0, 0]} name="Monthly avg" />
          <ReferenceLine
            y={overallMean}
            stroke="#c47c1b"
            strokeDasharray="4 4"
            label={{ value: "mean", fill: "#b45309", fontSize: 10, position: "right" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
        <span>
          Years covered: <b className="text-ink-700">{data.n_years}</b>
        </span>
        <span>
          Seasonality strength (CV of monthly avgs):{" "}
          <b className="text-ink-700">{(data.seasonality_strength * 100).toFixed(1)} %</b>
        </span>
        <span>
          Peak: <b className="text-ink-700">{MONTH_LABELS[peakMonth.month - 1]}</b>{" "}
          ({fmtInt(peakMonth.avg)})
        </span>
        <span>
          Trough: <b className="text-ink-700">{MONTH_LABELS[troughMonth.month - 1]}</b>{" "}
          ({fmtInt(troughMonth.avg)})
        </span>
      </div>
    </div>
  );
}
