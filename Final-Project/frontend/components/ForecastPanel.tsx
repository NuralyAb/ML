"use client";
import { useEffect, useMemo, useState } from "react";
import { Sparkles, TrendingUp, AlertTriangle } from "lucide-react";
import { api, ForecastResponse, IcdRow, RegionRow } from "@/lib/api";
import { Combobox } from "./Combobox";
import { HistoricalChart, HistPoint } from "./HistoricalChart";
import { fmtInt, fmtMonth, fmtPct } from "@/lib/format";

export function ForecastPanel({
  regions,
  initialRegion,
  initialIcd,
}: {
  regions: RegionRow[];
  initialRegion?: string;
  initialIcd?: string;
}) {
  const [region, setRegion] = useState<RegionRow | null>(
    initialRegion ? regions.find((r) => r.region === initialRegion) ?? null : regions[0] ?? null
  );
  const [icdList, setIcdList] = useState<IcdRow[]>([]);
  const [icd, setIcd] = useState<IcdRow | null>(null);
  const [horizon, setHorizon] = useState(3);
  const [resp, setResp] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!region) return;
    setIcd(null);
    api.icd(region.region, undefined, 200).then((rs) => {
      setIcdList(rs);
      const target = initialIcd ? rs.find((r) => r.icdid === initialIcd) ?? rs[0] : rs[0];
      setIcd(target ?? null);
    });
  }, [region, initialIcd]);

  async function run() {
    if (!region || !icd) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.forecast(region.region, icd.icdid, horizon);
      setResp(r);
    } catch (e: any) {
      setError(e.message ?? "Ошибка запроса");
    } finally {
      setLoading(false);
    }
  }

  // Auto-run on selection change.
  useEffect(() => {
    if (region && icd) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, icd, horizon]);

  const chartData: HistPoint[] = useMemo(() => {
    if (!resp) return [];
    const pts: HistPoint[] = resp.history.map((h) => ({ month: h.year_month, actual: h.actual }));
    if (resp.forecast.length) {
      const lastActual = pts[pts.length - 1];
      pts.push({ month: lastActual.month, predicted: lastActual.actual });
      for (const f of resp.forecast) {
        pts.push({ month: f.year_month, predicted: f.predicted });
      }
    }
    return pts;
  }, [resp]);

  const splitAt = resp?.history.length ? resp.history[resp.history.length - 1].year_month : undefined;

  const stats = useMemo(() => {
    if (!resp) return null;
    const recent = resp.history.slice(-12);
    const baseAvg = recent.reduce((s, h) => s + h.actual, 0) / Math.max(recent.length, 1);
    const fSum = resp.forecast.reduce((s, f) => s + f.predicted, 0);
    const fAvg = fSum / Math.max(resp.forecast.length, 1);
    const delta = baseAvg > 0 ? (fAvg / baseAvg - 1) * 100 : 0;
    return { baseAvg, fSum, fAvg, delta };
  }, [resp]);

  return (
    <div className="panel p-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-100 text-amber-700">
          <Sparkles className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">Прогноз количества рецептов</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="label">Регион</label>
          <Combobox
            value={region}
            onChange={setRegion}
            items={regions}
            itemKey={(it) => it.region}
            itemLabel={(it) => it.region}
            itemSubtitle={(it) => `${fmtInt(it.total_recipes)} рецептов · ${it.n_icd} МКБ`}
            placeholder="Выберите регион"
          />
        </div>
        <div>
          <label className="label">Диагноз (МКБ-10)</label>
          <Combobox
            value={icd}
            onChange={setIcd}
            items={icdList}
            itemKey={(it) => it.icdid}
            itemLabel={(it) => `${it.icdid} · ${it.nozology ?? ""}`}
            itemSubtitle={(it) => `всего ${fmtInt(it.total)} рецептов`}
            placeholder="Выберите код"
          />
        </div>
        <div>
          <label className="label">Горизонт прогноза</label>
          <div className="flex gap-1">
            {[1, 3, 6, 12].map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition border ${
                  horizon === h
                    ? "bg-brand-600 text-white border-brand-600 shadow-glow"
                    : "bg-white text-ink-700 border-line hover:bg-ink-50"
                }`}
              >
                {h} мес.
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={run} className="btn-primary" disabled={!region || !icd || loading}>
          <TrendingUp className="h-4 w-4" /> {loading ? "Считаю…" : "Спрогнозировать"}
        </button>
        {error && (
          <span className="chip-danger">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </span>
        )}
        {resp && stats && (
          <>
            <span className="chip">
              ср. за 12 мес.: <b className="ml-1 text-ink-900">{fmtInt(stats.baseAvg)}</b>
            </span>
            <span className="chip">
              прогноз ср/мес: <b className="ml-1 text-ink-900">{fmtInt(stats.fAvg)}</b>
            </span>
            <span className={stats.delta >= 0 ? "chip-success" : "chip-danger"}>
              динамика: {stats.delta >= 0 ? "+" : ""}{fmtPct(stats.delta)}
            </span>
            <span className="chip">сумма прогноза: <b className="ml-1 text-ink-900">{fmtInt(stats.fSum)}</b></span>
          </>
        )}
      </div>

      <div className="mt-5">
        <HistoricalChart
          data={chartData}
          splitAt={splitAt}
          title={resp ? `${resp.region} · ${resp.icd} — ${resp.nozology}` : ""}
        />
      </div>

      {resp && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <ForecastTable resp={resp} />
          <DecisionPanel resp={resp} />
        </div>
      )}
    </div>
  );
}

function ForecastTable({ resp }: { resp: ForecastResponse }) {
  return (
    <div className="panel-soft p-4">
      <div className="text-sm text-ink-800 mb-2 font-semibold">Прогноз по месяцам</div>
      <table className="w-full text-sm">
        <thead className="text-ink-500 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left pb-2">Месяц</th>
            <th className="text-right pb-2">Прогноз рецептов</th>
          </tr>
        </thead>
        <tbody>
          {resp.forecast.map((f) => (
            <tr key={f.year_month} className="border-t border-line">
              <td className="py-1.5 text-ink-900">{fmtMonth(f.year_month)}</td>
              <td className="py-1.5 text-right font-bold text-ink-900">{fmtInt(f.predicted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionPanel({ resp }: { resp: ForecastResponse }) {
  const last12 = resp.history.slice(-12);
  const baseAvg = last12.reduce((s, h) => s + h.actual, 0) / Math.max(last12.length, 1);
  const fAvg = resp.forecast.reduce((s, f) => s + f.predicted, 0) / Math.max(resp.forecast.length, 1);
  const delta = baseAvg > 0 ? (fAvg / baseAvg - 1) * 100 : 0;
  const tier =
    Math.abs(delta) < 5 ? "stable" : delta > 15 ? "surge" : delta > 5 ? "growth" : delta < -15 ? "drop" : "decline";

  const map = {
    stable:  { color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200",
               title: "Спрос стабилен", body: "Сохранить текущие объёмы закупки и распределения кадров." },
    growth:  { color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200",
               title: "Умеренный рост", body: "Увеличить страховой запас препаратов на 10–20% и проверить пропускную способность поликлиник." },
    surge:   { color: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200",
               title: "Резкий рост спроса", body: "Срочно нарастить запасы, проинформировать центр закупок и привлечь резервный медперсонал." },
    decline: { color: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200",
               title: "Снижение спроса", body: "Сократить новые закупки, перераспределить запасы между районами." },
    drop:    { color: "text-fuchsia-700", bg: "bg-fuchsia-50", border: "border-fuchsia-200",
               title: "Резкий спад", body: "Аудит причин: возможны сбои регистрации или снижение заболеваемости. Перенаправить ресурсы." },
  } as const;

  const cfg = map[tier];

  return (
    <div className={`rounded-xl border p-4 ${cfg.border} ${cfg.bg}`}>
      <div className={`text-xs uppercase tracking-wider font-bold ${cfg.color} mb-1`}>Рекомендация системы</div>
      <div className="font-display text-lg font-bold text-ink-900 mb-1">{cfg.title}</div>
      <div className="text-sm text-ink-700">{cfg.body}</div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Tile label="База (12 мес.)" value={fmtInt(baseAvg)} />
        <Tile label="Прогноз (среднее)" value={fmtInt(fAvg)} />
        <Tile label="Δ" value={`${delta >= 0 ? "+" : ""}${fmtPct(delta)}`} />
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-line px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">{label}</div>
      <div className="font-bold text-ink-900">{value}</div>
    </div>
  );
}
