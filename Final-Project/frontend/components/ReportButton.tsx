"use client";
import { useState } from "react";
import { FileDown, Loader2, AlertTriangle } from "lucide-react";

export function ReportButton({
  region,
  horizon = 6,
  topN = 10,
  variant = "primary",
  className = "",
}: {
  region?: string | null;
  horizon?: number;
  topN?: number;
  variant?: "primary" | "ghost";
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ horizon: String(horizon), top_n: String(topN) });
      if (region) params.set("region", region);
      const r = await fetch(`/api/report?${params.toString()}`);
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `${r.status} ${r.statusText}`);
      }
      // Extract filename from Content-Disposition.
      const cd = r.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const fname = m ? m[1] : `med_forecast_KZ_${new Date().toISOString().slice(0, 10)}.docx`;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || "Не удалось сгенерировать отчёт");
    } finally {
      setLoading(false);
    }
  }

  const cls =
    variant === "primary"
      ? "btn-primary"
      : "btn-ghost";

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button onClick={download} className={cls} disabled={loading} title="Скачать отчёт для МЗ РК (DOCX)">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
        {loading ? "Готовлю отчёт…" : "Скачать отчёт"}
      </button>
      {region && <span className="text-[11px] text-ink-500">по: {region}</span>}
      {error && (
        <span className="chip-danger">
          <AlertTriangle className="h-3.5 w-3.5" /> {error.slice(0, 80)}
        </span>
      )}
    </span>
  );
}
