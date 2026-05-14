"use client";
import { useEffect, useState } from "react";
import { FileCheck2, AlertTriangle, ShieldCheck, AlertOctagon } from "lucide-react";
import { api, ModelCard } from "@/lib/api";
import { fmtInt, fmtNum } from "@/lib/format";

/**
 * Machine-readable Model Card following the Google "Model Cards for Model
 * Reporting" pattern. The card lives in the backend (/api/model-card),
 * pulls live numbers from metadata.json, and is presented here as the
 * top-level governance / transparency document for the system.
 */
export function ModelCardPanel() {
  const [card, setCard] = useState<ModelCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.modelCard().then(setCard).catch((e) => setError(e?.message ?? "request failed"));
  }, []);

  if (error) {
    return (
      <div className="panel p-5 text-sm text-rose-700">
        <AlertTriangle className="inline h-4 w-4 mr-1" />
        Failed to load model card: {error}
      </div>
    );
  }
  if (!card) {
    return <div className="panel p-5 text-sm text-ink-500">Loading model card…</div>;
  }

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
          <FileCheck2 className="h-4 w-4" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink-900">
          Model Card — transparency &amp; governance
        </h2>
        <span className="chip ml-auto">Live from /api/model-card</span>
      </div>

      {/* Header block */}
      <div className="rounded-xl border border-line bg-ink-50/40 p-3 mb-4 text-sm">
        <div className="font-display text-lg font-bold text-ink-900">{card.name}</div>
        <div className="mt-1 text-ink-700">{card.purpose}</div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-ink-500">
          <div><span className="uppercase tracking-wider">Version</span><br /><span className="text-ink-700 font-mono">{card.version}</span></div>
          <div><span className="uppercase tracking-wider">Owner</span><br /><span className="text-ink-700">{card.owner}</span></div>
          <div><span className="uppercase tracking-wider">Data license</span><br /><span className="text-ink-700">{card.license_data}</span></div>
          <div><span className="uppercase tracking-wider">Code license</span><br /><span className="text-ink-700">{card.license_code}</span></div>
        </div>
      </div>

      {/* Intended use vs out-of-scope */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
          <div className="flex items-center gap-1 text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">
            <ShieldCheck className="h-3.5 w-3.5" />
            Intended users
          </div>
          <ul className="space-y-1 text-sm text-ink-700">
            {card.intended_users.map((u, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-emerald-600">•</span>{u}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-3">
          <div className="flex items-center gap-1 text-xs font-bold text-rose-700 uppercase tracking-wider mb-2">
            <AlertOctagon className="h-3.5 w-3.5" />
            Out-of-scope uses
          </div>
          <ul className="space-y-1 text-sm text-ink-700">
            {card.out_of_scope_uses.map((u, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-rose-600">•</span>{u}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Training data + model */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-line p-3">
          <div className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-2">
            Training data
          </div>
          <table className="w-full text-xs">
            <tbody>
              <Row label="Source"      value={card.training_data.source} />
              <Row label="Family"      value={card.training_data.dataset_family} mono />
              <Row label="Regions"     value={fmtInt(card.training_data.regions)} />
              <Row label="Districts"   value={fmtInt(card.training_data.districts)} />
              <Row label="ICD codes"   value={fmtInt(card.training_data.icd_codes_observed)} />
              <Row label="Series"      value={fmtInt(card.training_data.series)} />
              <Row label="Panel rows"  value={fmtInt(card.training_data.feature_panel_rows)} />
              <Row label="Period"      value={`${card.training_data.period_start} → ${card.training_data.period_end_full_coverage}`} />
              <Row label="License"     value={card.training_data.license} />
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-2">
            Model
          </div>
          <table className="w-full text-xs">
            <tbody>
              <Row label="Family"  value={card.model.family} />
              <Row label="Target"  value={card.model.target_transform} mono />
              <Row label="Features" value={fmtInt(card.model.n_features)} />
              <Row label="Training time" value={`${card.model.training_seconds} s`} />
              <Row label="Validation" value={card.model.validation_strategy} />
            </tbody>
          </table>
          <div className="text-[10px] uppercase tracking-wider text-ink-500 mt-2 mb-1">
            Feature groups
          </div>
          <ul className="text-xs text-ink-700 space-y-0.5">
            {card.model.feature_groups.map((g: string, i: number) => (
              <li key={i} className="flex gap-1">
                <span className="text-ink-400">·</span>{g}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Performance */}
      <div className="rounded-xl border border-line p-3 mb-4">
        <div className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-2">
          Performance (per-series 6-month hold-out)
        </div>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-2">
          <Metric label="MAE"   value={fmtNum(card.performance.MAE, 2)} />
          <Metric label="RMSE"  value={fmtNum(card.performance.RMSE, 2)} />
          <Metric label="MAPE"  value={`${fmtNum(card.performance.MAPE, 1)}%`} />
          <Metric label="sMAPE" value={`${fmtNum(card.performance.sMAPE, 1)}%`} />
          <Metric label="R²"    value={fmtNum(card.performance.R2, 4)} />
        </div>
        <div className="text-xs text-ink-700">
          {card.performance.vs_baselines}{" "}
          <span className="text-ink-500">
            ({fmtInt(card.performance.holdout_rows)} test rows.)
          </span>
        </div>
      </div>

      {/* Interpretability */}
      <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 mb-4">
        <div className="text-xs font-bold text-violet-700 uppercase tracking-wider mb-2">
          Interpretability — how to verify any forecast
        </div>
        <div className="text-sm text-ink-700 space-y-1">
          <div><b>Per-prediction:</b> {card.interpretability.per_prediction}</div>
          <div><b>Global:</b> {card.interpretability.global}</div>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-violet-700 mt-2 mb-1">
          Dashboard widgets exposing the model's behaviour
        </div>
        <ul className="text-xs text-ink-700 space-y-0.5">
          {card.interpretability.dashboard_widgets.map((w, i) => (
            <li key={i} className="flex gap-1">
              <span className="text-violet-500">·</span>{w}
            </li>
          ))}
        </ul>
      </div>

      {/* Limitations + ethics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
          <div className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-2">
            Known limitations
          </div>
          <ul className="space-y-1.5 text-xs text-ink-700">
            {card.limitations.map((u, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-amber-600">•</span>{u}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-2">
            Ethical considerations
          </div>
          <ul className="space-y-1.5 text-xs text-ink-700">
            {card.ethical_considerations.map((u, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-ink-500">•</span>{u}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Disclaimers */}
      <div className="rounded-xl border border-line p-3 text-xs text-ink-700 space-y-2">
        <div><b>Data quality.</b> {card.data_quality_disclaimer}</div>
        <div><b>Audit trail.</b> {card.audit_trail}</div>
      </div>
    </div>
  );
}


function Row({ label, value, mono = false }: { label: string; value: any; mono?: boolean }) {
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-1 pr-3 text-ink-500 align-top">{label}</td>
      <td className={`py-1 ${mono ? "font-mono" : ""} text-ink-900`}>{String(value)}</td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-line px-2 py-1.5 text-center">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">{label}</div>
      <div className="font-bold text-ink-900">{value}</div>
    </div>
  );
}
