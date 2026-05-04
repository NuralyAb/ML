export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(n);
}

export function fmtMonth(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString("ru-RU", { year: "numeric", month: "short" });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

// ICD chapter -> human label (subset relevant for prescriptions).
export const ICD_CHAPTERS: Record<string, string> = {
  A: "Инфекционные (A)",
  B: "Инфекционные (B)",
  C: "Новообразования (C)",
  D: "Кровь / новообр. (D)",
  E: "Эндокринные (E)",
  F: "Психические (F)",
  G: "Нервная система (G)",
  H: "Глаз / ухо (H)",
  I: "Кровообращение (I)",
  J: "Дыхательная (J)",
  K: "Пищеварение (K)",
  L: "Кожа (L)",
  M: "Костно-мыш. (M)",
  N: "Мочеполовая (N)",
  O: "Беременность (O)",
  P: "Перинатальные (P)",
  Q: "Врожденные (Q)",
  R: "Симптомы (R)",
  S: "Травмы (S)",
  T: "Травмы (T)",
  U: "Спец. (U)",
  V: "Внеш. причины (V)",
  W: "Внеш. причины (W)",
  X: "Внеш. причины (X)",
  Y: "Внеш. причины (Y)",
  Z: "Факторы здоровья (Z)",
};

/**
 * Light-theme friendly heatmap palette: pale slate → soft blue → cyan → amber → coral.
 * t in [0, 1].
 */
export function heatColor(t: number): string {
  const stops: [number, string][] = [
    [0.0,  "#f4f7fb"],
    [0.15, "#dbe7fb"],
    [0.35, "#a8c8f6"],
    [0.55, "#67a8e8"],
    [0.75, "#fdd07a"],
    [0.9,  "#f3895a"],
    [1.0,  "#e4565d"],
  ];
  const v = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (v - t0) / (t1 - t0);
      return mix(c0, c1, k);
    }
  }
  return stops[stops.length - 1][1];
}

function mix(a: string, b: string, k: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const r  = Math.round(pa[0] + (pb[0] - pa[0]) * k);
  const g  = Math.round(pa[1] + (pb[1] - pa[1]) * k);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * k);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parse(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function shortRegion(name: string): string {
  return name
    .replace("Восточно-Казахстанская", "В.-Казахст.")
    .replace("Западно-Казахстанская", "З.-Казахст.")
    .replace("Северо-Казахстанская", "С.-Казахст.")
    .replace("Карагандинская", "Карагандин.")
    .replace("Костанайская", "Костанай.")
    .replace("Алматинская", "Алматин.")
    .replace("Туркестанская", "Туркестан.")
    .replace("Кызылординская", "Кызылорд.")
    .replace("Мангистауская", "Мангистау.")
    .replace("Акмолинская", "Акмолин.")
    .replace("Актюбинская", "Актюбин.")
    .replace("Атырауская", "Атырау.")
    .replace("Жамбылская", "Жамбыл.")
    .replace("Павлодарская", "Павлодар.")
    .replace(" область", "")
    .replace("Область ", "");
}
