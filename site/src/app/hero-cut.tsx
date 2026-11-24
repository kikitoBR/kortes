"use client";

import { useEffect, useRef } from "react";

/**
 * Hero: a live (16:9) is cut by the Kortes scissors as you scroll. The game
 * strip and the webcam come off as torn paper and land in a phone, already in
 * the vertical layout, with captions: the whole product in one gesture.
 *
 * Everything is drawn on one canvas from one <video>, so the pieces stay in
 * sync. Scroll position alone decides each frame (no timers), and people who
 * ask for reduced motion see the finished clip.
 */

// The live, 1600x900. Crops are the ones Kortes' webcam detector found on it.
const SRC = { w: 1600, h: 900 };
const CAM = { x: 42, y: 13, w: 343, h: 243 };
const GAME = { x: 378, y: 0, w: 843, h: 900 };
const CAPTION = ["OLHA", "ISSO", "AQUI!"];
const TITLE = "A MISSÃO MAIS TENSA DO GTA 6";

type Rect = { x: number; y: number; w: number; h: number };
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const prog = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeBack = (x: number) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// A torn edge: the same jagged line for both sides of a cut, so they fit.
function tear(seed: number, length: number, step = 14, amp = 5) {
  const pts: number[] = [];
  let s = seed;
  for (let d = 0; d <= length; d += step) {
    s = (s * 9301 + 49297) % 233280;
    pts.push(((s / 233280) * 2 - 1) * amp);
  }
  return pts;
}
const LEFT = tear(11, SRC.h);
const RIGHT = tear(29, SRC.h);
const CAM_TOP = tear(41, CAM.w);
const CAM_SIDE = tear(53, CAM.h);

/** Path of a piece, in source pixels. Torn sides follow the cut lines. */
function strip(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  LEFT.forEach((o, i) => {
    const y = Math.min(SRC.h, i * 14);
    if (i === 0) ctx.moveTo(GAME.x + o, y);
    else ctx.lineTo(GAME.x + o, y);
  });
  for (let i = RIGHT.length - 1; i >= 0; i--) ctx.lineTo(GAME.x + GAME.w + RIGHT[i], Math.min(SRC.h, i * 14));
  ctx.closePath();
}
function cam(ctx: CanvasRenderingContext2D, fresh = true) {
  if (fresh) ctx.beginPath();
  ctx.moveTo(CAM.x, CAM.y);
  CAM_TOP.forEach((o, i) => ctx.lineTo(CAM.x + Math.min(CAM.w, i * 14), CAM.y + o));
  CAM_SIDE.forEach((o, i) => ctx.lineTo(CAM.x + CAM.w + o, CAM.y + Math.min(CAM.h, i * 14)));
  for (let i = CAM_TOP.length - 1; i >= 0; i--) ctx.lineTo(CAM.x + Math.min(CAM.w, i * 14), CAM.y + CAM.h - CAM_TOP[i]);
  for (let i = CAM_SIDE.length - 1; i >= 0; i--) ctx.lineTo(CAM.x - CAM_SIDE[i], CAM.y + Math.min(CAM.h, i * 14));
  ctx.closePath();
}
function leftRest(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  LEFT.forEach((o, i) => ctx.lineTo(GAME.x + o, Math.min(SRC.h, i * 14)));
  ctx.lineTo(0, SRC.h);
  ctx.closePath();
}
function rightRest(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(SRC.w, 0);
  RIGHT.forEach((o, i) => ctx.lineTo(GAME.x + GAME.w + o, Math.min(SRC.h, i * 14)));
  ctx.lineTo(SRC.w, SRC.h);
  ctx.closePath();
}

/** The Kortes scissors, blades opened by `open` (0-1), pointing right. */
function scissors(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number, open: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const k = size / 200;
  ctx.scale(k, k);
  ctx.translate(-150, -86);
  ctx.lineWidth = 16.6;
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,0,0,.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  const pivot = (deg: number, color: string, draw: () => void) => {
    ctx.save();
    ctx.translate(103.5, 86.1);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.translate(-103.5, -86.1);
    ctx.strokeStyle = color;
    draw();
    ctx.restore();
  };
  pivot(-14 * open, "#d6d3d1", () => {
    ctx.beginPath();
    ctx.arc(44.3, 61.1, 25, 0, Math.PI * 2);
    ctx.moveTo(44.3, 86.1);
    ctx.lineTo(103.5, 86.1);
    ctx.moveTo(150, 86.1);
    ctx.lineTo(180.7, 86.1);
    ctx.stroke();
  });
  pivot(14 * open, "#eb5116", () => {
    ctx.beginPath();
    ctx.arc(77.7, 147.3, 25, 0, Math.PI * 2);
    ctx.moveTo(60.02, 129.62);
    ctx.lineTo(156.34, 33.3);
    ctx.stroke();
  });
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(r.x, r.y, r.w, r.h, rad);
    return;
  }
  // older Safari
  const k = Math.min(rad, r.w / 2, r.h / 2);
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, k);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, k);
  ctx.closePath();
}

export function HeroCut() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const intro = useRef<HTMLDivElement>(null);
  const outro = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current!;
    const cv = canvas.current!;
    const vid = video.current!;
    const ctx = cv.getContext("2d")!;
    // The cut follows the scroll, so it runs for everyone (people with reduced
    // motion still drive it themselves); ?still shows the finished clip only.
    const still = new URLSearchParams(location.search).has("still");
    const touch = window.matchMedia("(max-width: 820px)").matches;
    // Without motion the hero is one screen: the headline beside the finished clip.
    el.dataset.still = still ? "1" : "";
    // Canvas text needs the real family name next/font generated.
    const fam = getComputedStyle(el).fontFamily || "system-ui, sans-serif";
    let raf = 0;
    let W = 0;
    let H = 0;
    // The drawn progress chases the scroll position: a mouse wheel moves in
    // big steps, and this turns each step into a glide instead of a jump.
    let shown = -1;
    let last = performance.now();

    const resize = () => {
      // Big desktop canvases are the expensive part: 1.5x is sharp enough.
      const dpr = Math.min(touch ? 2 : 1.5, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      // Phones resize while the address bar hides; ignore small height jumps.
      if (w === W && Math.abs(h - H) < 90 && W) return;
      W = w;
      H = h;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    // A lighter copy of the live for phones.
    vid.src = touch ? "/hero/live-540.mp4" : "/hero/live.mp4";
    vid.play().catch(() => {});

    // Draw only while the hero is on screen (battery and smooth scrolling below).
    let onScreen = true;
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) {
        vid.play().catch(() => {});
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      } else {
        vid.pause();
      }
    });
    io.observe(el);

    const draw = () => {
      if (!onScreen) return;
      raf = requestAnimationFrame(draw);
      const box = el.getBoundingClientRect();
      const scrollable = box.height - window.innerHeight;
      const target = still ? 1 : clamp(-box.top / Math.max(1, scrollable));
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      shown = shown < 0 ? target : shown + (target - shown) * (1 - Math.exp(-dt * (touch ? 5 : 7)));
      if (Math.abs(target - shown) < 0.0004) shown = target;
      const p = shown;
      const mobile = W < 820;

      // Where the live sits, and where the phone ends up.
      // The live starts right under the opening text (offsetTop ignores the scroll transform).
      const introEl = intro.current;
      const below = introEl && !still ? introEl.offsetTop + introEl.offsetHeight + (mobile ? 28 : 20) : H * 0.36;
      const top = Math.min(Math.max(below, H * 0.3), H * 0.72);
      const fw0 = Math.max(240, Math.min(mobile ? W * 0.92 : W * 0.78, (H - top - 24) * (16 / 9)));
      // As the opening text leaves, the live rises to the middle and grows.
      const fw1 = Math.min(mobile ? W * 1.04 : W * 0.84, (H - 140) * (16 / 9));
      const rise = easeInOut(prog(p, 0.03, 0.14));
      const fw = lerp(fw0, fw1, rise);
      const fy = lerp(top, (H - (fw1 * 9) / 16) / 2 + 30, rise);
      const frame: Rect = { x: (W - fw) / 2, y: fy, w: fw, h: (fw * 9) / 16 };
      const s = frame.w / SRC.w;
      const ph = mobile ? H * 0.6 : H * 0.8;
      const pw = (ph * 9) / 16;
      const phone: Rect = { x: mobile ? (W - pw) / 2 : W * (still ? 0.74 : 0.62) - pw / 2, y: mobile ? H * 0.12 : (H - ph) / 2 + 20, w: pw, h: ph };
      const pad = pw * 0.035;
      const screen: Rect = { x: phone.x + pad, y: phone.y + pad, w: pw - pad * 2, h: ph - pad * 2 };
      const camSlot: Rect = { x: screen.x, y: screen.y, w: screen.w, h: (screen.w * 768) / 1080 };
      const gameSlot: Rect = { x: screen.x, y: camSlot.y + camSlot.h, w: screen.w, h: screen.h - camSlot.h };
      const screenRadius = pw * 0.1;

      ctx.clearRect(0, 0, W, H);
      const ready = vid.readyState >= 2;

      // phases
      const cutL = easeInOut(prog(p, 0.1, 0.27));
      const cutR = easeInOut(prog(p, 0.27, 0.42));
      const cutC = easeInOut(prog(p, 0.42, 0.52));
      const fly = easeInOut(prog(p, 0.55, 0.78));
      const fall = prog(p, 0.52, 0.8);
      const phoneIn = easeOut(prog(p, 0.62, 0.8));
      const done = prog(p, 0.8, 1);

      const toScreen = (r: Rect): Rect => ({ x: frame.x + r.x * s, y: frame.y + r.y * s, w: r.w * s, h: r.h * s });
      const piece = (path: (c: CanvasRenderingContext2D) => void, from: Rect, to: Rect, t: number, rot: number, alpha = 1, shadow = 0) => {
        if (!ready || alpha <= 0) return;
        const a = toScreen(from);
        // Land a little larger than the slot, so the torn edges end under the
        // phone's bezel and the two pieces overlap at their seam.
        const bleed = 8;
        const dest = { x: to.x - bleed, y: to.y - bleed, w: to.w + bleed * 2, h: to.h + bleed * 2 };
        const r = { x: lerp(a.x, dest.x, t), y: lerp(a.y, dest.y, t), w: lerp(a.w, dest.w, t), h: lerp(a.h, dest.h, t) };
        const kx = r.w / from.w;
        const ky = r.h / from.h;
        ctx.save();
        // As it lands, the piece is trimmed by the phone's rounded screen.
        const dock = prog(t, 0.78, 1);
        if (dock > 0) {
          const g = (1 - dock) * 80;
          roundRect(ctx, { x: screen.x - g, y: screen.y - g, w: screen.w + g * 2, h: screen.h + g * 2 }, screenRadius + g);
          ctx.clip();
        }
        ctx.globalAlpha = alpha;
        ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
        ctx.rotate(rot);
        ctx.translate(-r.w / 2, -r.h / 2);
        ctx.scale(kx, ky);
        ctx.translate(-from.x, -from.y);
        if (shadow) {
          ctx.save();
          ctx.shadowColor = "rgba(60,20,5,.35)";
          ctx.shadowBlur = (mobile ? 18 : 26) * shadow;
          ctx.shadowOffsetY = 18 * shadow;
          path(ctx);
          ctx.fillStyle = "#000";
          ctx.fill();
          ctx.restore();
        }
        path(ctx);
        ctx.clip();
        ctx.drawImage(vid, 0, 0, SRC.w, SRC.h);
        ctx.restore();
      };

      // phone body behind the pieces
      if (phoneIn > 0) {
        ctx.save();
        ctx.globalAlpha = phoneIn;
        ctx.shadowColor = "rgba(60,20,5,.45)";
        ctx.shadowBlur = 80;
        ctx.shadowOffsetY = 40;
        roundRect(ctx, phone, pw * 0.13);
        ctx.fillStyle = "#0f0f10";
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = phoneIn;
        roundRect(ctx, screen, screenRadius);
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.restore();
      }

      // remnants fall away once the cuts are done
      const fallL = { x: -fall * W * 0.12, y: fall * fall * H * 0.9 };
      const fallAlpha = 1 - clamp((fall - 0.4) / 0.6);
      if (ready && fallAlpha > 0) {
        for (const [path, dx, dy, rot] of [
          [leftRest, fallL.x - 4 * cutL, fallL.y, -0.5 * fall],
          [rightRest, -fallL.x + 4 * cutR, fallL.y * 1.1, 0.45 * fall],
        ] as const) {
          ctx.save();
          ctx.globalAlpha = fallAlpha;
          ctx.translate(frame.x + frame.w / 2 + dx, frame.y + frame.h / 2 + dy);
          ctx.rotate(rot);
          ctx.translate(-frame.w / 2, -frame.h / 2);
          ctx.scale(s, s);
          ctx.save();
          ctx.shadowColor = "rgba(60,20,5,.25)";
          ctx.shadowBlur = mobile ? 12 : 20;
          ctx.shadowOffsetY = mobile ? 6 : 14;
          path(ctx);
          ctx.fillStyle = "#000";
          ctx.fill();
          ctx.restore();
          path(ctx);
          // the webcam leaves a hole in the left piece once it is cut out
          if (path === leftRest && cutC > 0.98) {
            cam(ctx, false);
          }
          ctx.clip("evenodd");
          ctx.drawImage(vid, 0, 0, SRC.w, SRC.h);
          ctx.restore();
        }
      }

      // the game strip and the webcam travel into the phone
      const lift = Math.sin(Math.PI * fly) * 0.06;
      piece(strip, GAME, gameSlot, fly, lerp(0, -0.05, Math.sin(Math.PI * fly)), 1, 0.4 + lift * 6);
      if (cutC > 0) piece(cam, CAM, camSlot, fly, lerp(0, 0.08, Math.sin(Math.PI * fly)), 1, 0.6);

      // live chrome on the frame before the cut
      const liveA = 1 - clamp(fall * 3);
      if (liveA > 0) {
        ctx.save();
        ctx.globalAlpha = liveA;
        const bx = frame.x + frame.w - 14 - 128;
        roundRect(ctx, { x: bx, y: frame.y + 14, w: 128, h: 38 }, 10);
        ctx.fillStyle = "#e5172f";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `800 17px ${fam}`;
        ctx.textBaseline = "middle";
        ctx.fillText(Date.now() % 1000 < 600 ? "● AO VIVO" : "   AO VIVO", bx + 16, frame.y + 34);
        ctx.restore();
      }

      // cut lines: dashed guide ahead of the scissors, a light seam behind
      const seam = (x: number, from: number, to: number, a: number) => {
        ctx.save();
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
        ctx.setLineDash([10, 9]);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, from);
        ctx.lineTo(x, to);
        ctx.stroke();
        ctx.restore();
      };
      const guideA = clamp(prog(p, 0.04, 0.1)) * (1 - clamp(fall * 4));
      if (guideA > 0) {
        const lx = frame.x + GAME.x * s;
        const rx = frame.x + (GAME.x + GAME.w) * s;
        seam(lx, frame.y + frame.h * cutL, frame.y + frame.h, guideA);
        seam(rx, frame.y, frame.y + frame.h * (1 - cutR), guideA);
      }

      // the scissors themselves
      const size = mobile ? 70 : 110;
      const open = Math.abs(Math.sin(p * 120));
      let sc: { x: number; y: number; a: number } | null = null;
      if (p > 0.05 && p < 0.27) sc = { x: frame.x + GAME.x * s, y: frame.y + frame.h * cutL, a: Math.PI / 2 };
      else if (p >= 0.27 && p < 0.42) sc = { x: frame.x + (GAME.x + GAME.w) * s, y: frame.y + frame.h * (1 - cutR), a: -Math.PI / 2 };
      else if (p >= 0.42 && p < 0.54) {
        // around the webcam: top edge, then down its right side
        const c = cutC;
        const r = toScreen(CAM);
        sc = c < 0.5
          ? { x: lerp(r.x, r.x + r.w, c * 2), y: r.y + r.h, a: 0 }
          : { x: r.x + r.w, y: lerp(r.y + r.h, r.y, (c - 0.5) * 2), a: -Math.PI / 2 };
      }
      if (sc) {
        const fadeIn = clamp(prog(p, 0.05, 0.09)) * (1 - clamp(prog(p, 0.52, 0.55)));
        ctx.save();
        ctx.globalAlpha = fadeIn;
        scissors(ctx, sc.x, sc.y, size, sc.a, open);
        ctx.restore();
      }

      // captions and title on the finished clip
      if (done > 0) {
        const fs = screen.w * 0.085;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        const wordsShown = Math.min(CAPTION.length, Math.floor(done * 3.2 * CAPTION.length));
        const words = CAPTION.slice(0, Math.max(1, wordsShown));
        ctx.font = `900 ${fs}px ${fam}`;
        const text = words.join(" ");
        const cx = screen.x + screen.w / 2;
        const cy = gameSlot.y + gameSlot.h * 0.55;
        const pop = easeBack(clamp((done * 3.2 * CAPTION.length) % 1 || 1));
        ctx.translate(cx, cy);
        ctx.scale(lerp(0.9, 1, clamp(pop)), lerp(0.9, 1, clamp(pop)));
        ctx.lineWidth = fs * 0.22;
        ctx.strokeStyle = "#000";
        ctx.strokeText(text, 0, 0);
        const before = words.slice(0, -1).join(" ");
        const last = words[words.length - 1];
        const full = ctx.measureText(text).width;
        const bw = before ? ctx.measureText(before + " ").width : 0;
        ctx.textAlign = "left";
        ctx.fillStyle = "#fff";
        if (before) ctx.fillText(before + " ", -full / 2, 0);
        ctx.fillStyle = "#ffd400";
        ctx.fillText(last, -full / 2 + bw, 0);
        ctx.restore();

        const tc = Math.round(clamp(done * 2) * TITLE.length);
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const tfs = screen.w * 0.068;
        ctx.font = `900 ${tfs}px ${fam}`;
        ctx.lineWidth = tfs * 0.2;
        ctx.strokeStyle = "#000";
        ctx.lineJoin = "round";
        const lines = ["A MISSÃO MAIS TENSA", "DO GTA 6"];
        let left = tc;
        lines.forEach((line, i) => {
          const part = line.slice(0, Math.max(0, left));
          left -= line.length + 1;
          const y = screen.y + screen.h * 0.06 + i * tfs * 1.1;
          ctx.strokeText(part, screen.x + screen.w / 2, y);
          ctx.fillStyle = "#fff";
          ctx.fillText(part, screen.x + screen.w / 2, y);
        });
        ctx.restore();
      }

      // DOM text in and out
      if (intro.current && !still) {
        const o = 1 - clamp(prog(p, 0.04, 0.16));
        intro.current.style.opacity = String(o);
        intro.current.style.transform = `translateY(${-p * 120}px)`;
        intro.current.style.visibility = o <= 0 ? "hidden" : "visible";
      }
      if (outro.current && !still) {
        const o = easeOut(prog(p, 0.74, 0.9));
        outro.current.style.opacity = String(o);
        outro.current.style.transform = `translateY(${(1 - o) * 40}px)`;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <section ref={wrap} className="lp-hero" aria-label="Kortes corta a live enquanto ela acontece">
      <div className="lp-hero-sticky">
        <canvas ref={canvas} className="lp-hero-canvas" aria-hidden />
        {/* Kept rendered (not display:none): iOS only decodes frames of a video in the layout. */}
        <video ref={video} className="lp-hero-src" poster="/hero/live-poster.jpg" muted loop playsInline autoPlay preload="auto" aria-hidden />
        <div ref={intro} className="lp-hero-intro">
          <p className="lp-eyebrow"><span className="lp-live-dot" /> Twitch, Kick e YouTube</p>
          <h1 className="lp-h1">Corte a live <span>enquanto ela acontece.</span></h1>
          <p className="lp-lead">Cole o link da live. A IA do Kortes acha os momentos virais e entrega o corte vertical pronto, com legenda e título, em minutos.</p>
          <div className="lp-cta-row">
            <a className="lp-btn" href="#baixar">Baixar para Windows</a>
            <a className="lp-btn lp-btn-ghost" href="#como-funciona">Ver como funciona</a>
          </div>
          <p className="lp-trust">IA inclusa · sem créditos · Windows 10 e 11</p>
          <p className="lp-scroll-hint">role para cortar ✂</p>
        </div>
        <div ref={outro} className="lp-hero-outro">
          <p className="lp-eyebrow">3 minutos depois do momento</p>
          <h2 className="lp-h2">Da live ao corte vertical. <span>Sozinho.</span></h2>
          <ul className="lp-checks">
            <li>Webcam e jogo enquadrados automaticamente</li>
            <li>Legenda palavra a palavra</li>
            <li>Título que prende nos primeiros segundos</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
