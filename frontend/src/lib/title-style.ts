// How the AI's hook title (and the cover text) looks. Mirrors the backend's
// media/title_styles.py: keep the ids, positions and defaults in step.

export type TitlePreset = "classico" | "faixa" | "duas_cores" | "faixa_cor" | "destaque";
export type TitlePosition = "auto" | "top" | "upper" | "middle" | "lower" | "bottom";
export type TitleSize = "s" | "m" | "l";
export type TitleDuration = "start" | "always";

export type TitleStyle = {
  preset: TitlePreset;
  position: TitlePosition;
  color: string;
  size: TitleSize;
  duration: TitleDuration;
};

export const DEFAULT_TITLE_STYLE: TitleStyle = {
  preset: "duas_cores",
  position: "auto",
  color: "#E11D2E",
  size: "m",
  duration: "start",
};

export const TITLE_PRESETS: { id: TitlePreset; label: string; hint: string }[] = [
  { id: "duas_cores", label: "Duas cores", hint: "Faixas brancas e a última na cor" },
  { id: "faixa_cor", label: "Faixa colorida", hint: "Todas as linhas na cor" },
  { id: "faixa", label: "Faixa escura", hint: "Fundo preto translúcido" },
  { id: "classico", label: "Contorno", hint: "Texto com contorno, palavras fortes na cor" },
  { id: "destaque", label: "Destaque", hint: "Texto na cor com contorno grosso" },
];

export const TITLE_POSITIONS: { id: TitlePosition; label: string }[] = [
  { id: "auto", label: "Automático" },
  { id: "top", label: "Topo" },
  { id: "upper", label: "Acima do meio" },
  { id: "middle", label: "Meio" },
  { id: "lower", label: "Abaixo do meio" },
  { id: "bottom", label: "Embaixo" },
];

export const TITLE_COLORS = ["#E11D2E", "#EB5116", "#F5B300", "#16A34A", "#2563EB", "#7C3AED", "#DB2777", "#111111"];

export const TITLE_SIZES: { id: TitleSize; label: string }[] = [
  { id: "s", label: "P" },
  { id: "m", label: "M" },
  { id: "l", label: "G" },
];

export const TITLE_DURATIONS: { id: TitleDuration; label: string }[] = [
  { id: "start", label: "Só no começo" },
  { id: "always", label: "O corte todo" },
];

const POSITION_Y: Record<Exclude<TitlePosition, "auto">, number> = {
  top: 0.11,
  upper: 0.4,
  middle: 0.5,
  lower: 0.62,
  bottom: 0.84,
};
const SIZE_SCALE: Record<TitleSize, number> = { s: 0.85, m: 1, l: 1.2 };

export function normalizeTitleStyle(value: unknown): TitleStyle {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    preset: TITLE_PRESETS.some((p) => p.id === raw.preset) ? (raw.preset as TitlePreset) : DEFAULT_TITLE_STYLE.preset,
    position: TITLE_POSITIONS.some((p) => p.id === raw.position) ? (raw.position as TitlePosition) : DEFAULT_TITLE_STYLE.position,
    color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toUpperCase() : DEFAULT_TITLE_STYLE.color,
    size: TITLE_SIZES.some((s) => s.id === raw.size) ? (raw.size as TitleSize) : DEFAULT_TITLE_STYLE.size,
    duration: TITLE_DURATIONS.some((d) => d.id === raw.duration) ? (raw.duration as TitleDuration) : DEFAULT_TITLE_STYLE.duration,
  };
}

/** Centre of the title block (share of the height). "auto" sits on the webcam/game line. */
export function titleCenter(style: TitleStyle, outputFormat?: string): number {
  if (style.position !== "auto") return POSITION_Y[style.position];
  if (outputFormat === "vertical_gameplay") return 0.4;
  if (outputFormat === "vertical_gameplay_bottom") return 0.6;
  return POSITION_Y.top;
}

export const titleScale = (style: TitleStyle) => SIZE_SCALE[style.size];

/** Up to 3 even lines, like the server (captions.split_title_lines). */
export function splitTitleLines(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  let best = [words.join(" ")];
  for (let count = 1; count <= Math.min(3, words.length); count++) {
    let bestLongest = Infinity;
    let candidate = best;
    const tryCuts = (cuts: number[]) => {
      const bounds = [0, ...cuts, words.length];
      const lines = bounds.slice(0, -1).map((start, i) => words.slice(start, bounds[i + 1]).join(" "));
      const longest = Math.max(...lines.map((l) => l.length));
      if (longest < bestLongest) {
        bestLongest = longest;
        candidate = lines;
      }
    };
    if (count === 1) tryCuts([]);
    else if (count === 2) for (let a = 1; a < words.length; a++) tryCuts([a]);
    else for (let a = 1; a < words.length; a++) for (let b = a + 1; b < words.length; b++) tryCuts([a, b]);
    best = candidate;
    if (bestLongest <= maxChars) break;
  }
  return best;
}
