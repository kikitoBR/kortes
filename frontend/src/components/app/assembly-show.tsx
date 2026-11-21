"use client";

/**
 * "Bastidores": the clip really being made, like an editor watched live.
 *
 * Everything shown comes from the render itself (backend src/show.py): the cut
 * chosen by the AI, its ranges (teaser and body), every caption word with its
 * time, a filmstrip and a light preview of the real cut, and where the webcam
 * and the game were found in it.
 *
 *  - Phone (program monitor): the preview framed with the clip's layout, its
 *    title and its captions, grouped like the render groups them; then the
 *    finished clip.
 *  - Timeline: title, video (filmstrip + the pieces of the source) and caption
 *    tracks at a fixed scale that follows the playhead.
 *  - Source monitor: the original cut with the parts the layout takes from it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getClipUrl } from "@/lib/clip-actions";
import { cn } from "@/lib/utils";

type Box = { x: number; y: number; w: number; h: number };
export type ShowStage = "momento" | "cortes" | "trecho" | "enquadramento" | "render" | "revisao" | "pronto";

export interface ShowWord {
  text: string;
  start: number;
  end: number;
}

export interface ShowClip {
  key: string;
  index: number;
  total: number;
  stage: ShowStage;
  start_time?: string | null;
  end_time?: string | null;
  title?: string | null;
  layout?: string | null;
  ranges?: [number, number][];
  teaser?: number;
  duration?: number;
  words?: ShowWord[];
  words_per_line?: number;
  preview?: string;
  preview_size?: [number | null, number | null];
  strip?: string;
  strip_frames?: number;
  regions?: { cam?: Box; game?: Box } | null;
  video_url?: string | null;
  filename?: string | null;
}

export interface ShowQueueItem {
  n: number;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  status: string;
}

export interface ShowState {
  clip: ShowClip | null;
  queue: ShowQueueItem[];
}

const STAGES: { id: ShowStage; label: string; agent?: string }[] = [
  { id: "momento", label: "Momento", agent: "Diretor" },
  { id: "cortes", label: "Cortes e legendas", agent: "Legendista" },
  { id: "trecho", label: "Trecho" },
  { id: "enquadramento", label: "Enquadramento", agent: "Câmera" },
  { id: "render", label: "Render" },
  { id: "revisao", label: "Revisão", agent: "Revisor" },
  { id: "pronto", label: "Pronto" },
];
const STORAGE_KEY = "kortes-show-open";
const CAM_SHARE = 768 / 1920;
const WEBCAM_LAYOUTS = new Set(["vertical_gameplay", "vertical_gameplay_bottom", "vertical_cam_float"]);
const TITLE_SECONDS = 4;
/** Timeline scale: wide enough to read a caption line. */
const PX_PER_SECOND = 56;
const TRACK_VIDEO_H = 56;

const apiUrl = (url?: string | null) => (url ? getClipUrl(url) : null);
const stageIndex = (stage: ShowStage) => STAGES.findIndex((s) => s.id === stage);
const clockLabel = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type CaptionLine = { start: number; end: number; words: ShowWord[] };

/** Caption lines as the render cuts them: every N words (the template's max_words_per_line). */
export function captionLines(words: ShowWord[], perLine = 4): CaptionLine[] {
  const size = Math.max(1, Math.round(perLine));
  const lines: CaptionLine[] = [];
  for (let i = 0; i < words.length; i += size) {
    const chunk = words.slice(i, i + size);
    lines.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, words: chunk });
  }
  return lines;
}

/** Part of the frame (fractions) cover-fitted to an aspect, around its centre. */
function coverCut(box: Box, sw: number, sh: number, aspect: number) {
  const bw = box.w * sw,
    bh = box.h * sh;
  const [w, h] = bw / bh > aspect ? [bh * aspect, bh] : [bw, bw / aspect];
  const cx = (box.x + box.w / 2) * sw,
    cy = (box.y + box.h / 2) * sh;
  return {
    x: Math.min(Math.max(cx - w / 2, 0), sw - w),
    y: Math.min(Math.max(cy - h / 2, 0), sh - h),
    w,
    h,
  };
}

type Piece = { name: string; cut: Box; tile: Box; color: string };

/** What the layout takes from the source (pixels) and where it goes on a W×H phone. */
function layoutPieces(clip: ShowClip, sw: number, sh: number, W: number, H: number): Piece[] {
  const layout = clip.layout || "vertical";
  const regions = clip.regions;
  const whole = { x: 0, y: 0, w: 1, h: 1 };
  if (WEBCAM_LAYOUTS.has(layout) && regions?.cam && regions.game) {
    if (layout === "vertical_cam_float") {
      const camTile = { x: W * (40 / 1080), y: H * (300 / 1920), w: W * (480 / 1080), h: (W * (480 / 1080) * 768) / 1080 };
      return [
        { name: "Jogo", cut: coverCut(regions.game, sw, sh, W / H), tile: { x: 0, y: 0, w: W, h: H }, color: "#a78bfa" },
        { name: "Webcam", cut: coverCut(regions.cam, sw, sh, camTile.w / camTile.h), tile: camTile, color: "#34d399" },
      ];
    }
    const camH = H * CAM_SHARE,
      camTop = layout === "vertical_gameplay";
    const camTile = { x: 0, y: camTop ? 0 : H - camH, w: W, h: camH };
    const gameTile = { x: 0, y: camTop ? camH : 0, w: W, h: H - camH };
    return [
      { name: "Webcam", cut: coverCut(regions.cam, sw, sh, camTile.w / camTile.h), tile: camTile, color: "#34d399" },
      { name: "Jogo", cut: coverCut(regions.game, sw, sh, gameTile.w / gameTile.h), tile: gameTile, color: "#a78bfa" },
    ];
  }
  if (layout === "vertical_blur" || layout === "original") {
    const h = (W * sh) / sw;
    return [{ name: "Quadro inteiro", cut: { x: 0, y: 0, w: sw, h: sh }, tile: { x: 0, y: (H - h) / 2, w: W, h }, color: "#a78bfa" }];
  }
  // Face-tracked layouts: the renderer follows the face; a centred 9:16 cut is close.
  return [{ name: "Corte 9:16", cut: coverCut(whole, sw, sh, W / H), tile: { x: 0, y: 0, w: W, h: H }, color: "#a78bfa" }];
}

/** The program monitor: the real cut framed like the clip will be. */
function drawPhone(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: ShowClip, lines: CaptionLine[]) {
  const { width: W, height: H } = ctx.canvas;
  const sw = video.videoWidth,
    sh = video.videoHeight;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  if (clip.layout === "vertical_blur") {
    ctx.save();
    ctx.filter = "blur(14px) brightness(0.85)";
    const fill = coverCut({ x: 0, y: 0, w: 1, h: 1 }, sw, sh, W / H);
    ctx.drawImage(video, fill.x, fill.y, fill.w, fill.h, 0, 0, W, H);
    ctx.restore();
  }
  for (const piece of layoutPieces(clip, sw, sh, W, H)) {
    const { cut, tile } = piece;
    ctx.drawImage(video, cut.x, cut.y, cut.w, cut.h, tile.x, tile.y, tile.w, tile.h);
    if (clip.layout === "vertical_cam_float" && piece.name === "Webcam") {
      ctx.strokeStyle = "white";
      ctx.lineWidth = Math.max(2, W * (6 / 1080));
      ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
    }
  }
  drawTitle(ctx, clip, video.currentTime);
  drawCaption(ctx, lines, video.currentTime);
}

function drawTitle(ctx: CanvasRenderingContext2D, clip: ShowClip, time: number) {
  if (!clip.title || time >= TITLE_SECONDS) return;
  const { width: W, height: H } = ctx.canvas;
  ctx.save();
  ctx.font = `800 ${Math.round(W * 0.058)}px system-ui, sans-serif`;
  const lines: string[] = [];
  let current = "";
  for (const word of clip.title.toUpperCase().split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > W * 0.84 && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  const shown = lines.slice(0, 2);
  const lh = W * 0.075;
  const w = Math.max(...shown.map((l) => ctx.measureText(l).width)) + W * 0.06;
  const y = H * 0.07;
  ctx.fillStyle = "#dc2626";
  ctx.beginPath();
  ctx.roundRect((W - w) / 2, y, w, shown.length * lh + W * 0.03, 6);
  ctx.fill();
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  shown.forEach((l, i) => ctx.fillText(l, W / 2, y + W * 0.015 + lh * (i + 0.5)));
  ctx.restore();
}

function activeLine(lines: CaptionLine[], time: number) {
  return lines.findIndex((line) => time >= line.start && time <= line.end + 0.1);
}

function drawCaption(ctx: CanvasRenderingContext2D, lines: CaptionLine[], time: number) {
  const line = lines[activeLine(lines, time)];
  if (!line) return;
  const { width: W, height: H } = ctx.canvas;
  ctx.save();
  ctx.font = `900 ${Math.round(W * 0.07)}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const space = ctx.measureText(" ").width;
  const texts = line.words.map((w) => w.text.toUpperCase());
  const total = texts.reduce((s, t) => s + ctx.measureText(t).width, 0) + space * (texts.length - 1);
  const scale = total > W * 0.92 ? (W * 0.92) / total : 1;
  let x = (W - total * scale) / 2;
  const y = H * 0.75;
  texts.forEach((text, i) => {
    const word = line.words[i];
    const next = line.words[i + 1];
    const speaking = time >= word.start && time < (next ? next.start : word.end + 0.1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.lineWidth = W * 0.014;
    ctx.strokeStyle = "black";
    ctx.lineJoin = "round";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = speaking ? "#facc15" : "white";
    ctx.fillText(text, 0, 0);
    ctx.restore();
    x += (ctx.measureText(text).width + space) * scale;
  });
  ctx.restore();
}

/** The source monitor: the original cut, with what the layout takes from it. */
function drawSource(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: ShowClip) {
  const { width: W, height: H } = ctx.canvas;
  const sw = video.videoWidth,
    sh = video.videoHeight;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const k = Math.min(W / sw, H / sh);
  const ox = (W - sw * k) / 2,
    oy = (H - sh * k) / 2;
  ctx.drawImage(video, ox, oy, sw * k, sh * k);
  const pieces = layoutPieces(clip, sw, sh, 1080, 1920);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, W, H);
  for (const { cut } of pieces) {
    ctx.drawImage(video, cut.x, cut.y, cut.w, cut.h, ox + cut.x * k, oy + cut.y * k, cut.w * k, cut.h * k);
  }
  ctx.font = `600 ${Math.round(W * 0.028)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const { name, cut, color } of pieces) {
    const x = ox + cut.x * k,
      y = oy + cut.y * k;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, cut.w * k - 2, cut.h * k - 2);
    const label = name;
    const lw = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, lw, W * 0.04);
    ctx.fillStyle = "#0c0a09";
    ctx.fillText(label, x + 6, y + 1 + W * 0.007);
  }
}

function Phone({ clip, canvasRef, finalRef }: {
  clip: ShowClip;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  finalRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const final = clip.stage === "pronto" ? apiUrl(clip.video_url) : null;
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-[28px] border-[6px] border-stone-700 bg-black shadow-2xl">
      {final ? (
        <video ref={finalRef} key={final} src={final} autoPlay muted loop playsInline className="size-full object-cover" />
      ) : clip.preview ? (
        <canvas ref={canvasRef} width={540} height={960} className="size-full" aria-label="Prévia do corte com o layout e as legendas" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-stone-400">
          <Loader2 className="size-5 animate-spin" />
          {clip.stage === "trecho"
            ? "Baixando os minutos deste corte…"
            : clip.stage === "momento"
              ? "Separando o momento…"
              : "Cortando o vídeo…"}
        </div>
      )}
      {clip.stage === "pronto" && (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-green-600 px-2 py-0.5 text-[11px] font-semibold text-white">
          <Check className="size-3" /> Pronto
        </span>
      )}
    </div>
  );
}

function Filmstrip({ clip, width }: { clip: ShowClip; width: number }) {
  const strip = apiUrl(clip.strip);
  const frames = clip.strip_frames || 12;
  if (!strip) return <div className="absolute inset-0 animate-pulse bg-white/5" />;
  const [pw, ph] = clip.preview_size ?? [];
  const aspect = pw && ph ? pw / ph : 16 / 9;
  const slot = width / frames;
  // Each frame keeps its shape: as wide as its slot, or as tall as the track.
  const frameW = Math.max(slot, TRACK_VIDEO_H * aspect);
  return (
    <>
      {Array.from({ length: frames }, (_, i) => (
        <div
          key={i}
          className="absolute inset-y-0 border-r border-black/40 animate-in fade-in"
          style={{
            left: i * slot,
            width: slot,
            backgroundImage: `url(${strip})`,
            backgroundSize: `${frames * frameW}px auto`,
            backgroundPosition: `${-(i * frameW + (frameW - slot) / 2)}px center`,
            animationDelay: `${i * 40}ms`,
            animationFillMode: "both",
          }}
        />
      ))}
    </>
  );
}

function Timeline({ clip, lines, scrollRef, playheadRef, lineRefs, onManualScroll }: {
  clip: ShowClip;
  lines: CaptionLine[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  playheadRef: React.RefObject<HTMLDivElement | null>;
  lineRefs: React.RefObject<(HTMLSpanElement | null)[]>;
  onManualScroll: () => void;
}) {
  const duration = clip.duration || 0;
  const ranges = clip.ranges ?? [];
  const teaser = clip.teaser ?? 0;
  const width = Math.max(1, duration * PX_PER_SECOND);
  const ready = stageIndex(clip.stage) >= stageIndex("cortes") && duration > 0;
  const x = (t: number) => t * PX_PER_SECOND;
  let cursor = 0;
  const blocks = ranges.map(([a, b], i) => {
    const block = { left: cursor, length: b - a, from: a, to: b, teaser: i < teaser, index: i };
    cursor += b - a;
    return block;
  });
  const seconds = Math.floor(duration);

  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-stone-900 p-3 text-white">
      <div className="mb-2 flex items-center justify-between text-[11px] text-stone-400">
        <span>Linha do tempo</span>
        {ready && (
          <span className="tabular-nums">
            {duration.toFixed(1)} s · {clip.words?.length ?? 0} palavras · {ranges.length} {ranges.length === 1 ? "pedaço" : "pedaços"} do original
          </span>
        )}
      </div>
      <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 text-[11px]">
        <div className="flex flex-col gap-1.5 text-stone-400">
          <span className="h-5" />
          <span className="flex h-7 items-center">Título</span>
          <span className="flex items-center" style={{ height: TRACK_VIDEO_H }}>Vídeo</span>
          <span className="flex h-9 items-center">Legenda</span>
        </div>
        <div
          ref={scrollRef}
          className="min-w-0 overflow-x-auto pb-1 [scrollbar-color:#57534e_transparent] [scrollbar-width:thin]"
          onWheel={onManualScroll}
          onPointerDown={onManualScroll}
          onTouchStart={onManualScroll}
        >
          {ready ? (
            <div className="relative flex flex-col gap-1.5" style={{ width }}>
              <div className="relative h-5 border-b border-white/10">
                {Array.from({ length: seconds + 1 }, (_, t) => (
                  <span key={t} className="absolute bottom-0 w-px bg-white/15" style={{ left: x(t), height: t % 5 === 0 ? 8 : 4 }}>
                    {t % 5 === 0 && (
                      <span className="absolute bottom-2 left-1 text-[10px] text-stone-500 tabular-nums">{clockLabel(t)}</span>
                    )}
                  </span>
                ))}
              </div>
              <div className="relative h-7 rounded bg-white/5">
                {clip.title && (
                  <div
                    className="absolute inset-y-0 flex items-center rounded bg-red-600 px-2 font-semibold animate-in fade-in slide-in-from-left-2"
                    style={{ left: 0, width: x(Math.min(TITLE_SECONDS, duration)) }}
                    title={clip.title}
                  >
                    <span className="truncate">{clip.title}</span>
                  </div>
                )}
              </div>
              <div className="relative overflow-hidden rounded bg-white/5" style={{ height: TRACK_VIDEO_H }}>
                <Filmstrip clip={clip} width={width} />
                {blocks.map((block) => {
                  const w = x(block.length);
                  const label = block.teaser
                    ? block.index === 0 ? "Gancho" : "Volta"
                    : `Corte ${block.index + 1 - teaser} · ${clockLabel(block.from)}–${clockLabel(block.to)}`;
                  return (
                    <div
                      key={block.index}
                      className={cn(
                        "absolute inset-y-0 border-x-2 animate-in fade-in slide-in-from-left-2",
                        block.teaser ? "border-pink-400 bg-pink-500/20" : "border-violet-400 bg-violet-500/10",
                      )}
                      style={{ left: x(block.left), width: w, animationDelay: `${block.index * 150}ms`, animationFillMode: "both" }}
                      title={`${label} (original ${clockLabel(block.from)}–${clockLabel(block.to)})`}
                    >
                      {w >= 44 && (
                        <span className="absolute left-1 top-1 max-w-[calc(100%-8px)] truncate rounded bg-black/70 px-1 text-[10px]">{label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="relative h-9 rounded bg-white/5">
                {lines.map((line, i) => (
                  <span
                    key={`${line.start}-${i}`}
                    ref={(el) => {
                      lineRefs.current[i] = el;
                    }}
                    className="absolute inset-y-1 flex items-center overflow-hidden whitespace-nowrap rounded border border-yellow-500/40 bg-yellow-400/80 px-1 text-[10px] font-semibold text-black animate-in fade-in zoom-in-95 data-[active=1]:z-10 data-[active=1]:bg-yellow-300 data-[active=1]:ring-2 data-[active=1]:ring-white"
                    style={{
                      left: x(line.start),
                      width: Math.max(10, x(line.end - line.start) - 2),
                      animationDelay: `${Math.min(i * 45, 2500)}ms`,
                      animationFillMode: "both",
                    }}
                    title={line.words.map((w) => w.text).join(" ")}
                  >
                    {line.words.map((w) => w.text).join(" ")}
                  </span>
                ))}
              </div>
              <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 z-20 hidden w-0.5 bg-white shadow-[0_0_6px_white]" />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="h-5" />
              <span className="h-7 animate-pulse rounded bg-white/5" />
              <span className="animate-pulse rounded bg-white/5" style={{ height: TRACK_VIDEO_H }} />
              <span className="h-9 animate-pulse rounded bg-white/5" />
            </div>
          )}
        </div>
      </div>
      {!ready && <p className="mt-2 text-[10px] text-stone-500">Escolhendo os cortes…</p>}
    </div>
  );
}

function SourceMonitor({ clip, canvasRef }: { clip: ShowClip; canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const [pw, ph] = clip.preview_size ?? [];
  const height = pw && ph ? Math.round((640 * ph) / pw) : 360;
  const cam = clip.regions?.cam;
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-stone-900 p-3 text-white">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-stone-400">
        <span>Fonte · o que a Câmera tirou do original</span>
        {cam && (
          <span className="tabular-nums">
            webcam em {Math.round(cam.x * 100)}%, {Math.round(cam.y * 100)}%
          </span>
        )}
      </div>
      {clip.preview ? (
        <canvas ref={canvasRef} width={640} height={height} className="w-full rounded bg-black" aria-label="Vídeo original com as partes usadas no corte" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded bg-black/60 text-xs text-stone-500">
          {stageIndex(clip.stage) < stageIndex("enquadramento") ? "Esperando o corte…" : "Carregando a prévia…"}
        </div>
      )}
    </div>
  );
}

const QUEUE_STYLE: Record<string, string> = {
  pronto: "border-green-500/40 bg-green-500/15 text-green-300",
  montando: "border-violet-400/60 bg-violet-500/20 text-violet-200",
  "na fila": "border-white/10 bg-white/5 text-stone-300",
  falhou: "border-red-500/40 bg-red-500/15 text-red-300",
};

/** The clip being made right now, with its real content; hidden behind a toggle. */
export function AssemblyShow({ show, message, live = false }: { show: ShowState | null; message: string; live?: boolean }) {
  const [open, setOpen] = useState(true);
  const clip = show?.clip ?? null;
  const previewRef = useRef<HTMLVideoElement>(null);
  const finalRef = useRef<HTMLVideoElement>(null);
  const phoneRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const manualUntil = useRef(0);
  const lines = useMemo(() => captionLines(clip?.words ?? [], clip?.words_per_line ?? 4), [clip?.words, clip?.words_per_line]);
  const clipRef = useRef(clip);
  const linesRef = useRef(lines);
  useEffect(() => {
    clipRef.current = clip;
    linesRef.current = lines;
  });

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) !== "closed");
    } catch {
      /* keep it open */
    }
  }, []);

  // One clock for everything: the finished clip once it is ready, else the preview.
  useEffect(() => {
    let frame = 0;
    let lastActive = -1;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const current = clipRef.current;
      const preview = previewRef.current;
      const final = finalRef.current;
      if (!current) return;
      const clock = final && final.readyState >= 2 ? final : preview && preview.readyState >= 2 ? preview : null;
      if (!clock) return;
      const time = clock.currentTime;
      if (clock === final && preview && preview.readyState >= 2 && Math.abs(preview.currentTime - time) > 0.4) {
        preview.currentTime = time;
      }
      const phone = phoneRef.current?.getContext("2d");
      if (phone && preview && clock === preview) drawPhone(phone, preview, current, linesRef.current);
      const source = sourceRef.current?.getContext("2d");
      if (source && preview && preview.readyState >= 2) drawSource(source, preview, current);

      const head = playheadRef.current;
      const scroller = scrollRef.current;
      const px = time * PX_PER_SECOND;
      if (head) {
        head.style.display = "block";
        head.style.left = `${px}px`;
      }
      if (scroller && performance.now() > manualUntil.current) {
        const view = scroller.clientWidth;
        if (px < scroller.scrollLeft + 16 || px > scroller.scrollLeft + view * 0.75) {
          scroller.scrollLeft = Math.max(0, px - view * 0.25);
        }
      }
      const active = activeLine(linesRef.current, time);
      if (active !== lastActive) {
        lineRefs.current[lastActive]?.setAttribute("data-active", "0");
        lineRefs.current[active]?.setAttribute("data-active", "1");
        lastActive = active;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggle = () =>
    setOpen((value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value ? "closed" : "open");
      } catch {
        /* ignore */
      }
      return !value;
    });

  const current = clip ? stageIndex(clip.stage) : -1;
  const queue = show?.queue ?? [];
  const preview = clip ? apiUrl(clip.preview) : null;

  return (
    <section className="overflow-hidden rounded-2xl border bg-stone-950 text-white" aria-label="Bastidores da montagem">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold">
          Bastidores
          <span className="font-normal text-stone-400">
            {clip
              ? ` · montando o corte #${clip.index + 1}${clip.total ? ` de ${clip.total}` : ""}${clip.start_time ? ` · ${clip.start_time}–${clip.end_time}${live ? " da live" : ""}` : ""}`
              : " · a montagem aparece aqui"}
          </span>
        </p>
        <Button type="button" size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={toggle} aria-expanded={open}>
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
          {open ? "Recolher" : "Mostrar"}
        </Button>
      </div>
      {open && (
        <div className="space-y-4 p-4">
          {clip ? (
            <>
              {preview && <video ref={previewRef} key={preview} src={preview} autoPlay muted loop playsInline className="hidden" />}
              <ol className="flex flex-wrap gap-1.5" aria-label="Etapas da montagem">
                {STAGES.filter((s) => s.id !== "trecho" || clip.stage === "trecho" || live).map((stage) => {
                  const index = stageIndex(stage.id);
                  const done = index < current || (index === current && stage.id === "pronto");
                  const active = index === current && !done;
                  return (
                    <li
                      key={stage.id}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]",
                        done && "border-green-500/40 bg-green-500/10 text-green-300",
                        active && "border-violet-400 bg-violet-500/20 text-white",
                        !done && !active && "border-white/10 text-stone-500",
                      )}
                    >
                      {done ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : null}
                      {stage.label}
                      {stage.agent && <span className="text-stone-400">· {stage.agent}</span>}
                    </li>
                  );
                })}
              </ol>
              <div className="grid items-start gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                <Phone clip={clip} canvasRef={phoneRef} finalRef={finalRef} />
                <div className="min-w-0 space-y-4">
                  <Timeline
                    clip={clip}
                    lines={lines}
                    scrollRef={scrollRef}
                    playheadRef={playheadRef}
                    lineRefs={lineRefs}
                    onManualScroll={() => {
                      manualUntil.current = performance.now() + 4000;
                    }}
                  />
                  <div className="max-w-[460px]">
                    <SourceMonitor clip={clip} canvasRef={sourceRef} />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-stone-900 px-4 py-6 text-sm text-stone-300">
              <Loader2 className="size-4 shrink-0 animate-spin text-violet-300" />
              {message || (live ? "Ouvindo a live à procura de um momento forte…" : "Lendo o vídeo…")}
            </div>
          )}
          {queue.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="mr-1 text-stone-400">Cortes:</span>
              {queue.map((item) => (
                <span
                  key={item.n}
                  className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", QUEUE_STYLE[item.status] ?? QUEUE_STYLE["na fila"])}
                  title={item.title ?? undefined}
                >
                  #{item.n}
                  {item.start ? <span className="tabular-nums opacity-80">{item.start}</span> : null}
                  <span className="opacity-80">· {item.status}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
