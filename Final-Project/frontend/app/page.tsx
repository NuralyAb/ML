"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Calendar, Database, Globe2, LineChart, Map, Pill, Stethoscope,
} from "lucide-react";

import { Topbar } from "@/components/Topbar";
import { KpiCard } from "@/components/KpiCard";
import { RegionBars } from "@/components/RegionBars";
import { Heatmap } from "@/components/Heatmap";
import { TopDiseases } from "@/components/TopDiseases";
import { ForecastPanel } from "@/components/ForecastPanel";
import { ModelMetricsCard } from "@/components/ModelMetricsCard";
import { EvalScatter } from "@/components/EvalScatter";
import { AnomaliesPanel } from "@/components/AnomaliesPanel";
import { DataIngestPanel } from "@/components/DataIngestPanel";
import { GeoHeatmap } from "@/components/GeoHeatmap";
import { HistoricalChart } from "@/components/HistoricalChart";
import { SeasonalityPanel } from "@/components/SeasonalityPanel";
import { ExplainabilityPanel } from "@/components/ExplainabilityPanel";
import { ModelCardPanel } from "@/components/ModelCardPanel";
import { fmtInt, fmtMonth } from "@/lib/format";

import type { GlobalStats, HeatmapCell, RegionRow, RegionTotal } from "@/lib/api";
import { api } from "@/lib/api";

export default function Page() {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [selectedIcd, setSelectedIcd] = useState<string | null>(null);
  const [overview, setOverview] = useState<{ month: string; total: number }[]>([]);
  const [regionTotals, setRegionTotals] = useState<RegionTotal[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  // Bumped after a successful /api/ingest so all panel-derived data refetches.
  const [dataVersion, setDataVersion] = useState(0);

  // Initial fetch (and refetch on data-version bump after ingest).
  useEffect(() => {
    Promise.all([
      api.globalStats().catch(() => null),
      api.regions().catch(() => []),
      api.heatmap({ months: 24 }).catch(() => []),
      api.regionSummary(undefined, { months: 12 }).catch(() => []),
    ]).then(([s, rs, hm, rt]) => {
      setStats(s);
      setRegions(rs);
      setHeatmap(hm);
      setRegionTotals(rt);
      if (rs.length && !selectedRegion) setSelectedRegion(rs[0].region);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  // Region-dependent timeseries.
  useEffect(() => {
    api.timeseriesOverview(selectedRegion ?? undefined).then(setOverview).catch(() => setOverview([]));
  }, [selectedRegion, dataVersion]);

  const totalLast = useMemo(() => {
    if (!overview.length) return 0;
    return overview.slice(-12).reduce((s, r) => s + r.total, 0);
  }, [overview]);

  const peak = useMemo(() => {
    if (!overview.length) return null;
    return overview.reduce((m, r) => (r.total > m.total ? r : m), overview[0]);
  }, [overview]);

  const overviewData = overview.map((p) => ({ month: p.month, actual: p.total }));

  return (
    <div>
      <Topbar
        stats={
          stats
            ? {
                regions: stats.regions,
                icd: stats.icd_codes,
                period: `${stats.period_start ?? ""} → ${stats.period_end ?? ""}`,
              }
            : undefined
        }
        region={selectedRegion}
      />

      <main className="mx-auto max-w-[1400px] px-6 pb-16 pt-8">
        {/* Hero */}
        <section className="grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-8 panel relative overflow-hidden p-7 bg-hero-soft">
            <div className="text-xs uppercase tracking-wider text-brand-700 font-bold">
              ML System Design · Final Project
            </div>
            <h1 className="mt-3 font-display text-3xl md:text-5xl font-bold leading-tight text-ink-900">
              Прогноз выписки рецептов <span className="grad-text">по регионам РК</span>
            </h1>
            <p className="mt-3 max-w-2xl text-ink-600">
              Система помогает Министерству здравоохранения принимать управленческие решения:
              закупать препараты, распределять кадры и проводить аудит поликлиник на основе
              ML-прогноза количества рецептов на ближайшие месяцы по диагнозам и регионам.
            </p>

            <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard
                label="Регионов"
                value={fmtInt(stats?.regions ?? 0)}
                hint="включая Астану, Алматы и Шымкент"
                icon={<Globe2 className="h-5 w-5" />}
              />
              <KpiCard
                label="Районов"
                value={fmtInt(stats?.districts ?? 0)}
                hint="по полю raion_med_organ"
                icon={<Map className="h-5 w-5" />}
                accent="accent"
              />
              <KpiCard
                label="МКБ-10 кодов"
                value={fmtInt(stats?.icd_codes ?? 0)}
                hint="наблюдаемых в данных"
                icon={<Stethoscope className="h-5 w-5" />}
                accent="warning"
              />
              <KpiCard
                label="Всего рецептов"
                value={fmtInt(stats?.total_recipes ?? 0)}
                hint={
                  stats
                    ? `${stats.period_start ?? ""} → ${stats.period_end ?? ""}`
                    : ""
                }
                icon={<Pill className="h-5 w-5" />}
                accent="success"
              />
            </div>
          </div>

          <div className="lg:col-span-4 panel p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-100 text-cyan-700">
                <LineChart className="h-4 w-4" />
              </div>
              <h2 className="font-display text-base font-semibold text-ink-900">Динамика рецептов</h2>
              <span className="chip ml-auto truncate max-w-[60%]">
                {selectedRegion ?? "Все регионы"}
              </span>
            </div>
            <HistoricalChart data={overviewData} />
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-white border border-line px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                  сумма за 12 мес.
                </div>
                <div className="font-bold text-ink-900">{fmtInt(totalLast)}</div>
              </div>
              <div className="rounded-lg bg-white border border-line px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                  пик
                </div>
                <div className="font-bold text-ink-900 flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-cyan-600" />
                  {peak ? fmtMonth(peak.month) : "—"}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Data ingest (xlsx / parquet → monthly_panel) */}
        <section className="mt-6">
          <DataIngestPanel onIngested={() => setDataVersion((v) => v + 1)} />
        </section>

        {/* Geographic heatmap of Kazakhstan */}
        <section className="mt-6">
          <GeoHeatmap
            selectedRegion={selectedRegion}
            onSelectRegion={(r) => setSelectedRegion(r || null)}
          />
        </section>

        {/* Region bars */}
        <section className="mt-6 panel p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-100 text-cyan-700">
              <Database className="h-4 w-4" />
            </div>
            <h2 className="font-display text-base font-semibold text-ink-900">
              Регионы · 12 мес.
            </h2>
          </div>
          <RegionBars rows={regionTotals} selected={selectedRegion} onSelect={setSelectedRegion} />
        </section>

        {/* Forecast */}
        <section className="mt-6">
          {regions.length > 0 && (
            <ForecastPanel
              regions={regions}
              initialRegion={selectedRegion ?? undefined}
              initialIcd={selectedIcd ?? undefined}
            />
          )}
        </section>

        {/* Disease seasonality (monthly profile across years) */}
        <section className="mt-6">
          {regions.length > 0 && (
            <SeasonalityPanel
              regions={regions}
              initialRegion={selectedRegion}
              initialIcd={selectedIcd}
            />
          )}
        </section>

        {/* Per-prediction explainability (TreeSHAP) */}
        <section className="mt-6">
          {regions.length > 0 && (
            <ExplainabilityPanel
              regions={regions}
              initialRegion={selectedRegion}
              initialIcd={selectedIcd}
            />
          )}
        </section>

        {/* Model Card — governance & transparency block */}
        <section className="mt-6">
          <ModelCardPanel />
        </section>

        {/* Disease heatmap + top diseases */}
        <section className="mt-6 grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-8 panel p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-100 text-amber-700">
                <Stethoscope className="h-4 w-4" />
              </div>
              <h2 className="font-display text-base font-semibold text-ink-900">
                Тепловая карта: регион × класс МКБ
              </h2>
            </div>
            <Heatmap cells={heatmap} />
          </div>
          <div className="lg:col-span-4">
            <TopDiseases region={selectedRegion} onPick={setSelectedIcd} />
          </div>
        </section>

        {/* Model metrics + scatter */}
        <section className="mt-6 grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-7"><ModelMetricsCard /></div>
          <div className="lg:col-span-5"><EvalScatter /></div>
        </section>

        {/* Anomaly audit panel */}
        <section className="mt-6">
          <AnomaliesPanel />
        </section>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
          <div>
            Источник данных:{" "}
            <a href="https://ashyq.data.gov.kz" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
              ashyq.data.gov.kz
            </a>{" "}
            — ЭРСБ МЗ РК · ISLO_MEDICALHISTORYOFCITIZENS
          </div>
          <div>Модель: LightGBM · Обновление: офлайн (кварт. ETL → train → deploy)</div>
        </footer>
      </main>
    </div>
  );
}
