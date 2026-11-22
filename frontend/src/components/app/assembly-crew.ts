/**
 * The crew of the assembly show: who does what, when, and what each one is
 * doing right now. Pure functions; the component animates from them.
 *
 * The real data arrives in steps (backend src/show.py). Each step plays as a
 * short build: the Diretor drags the pieces of the original onto the video
 * track, the Legendista types the title and drops the caption lines, the
 * Câmera crops the webcam and the game out of the source and carries them to
 * the phone, the Montador renders and the Revisor watches the result.
 */

export type AgentId = "diretor" | "legendista" | "camera" | "montador" | "revisor";

export const AGENTS: { id: AgentId; name: string; color: string }[] = [
  { id: "diretor", name: "Diretor", color: "#facc15" },
  { id: "legendista", name: "Legendista", color: "#f472b6" },
  { id: "camera", name: "Câmera", color: "#34d399" },
  { id: "montador", name: "Montador", color: "#fb923c" },
  { id: "revisor", name: "Revisor", color: "#38bdf8" },
];

export const agentColor = (id: AgentId) => AGENTS.find((a) => a.id === id)!.color;

const STAGE_ORDER = ["momento", "cortes", "trecho", "enquadramento", "render", "revisao", "pronto"] as const;
export type CrewStage = (typeof STAGE_ORDER)[number];
const at = (stage: CrewStage) => STAGE_ORDER.indexOf(stage);

export interface CutsPlan {
  /** Seconds after the cuts arrived: when the Diretor picks each piece up and drops it. */
  blocks: { start: number; drop: number }[];
  title: { start: number; end: number } | null;
  /** When each caption line lands. */
  lines: number[];
  blocksEnd: number;
  end: number;
}

/** The timeline build: pieces first (quick hands for many), then title and captions. */
export function cutsPlan(blocks: number, hasTitle: boolean, lines: number): CutsPlan {
  const step = blocks ? Math.min(0.5, 3 / blocks) : 0;
  const drag = Math.min(0.42, step * 0.9);
  const placed = Array.from({ length: blocks }, (_, i) => {
    const start = 0.3 + i * step;
    return { start, drop: start + drag };
  });
  const blocksEnd = placed.length ? placed[placed.length - 1].drop + 0.15 : 0.3;
  // The title is typed while the pieces land; the lines follow the pieces.
  const title = hasTitle ? { start: 0.3, end: 1.2 } : null;
  const linesStart = Math.max(blocksEnd, title ? title.end : 0) + 0.1;
  const lineStep = lines ? Math.min(0.28, 3.5 / lines) : 0;
  const landed = Array.from({ length: lines }, (_, i) => linesStart + 0.1 + i * lineStep);
  const end = (landed.length ? landed[landed.length - 1] : Math.max(blocksEnd, title?.end ?? 0)) + 0.3;
  return { blocks: placed, title, lines: landed, blocksEnd, end };
}

export interface FramePlan {
  /** Per piece: the selection is drawn, held, flown to the phone and landed. */
  pieces: { select: number; hold: number; fly: number; land: number }[];
  /** When the title starts appearing on the phone. */
  title: number;
  end: number;
}

export function framePlan(pieces: number): FramePlan {
  const placed = Array.from({ length: pieces }, (_, j) => {
    const select = 0.2 + j * 1.25;
    return { select, hold: select + 0.55, fly: select + 0.75, land: select + 1.3 };
  });
  const last = placed.length ? placed[placed.length - 1].land : 0.2;
  return { pieces: placed, title: last + 0.1, end: last + 1.0 };
}

/** Index of the last step that has started by `t` (-1 before the first). */
export function currentStep(starts: number[], t: number) {
  let found = -1;
  for (let i = 0; i < starts.length; i++) if (t >= starts[i]) found = i;
  return found;
}

export type CrewState = "idle" | "working" | "done";
export interface CrewMember {
  state: CrewState;
  text: string;
}

export interface CrewInput {
  stage: CrewStage;
  blocks: number;
  teaser: number;
  lines: number;
  words: number;
  title: boolean;
  /** Names of what the layout takes from the source, e.g. ["Webcam", "Jogo"]. */
  pieces: string[];
  /** Seconds since the timeline build started (null: no cuts yet). */
  cuts: number | null;
  /** Seconds since the framing build started (null: no preview yet). */
  frame: number | null;
  duration: number;
  review?: { score: number; changes: string[] } | null;
  webcam?: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What every agent is doing at this moment of the build. */
export function crewStatus(input: CrewInput): Record<AgentId, CrewMember> {
  const stage = at(input.stage);
  const cuts = cutsPlan(input.blocks, input.title, input.lines);
  const frame = framePlan(input.pieces.length);
  const c = input.cuts;
  const f = input.frame;
  const done = (text: string): CrewMember => ({ state: "done", text });
  const working = (text: string): CrewMember => ({ state: "working", text });
  const idle = (text: string): CrewMember => ({ state: "idle", text });

  let diretor: CrewMember;
  if (stage === at("momento")) diretor = working("escolhendo o momento");
  else if (c === null) diretor = working("separando os pedaços");
  else if (c < cuts.blocksEnd && input.blocks) {
    const i = Math.max(0, currentStep(cuts.blocks.map((b) => b.start), c));
    diretor = working(`arrastando o pedaço ${i + 1} de ${input.blocks}`);
  } else
    diretor = done(
      `${plural(input.blocks, "pedaço", "pedaços")} do original${input.teaser ? " · gancho na frente" : ""}`,
    );

  let legendista: CrewMember;
  if (c === null) legendista = idle("esperando os cortes");
  // Once the crops are on the phone, the title and the captions go on top.
  else if (f !== null && f >= frame.title && f < frame.end) legendista = working("pondo o título e a legenda no celular");
  else if (cuts.title && c < cuts.title.end) legendista = working("escrevendo o título");
  else if (input.lines && c < cuts.end - 0.3) {
    const i = Math.max(0, currentStep(cuts.lines, c + 0.1));
    legendista = working(`colocando a legenda ${i + 1} de ${input.lines}`);
  } else
    legendista = done(
      input.lines ? `${plural(input.lines, "linha", "linhas")} · ${plural(input.words, "palavra", "palavras")}` : "sem fala neste corte",
    );

  let camera: CrewMember;
  if (stage < at("enquadramento")) camera = idle("esperando o corte");
  else if (f === null)
    camera = stage >= at("render")
      ? done("enquadramento pronto")
      : working(input.pieces.length > 1 ? "procurando a webcam e o jogo" : "enquadrando");
  else if (frame.pieces.length && f < frame.pieces[frame.pieces.length - 1].land) {
    const j = Math.max(0, currentStep(frame.pieces.map((p) => p.select), f));
    const name = (input.pieces[j] || "corte").toLowerCase();
    camera = working(f < frame.pieces[j].fly ? `recortando ${name}` : `levando ${name} para o celular`);
  } else camera = done(input.webcam || input.pieces.join(" + ") || "enquadrado");

  let montador: CrewMember;
  if (stage === at("trecho")) montador = working("baixando os minutos do original");
  else if (stage < at("render")) montador = idle("esperando as peças");
  else if (stage === at("render")) montador = working(`renderizando ${Math.round(input.duration)} s em 1080×1920`);
  else montador = done("render pronto");

  const review = input.review;
  const verdict = review
    ? `nota ${review.score}/10 · ${review.changes.length ? review.changes[0] : "aprovado"}`
    : null;
  let revisor: CrewMember;
  if (stage === at("pronto")) revisor = done(review ? `nota ${review.score}/10 · ${review.changes.length ? "ajustes feitos" : "aprovado"}` : "liberado");
  else if (stage === at("revisao")) revisor = review ? done(verdict!) : working("assistindo o corte");
  // Asked for fixes: the clip is being made again with them.
  else if (review?.changes.length) revisor = working(`pediu: ${review.changes[0]}`);
  else revisor = idle("esperando o render");

  return { diretor, legendista, camera, montador, revisor };
}
