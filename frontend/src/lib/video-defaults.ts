// Configurações → "Padrões para novos vídeos". Saved as one JSON object on the user
// (users.video_defaults); the home page starts from it and the backend fills in
// whatever a request leaves out (API keys, MCP).

export type OutputFormat =
  | "vertical"
  | "vertical_pan"
  | "vertical_split"
  | "vertical_gameplay"
  | "vertical_gameplay_bottom"
  | "vertical_cam_float"
  | "vertical_blur"
  | "original";

export type ClipDuration = "auto" | "short" | "medium" | "long";

/** How picky the AI is: more cuts, as today, or only the strongest moments. */
export type Strictness = "more" | "balanced" | "best";

export const FRAMINGS: { id: OutputFormat; label: string; hint: string }[] = [
  { id: "vertical", label: "Auto 9:16", hint: "Corte vertical com rastreamento facial" },
  { id: "vertical_pan", label: "Seguir orador", hint: "Acompanha quem estiver falando" },
  { id: "vertical_split", label: "Tela dividida", hint: "Dois oradores empilhados" },
  { id: "vertical_gameplay", label: "Webcam em cima", hint: "Webcam em cima, jogo embaixo" },
  { id: "vertical_gameplay_bottom", label: "Jogo em cima", hint: "Jogo em cima, webcam embaixo" },
  { id: "vertical_cam_float", label: "Webcam flutuando", hint: "Jogo na tela toda, webcam no canto" },
  { id: "vertical_blur", label: "Fundo borrado", hint: "Vídeo inteiro no meio, fundo borrado" },
  { id: "original", label: "Original", hint: "Manter proporção original do vídeo" },
];

export const DURATIONS: { id: ClipDuration; label: string; range: string; hint: string }[] = [
  { id: "auto", label: "Auto", range: "20s – 2m", hint: "A IA escolhe o tempo ideal para cada momento (20s a 2m)" },
  { id: "short", label: "Curto", range: "20s – 30s", hint: "Ideal para TikTok e Shorts rápidos" },
  { id: "medium", label: "Médio", range: "30s – 60s", hint: "Equilíbrio entre contexto e dinamismo" },
  { id: "long", label: "Longo", range: "60s – 120s", hint: "Momentos mais completos e reflexivos (1m – 2m)" },
];

export const CLIP_COUNTS: { value: number | null; label: string }[] = [
  { value: null, label: "Automático" },
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: 15, label: "15" },
  { value: 20, label: "20" },
];

export const STRICTNESS: { id: Strictness; label: string; hint: string }[] = [
  { id: "more", label: "Mais cortes", hint: "Aceita momentos medianos: mais cortes por vídeo e por live." },
  { id: "balanced", label: "Equilibrado", hint: "O padrão: só momentos bons." },
  { id: "best", label: "Só os melhores", hint: "Só os momentos mais fortes: menos cortes, todos de alto nível." },
];

export type VideoDefaults = {
  /** null: automatic (about one per 5 minutes of video). */
  clipCount: number | null;
  strictness: Strictness;
  clipDuration: ClipDuration;
  outputFormat: OutputFormat;
  /** The AI's hook title burned at the top for the first seconds. */
  titleOverlay: boolean;
  /** "Ganho inicial": the clip opens with its strongest line. */
  hookIntro: boolean;
  /** Kortes Desktop: a copy of every cut goes to this folder (null: off). */
  exportDir: string | null;
  /** Kortes Desktop: a Windows notice when a cut is ready. */
  notifyDesktop: boolean;
};

export const VIDEO_DEFAULTS: VideoDefaults = {
  clipCount: null,
  strictness: "balanced",
  clipDuration: "auto",
  outputFormat: "vertical",
  titleOverlay: true,
  hookIntro: false,
  exportDir: null,
  notifyDesktop: true,
};

/** Keep only valid values; anything else falls back to the default. */
export function normalizeVideoDefaults(value: unknown): VideoDefaults {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const pick = <T,>(key: keyof VideoDefaults, valid: (v: unknown) => v is T): T =>
    (valid(raw[key]) ? raw[key] : VIDEO_DEFAULTS[key]) as T;
  return {
    clipCount: pick<number | null>("clipCount", (v): v is number | null => v === null || [5, 10, 15, 20].includes(v as number)),
    strictness: pick<Strictness>("strictness", (v): v is Strictness => STRICTNESS.some((s) => s.id === v)),
    clipDuration: pick<ClipDuration>("clipDuration", (v): v is ClipDuration => DURATIONS.some((d) => d.id === v)),
    outputFormat: pick<OutputFormat>("outputFormat", (v): v is OutputFormat => FRAMINGS.some((f) => f.id === v)),
    titleOverlay: pick<boolean>("titleOverlay", (v): v is boolean => typeof v === "boolean"),
    hookIntro: pick<boolean>("hookIntro", (v): v is boolean => typeof v === "boolean"),
    exportDir: pick<string | null>(
      "exportDir",
      (v): v is string | null => v === null || (typeof v === "string" && v.trim().length > 0 && v.length <= 500),
    ),
    notifyDesktop: pick<boolean>("notifyDesktop", (v): v is boolean => typeof v === "boolean"),
  };
}

/** Which keys of a PATCH body are invalid (to answer 400 instead of silently ignoring them). */
export function invalidVideoDefaultKeys(value: Record<string, unknown>): string[] {
  const normalized = normalizeVideoDefaults(value) as Record<string, unknown>;
  return Object.keys(value).filter((key) => key in VIDEO_DEFAULTS && normalized[key] !== value[key]);
}
