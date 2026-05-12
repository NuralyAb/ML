"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { fmtInt, heatColor, shortRegion } from "@/lib/format";

type Feature = {
  type: "Feature";
  properties: { name: string; name_en?: string; region?: string; matched?: boolean };
  geometry: GeoJSON.Geometry;
};

type FC = { type: "FeatureCollection"; features: Feature[] };

type Marker = {
  name: string;
  type: "city" | "region";
  lon: number;
  lat: number;
  label_anchor?: [number, number];
};

type DistrictRow = { region: string; district: string; total: number };

const WIDTH = 900;
const HEIGHT = 480;

export function KazakhstanMap({
  rows,
  districtRows,
  selected,
  onSelect,
  metricLabel = "Рецептов",
  showDistricts = false,
  zoomedRegion = null,
  view = "new",
}: {
  rows: { region: string; total: number }[];
  districtRows?: DistrictRow[];
  selected?: string | null;
  onSelect?: (r: string) => void;
  metricLabel?: string;
  /** When true, draw all ADM2 boundaries as a thin overlay over the country. */
  showDistricts?: boolean;
  /** When set, fit map to this region's bounds so its districts are readable. */
  zoomedRegion?: string | null;
  /** "new" — current 20-polygon layout; "old" — pre-2022 17-polygon layout. */
  view?: "old" | "new" | "auto";
}) {
  const [geo, setGeo] = useState<FC | null>(null);
  const [districts, setDistricts] = useState<FC | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [hover, setHover] = useState<{ name: string; sub?: string; value: number; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Pick the right region GeoJSON based on the view. The two files share the
  // same schema so the rest of the component is identical.
  useEffect(() => {
    const path = view === "old" ? "/kz_regions_pre2022.geojson" : "/kz_regions.geojson";
    fetch(path).then((r) => r.json()).then(setGeo).catch(() => null);
  }, [view]);

  useEffect(() => {
    fetch("/kz_districts.geojson").then((r) => r.json()).then(setDistricts).catch(() => setDistricts(null));
    fetch("/kz_markers.json").then((r) => r.json()).then(setMarkers).catch(() => setMarkers([]));
  }, []);

  const valueByRegion = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.region, r.total);
    return m;
  }, [rows]);

  const valueByDistrict = useMemo(() => {
    const m = new Map<string, number>();
    if (districtRows) for (const r of districtRows) m.set(`${r.region}|${r.district}`, r.total);
    return m;
  }, [districtRows]);

  const max = useMemo(() => Math.max(0, ...rows.map((r) => r.total)), [rows]);
  const norm = (v: number) => (max && v ? Math.log1p(v) / Math.log1p(max) : 0);

  // Pick what we fit to: country, or one region (zoom).
  const fitGeo = useMemo<FC | null>(() => {
    if (!geo) return null;
    if (!zoomedRegion) return geo;
    // Try region polygon first.
    const f = geo.features.find((x) => x.properties.name === zoomedRegion);
    if (f) return { type: "FeatureCollection", features: [f] } as FC;
    // No polygon for that region (e.g. Шымкент / Абай) — fit to the
    // districts that belong to it.
    if (districts) {
      const subs = districts.features.filter((d) => d.properties.region === zoomedRegion);
      if (subs.length) return { type: "FeatureCollection", features: subs } as FC;
    }
    return geo;
  }, [geo, districts, zoomedRegion]);

  const projection = useMemo(() => {
    if (!fitGeo) return null;
    return geoMercator().fitExtent(
      [[24, 24], [WIDTH - 24, HEIGHT - 24]],
      fitGeo as any
    );
  }, [fitGeo]);

  const path = useMemo(() => (projection ? geoPath(projection) : null), [projection]);

  // Project marker city points.
  const markerPts = useMemo(() => {
    if (!projection) return [];
    return markers.map((m) => {
      const p = projection([m.lon, m.lat]) ?? [0, 0];
      const lp = m.label_anchor ? projection(m.label_anchor) ?? p : p;
      return { ...m, x: p[0], y: p[1], lx: lp[0], ly: lp[1] };
    });
  }, [markers, projection]);

  // District features visible on this view.
  const visibleDistricts = useMemo<Feature[]>(() => {
    if (!districts) return [];
    if (zoomedRegion) {
      return districts.features.filter((d) => d.properties.region === zoomedRegion);
    }
    return showDistricts ? districts.features : [];
  }, [districts, showDistricts, zoomedRegion]);

  if (!geo || !path || !projection) {
    return (
      <div className="flex items-center justify-center h-[420px] text-ink-500 text-sm">
        Загрузка карты Казахстана…
      </div>
    );
  }

  const onMouseMoveTo = (e: React.MouseEvent, payload: { name: string; sub?: string; value: number }) => {
    const svg = (e.target as SVGElement).ownerSVGElement!;
    const rect = svg.getBoundingClientRect();
    const sx = WIDTH / rect.width;
    const sy = HEIGHT / rect.height;
    setHover({ ...payload, x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy });
  };

  return (
    <div className="relative w-full" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto select-none"
        style={{ filter: "drop-shadow(0 6px 24px rgba(15,23,42,0.06))" }}
      >
        <defs>
          <linearGradient id="mapBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#eef2f7" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="url(#mapBg)" rx="14" />

        {/* === Region polygons (or single region when zoomed) === */}
        {(zoomedRegion ? geo.features.filter((f) => f.properties.name === zoomedRegion) : geo.features).map((f) => {
          const name = f.properties.name;
          const v = valueByRegion.get(name) ?? 0;
          const t = norm(v);
          const isSel = selected === name;
          const d = path(f as any) || "";
          // When zoomed and rendering districts inside, fade the parent region.
          const fillOpacity = zoomedRegion && visibleDistricts.length ? 0.45 : 1;
          return (
            <path
              key={name}
              d={d}
              fill={heatColor(t)}
              fillOpacity={fillOpacity}
              stroke={isSel ? "#1e293b" : "#ffffff"}
              strokeWidth={isSel ? 2.5 : 1}
              style={{ cursor: onSelect ? "pointer" : "default", transition: "fill 0.25s" }}
              onClick={() => onSelect?.(name)}
              onMouseMove={(e) => onMouseMoveTo(e, { name, value: v })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {/* === District polygons === */}
        {visibleDistricts.map((d) => {
          const v = valueByDistrict.get(`${d.properties.region}|${d.properties.name}`) ?? 0;
          const t = norm(v);
          const dPath = path(d as any) || "";
          const labelable = !!d.properties.matched;
          return (
            <path
              key={`d-${d.properties.region}-${d.properties.name_en}`}
              d={dPath}
              fill={zoomedRegion ? heatColor(t) : "transparent"}
              fillOpacity={zoomedRegion ? 0.95 : 0}
              stroke={zoomedRegion ? "#ffffff" : "rgba(15,23,42,0.20)"}
              strokeWidth={zoomedRegion ? 1 : 0.6}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: zoomedRegion ? "pointer" : "default", transition: "fill 0.25s" }}
              onMouseMove={(e) =>
                onMouseMoveTo(e, {
                  name: d.properties.name,
                  sub: d.properties.region,
                  value: labelable ? v : NaN,
                })
              }
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {/* === Region labels (only when not zoomed) === */}
        {!zoomedRegion &&
          geo.features.map((f) => {
            const c = polygonCentroid(f.geometry);
            const [x, y] = projection!(c) ?? [0, 0];
            const v = valueByRegion.get(f.properties.name) ?? 0;
            const t = norm(v);
            const dark = t > 0.55;
            const isCity = f.properties.name === "Астана" || f.properties.name === "Алматы";
            if (isCity) return null;
            return (
              <text
                key={`lbl-${f.properties.name}`}
                x={x}
                y={y}
                textAnchor="middle"
                fontSize="10"
                fontWeight="600"
                fill={dark ? "#ffffff" : "#0f172a"}
                style={{ pointerEvents: "none", textShadow: dark ? "none" : "0 1px 2px rgba(255,255,255,0.6)" }}
              >
                {shortRegion(f.properties.name)}
              </text>
            );
          })}

        {/* === District labels (only when zoomed) === */}
        {zoomedRegion &&
          visibleDistricts.map((d) => {
            const c = polygonCentroid(d.geometry);
            const [x, y] = projection!(c) ?? [0, 0];
            const v = valueByDistrict.get(`${d.properties.region}|${d.properties.name}`) ?? 0;
            const t = norm(v);
            const dark = t > 0.55;
            const short = d.properties.name
              .replace(" район", "")
              .replace(" г.а.", " (г)");
            return (
              <text
                key={`dlbl-${d.properties.region}-${d.properties.name_en}`}
                x={x}
                y={y}
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="600"
                fill={dark ? "#ffffff" : "#0f172a"}
                style={{
                  pointerEvents: "none",
                  textShadow: dark ? "none" : "0 1px 2px rgba(255,255,255,0.7)",
                }}
              >
                {short}
              </text>
            );
          })}

        {/* === City markers (Astana / Almaty / Shymkent have tiny polygons; we add dots) === */}
        {!zoomedRegion &&
          (["Астана", "Алматы", "Шымкент"] as const).map((name) => {
            const f = geo.features.find((x) => x.properties.name === name);
            if (!f) return null;
            const c = polygonCentroid(f.geometry);
            const [x, y] = projection!(c) ?? [0, 0];
            const v = valueByRegion.get(name) ?? 0;
            const dx = name === "Астана" ? -9 : 9;
            const anchor = name === "Астана" ? "end" : "start";
            return (
              <g key={name} style={{ pointerEvents: "none" }}>
                <circle cx={x} cy={y} r={6} fill="#0ea5e9" stroke="#ffffff" strokeWidth={2} />
                <text
                  x={x + dx}
                  y={y + 4}
                  fontSize="11"
                  fontWeight="700"
                  fill="#0f172a"
                  textAnchor={anchor}
                  style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 3 }}
                >
                  {name} · {fmtInt(v)}
                </text>
              </g>
            );
          })}

        {/* === Manual markers (Shymkent, Abay) === */}
        {!zoomedRegion &&
          markerPts.map((m) => {
            const v = valueByRegion.get(m.name) ?? 0;
            const t = norm(v);
            const r = 6 + Math.sqrt(t) * 12;
            return (
              <g
                key={m.name}
                style={{ cursor: onSelect ? "pointer" : "default" }}
                onClick={() => onSelect?.(m.name)}
                onMouseMove={(e) => onMouseMoveTo(e, { name: m.name, value: v })}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={r}
                  fill={heatColor(t)}
                  stroke={selected === m.name ? "#1e293b" : "#ffffff"}
                  strokeWidth={selected === m.name ? 2.5 : 1.5}
                  opacity={0.92}
                />
                <text
                  x={m.lx}
                  y={m.ly + r + 12}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill="#0f172a"
                  style={{ pointerEvents: "none", textShadow: "0 1px 2px rgba(255,255,255,0.7)" }}
                >
                  {m.name === "Область Абай" ? "Абай" : m.name} · {fmtInt(v)}
                </text>
              </g>
            );
          })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-cardLg"
          style={{
            left: `calc(${(hover.x / WIDTH) * 100}% + 12px)`,
            top: `calc(${(hover.y / HEIGHT) * 100}% - 8px)`,
            transform: "translateY(-100%)",
          }}
        >
          <div className="font-semibold text-ink-900">{hover.name}</div>
          {hover.sub && <div className="text-[11px] text-ink-500">{hover.sub}</div>}
          <div className="text-ink-500">{metricLabel}</div>
          <div className="mt-0.5 font-bold text-ink-900">
            {Number.isNaN(hover.value) ? "нет данных" : fmtInt(hover.value)}
          </div>
        </div>
      )}

      <Legend max={max} label={metricLabel} />
    </div>
  );
}

function Legend({ max, label }: { max: number; label: string }) {
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
      <span>{label}:</span>
      <span>0</span>
      <div className="flex h-2 w-56 overflow-hidden rounded-full border border-line">
        {stops.map((t, i) => (
          <div key={i} className="flex-1" style={{ background: heatColor(t) }} />
        ))}
      </div>
      <span>{max ? fmtInt(max) : "—"}</span>
    </div>
  );
}

// --- helpers ----------------------------------------------------------------

function polygonCentroid(geom: GeoJSON.Geometry): [number, number] {
  if (geom.type === "Polygon") return ringCentroid(geom.coordinates[0]);
  if (geom.type === "MultiPolygon") {
    let best: [number, number] = [0, 0];
    let bestArea = -Infinity;
    for (const poly of geom.coordinates) {
      const ring = poly[0];
      const a = Math.abs(signedArea(ring));
      if (a > bestArea) {
        bestArea = a;
        best = ringCentroid(ring);
      }
    }
    return best;
  }
  return [0, 0];
}

function ringCentroid(ring: number[][]): [number, number] {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    twiceArea += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  if (twiceArea === 0) return ring[0] as [number, number];
  const area = twiceArea / 2;
  return [x / (6 * area), y / (6 * area)];
}

function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
