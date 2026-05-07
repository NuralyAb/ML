"use client";
import { useEffect, useState } from "react";
import { CalendarRange } from "lucide-react";
import type { Period } from "@/lib/api";

const PRESETS: { label: string; months: number }[] = [
  { label: "6 мес.", months: 6 },
  { label: "12 мес.", months: 12 },
  { label: "24 мес.", months: 24 },
  { label: "36 мес.", months: 36 },
];

export function PeriodPicker({
  value,
  onChange,
  range,
}: {
  value: Period;
  onChange: (p: Period) => void;
  range?: { min: string; max: string } | null;
}) {
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState(value.start ?? "");
  const [end, setEnd] = useState(value.end ?? "");

  useEffect(() => {
    setStart(value.start ?? "");
    setEnd(value.end ?? "");
    setCustom(Boolean(value.start || value.end));
  }, [value]);

  const minMonth = range ? toMonth(range.min) : "2018-01";
  const maxMonth = range ? toMonth(range.max) : "";

  return (
    <div>
      <label className="label flex items-center gap-1">
        <CalendarRange className="h-3.5 w-3.5" /> Период
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.months}
            onClick={() => {
              setCustom(false);
              onChange({ months: p.months });
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
              !custom && value.months === p.months
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-white text-ink-700 border-line hover:bg-ink-50"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => {
            setCustom(false);
            onChange({});
          }}
          className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
            !custom && !value.months && !value.start && !value.end
              ? "bg-brand-600 text-white border-brand-600"
              : "bg-white text-ink-700 border-line hover:bg-ink-50"
          }`}
        >
          Весь период
        </button>
        <button
          onClick={() => setCustom((v) => !v)}
          className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
            custom
              ? "bg-amber-500 text-white border-amber-500"
              : "bg-white text-ink-700 border-line hover:bg-ink-50"
          }`}
        >
          Произвольно…
        </button>
      </div>
      {custom && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="month"
            min={minMonth}
            max={maxMonth}
            value={start ? toMonth(start) : ""}
            onChange={(e) => {
              const v = e.target.value ? `${e.target.value}-01` : "";
              setStart(v);
              onChange({ start: v || undefined, end: end || undefined });
            }}
            className="input max-w-[140px]"
          />
          <span className="text-ink-500 text-xs">→</span>
          <input
            type="month"
            min={minMonth}
            max={maxMonth}
            value={end ? toMonth(end) : ""}
            onChange={(e) => {
              const v = e.target.value ? lastDayOfMonth(e.target.value) : "";
              setEnd(v);
              onChange({ start: start || undefined, end: v || undefined });
            }}
            className="input max-w-[140px]"
          />
          {range && (
            <span className="text-[11px] text-ink-500">
              доступно: {fmtRange(range.min)} → {fmtRange(range.max)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function toMonth(d: string): string {
  return d.slice(0, 7);
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

function fmtRange(d: string): string {
  const dt = new Date(d);
  return dt.toLocaleDateString("ru-RU", { year: "numeric", month: "short" });
}
