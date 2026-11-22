"use client";

/**
 * "Bastidores": the clip really being made, like an editor watched live, by a
 * crew of agents (see assembly-crew.ts).
 *
 * Everything shown comes from the render itself (backend src/show.py): the cut
 * chosen by the AI, its ranges (teaser and body), every caption word with its
 * time, a filmstrip and a light preview of the real cut, where the webcam and
 * the game were found in it, and what the AI review asked for.
 *
 *  - Crew: each agent with what it is doing now.
 *  - Phone (program monitor): the preview framed with the clip's layout, its
 *    title and its captions; then the finished clip.
 *  - Timeline: title, video (filmstrip + the pieces of the source) and caption
 *    tracks at a fixed scale that follows the playhead.
 *  - Source monitor: the original cut with the parts the layout takes from it.
 *  - Overlay: the agents' cursors dragging the pieces onto the timeline,
 *    cropping the source and carrying each crop to the phone.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Captions, Check, ChevronDown, Clapperboard, Crop, Film, Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getClipUrl } from "@/lib/clip-actions";
import { cn } from "@/lib/utils";
import {
  AGENTS,
  type AgentId,
  type CrewMember,
  agentColor,
  crewStatus,
  currentStep,
  cutsPlan,
  framePlan,
  type CutsPlan,
  type FramePlan,
} from "./assembly-crew";

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
  review?: { score: number; changes: string[]; notes?: string } | null;
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

// The review reads the moment before it is cut and rendered.
const STAGE_IDS: ShowStage[] = ["momento", "revisao", "cortes", "trecho", "enquadramento", "render", "pronto"];
const STORAGE_KEY = "kortes-show-open";
const CAM_SHARE = 768 / 1920;
const WEBCAM_LAYOUTS = new Set(["vertical_gameplay", "vertical_gameplay_bottom", "vertical_cam_float"]);
const TITLE_SECONDS = 4;
/** Timeline scale: wide enough to read a caption line. */
const PX_PER_SECOND = 56;
const TRACK_VIDEO_H = 56;
const PHONE_W = 540;
const PHONE_H = 960;
const TEASER_COLOR = "#f472b6";
const BODY_COLOR = "#a78bfa";

const AGENT_ICONS: Record<AgentId, LucideIcon> = {
  diretor: Clapperboard,
  legendista: Captions,
  camera: Crop,
  montador: Film,
  revisor: ScanSearch,
};

const apiUrl = (url?: string | null) => (url ? getClipUrl(url) : null);
const stageIndex = (stage: ShowStage) => STAGE_IDS.indexOf(stage);
const clockLabel = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

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

type Block = { left: number; length: number; from: number; to: number; teaser: boolean; index: number; label: string };

/** The pieces of the source in play order, placed on the clip's timeline. */
function timelineBlocks(clip: ShowClip): Block[] {
  const teaser = clip.teaser ?? 0;
  let cursor = 0;
  return (clip.ranges ?? []).map(([a, b], i) => {
    const isTeaser = i < teaser;
    const block = {
      left: cursor,
      length: b - a,
      from: a,
      to: b,
      teaser: isTeaser,
      index: i,
      label: isTeaser ? (i === 0 ? "Gancho" : "Volta") : `Corte ${i + 1 - teaser} · ${clockLabel(a)}–${clockLabel(b)}`,
    };
    cursor += b - a;
    return block;
  });
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
        { name: "Jogo", cut: coverCut(regions.game, sw, sh, W / H), tile: { x: 0, y: 0, w: W, h: H }, color: BODY_COLOR },
        { name: "Webcam", cut: coverCut(regions.cam, sw, sh, camTile.w / camTile.h), tile: camTile, color: "#34d399" },
      ];
    }
    const camH = H * CAM_SHARE,
      camTop = layout === "vertical_gameplay";
    const camTile = { x: 0, y: camTop ? 0 : H - camH, w: W, h: camH };
    const gameTile = { x: 0, y: camTop ? camH : 0, w: W, h: H - camH };
    return [
      { name: "Webcam", cut: coverCut(regions.cam, sw, sh, camTile.w / camTile.h), tile: camTile, color: "#34d399" },
      { name: "Jogo", cut: coverCut(regions.game, sw, sh, gameTile.w / gameTile.h), tile: gameTile, color: BODY_COLOR },
    ];
  }
  if (layout === "vertical_blur" || layout === "original") {
    const h = (W * sh) / sw;
    return [{ name: "Quadro inteiro", cut: { x: 0, y: 0, w: sw, h: sh }, tile: { x: 0, y: (H - h) / 2, w: W, h }, color: BODY_COLOR }];
  }
  // Face-tracked layouts: the renderer follows the face; a centred 9:16 cut is close.
  return [{ name: "Corte 9:16", cut: coverCut(whole, sw, sh, W / H), tile: { x: 0, y: 0, w: W, h: H }, color: BODY_COLOR }];
}

/** How the source frame sits in the source monitor canvas. */
function sourceFit(W: number, H: number, sw: number, sh: number) {
  const k = Math.min(W / sw, H / sh);
  return { k, ox: (W - sw * k) / 2, oy: (H - sh * k) / 2 };
}

type PhoneBuild = { landed: boolean[]; titleK: number; forceTitle: boolean; captions: boolean };

/** The program monitor: the real cut framed like the clip will be, as the Câmera fills it. */
function drawPhone(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: ShowClip, lines: CaptionLine[], build: PhoneBuild) {
  const { width: W, height: H } = ctx.canvas;
  const sw = video.videoWidth,
    sh = video.videoHeight;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const pieces = layoutPieces(clip, sw, sh, W, H);
  if (clip.layout === "vertical_blur" && build.landed[0]) {
    ctx.save();
    ctx.filter = "blur(14px) brightness(0.85)";
    const fill = coverCut({ x: 0, y: 0, w: 1, h: 1 }, sw, sh, W / H);
    ctx.drawImage(video, fill.x, fill.y, fill.w, fill.h, 0, 0, W, H);
    ctx.restore();
  }
  pieces.forEach((piece, i) => {
    const { cut, tile } = piece;
    if (!build.landed[i]) {
      // The empty slot the Câmera is about to fill.
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = piece.color;
      ctx.lineWidth = 3;
      ctx.strokeRect(tile.x + 6, tile.y + 6, tile.w - 12, tile.h - 12);
      ctx.setLineDash([]);
      ctx.fillStyle = piece.color;
      ctx.font = `700 ${Math.round(W * 0.05)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(piece.name, tile.x + tile.w / 2, tile.y + tile.h / 2);
      ctx.restore();
      return;
    }
    ctx.drawImage(video, cut.x, cut.y, cut.w, cut.h, tile.x, tile.y, tile.w, tile.h);
    if (clip.layout === "vertical_cam_float" && piece.name === "Webcam") {
      ctx.strokeStyle = "white";
      ctx.lineWidth = Math.max(2, W * (6 / 1080));
      ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
    }
  });
  if (build.forceTitle || video.currentTime < TITLE_SECONDS) drawTitle(ctx, clip, build.titleK);
  if (build.captions) drawCaption(ctx, lines, video.currentTime);
}

/** The red title, typed up to `typed` (0-1) of its letters. */
function drawTitle(ctx: CanvasRenderingContext2D, clip: ShowClip, typed: number) {
  if (!clip.title || typed <= 0) return;
  const { width: W, height: H } = ctx.canvas;
  const full = clip.title.toUpperCase();
  const text = full.slice(0, Math.ceil(full.length * typed));
  ctx.save();
  ctx.font = `800 ${Math.round(W * 0.058)}px system-ui, sans-serif`;
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
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

/** Selection of one piece on the source: drawn (k 0-1), held with handles, then placed. */
type SourceSelection = { k: number; held: boolean; landed: boolean };

function handles(ctx: CanvasRenderingContext2D, r: Box, color: string) {
  ctx.fillStyle = "white";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h]]) {
    ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.strokeRect(x - 4, y - 4, 8, 8);
  }
}

/** The source monitor: the original cut, with what the Câmera crops out of it. */
function drawSource(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: ShowClip, selection: SourceSelection[]) {
  const { width: W, height: H } = ctx.canvas;
  const sw = video.videoWidth,
    sh = video.videoHeight;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const { k, ox, oy } = sourceFit(W, H, sw, sh);
  ctx.drawImage(video, ox, oy, sw * k, sh * k);
  const pieces = layoutPieces(clip, sw, sh, 1080, 1920);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, W, H);
  ctx.font = `600 ${Math.round(W * 0.028)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  pieces.forEach(({ name, cut, color }, i) => {
    const sel = selection[i] ?? { k: 1, held: true, landed: true };
    if (sel.k <= 0) return;
    const grow = ease(sel.k);
    const r = { x: ox + cut.x * k, y: oy + cut.y * k, w: cut.w * k * grow, h: cut.h * k * grow };
    // The selected part lights up as the rubber band grows over it.
    ctx.drawImage(video, cut.x, cut.y, cut.w * grow, cut.h * grow, r.x, r.y, r.w, r.h);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (!sel.landed) ctx.setLineDash([7, 5]);
    ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
    ctx.restore();
    if (sel.held && !sel.landed) handles(ctx, r, color);
    if (sel.held) {
      const lw = ctx.measureText(name).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(r.x + 1, r.y + 1, lw, W * 0.04);
      ctx.fillStyle = "#0c0a09";
      ctx.fillText(name, r.x + 6, r.y + 1 + W * 0.007);
    }
  });
}

// ---------- the agents on the overlay

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.5, 13);
  ctx.lineTo(7.5, 19.5);
  ctx.lineTo(10.5, 18);
  ctx.lineTo(7.5, 11.5);
  ctx.lineTo(13, 11.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = "600 11px system-ui, sans-serif";
  const w = ctx.measureText(label).width + 12;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(11, 17, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = "#0c0a09";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, 17, 26.5);
  ctx.restore();
}

/** A piece being carried: a solid chip in the track's colour. */
function drawGhost(ctx: CanvasRenderingContext2D, r: Box, color: string, label: string) {
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 5);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0c0a09";
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x + 4, r.y, r.w - 8, r.h);
  ctx.clip();
  ctx.fillText(label, r.x + 5, r.y + r.h / 2);
  ctx.restore();
  ctx.restore();
}

/** A marching dashed arrow: where the agent is taking the piece. */
function drawLink(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, color: string, t: number) {
  const cx = (from.x + to.x) / 2;
  const cy = Math.min(from.y, to.y) - Math.abs(to.x - from.x) * 0.15 - 20;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 7]);
  ctx.lineDashOffset = -t * 40;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cx, cy, to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(to.y - cy, to.x - cx);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - 10 * Math.cos(a - 0.45), to.y - 10 * Math.sin(a - 0.45));
  ctx.lineTo(to.x - 10 * Math.cos(a + 0.45), to.y - 10 * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawScissors(ctx: CanvasRenderingContext2D, x: number, track: Box, k: number) {
  ctx.save();
  ctx.globalAlpha = 1 - k;
  ctx.fillStyle = "white";
  ctx.fillRect(x - 1, track.y - 6, 2, track.h + 12);
  ctx.font = "16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("✂", x, track.y - 4 - 6 * k);
  ctx.restore();
}

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  ctx.save();
  ctx.font = "700 11px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
  ctx.fill();
  ctx.fillStyle = "#0c0a09";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function drawMagnifier(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.fillStyle = "rgba(56,189,248,0.12)";
  ctx.beginPath();
  ctx.arc(x - 12, y - 12, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 2, y - 2);
  ctx.lineTo(x + 3, y + 3);
  ctx.stroke();
  ctx.restore();
}

/** Sizes the overlay to its wrapper and returns a cleared context in CSS pixels. */
function fitOverlay(canvas: HTMLCanvasElement, wrap: HTMLElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth,
    h = wrap.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

type Elements = {
  wrap: HTMLElement;
  scroller: HTMLElement | null;
  titleTrack: HTMLElement | null;
  videoTrack: HTMLElement | null;
  captionTrack: HTMLElement | null;
  sourceBox: HTMLElement | null;
  sourceCanvas: HTMLCanvasElement | null;
  phoneBox: HTMLElement | null;
  phoneCanvas: HTMLCanvasElement | null;
  preview: HTMLVideoElement | null;
};

type Scene = {
  clip: ShowClip;
  stage: number;
  now: number;
  time: number | null;
  cuts: number | null;
  frame: number | null;
  cutsPlan: CutsPlan;
  framePlan: FramePlan;
  blocks: Block[];
  lines: CaptionLine[];
};

/**
 * Draws every agent at work and returns where on the timeline (content px) the
 * build is happening, so the view can follow it.
 */
function drawCrew(ctx: CanvasRenderingContext2D, el: Elements, s: Scene): number | null {
  const wr = el.wrap.getBoundingClientRect();
  const rel = (node: Element): Box => {
    const r = node.getBoundingClientRect();
    return { x: r.left - wr.left, y: r.top - wr.top, w: r.width, h: r.height };
  };
  const S = el.scroller ? rel(el.scroller) : null;
  const scrollLeft = el.scroller?.scrollLeft ?? 0;
  const contentX = (t: number) => (S ? S.x + t * PX_PER_SECOND - scrollLeft : 0);
  const clampX = (x: number) => (S ? Math.min(Math.max(x, S.x + 6), S.x + S.w - 40) : x);
  const titleTrack = el.titleTrack ? rel(el.titleTrack) : null;
  const videoTrack = el.videoTrack ? rel(el.videoTrack) : null;
  const captionTrack = el.captionTrack ? rel(el.captionTrack) : null;
  const B = el.sourceBox ? rel(el.sourceBox) : null;
  const P = el.phoneBox ? rel(el.phoneBox) : null;
  const pi = (id: AgentId) => agentColor(id);
  let follow: number | null = null;
  const { cuts, frame, cutsPlan: cp, framePlan: fp, stage, now } = s;
  const at = (id: Parameters<typeof stageIndex>[0]) => stageIndex(id);

  // Diretor: picks the moment, then drags each piece of the original onto the video track.
  if (S && (stage === at("momento") || (cuts === null && stage === at("cortes")))) {
    const y = videoTrack ? videoTrack.y + videoTrack.h / 2 : S.y + S.h / 2;
    drawCursor(ctx, S.x + S.w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(now * 1.6))), y, pi("diretor"), "Diretor");
  } else if (S && videoTrack && cuts !== null && cuts < cp.blocksEnd) {
    const i = currentStep(cp.blocks.map((b) => b.start), cuts);
    const step = cp.blocks[i];
    const block = s.blocks[i];
    if (step && block) {
      const slot = { x: contentX(block.left), y: videoTrack.y + 4, w: Math.max(8, block.length * PX_PER_SECOND), h: videoTrack.h - 8 };
      const target = { x: clampX(slot.x + Math.min(slot.w / 2, 40)), y: slot.y + slot.h / 2 };
      follow = (block.left + Math.min(block.length / 2, 0.7)) * PX_PER_SECOND;
      const color = block.teaser ? TEASER_COLOR : BODY_COLOR;
      if (cuts < step.drop) {
        const k = ease((cuts - step.start) / (step.drop - step.start));
        const from = B ? { x: B.x + B.w * 0.5 + ((i % 3) - 1) * 24, y: B.y + B.h * 0.4 } : { x: S.x + S.w, y: S.y };
        const pos = { x: lerp(from.x, target.x, k), y: lerp(from.y, target.y, k) };
        drawLink(ctx, from, pos, pi("diretor"), now);
        const gw = Math.min(120, Math.max(40, slot.w)),
          gh = Math.max(18, slot.h * 0.7);
        drawGhost(ctx, { x: pos.x - gw / 2, y: pos.y - gh / 2, w: gw, h: gh }, color, block.label);
        drawCursor(ctx, pos.x + gw / 2 - 8, pos.y + gh / 2 - 8, pi("diretor"), "Diretor");
      } else {
        const since = cuts - step.drop;
        if (since < 0.25 && slot.x >= S.x && slot.x <= S.x + S.w) drawScissors(ctx, slot.x, videoTrack, since / 0.25);
        drawCursor(ctx, target.x + 6, target.y + 4, pi("diretor"), "Diretor");
      }
    }
  }

  // Legendista: types the title, then drops the caption lines where they are spoken.
  if (S && cuts !== null && cuts < cp.end) {
    if (cp.title && titleTrack && cuts >= cp.title.start && cuts < cp.title.end) {
      const k = (cuts - cp.title.start) / (cp.title.end - cp.title.start);
      const width = Math.min(TITLE_SECONDS, s.clip.duration ?? TITLE_SECONDS) * PX_PER_SECOND;
      drawCursor(ctx, clampX(contentX(0) + width * k), titleTrack.y + titleTrack.h * 0.55, pi("legendista"), "Legendista");
    } else if (captionTrack && cp.lines.length && cuts >= cp.lines[0] - 0.1) {
      const i = currentStep(cp.lines.map((t) => t - 0.1), cuts);
      const lineX = (n: number) => {
        const line = s.lines[n];
        return line ? (line.start + (line.end - line.start) / 2) * PX_PER_SECOND : 0;
      };
      const k = ease((cuts - (cp.lines[i] - 0.1)) / 0.1);
      const x = i > 0 ? lerp(lineX(i - 1), lineX(i), k) : lineX(i);
      follow = x;
      drawCursor(ctx, clampX(S.x + x - scrollLeft), captionTrack.y + captionTrack.h * 0.55, pi("legendista"), "Legendista");
    }
  }

  // ...and once the crops are on the phone, puts the title and the captions on it.
  if (frame !== null && frame >= fp.title && frame < fp.end && el.phoneCanvas) {
    const PC = rel(el.phoneCanvas);
    const typing = clamp01((frame - fp.title) / 0.8);
    if (frame < fp.title + 0.9) drawCursor(ctx, PC.x + PC.w * (0.2 + 0.6 * typing), PC.y + PC.h * 0.13, pi("legendista"), "Legendista");
    else drawCursor(ctx, PC.x + PC.w * 0.72, PC.y + PC.h * 0.77, pi("legendista"), "Legendista");
  }

  // Câmera: searches the source, crops each piece and carries it to its place on the phone.
  if (B && stage === at("enquadramento") && frame === null) {
    const x = B.x + B.w * (0.3 + 0.4 * (0.5 + 0.5 * Math.sin(now * 1.2)));
    const y = B.y + B.h * (0.3 + 0.4 * (0.5 + 0.5 * Math.cos(now * 0.9)));
    ctx.save();
    ctx.strokeStyle = pi("camera");
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -now * 30;
    const size = 40 + 10 * Math.sin(now * 3);
    ctx.strokeRect(x - size, y - size * 0.6, size * 2, size * 1.2);
    ctx.restore();
    drawCursor(ctx, x, y, pi("camera"), "Câmera");
  } else if (frame !== null && frame < fp.end && el.sourceCanvas && el.phoneCanvas && el.preview && el.preview.videoWidth) {
    const j = currentStep(fp.pieces.map((p) => p.select), frame);
    const step = fp.pieces[j];
    const video = el.preview;
    const sw = video.videoWidth,
      sh = video.videoHeight;
    const piece = layoutPieces(s.clip, sw, sh, PHONE_W, PHONE_H)[j];
    if (step && piece) {
      const C = rel(el.sourceCanvas);
      const cs = C.w / el.sourceCanvas.width;
      const fit = sourceFit(el.sourceCanvas.width, el.sourceCanvas.height, sw, sh);
      const R = {
        x: C.x + (fit.ox + piece.cut.x * fit.k) * cs,
        y: C.y + (fit.oy + piece.cut.y * fit.k) * cs,
        w: piece.cut.w * fit.k * cs,
        h: piece.cut.h * fit.k * cs,
      };
      const PC = rel(el.phoneCanvas);
      const ps = PC.w / PHONE_W;
      const T = { x: PC.x + piece.tile.x * ps, y: PC.y + piece.tile.y * ps, w: piece.tile.w * ps, h: piece.tile.h * ps };
      if (frame < step.hold) {
        const k = ease((frame - step.select) / (step.hold - step.select));
        drawCursor(ctx, R.x + R.w * k, R.y + R.h * k, pi("camera"), "Câmera");
      } else if (frame < step.fly) {
        drawPill(ctx, R.x + R.w / 2, R.y - 14, `recortar ${piece.name.toLowerCase()}`, pi("camera"));
        drawCursor(ctx, R.x + R.w, R.y + R.h, pi("camera"), "Câmera");
      } else if (frame < step.land) {
        const k = ease((frame - step.fly) / (step.land - step.fly));
        const cur = lerpBox(R, T, k);
        drawLink(ctx, { x: R.x + R.w / 2, y: R.y + R.h / 2 }, { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 }, piece.color, now);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 18;
        ctx.drawImage(video, piece.cut.x, piece.cut.y, piece.cut.w, piece.cut.h, cur.x, cur.y, cur.w, cur.h);
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = piece.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(cur.x, cur.y, cur.w, cur.h);
        ctx.restore();
        drawCursor(ctx, cur.x + cur.w - 6, cur.y + cur.h - 6, pi("camera"), "Câmera");
      } else if (frame < step.land + 0.35) {
        ctx.save();
        ctx.globalAlpha = 1 - (frame - step.land) / 0.35;
        ctx.strokeStyle = "white";
        ctx.lineWidth = 3;
        ctx.strokeRect(T.x, T.y, T.w, T.h);
        ctx.restore();
        drawCursor(ctx, T.x + T.w / 2, T.y + T.h / 2, pi("camera"), "Câmera");
      }
    }
  }

  // Montador: fetches the minutes of the source, then renders along the timeline.
  if (stage === at("trecho") && B) {
    const x = B.x + B.w / 2 + Math.sin(now * 2) * 18;
    const y = B.y + B.h / 2;
    ctx.save();
    ctx.strokeStyle = pi("montador");
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(B.x + B.w / 2, y - 26, 12, now * 5, now * 5 + 4.4);
    ctx.stroke();
    ctx.restore();
    drawCursor(ctx, x, y, pi("montador"), "Montador");
  } else if (stage === at("render") && S && videoTrack) {
    const t = s.time ?? ((now * 2) % Math.max(1, s.clip.duration ?? 1));
    const x = contentX(t);
    const left = Math.max(S.x, contentX(0));
    const right = Math.min(S.x + S.w, x);
    if (right > left) {
      ctx.fillStyle = "rgba(251,146,60,0.16)";
      ctx.fillRect(left, videoTrack.y, right - left, videoTrack.h);
    }
    drawCursor(ctx, clampX(x), videoTrack.y + videoTrack.h * 0.55, pi("montador"), "Montador");
  }

  // Revisor: reads the start, the title and the ending of the moment; then gives a verdict.
  if (stage === at("revisao") && S && P) {
    const review = s.clip.review;
    if (review) {
      const verdict = `nota ${review.score}/10 · ${review.changes.length ? "pediu ajuste" : "aprovado"}`;
      drawPill(ctx, P.x + P.w / 2, P.y + P.h * 0.32, verdict, pi("revisor"));
      drawCursor(ctx, P.x + P.w / 2 + 30, P.y + P.h * 0.32 + 8, pi("revisor"), "Revisor");
    } else {
      const y = S.y + S.h / 2;
      const points = [
        { x: S.x + S.w * 0.12, y, label: "começo" },
        { x: P.x + P.w / 2, y: P.y + P.h * 0.12, label: "título" },
        { x: S.x + S.w * 0.85, y, label: "final" },
      ];
      const slot = Math.floor(now / 1.6) % points.length;
      const prev = points[(slot + points.length - 1) % points.length];
      const k = ease((now % 1.6) / 0.5);
      const pos = { x: lerp(prev.x, points[slot].x, k), y: lerp(prev.y, points[slot].y, k) };
      drawMagnifier(ctx, pos.x, pos.y, pi("revisor"));
      if (k >= 1) drawPill(ctx, pos.x - 12, pos.y - 38, `${points[slot].label}?`, pi("revisor"));
      drawCursor(ctx, pos.x, pos.y, pi("revisor"), "Revisor");
    }
  }
  return follow;
}

// ---------- the parts of the show

function Crew({ crew }: { crew: Record<AgentId, CrewMember> | null }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Agentes trabalhando neste corte">
      {AGENTS.map(({ id, name, color }) => {
        const member: CrewMember = crew?.[id] ?? { state: "idle", text: "esperando" };
        const Icon = AGENT_ICONS[id];
        return (
          <li
            key={id}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors",
              member.state === "working" ? "border-white/25 bg-white/[0.07]" : "border-white/10 bg-white/[0.02]",
              member.state === "idle" && "opacity-55",
            )}
          >
            <span className="relative grid size-8 shrink-0 place-items-center rounded-full" style={{ backgroundColor: `${color}26`, color }}>
              <Icon className="size-4" aria-hidden />
              {member.state === "working" && (
                <span className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ boxShadow: `0 0 0 2px ${color}` }} />
              )}
              {member.state === "done" && (
                <span className="absolute -bottom-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-green-500 text-black">
                  <Check className="size-2.5" strokeWidth={3} aria-hidden />
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold" style={member.state === "idle" ? undefined : { color }}>
                {name}
              </span>
              <span className="block truncate text-[11px] text-stone-400" title={member.text}>
                {member.text}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Phone({ clip, canvasRef, finalRef, boxRef }: {
  clip: ShowClip;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  finalRef: React.RefObject<HTMLVideoElement | null>;
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
  const final = clip.stage === "pronto" ? apiUrl(clip.video_url) : null;
  return (
    <div
      ref={boxRef}
      className={cn(
        "relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-[28px] border-[6px] bg-black shadow-2xl transition-colors",
        final ? "border-green-600" : "border-stone-700",
      )}
    >
      {final ? (
        <video ref={finalRef} key={final} src={final} autoPlay muted loop playsInline className="size-full object-cover" />
      ) : clip.preview ? (
        <canvas ref={canvasRef} width={PHONE_W} height={PHONE_H} className="size-full" aria-label="Prévia do corte com o layout e as legendas" />
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

type TimelineRefs = {
  scroll: React.RefObject<HTMLDivElement | null>;
  playhead: React.RefObject<HTMLDivElement | null>;
  lines: React.RefObject<(HTMLSpanElement | null)[]>;
  blocks: React.RefObject<(HTMLDivElement | null)[]>;
  title: React.RefObject<HTMLDivElement | null>;
  titleTrack: React.RefObject<HTMLDivElement | null>;
  videoTrack: React.RefObject<HTMLDivElement | null>;
  captionTrack: React.RefObject<HTMLDivElement | null>;
};

// Pieces, title and caption lines start hidden: the agents put them in place (see the clock).
function Timeline({ clip, lines, refs, onManualScroll }: {
  clip: ShowClip;
  lines: CaptionLine[];
  refs: TimelineRefs;
  onManualScroll: () => void;
}) {
  const duration = clip.duration || 0;
  const blocks = timelineBlocks(clip);
  const width = Math.max(1, duration * PX_PER_SECOND);
  const ready = stageIndex(clip.stage) >= stageIndex("cortes") && duration > 0 && blocks.length > 0;
  const x = (t: number) => t * PX_PER_SECOND;
  const seconds = Math.floor(duration);

  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-stone-900 p-3 text-white">
      <div className="mb-2 flex items-center justify-between text-[11px] text-stone-400">
        <span>Linha do tempo</span>
        {ready && (
          <span className="tabular-nums">
            {duration.toFixed(1)} s · {clip.words?.length ?? 0} palavras · {blocks.length} {blocks.length === 1 ? "pedaço" : "pedaços"} do original
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
          ref={refs.scroll}
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
              <div ref={refs.titleTrack} className="relative h-7 rounded bg-white/5">
                {clip.title && (
                  <div
                    ref={refs.title}
                    className="absolute inset-y-0 flex items-center rounded bg-red-600 px-2 font-semibold"
                    style={{ left: 0, width: x(Math.min(TITLE_SECONDS, duration)), clipPath: "inset(0 100% 0 0)" }}
                    title={clip.title}
                  >
                    <span className="truncate">{clip.title}</span>
                  </div>
                )}
              </div>
              <div ref={refs.videoTrack} className="relative overflow-hidden rounded bg-white/5" style={{ height: TRACK_VIDEO_H }}>
                <Filmstrip clip={clip} width={width} />
                {blocks.map((block) => {
                  const w = x(block.length);
                  return (
                    <div
                      key={block.index}
                      ref={(el) => {
                        refs.blocks.current[block.index] = el;
                      }}
                      className={cn(
                        "absolute inset-y-0 origin-bottom border-x-2",
                        block.teaser ? "border-pink-400 bg-pink-500/20" : "border-violet-400 bg-violet-500/10",
                      )}
                      style={{ left: x(block.left), width: w, opacity: 0 }}
                      title={`${block.label} (original ${clockLabel(block.from)}–${clockLabel(block.to)})`}
                    >
                      {w >= 44 && (
                        <span className="absolute left-1 top-1 max-w-[calc(100%-8px)] truncate rounded bg-black/70 px-1 text-[10px]">{block.label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div ref={refs.captionTrack} className="relative h-9 rounded bg-white/5">
                {lines.map((line, i) => (
                  <span
                    key={`${line.start}-${i}`}
                    ref={(el) => {
                      refs.lines.current[i] = el;
                    }}
                    className="absolute inset-y-1 flex items-center overflow-hidden whitespace-nowrap rounded border border-yellow-500/40 bg-yellow-400/80 px-1 text-[10px] font-semibold text-black data-[active=1]:z-10 data-[active=1]:bg-yellow-300 data-[active=1]:ring-2 data-[active=1]:ring-white"
                    style={{ left: x(line.start), width: Math.max(10, x(line.end - line.start) - 2), opacity: 0 }}
                    title={line.words.map((w) => w.text).join(" ")}
                  >
                    {line.words.map((w) => w.text).join(" ")}
                  </span>
                ))}
              </div>
              <div ref={refs.playhead} className="pointer-events-none absolute bottom-0 top-0 z-20 hidden w-0.5 bg-white shadow-[0_0_6px_white]" />
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
      {!ready && <p className="mt-2 text-[10px] text-stone-500">O Diretor está escolhendo os cortes…</p>}
    </div>
  );
}

function SourceMonitor({ clip, canvasRef, boxRef }: {
  clip: ShowClip;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
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
      <div ref={boxRef}>
        {clip.preview ? (
          <canvas ref={canvasRef} width={640} height={height} className="w-full rounded bg-black" aria-label="Vídeo original com as partes usadas no corte" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center rounded bg-black/60 text-xs text-stone-500">
            {stageIndex(clip.stage) < stageIndex("enquadramento") ? "Esperando o corte…" : "Carregando a prévia…"}
          </div>
        )}
      </div>
    </div>
  );
}

const QUEUE_STYLE: Record<string, string> = {
  pronto: "border-green-500/40 bg-green-500/15 text-green-300",
  montando: "border-violet-400/60 bg-violet-500/20 text-violet-200",
  "na fila": "border-white/10 bg-white/5 text-stone-300",
  falhou: "border-red-500/40 bg-red-500/15 text-red-300",
};

/** When each build started on this page (seconds, performance clock). */
type BuildClock = {
  signature: string;
  key: string;
  cuts: number | null;
  frame: number | null;
  /** The preview shown before a review re-render; the new one starts the framing build. */
  stalePreview: string | null;
  skip: boolean;
};

/** The clip being made right now, with its real content; hidden behind a toggle. */
export function AssemblyShow({ show, message, live = false }: { show: ShowState | null; message: string; live?: boolean }) {
  const [open, setOpen] = useState(true);
  const [crew, setCrew] = useState<Record<AgentId, CrewMember> | null>(null);
  const clip = show?.clip ?? null;
  const previewRef = useRef<HTMLVideoElement>(null);
  const finalRef = useRef<HTMLVideoElement>(null);
  const phoneRef = useRef<HTMLCanvasElement>(null);
  const phoneBoxRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const sourceBoxRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const timelineRefs: TimelineRefs = {
    scroll: useRef<HTMLDivElement>(null),
    playhead: useRef<HTMLDivElement>(null),
    lines: useRef<(HTMLSpanElement | null)[]>([]),
    blocks: useRef<(HTMLDivElement | null)[]>([]),
    title: useRef<HTMLDivElement>(null),
    titleTrack: useRef<HTMLDivElement>(null),
    videoTrack: useRef<HTMLDivElement>(null),
    captionTrack: useRef<HTMLDivElement>(null),
  };
  const refsRef = useRef(timelineRefs);
  const manualUntil = useRef(0);
  const buildRef = useRef<BuildClock>({ signature: "", key: "", cuts: null, frame: null, stalePreview: null, skip: false });
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

  // One clock for everything: the builds, the agents, and the playback (the finished clip once ready, else the preview).
  useEffect(() => {
    let frame = 0;
    let lastActive = -1;
    let lastCrew = "";
    let lastPlay = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const current = clipRef.current;
      const refs = refsRef.current;
      const wrap = wrapRef.current;
      const octx = overlayRef.current && wrap ? fitOverlay(overlayRef.current, wrap) : null;
      if (!current) return;
      const now = performance.now() / 1000;
      const stage = stageIndex(current.stage);
      const build = buildRef.current;
      const blocks = timelineBlocks(current);
      const signature = `${current.key}|${JSON.stringify(current.ranges ?? [])}`;
      if (build.signature !== signature) {
        const fresh = build.key !== current.key;
        // A new clip opened when already finished plays no build; a review re-render plays it again.
        build.stalePreview = fresh ? null : (current.preview ?? null);
        // The agents play even with "reduce motion" on: Windows turns it on with its animations off.
        build.skip = fresh && current.stage === "pronto";
        build.signature = signature;
        build.key = current.key;
        build.cuts = null;
        build.frame = null;
      }
      const cp = cutsPlan(blocks.length, !!current.title, linesRef.current.length);
      if (build.cuts === null && stage >= stageIndex("cortes") && blocks.length && (current.duration ?? 0) > 0) {
        build.cuts = build.skip ? -1e6 : now;
      }
      const preview = previewRef.current;
      const final = finalRef.current;
      const previewReady = !!preview && preview.readyState >= 2 && preview.videoWidth > 0;
      // Autoplay can still be held back (power saving, background tab): ask again now and then.
      if (preview && previewReady && preview.paused && now - lastPlay > 1) {
        lastPlay = now;
        preview.play().catch(() => {});
      }
      if (
        build.frame === null &&
        build.cuts !== null &&
        previewReady &&
        stage >= stageIndex("enquadramento") &&
        current.preview !== build.stalePreview
      ) {
        build.frame = build.skip ? -1e6 : Math.max(now, build.cuts + cp.end);
      }
      const cutsT = build.cuts === null ? null : now - build.cuts;
      const frameT = build.frame === null || now < build.frame ? null : now - build.frame;
      const pieceNames = layoutPieces(current, 16, 9, 9, 16).map((p) => p.name);
      const fp = framePlan(pieceNames.length);

      // The timeline: each piece, the title and each line appear when their agent puts them down.
      const ct = cutsT ?? -1;
      cp.blocks.forEach((step, i) => {
        const el = refs.blocks.current[i];
        if (!el) return;
        const since = ct - step.drop;
        el.style.opacity = since >= 0 ? "1" : "0";
        el.style.transform = since >= 0 && since < 0.22 ? `scaleY(${1 + 0.3 * (1 - since / 0.22)})` : "";
      });
      if (refs.title.current) {
        const k = cp.title ? clamp01((ct - cp.title.start) / (cp.title.end - cp.title.start)) : 1;
        refs.title.current.style.clipPath = `inset(0 ${(1 - k) * 100}% 0 0)`;
      }
      cp.lines.forEach((t, i) => {
        const el = refs.lines.current[i];
        if (!el) return;
        const since = ct - t;
        el.style.opacity = since >= 0 ? "1" : "0";
        el.style.transform = since >= 0 && since < 0.2 ? `translateY(${-8 * (1 - since / 0.2)}px)` : "";
      });

      const clock = final && final.readyState >= 2 ? final : previewReady ? preview : null;
      const time = clock ? clock.currentTime : null;
      if (clock === final && final && preview && previewReady && Math.abs(preview.currentTime - final.currentTime) > 0.4) {
        preview.currentTime = final.currentTime;
      }
      const ft = frameT ?? -1;
      const phone = phoneRef.current?.getContext("2d");
      if (phone && preview && previewReady && clock === preview) {
        drawPhone(phone, preview, current, linesRef.current, {
          landed: fp.pieces.map((p) => ft >= p.land),
          titleK: clamp01((ft - fp.title) / 0.8),
          forceTitle: ft >= fp.title && ft < fp.end + 1.5,
          captions: ft >= fp.title,
        });
      }
      const source = sourceRef.current?.getContext("2d");
      if (source && preview && previewReady) {
        drawSource(
          source,
          preview,
          current,
          fp.pieces.map((p) => ({ k: clamp01((ft - p.select) / (p.hold - p.select)), held: ft >= p.hold, landed: ft >= p.land })),
        );
      }

      // The agents.
      let follow: number | null = null;
      if (octx && wrap && current.stage !== "pronto") {
        follow = drawCrew(
          octx,
          {
            wrap,
            scroller: refs.scroll.current,
            titleTrack: refs.titleTrack.current,
            videoTrack: refs.videoTrack.current,
            captionTrack: refs.captionTrack.current,
            sourceBox: sourceBoxRef.current,
            sourceCanvas: sourceRef.current,
            phoneBox: phoneBoxRef.current,
            phoneCanvas: phoneRef.current,
            preview: previewReady ? preview : null,
          },
          { clip: current, stage, now, time, cuts: cutsT, frame: frameT, cutsPlan: cp, framePlan: fp, blocks, lines: linesRef.current },
        );
      }
      const cam = current.regions?.cam;
      const status = crewStatus({
        stage: current.stage,
        blocks: blocks.length,
        teaser: current.teaser ?? 0,
        lines: linesRef.current.length,
        words: current.words?.length ?? 0,
        title: !!current.title,
        pieces: pieceNames,
        cuts: cutsT,
        frame: frameT,
        duration: current.duration ?? 0,
        review: current.review ?? null,
        webcam: cam ? `webcam em ${Math.round(cam.x * 100)}%, ${Math.round(cam.y * 100)}%` : null,
      });
      const key = JSON.stringify(status);
      if (key !== lastCrew) {
        lastCrew = key;
        setCrew(status);
      }

      // Playhead, and the view following the agents (then the playhead).
      const head = refs.playhead.current;
      const scroller = refs.scroll.current;
      if (head && time !== null) {
        head.style.display = "block";
        head.style.left = `${time * PX_PER_SECOND}px`;
      }
      const target = follow ?? (time !== null ? time * PX_PER_SECOND : null);
      if (scroller && target !== null && performance.now() > manualUntil.current) {
        const view = scroller.clientWidth;
        if (target < scroller.scrollLeft + 16 || target > scroller.scrollLeft + view * 0.75) {
          scroller.scrollLeft = Math.max(0, target - view * 0.25);
        }
      }
      const active = time === null ? -1 : activeLine(linesRef.current, time);
      if (active !== lastActive) {
        refs.lines.current[lastActive]?.setAttribute("data-active", "0");
        refs.lines.current[active]?.setAttribute("data-active", "1");
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
              <Crew crew={crew} />
              <div ref={wrapRef} className="relative">
                {/* Drawn on the canvases. Chrome never autoplays a display:none video, so it stays laid out (1 px, transparent). */}
                {preview && (
                  <video
                    ref={previewRef}
                    key={preview}
                    src={preview}
                    autoPlay
                    muted
                    loop
                    playsInline
                    aria-hidden
                    className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
                  />
                )}
                <div className="grid items-start gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                  <Phone clip={clip} canvasRef={phoneRef} finalRef={finalRef} boxRef={phoneBoxRef} />
                  <div className="min-w-0 space-y-4">
                    <Timeline
                      clip={clip}
                      lines={lines}
                      refs={timelineRefs}
                      onManualScroll={() => {
                        manualUntil.current = performance.now() + 4000;
                      }}
                    />
                    <div className="max-w-[460px]">
                      <SourceMonitor clip={clip} canvasRef={sourceRef} boxRef={sourceBoxRef} />
                    </div>
                  </div>
                </div>
                <canvas ref={overlayRef} className="pointer-events-none absolute left-0 top-0 z-30" aria-hidden />
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
