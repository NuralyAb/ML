"use client";
import { useCallback, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { IngestResponse, api } from "@/lib/api";
import { fmtInt, fmtMonth } from "@/lib/format";

const ACCEPT = ".xlsx,.parquet";
const MAX_MB = 100;

export function DataIngestPanel({ onIngested }: { onIngested?: (resp: IngestResponse) => void }) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(async (f: File) => {
    setError(null);
    setResult(null);
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`Файл слишком большой (${(f.size / 1e6).toFixed(1)} МБ, лимит ${MAX_MB} МБ).`);
      return;
    }
    if (!/\.(xlsx|parquet)$/i.test(f.name)) {
      setError("Поддерживаются только .xlsx и .parquet файлы.");
      return;
    }
    setBusy(true);
    try {
      const resp = await api.ingest(f);
      setResult(resp);
      onIngested?.(resp);
    } catch (e: any) {
      setError(e?.message ?? "Сбой загрузки");
    } finally {
      setBusy(false);
      setStagedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [onIngested]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setStagedFile(f);
    void submit(f);
  }, [submit]);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setStagedFile(f);
    void submit(f);
  }, [submit]);

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
          <FileUp className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">Загрузка свежих данных</h2>
        <span className="chip ml-auto">XLSX или Parquet · до {MAX_MB} МБ</span>
      </div>

      <div className="grid lg:grid-cols-12 gap-4">
        <div
          className={`lg:col-span-7 rounded-xl border-2 border-dashed p-6 transition cursor-pointer ${
            hover ? "border-brand-500 bg-brand-50/40" : "border-line bg-white hover:bg-ink-50/60"
          }`}
          onDragOver={(e) => { e.preventDefault(); setHover(true); }}
          onDragLeave={() => setHover(false)}
          onDrop={onDrop}
          onClick={() => !busy && fileInputRef.current?.click()}
          role="button"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={onPick}
            disabled={busy}
          />
          <div className="flex flex-col items-center justify-center text-center">
            {busy ? (
              <>
                <Loader2 className="h-8 w-8 text-brand-600 animate-spin mb-2" />
                <div className="text-sm font-medium text-ink-900">
                  Обрабатываю {stagedFile?.name ?? "файл"}…
                </div>
                <div className="text-xs text-ink-500 mt-1">
                  Парсинг + дедупликация + запись parquet может занять до минуты.
                </div>
              </>
            ) : (
              <>
                <Upload className="h-8 w-8 text-ink-500 mb-2" />
                <div className="text-sm font-medium text-ink-900">
                  Перетащите файл сюда или нажмите для выбора
                </div>
                <div className="text-xs text-ink-500 mt-1">
                  Принимаются: <code className="text-[11px]">.xlsx</code> (схема ЭРСБ) или
                  {" "}<code className="text-[11px]">.parquet</code> (схема monthly_panel)
                </div>
              </>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 min-h-[140px]">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm">
              <div className="flex items-center gap-1.5 text-rose-700 font-semibold mb-1">
                <AlertCircle className="h-4 w-4" /> Ошибка загрузки
              </div>
              <div className="text-rose-900 font-mono text-[11px] whitespace-pre-wrap">{error}</div>
            </div>
          )}
          {result && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
              <div className="flex items-center gap-1.5 text-emerald-700 font-semibold mb-2">
                <CheckCircle2 className="h-4 w-4" /> Готово за {result.processing_seconds.toFixed(1)} с
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-ink-700">
                <Stat label="Источник" value={`${result.source_kind} · ${(result.size_bytes / 1e6).toFixed(2)} МБ`} />
                <Stat label="Строк в файле" value={fmtInt(result.rows_in_upload)} />
                <Stat label="+ к панели" value={result.rows_added >= 0 ? `+${fmtInt(result.rows_added)}` : `${fmtInt(result.rows_added)} (дедуп)`} />
                <Stat label="Всего в панели" value={fmtInt(result.rows_after)} />
                <Stat
                  label="Последний месяц"
                  value={
                    result.last_month_before === result.last_month_after
                      ? fmtMonth(result.last_month_after ?? "")
                      : `${fmtMonth(result.last_month_before ?? "")} → ${fmtMonth(result.last_month_after ?? "")}`
                  }
                />
                <Stat label="Регионов в апроде" value={`${result.regions_in_upload.length}`} />
              </div>
              <details className="mt-3 text-[11px] text-ink-600">
                <summary className="cursor-pointer text-ink-700 font-semibold">Что обновилось ↑</summary>
                <div className="mt-1.5">{result.note}</div>
              </details>
            </div>
          )}
          {!error && !result && !busy && (
            <div className="rounded-xl border border-line bg-ink-50/40 p-4 text-xs text-ink-600 h-full">
              <div className="font-semibold text-ink-800 mb-1">Что происходит при загрузке</div>
              <ul className="list-disc pl-4 space-y-1">
                <li>Файл валидируется по схеме (xlsx сжимается до monthly grid тем же кодом, что ETL).</li>
                <li>Новые строки дедуплицируются с текущим <code>monthly_panel.parquet</code>.</li>
                <li>KPI, карта, heatmap, top-diseases обновятся <b>сразу</b>.</li>
                <li>Прогноз и аномалии работают на снапшоте обучения — обновляются офлайн-пайплайном.</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-line px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">{label}</div>
      <div className="font-bold text-ink-900">{value}</div>
    </div>
  );
}
