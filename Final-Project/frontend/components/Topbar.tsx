"use client";
import { Activity, Database, Github, LineChart } from "lucide-react";
import { ReportButton } from "./ReportButton";

export function Topbar({ stats, region }: { stats?: { regions: number; icd: number; period: string }; region?: string | null }) {
  return (
    <div className="sticky top-0 z-30 border-b border-line bg-white/80 backdrop-blur">
      <div className="mx-auto max-w-[1400px] px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-accent-500 shadow-glow">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-lg font-semibold tracking-tight text-ink-900">
              Med Forecast <span className="grad-text">KZ</span>
            </div>
            <div className="text-xs muted">Прогноз рецептов · МЗ РК · ЭРСБ</div>
          </div>
        </div>

        <div className="ml-6 hidden md:flex items-center gap-2 text-xs">
          {stats && (
            <>
              <span className="chip"><Database className="h-3 w-3" /> {stats.regions} регионов</span>
              <span className="chip"><LineChart className="h-3 w-3" /> {stats.icd} МКБ-кодов</span>
              <span className="chip">данные: {stats.period}</span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ReportButton region={region} horizon={6} topN={10} />
          <a
            href="https://ashyq.data.gov.kz/"
            target="_blank"
            rel="noreferrer"
            className="btn-ghost"
          >
            <Database className="h-3.5 w-3.5" />
            Источник
          </a>
          <a className="btn-ghost" href="#" rel="noreferrer">
            <Github className="h-3.5 w-3.5" />
            GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
