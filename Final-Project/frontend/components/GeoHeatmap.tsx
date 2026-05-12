"use client";
import { useEffect, useMemo, useState } from "react";
import { Map as MapIcon, Stethoscope, X, ZoomIn, ZoomOut, Layers } from "lucide-react";
import { api, IcdRow, Period, RegionTotal, DistrictSummaryRow, DataRange, viewFromPeriod, RegionView } from "@/lib/api";
import { Combobox } from "./Combobox";
import { KazakhstanMap } from "./KazakhstanMap";
import { PeriodPicker } from "./PeriodPicker";
import { fmtInt, fmtMonth } from "@/lib/format";

const CHAPTERS = [
  ["", "Все классы"],
  ["I", "I — Кровообращение"],
  ["E", "E — Эндокринные"],
  ["J", "J — Дыхательная"],
  ["N", "N — Мочеполовая"],
  ["K", "K — Пищеварение"],
  ["G", "G — Нервная система"],
  ["M", "M — Костно-мышечная"],
  ["F", "F — Психические"],
  ["C", "C — Новообразования"],
  ["A", "A — Инфекционные"],
] as const;

type Mode = "chapter" | "icd";

export function GeoHeatmap({
  selectedRegion,
  onSelectRegion,
}: {
  selectedRegion: string | null;
  onSelectRegion: (r: string) => void;
}) {
  const [period, setPeriod] = useState<Period>({ months: 12 });
  const [dataRange, setDataRange] = useState<DataRange | null>(null);
  const [mode, setMode] = useState<Mode>("chapter");
  const [chapter, setChapter] = useState<string>(""); // "" = all
  const [icdQuery, setIcdQuery] = useState<string>("");
  const [icdList, setIcdList] = useState<IcdRow[]>([]);
  const [icd, setIcd] = useState<IcdRow | null>(null);
  const [regionRows, setRegionRows] = useState<RegionTotal[]>([]);
  const [districtRows, setDistrictRows] = useState<DistrictSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDistricts, setShowDistricts] = useState(true);  // overlay borders by default
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    api.dataRange().then(setDataRange).catch(() => null);
  }, []);

  // ICD list when in icd mode
  useEffect(() => {
    if (mode !== "icd") return;
    api.icd(undefined, icdQuery || undefined, 80).then((rs) => {
      setIcdList(rs);
      if (!icd && rs.length) setIcd(rs[0]);
    });
  }, [mode, icdQuery]); // eslint-disable-line

  // The reform of 8 June 2022 created Abay/Zhetysu/Ulytau. We pick which
  // administrative layout the map should use based on the period being asked
  // for; the same `view` is forwarded to the backend so totals collapse Abay
  // back into East Kazakhstan when needed.
  const view: RegionView = useMemo(
    () => viewFromPeriod(period, dataRange?.max ?? null),
    [period, dataRange]
  );

  // Re-fetch totals when filter / period changes.
  useEffect(() => {
    setLoading(true);
    const filterIcd = mode === "icd" ? icd?.icdid : undefined;
    const filterChapter = mode === "chapter" && chapter ? chapter : undefined;

    const reqRegion = api
      .regionSummary({ icd: filterIcd, chapter: filterChapter, period, view })
      .catch(() => [] as RegionTotal[]);
    const reqDistricts = api
      .districtSummary({ icd: filterIcd, chapter: filterChapter, period, view })
      .catch(() => [] as DistrictSummaryRow[]);

    Promise.all([reqRegion, reqDistricts]).then(([regs, dists]) => {
      setRegionRows(regs);
      setDistrictRows(dists);
      setLoading(false);
    });
  }, [mode, chapter, icd, period, view]);

  const metricLabel = useMemo(() => {
    const periodLabel = period.start || period.end
      ? `${fmtMonth(period.start || dataRange?.min || "")} – ${fmtMonth(period.end || dataRange?.max || "")}`
      : period.months !== undefined
        ? `за ${period.months} мес.`
        : "за весь период";
    if (mode === "icd" && icd) return `${icd.icdid} · рецептов ${periodLabel}`;
    if (mode === "chapter" && chapter) {
      const lbl = CHAPTERS.find(([k]) => k === chapter)?.[1] ?? chapter;
      return `${lbl} · ${periodLabel}`;
    }
    return `Все рецепты ${periodLabel}`;
  }, [mode, chapter, icd, period, dataRange]);

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-100 text-brand-700">
          <MapIcon className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">
          Гео-карта Казахстана
        </h2>
        {selectedRegion && (
          <span className="chip-brand">
            {selectedRegion}
            <button onClick={() => { onSelectRegion(""); if (zoomed === selectedRegion) setZoomed(null); }} className="ml-1 opacity-70 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {!zoomed && (
            <button
              onClick={() => setShowDistricts((v) => !v)}
              title="Показывать границы районов поверх регионов"
              className={`btn-ghost text-xs ${showDistricts ? "bg-ink-50" : ""}`}
            >
              <Layers className="h-3.5 w-3.5" />
              Районы {showDistricts ? "вкл" : "выкл"}
            </button>
          )}
          {selectedRegion && !zoomed && (
            <button onClick={() => setZoomed(selectedRegion)} className="btn-ghost text-xs">
              <ZoomIn className="h-3.5 w-3.5" />
              Перейти к районам
            </button>
          )}
          {zoomed && (
            <button onClick={() => setZoomed(null)} className="btn-ghost text-xs">
              <ZoomOut className="h-3.5 w-3.5" />
              Вся страна
            </button>
          )}
        </div>
      </div>

      {/* Controls row */}
      <div className="grid gap-4 md:grid-cols-2 mb-4">
        <PeriodPicker value={period} onChange={setPeriod} range={dataRange} />

        <div>
          <label className="label">Группировка</label>
          <div className="flex gap-1">
            <button
              onClick={() => setMode("chapter")}
              className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium border transition ${
                mode === "chapter"
                  ? "bg-brand-600 text-white border-brand-600 shadow-glow"
                  : "bg-white text-ink-700 border-line hover:bg-ink-50"
              }`}
            >
              По классу МКБ
            </button>
            <button
              onClick={() => setMode("icd")}
              className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium border transition ${
                mode === "icd"
                  ? "bg-brand-600 text-white border-brand-600 shadow-glow"
                  : "bg-white text-ink-700 border-line hover:bg-ink-50"
              }`}
            >
              По коду МКБ
            </button>
          </div>
        </div>
      </div>

      {mode === "chapter" ? (
        <div className="mb-4">
          <label className="label">Класс заболеваний</label>
          <div className="flex flex-wrap gap-1.5">
            {CHAPTERS.map(([k, label]) => (
              <button
                key={k || "all"}
                onClick={() => setChapter(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
                  chapter === k
                    ? "bg-amber-500 text-white border-amber-500"
                    : "bg-white text-ink-700 border-line hover:bg-ink-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">Поиск по коду / названию</label>
            <input
              value={icdQuery}
              onChange={(e) => setIcdQuery(e.target.value)}
              placeholder="например I20 или диабет"
              className="input"
            />
          </div>
          <div>
            <label className="label">Диагноз</label>
            <Combobox
              value={icd}
              onChange={setIcd}
              items={icdList}
              itemKey={(it) => it.icdid}
              itemLabel={(it) => `${it.icdid} · ${it.nozology ?? ""}`}
              itemSubtitle={(it) => `${fmtInt(it.total)} рецептов всего`}
              placeholder="Выберите код"
            />
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-white overflow-hidden">
        <KazakhstanMap
          rows={zoomed ? districtRows.filter((d) => d.region === zoomed).map((d) => ({ region: d.district, total: d.total })) : regionRows}
          districtRows={districtRows}
          selected={zoomed ? null : selectedRegion}
          onSelect={(r) => onSelectRegion(r)}
          metricLabel={metricLabel}
          showDistricts={showDistricts}
          zoomedRegion={zoomed}
          view={view}
        />
      </div>

      <div className="mt-3 flex items-start gap-2 text-[11px] text-ink-500">
        <Stethoscope className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
        <span>
          Цвет регионов отражает количество рецептов{" "}
          {mode === "icd" && icd ? `по диагнозу ${icd.icdid}` : (mode === "chapter" && chapter ? `класса ${chapter}` : "всего")}{" "}
          {metricLabel.toLowerCase().includes("за") ? "" : "за выбранный период"}.
          {view === "old" && (
            <> Период выбран до реформы 8 июня 2022 — карта в <b>старой</b> разбивке (14 областей + 3 города), Абай слит в ВКО.</>
          )}
          {view === "new" && (
            <> Карта в <b>текущей</b> разбивке (17 областей + 3 города), включая Абай, Жетысу и Улытау.</>
          )}
          {!zoomed && " Тонкая штриховка — границы районов."}
          {zoomed && " Внутри региона показаны районы и их данные."}
          {" "}Клик по региону выбирает его как фильтр.
        </span>
        {loading && <span className="ml-auto chip">Обновление…</span>}
      </div>
    </div>
  );
}
