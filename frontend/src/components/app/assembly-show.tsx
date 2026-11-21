"use client";

/**
 * "Bastidores": the clip being made, drawn live while the task processes.
 *
 *   analisando  the source on a TV, a green line sweeping it, volume bars, the
 *               Diretor saying what is happening
 *   montando    a phone built from scratch: the webcam and the game fly from the
 *               source into the chosen layout, the title drops, the captions come
 *               in word by word, the timeline fills; four agents (cursors with a
 *               name) move the pieces
 *   pronto      the real clip plays inside the phone for a few seconds
 *
 * Inspired by SHARINGAN's assembly show (MIT), drawn in Kortes' own style.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AssemblingClip {
  index: number;
  total: number;
  start_time?: string | null;
  end_time?: string | null;
  hook_title?: string | null;
  words?: string[];
  layout?: string | null;
  at: number;
}

export interface ReadyFlash {
  url: string;
  title?: string | null;
  at: number;
}

interface Props {
  message: string;
  live?: boolean;
  layout: string;
  source: string | null;
  assembling: AssemblingClip | null;
  ready: ReadyFlash | null;
}

const W = 1280;
const H = 720;
const TV = { x: 60, y: 120, w: 620, h: 349 };
const PHONE = { x: 860, y: 40, w: 300, h: 600 };
const SCREEN = { x: PHONE.x + 15, y: PHONE.y + 60, w: 270, h: 480 };
const CYCLE = 8;
const READY_SECONDS = 6;
const STORAGE_KEY = "kortes-show-open";

type Box = { x: number; y: number; w: number; h: number };

const AGENTS = [
  { name: "Diretor", color: "#a855f7" },
  { name: "Câmera", color: "#3b82f6" },
  { name: "Legendista", color: "#facc15" },
  { name: "Revisor", color: "#22c55e" },
] as const;

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const bounce = (x: number) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
const inBox = (outer: Box, f: Box): Box => ({ x: outer.x + f.x * outer.w, y: outer.y + f.y * outer.h, w: f.w * outer.w, h: f.h * outer.h });

/** Pieces of the layout: where they come from on the source and where they go on the phone. */
function layoutPieces(layout: string): { name: string; from: Box; to: Box; color: string; blur?: boolean }[] {
  const webcam: Box = { x: 0.03, y: 0.6, w: 0.27, h: 0.36 };
  const gameColumn: Box = { x: 0.33, y: 0, w: 0.34, h: 1 };
  const camAspectH = (SCREEN.w * 0.444) / 1.406 / SCREEN.h;
  switch (layout) {
    case "vertical_gameplay":
      return [
        { name: "Webcam", from: webcam, to: { x: 0, y: 0, w: 1, h: 0.4 }, color: "#3b82f6" },
        { name: "Jogo", from: gameColumn, to: { x: 0, y: 0.4, w: 1, h: 0.6 }, color: "#a855f7" },
      ];
    case "vertical_gameplay_bottom":
      return [
        { name: "Jogo", from: gameColumn, to: { x: 0, y: 0, w: 1, h: 0.6 }, color: "#a855f7" },
        { name: "Webcam", from: webcam, to: { x: 0, y: 0.6, w: 1, h: 0.4 }, color: "#3b82f6" },
      ];
    case "vertical_cam_float":
      return [
        { name: "Jogo", from: { x: 0.34, y: 0, w: 0.32, h: 1 }, to: { x: 0, y: 0, w: 1, h: 1 }, color: "#a855f7" },
        { name: "Webcam", from: webcam, to: { x: 0.037, y: 0.156, w: 0.444, h: camAspectH }, color: "#3b82f6" },
      ];
    case "vertical_blur":
      return [
        { name: "Fundo", from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0, y: 0, w: 1, h: 1 }, color: "#57534e", blur: true },
        { name: "Vídeo", from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0, y: 0.34, w: 1, h: 0.32 }, color: "#a855f7" },
      ];
    case "original":
      return [{ name: "Vídeo", from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0, y: 0.34, w: 1, h: 0.32 }, color: "#a855f7" }];
    default:
      return [{ name: "Rosto", from: { x: 0.34, y: 0, w: 0.32, h: 1 }, to: { x: 0, y: 0, w: 1, h: 1 }, color: "#a855f7" }];
  }
}

function roundRect(ctx: CanvasRenderingContext2D, b: Box, r: number) {
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, r);
}

function drawPicture(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, from: Box, to: Box, color: string, label: string, blur = false) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(to.x, to.y, to.w, to.h);
  ctx.clip();
  if (img) {
    // Cover the target with the source part, keeping its proportions.
    const sw = from.w * img.naturalWidth, sh = from.h * img.naturalHeight;
    const scale = Math.max(to.w / sw, to.h / sh);
    const cw = to.w / scale, ch = to.h / scale;
    const sx = from.x * img.naturalWidth + (sw - cw) / 2, sy = from.y * img.naturalHeight + (sh - ch) / 2;
    if (blur) ctx.filter = "blur(10px) brightness(0.8)";
    ctx.drawImage(img, sx, sy, cw, ch, to.x, to.y, to.w, to.h);
  } else {
    const g = ctx.createLinearGradient(to.x, to.y, to.x + to.w, to.y + to.h);
    g.addColorStop(0, color);
    g.addColorStop(1, "#1c1917");
    ctx.fillStyle = g;
    ctx.fillRect(to.x, to.y, to.w, to.h);
    if (!blur) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, to.x + to.w / 2, to.y + to.h / 2);
    }
  }
  ctx.restore();
}

function cursor(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, name: string, busy = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 22);
  ctx.lineTo(6, 16);
  ctx.lineTo(11, 26);
  ctx.lineTo(15, 24);
  ctx.lineTo(10, 14);
  ctx.lineTo(18, 14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.font = "600 14px system-ui, sans-serif";
  const label = busy ? `${name} …` : name;
  const w = ctx.measureText(label).width + 14;
  ctx.fillStyle = color;
  roundRect(ctx, { x: 16, y: 24, w, h: 22 }, 11);
  ctx.fill();
  ctx.fillStyle = color === "#facc15" ? "#111" : "white";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 23, 35);
  ctx.restore();
}

function balloon(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.font = "600 17px system-ui, sans-serif";
  let line = text;
  while (ctx.measureText(line).width > 520 && line.length > 4) line = line.slice(0, -2);
  if (line !== text) line = `${line.trimEnd()}…`;
  const w = ctx.measureText(line).width + 32;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(ctx, { x: x + 4, y: y + 4, w, h: 44 }, 14);
  ctx.fill();
  ctx.fillStyle = "white";
  roundRect(ctx, { x, y, w, h: 44 }, 14);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 26, y + 44);
  ctx.lineTo(x + 36, y + 58);
  ctx.lineTo(x + 46, y + 44);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.textBaseline = "middle";
  ctx.fillText(line, x + 16, y + 23);
  ctx.restore();
}

function phone(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = "#0a0a0a";
  ctx.strokeStyle = "#44403c";
  ctx.lineWidth = 4;
  roundRect(ctx, PHONE, 38);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1c1917";
  roundRect(ctx, { x: PHONE.x + PHONE.w / 2 - 45, y: PHONE.y + 18, w: 90, h: 22 }, 11);
  ctx.fill();
  ctx.fillStyle = "#0c0a09";
  ctx.fillRect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
  ctx.restore();
}

/** Assembly show; hidden behind a toggle the viewer can collapse. */
export function AssemblyShow({ message, live = false, layout, source, assembling, ready }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const state = useRef({ message, layout, assembling, ready, live });
  state.current = { message, layout, assembling, ready, live };
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) !== "closed");
    } catch {
      /* keep it open */
    }
  }, []);

  useEffect(() => {
    imageRef.current = null;
    if (!source) return;
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
    };
    img.src = source;
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;
    video.src = ready.url;
    video.currentTime = 0;
    void video.play().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        frame = requestAnimationFrame(draw);
        return;
      }
      const now = performance.now() / 1000;
      const wall = Date.now();
      const { message: msg, layout: lay, assembling: clip, ready: flash, live: isLive } = state.current;
      const img = imageRef.current;
      const showReady = flash && wall - flash.at < READY_SECONDS * 1000;
      const building = !showReady && clip && (!flash || flash.at < clip.at);
      const t = building ? ((wall - clip!.at) / 1000) % CYCLE : 0;
      const reviewing = /revisando/i.test(msg);

      // background
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0c0a09");
      bg.addColorStop(1, "#1c1917");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }

      // the source on a TV
      ctx.save();
      ctx.fillStyle = "#292524";
      roundRect(ctx, { x: TV.x - 14, y: TV.y - 14, w: TV.w + 28, h: TV.h + 28 }, 18);
      ctx.fill();
      ctx.restore();
      drawPicture(ctx, img, { x: 0, y: 0, w: 1, h: 1 }, TV, "#44403c", isLive ? "Ao vivo" : "Vídeo original");
      ctx.save();
      ctx.font = "700 13px system-ui, sans-serif";
      ctx.fillStyle = isLive ? "#dc2626" : "#57534e";
      roundRect(ctx, { x: TV.x + 12, y: TV.y + 12, w: isLive ? 72 : 76, h: 24 }, 12);
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.textBaseline = "middle";
      ctx.fillText(isLive ? "● AO VIVO" : "ORIGINAL", TV.x + 22, TV.y + 24);
      ctx.restore();

      // the AI reading: a sweeping line over the source
      if (!building && !showReady) {
        const sx = TV.x + ((now * 0.35) % 1) * TV.w;
        const glow = ctx.createLinearGradient(sx - 60, 0, sx, 0);
        glow.addColorStop(0, "rgba(34,197,94,0)");
        glow.addColorStop(1, "rgba(34,197,94,0.35)");
        ctx.fillStyle = glow;
        ctx.fillRect(Math.max(TV.x, sx - 60), TV.y, Math.min(60, sx - TV.x), TV.h);
        ctx.fillStyle = "#22c55e";
        ctx.fillRect(sx, TV.y, 3, TV.h);
      }

      // volume bars under the TV
      const bars = 56;
      for (let i = 0; i < bars; i++) {
        const v = 0.25 + 0.75 * Math.abs(Math.sin(now * 2.2 + i * 0.55) * Math.sin(now * 0.7 + i * 0.13));
        const peak = v > 0.86;
        ctx.fillStyle = peak ? "#ef4444" : "#57534e";
        const bh = v * 56;
        ctx.fillRect(TV.x + i * (TV.w / bars), TV.y + TV.h + 70 - bh, TV.w / bars - 3, bh);
      }
      ctx.fillStyle = "#a8a29e";
      ctx.font = "500 13px system-ui, sans-serif";
      ctx.fillText("volume da voz · picos em vermelho", TV.x, TV.y + TV.h + 92);

      // the phone and what is on it
      phone(ctx);
      const pieces = layoutPieces(lay);
      if (showReady && videoRef.current && videoRef.current.readyState >= 2) {
        const video = videoRef.current;
        const scale = Math.max(SCREEN.w / video.videoWidth, SCREEN.h / video.videoHeight);
        const vw = video.videoWidth * scale, vh = video.videoHeight * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
        ctx.clip();
        ctx.drawImage(video, SCREEN.x + (SCREEN.w - vw) / 2, SCREEN.y + (SCREEN.h - vh) / 2, vw, vh);
        ctx.restore();
      } else if (building) {
        pieces.forEach((piece, i) => {
          const k = ease((t - 0.4 - i * 0.7) / 1.1);
          if (k <= 0) return;
          const to = inBox(SCREEN, piece.to);
          const from = inBox(TV, piece.from);
          const box = lerpBox(from, to, k);
          drawPicture(ctx, img, piece.from, box, piece.color, piece.name, piece.blur);
          if (k < 1) {
            ctx.strokeStyle = piece.color;
            ctx.lineWidth = 3;
            ctx.strokeRect(box.x, box.y, box.w, box.h);
          } else if (lay === "vertical_cam_float" && piece.name === "Webcam") {
            ctx.strokeStyle = "white";
            ctx.lineWidth = 3;
            ctx.strokeRect(box.x, box.y, box.w, box.h);
          }
        });
        // title dropping in
        const title = clip?.hook_title;
        if (title) {
          const k = bounce((t - 2.4) / 0.8);
          if (k > 0) {
            ctx.save();
            ctx.font = "800 17px system-ui, sans-serif";
            // Up to two lines, broken between words, like the burned-in title.
            const lines: string[] = [];
            let current = "";
            for (const word of title.toUpperCase().split(/\s+/)) {
              const next = current ? `${current} ${word}` : word;
              if (ctx.measureText(next).width > SCREEN.w - 44 && current) {
                lines.push(current);
                current = word;
              } else current = next;
            }
            if (current) lines.push(current);
            if (lines.length > 2) lines.splice(1, lines.length - 1, `${lines.slice(1).join(" ").slice(0, 18).trimEnd()}…`);
            const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
            const h = lines.length * 24 + 8;
            const y = lerp(SCREEN.y - 60, SCREEN.y + 30, k);
            ctx.fillStyle = "#dc2626";
            roundRect(ctx, { x: SCREEN.x + (SCREEN.w - w) / 2, y, w, h }, 6);
            ctx.fill();
            ctx.fillStyle = "white";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            lines.forEach((l, i) => ctx.fillText(l, SCREEN.x + SCREEN.w / 2, y + 16 + i * 24));
            ctx.restore();
          }
        }
        // captions, word by word
        const words = clip?.words?.length ? clip.words : ["…"];
        if (t > 3.2) {
          const index = Math.floor((t - 3.2) / 0.32) % words.length;
          const group = words.slice(Math.max(0, index - 2), index + 1);
          ctx.save();
          ctx.font = "800 20px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const text = group.join(" ").toUpperCase();
          const cy = SCREEN.y + SCREEN.h * 0.75;
          ctx.lineWidth = 5;
          ctx.strokeStyle = "black";
          ctx.strokeText(text, SCREEN.x + SCREEN.w / 2, cy, SCREEN.w - 24);
          ctx.fillStyle = "#facc15";
          ctx.fillText(text, SCREEN.x + SCREEN.w / 2, cy, SCREEN.w - 24);
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.fillStyle = "#57534e";
        ctx.font = "500 15px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(isLive ? "Esperando um momento forte…" : "Procurando os melhores momentos…", SCREEN.x + SCREEN.w / 2, SCREEN.y + SCREEN.h / 2);
        ctx.restore();
      }

      // timeline under the phone
      const tl = { x: PHONE.x - 20, y: PHONE.y + PHONE.h + 20, w: PHONE.w + 40, h: 18 };
      ctx.fillStyle = "#292524";
      roundRect(ctx, tl, 9);
      ctx.fill();
      const fill = showReady ? 1 : building ? Math.min(1, t / (CYCLE - 1)) : 0;
      if (fill > 0) {
        ctx.fillStyle = showReady ? "#22c55e" : "#a855f7";
        roundRect(ctx, { ...tl, w: Math.max(18, tl.w * fill) }, 9);
        ctx.fill();
      }

      // the agents
      const camPiece = pieces.find((p) => p.name === "Webcam") ?? pieces[0];
      const camTarget = inBox(SCREEN, camPiece.to);
      const camFrom = inBox(TV, camPiece.from);
      const k = building ? ease((t - 0.4) / 1.1) : 0;
      const wob = (n: number) => Math.sin(now * 1.7 + n) * 10;
      const director = { x: TV.x + TV.w * 0.5 + wob(1) * 3, y: TV.y + TV.h * 0.45 + wob(2) };
      const camera = building
        ? { x: lerp(camFrom.x + camFrom.w / 2, camTarget.x + camTarget.w / 2, k), y: lerp(camFrom.y + camFrom.h / 2, camTarget.y + camTarget.h / 2, k) }
        : { x: TV.x + TV.w * 0.16 + wob(3), y: TV.y + TV.h * 0.78 + wob(4) };
      // Writes the captions from beside the phone, clear of the webcam.
      const captions = { x: SCREEN.x - 120 + wob(5), y: SCREEN.y + SCREEN.h * 0.72 + wob(6) };
      const reviewer = { x: PHONE.x + PHONE.w + 10 + wob(7), y: SCREEN.y + SCREEN.h * 0.45 + wob(8) };
      cursor(ctx, director.x, director.y, AGENTS[0].color, AGENTS[0].name, !building && !showReady);
      cursor(ctx, camera.x, camera.y, AGENTS[1].color, AGENTS[1].name, Boolean(building) && k < 1);
      cursor(ctx, captions.x, captions.y, AGENTS[2].color, AGENTS[2].name, Boolean(building) && t > 3.2);
      cursor(ctx, reviewer.x, reviewer.y, AGENTS[3].color, AGENTS[3].name, reviewing);
      if (showReady || reviewing) {
        ctx.save();
        ctx.fillStyle = "#22c55e";
        ctx.beginPath();
        ctx.arc(PHONE.x + PHONE.w - 6, PHONE.y + 30, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(PHONE.x + PHONE.w - 16, PHONE.y + 30);
        ctx.lineTo(PHONE.x + PHONE.w - 8, PHONE.y + 38);
        ctx.lineTo(PHONE.x + PHONE.w + 6, PHONE.y + 22);
        ctx.stroke();
        ctx.restore();
      }

      // what the Diretor says
      const said = showReady
        ? `Pronto! ${flash?.title ? `"${flash.title}"` : "Mais um clipe na parede."}`
        : building && clip
          ? `Montando o clipe ${clip.index + 1}${clip.total ? ` de ${clip.total}` : ""}${clip.start_time ? ` · ${clip.start_time}–${clip.end_time}` : ""}`
          : msg || "Lendo o vídeo…";
      balloon(ctx, TV.x, 30, said);

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const toggle = () =>
    setOpen((value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value ? "closed" : "open");
      } catch {
        /* ignore */
      }
      return !value;
    });

  return (
    <section className="overflow-hidden rounded-2xl border bg-stone-950" aria-label="Bastidores da montagem">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5 text-white">
        <p className="text-sm font-semibold">
          Bastidores <span className="font-normal text-stone-400">· os agentes montando seus clipes</span>
        </p>
        <Button type="button" size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={toggle} aria-expanded={open}>
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
          {open ? "Recolher" : "Mostrar"}
        </Button>
      </div>
      {open && (
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          role="img"
          aria-label={message || "Montagem dos clipes"}
          className="block aspect-video w-full"
        />
      )}
      <video ref={videoRef} muted playsInline loop className="hidden" />
    </section>
  );
}
