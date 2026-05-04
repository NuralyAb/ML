"use client";
import { motion } from "framer-motion";
import { ReactNode } from "react";

const palette = {
  brand:   { from: "from-brand-100",   to: "to-brand-50",   icon: "bg-brand-100 text-brand-700",     ring: "ring-brand-200" },
  accent:  { from: "from-cyan-100",    to: "to-cyan-50",    icon: "bg-cyan-100 text-cyan-700",       ring: "ring-cyan-200" },
  warning: { from: "from-amber-100",   to: "to-amber-50",   icon: "bg-amber-100 text-amber-700",     ring: "ring-amber-200" },
  success: { from: "from-emerald-100", to: "to-emerald-50", icon: "bg-emerald-100 text-emerald-700", ring: "ring-emerald-200" },
  danger:  { from: "from-rose-100",    to: "to-rose-50",    icon: "bg-rose-100 text-rose-700",       ring: "ring-rose-200" },
} as const;

export function KpiCard({
  label,
  value,
  hint,
  icon,
  delta,
  accent = "brand",
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  delta?: { text: string; positive?: boolean };
  accent?: keyof typeof palette;
}) {
  const cfg = palette[accent];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={`panel relative overflow-hidden p-5 bg-gradient-to-br ${cfg.from} ${cfg.to}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500 font-semibold">{label}</div>
          <div className="mt-1 font-display text-2xl font-bold text-ink-900">{value}</div>
          {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
        </div>
        {icon && (
          <div className={`grid h-10 w-10 place-items-center rounded-xl ${cfg.icon}`}>
            {icon}
          </div>
        )}
      </div>
      {delta && (
        <div
          className={`mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            delta.positive
              ? "bg-emerald-100 text-emerald-700"
              : "bg-rose-100 text-rose-700"
          }`}
        >
          {delta.text}
        </div>
      )}
    </motion.div>
  );
}
