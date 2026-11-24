"use client";

import { useEffect, useRef } from "react";

/**
 * "Bastidores": the Kortes crew assembling a clip, like the app's assembly show.
 * Câmera frames the live, Diretor drops the moments on the timeline, Montador
 * types the title, Legendista syncs the captions, and the phone shows the clip
 * taking shape. A 10 s loop that runs while the section is on screen; the live
 * and the phone are drawn from one video so they stay in sync.
 */

const SRC = { w: 1600, h: 900 };
const CAM = { x: 42, y: 13, w: 343, h: 243 };
const GAME = { x: 378, y: 0, w: 843, h: 900 };
const FACE = { x: 180, y: 103, w: 70, h: 91 };
const TITLE = "A MISSÃO MAIS TENSA DO GTA 6";
const CAPS = ["OLHA", "ISSO", "AQUI!"];
const LOOP = 10;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const back = (x: number) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// when each crew member works, in loop seconds
const STAGES = [
  { who: "Câmera", color: "#2f6fed", from: 0.6, to: 2.6, doing: "enquadrando webcam e jogo" },
  { who: "Diretor", color: "#eb5116", from: 2.6, to: 4.6, doing: "levando os trechos para a linha do tempo" },
  { who: "Montador", color: "#12a150", from: 4.6, to: 6.0, doing: "escrevendo o título" },
  { who: "Legendista", color: "#d6336c", from: 6.0, to: 7.6, doing: "sincronizando a legenda" },
];

export function Backstage() {
  const root = useRef<HTMLDivElement>(null);
  const mon = useRef<HTMLCanvasElement>(null);
  const phone = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = root.current!;
    const vid = video.current!;
    const mc = mon.current!;
    const pc = phone.current!;
    const m = mc.getContext("2d")!;
    const p = pc.getContext("2d")!;
    const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const $$ = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
    const fam = getComputedStyle(el).fontFamily;
    const touch = window.matchMedia("(max-width: 820px)").matches;
    vid.src = touch ? "/hero/live-540.mp4" : "/hero/live.mp4";

    let raf = 0;
    let start = performance.now();
    let on = false;

    const fit = (cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    };

    const draw = () => {
      if (!on) return;
      raf = requestAnimationFrame(draw);
      const t = ((performance.now() - start) / 1000) % LOOP;
      const ready = vid.readyState >= 2;
      const fade = Math.min(prog(t, 0, 0.5), 1 - prog(t, LOOP - 0.5, LOOP));

      // --- source monitor with the Câmera's boxes
      const M = fit(mc, m);
      m.clearRect(0, 0, M.w, M.h);
      if (ready) m.drawImage(vid, 0, 0, M.w, M.h);
      const sx = M.w / SRC.w;
      const box = (r: typeof CAM, k: number, color: string, dashed = false, label = "") => {
        if (k <= 0) return;
        m.save();
        m.globalAlpha = k;
        m.strokeStyle = color;
        m.lineWidth = 3;
        if (dashed) m.setLineDash([9, 7]);
        const g = (1 - k) * 18;
        m.strokeRect(r.x * sx - g, r.y * sx - g, r.w * sx + g * 2, r.h * sx + g * 2);
        if (label) {
          m.setLineDash([]);
          m.font = `700 12px ${fam}`;
          const tw = m.measureText(label).width + 12;
          m.fillStyle = color;
          m.fillRect(r.x * sx, (r.y + r.h) * sx + 4, tw, 20);
          m.fillStyle = color === "#fff" ? "#111" : "#fff";
          m.fillText(label, r.x * sx + 6, (r.y + r.h) * sx + 18);
        }
        m.restore();
      };
      box(FACE, ease(prog(t, 0.8, 1.2)) * (1 - prog(t, 1.6, 1.9)), "#fff", false, "rosto");
      box(CAM, ease(prog(t, 1.2, 1.7)), "#eb5116", false, "webcam");
      box(GAME, ease(prog(t, 1.7, 2.2)), "#fff", true, "jogo");

      // --- phone: the clip taking shape
      const P = fit(pc, p);
      p.clearRect(0, 0, P.w, P.h);
      p.fillStyle = "#000";
      p.fillRect(0, 0, P.w, P.h);
      const camH = (P.w * 768) / 1080;
      const slot = (r: typeof CAM, y: number, h: number, k: number) => {
        if (!ready || k <= 0) return;
        p.save();
        p.globalAlpha = k;
        p.beginPath();
        p.rect(0, y, P.w, h);
        p.clip();
        const sc = Math.max(P.w / r.w, h / r.h);
        const dw = r.w * sc;
        const dh = r.h * sc;
        const ox = (P.w - dw) / 2;
        const oy = y + (h - dh) / 2;
        p.translate(0, (1 - k) * 30);
        p.drawImage(vid, r.x, r.y, r.w, r.h, ox, oy, dw, dh);
        p.restore();
      };
      slot(CAM, 0, camH, ease(prog(t, 1.9, 2.4)));
      slot(GAME, camH, P.h - camH, ease(prog(t, 2.2, 2.7)));
      if (prog(t, 1.9, 2.4) === 0) {
        p.fillStyle = "rgba(255,255,255,.55)";
        p.font = `600 13px ${fam}`;
        p.textAlign = "center";
        p.fillText("montando o corte…", P.w / 2, P.h / 2);
      }
      const text = (str: string, y: number, size: number, color: string, last?: string) => {
        p.save();
        p.font = `900 ${size}px ${fam}`;
        p.textAlign = "left";
        p.textBaseline = "middle";
        p.lineJoin = "round";
        p.lineWidth = size * 0.22;
        p.strokeStyle = "#000";
        const full = str + (last ? (str ? " " : "") + last : "");
        const w = p.measureText(full).width;
        const x = (P.w - w) / 2;
        p.strokeText(full, x, y);
        p.fillStyle = color;
        p.fillText(str, x, y);
        if (last) {
          p.fillStyle = "#ffd400";
          p.fillText(last, x + (str ? p.measureText(str + " ").width : 0), y);
        }
        p.restore();
      };
      const tc = Math.round(prog(t, 4.8, 5.8) * TITLE.length);
      if (tc) {
        const a = TITLE.slice(0, Math.min(tc, 19));
        const b = tc > 20 ? TITLE.slice(20, tc) : "";
        text(a, camH * 0.12, P.w * 0.068, "#fff");
        if (b) text(b, camH * 0.12 + P.w * 0.078, P.w * 0.068, "#fff");
      }
      const cw = Math.floor(prog(t, 6.3, 7.4) * CAPS.length * 1.0001);
      if (t > 6.3) {
        const shown = CAPS.slice(0, Math.max(1, cw));
        text(shown.slice(0, -1).join(" "), camH + (P.h - camH) * 0.58, P.w * 0.085, "#fff", shown[shown.length - 1]);
      }

      // --- DOM: crew, timeline, cursors, done badge
      el.style.setProperty("--fade", String(fade));
      $$(".bs-crew li").forEach((li, i) => {
        const s = STAGES[i];
        const state = t < s.from ? "wait" : t < s.to ? "work" : "done";
        if (li.dataset.state !== state) {
          li.dataset.state = state;
          li.querySelector(".bs-st")!.textContent = state === "wait" ? "na fila" : state === "work" ? "trabalhando…" : "pronto ✓";
        }
      });
      const now = STAGES.find((s) => t >= s.from && t < s.to);
      const label = $<HTMLElement>(".bs-now");
      const want = now ? `${now.who} ${now.doing}` : t >= 7.6 ? "Corte pronto para postar" : "Lendo a live…";
      if (label.textContent !== want) label.textContent = want;

      // Diretor drops 3 moments onto the video lane
      $$(".bs-piece").forEach((pc2, i) => {
        const s = 2.8 + i * 0.5;
        const k = ease(prog(t, s, s + 0.5));
        pc2.style.opacity = t > s ? "1" : "0";
        pc2.style.transform = `translate(${(1 - k) * (40 - i * 30)}px, ${(1 - k) * -120}px) scale(${lerp(1.15, 1, k)})`;
      });
      // Montador's title block grows as it types
      const tb = $<HTMLElement>(".bs-title");
      tb.style.width = `${prog(t, 4.8, 5.8) * 100}%`;
      tb.textContent = TITLE.slice(0, tc);
      tb.style.display = tc ? "flex" : "none";
      // Legendista's caption blocks
      $$(".bs-cap").forEach((c, i) => {
        const s = 6.2 + i * 0.35;
        const k = back(clamp((t - s) / 0.45));
        c.style.opacity = String(clamp((t - s) / 0.15));
        c.style.transform = `translateY(${(1 - clamp(k)) * -24}px) scale(${lerp(0.7, 1, clamp(k))})`;
      });
      // playhead
      $<HTMLElement>(".bs-head").style.left = `calc((100% - var(--lab)) * ${prog(t, 2.6, 7.8)})`;
      // the working agent's cursor
      const cur = $<HTMLElement>(".bs-cursor");
      if (now) {
        cur.style.opacity = "1";
        cur.style.setProperty("--c", now.color);
        cur.querySelector("span")!.textContent = now.who;
        const k = prog(t, now.from, now.to);
        const lanes = $<HTMLElement>(".bs-lanes").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const monR = mc.getBoundingClientRect();
        let x = 0;
        let y = 0;
        if (now.who === "Câmera") {
          x = monR.left - r.left + monR.width * lerp(0.12, 0.62, ease(k));
          y = monR.top - r.top + monR.height * lerp(0.3, 0.85, ease(k));
        } else {
          const lane = now.who === "Diretor" ? 0 : now.who === "Montador" ? 1 : 2;
          const lx = lanes.left - r.left + 110;
          const lw = lanes.width - 120;
          x = lx + lw * (now.who === "Diretor" ? Math.min(0.95, Math.floor(prog(t, 2.8, 4.3) * 3) / 3 + 0.16) : ease(k) * 0.92);
          y = lanes.top - r.top + 22 + lane * 52;
        }
        // keep the cursor and its name inside the window
        x = Math.min(x, r.width - 130);
        cur.style.transform = `translate(${x}px, ${y}px)`;
      } else cur.style.opacity = "0";
      const done = $<HTMLElement>(".bs-done");
      const dk = back(clamp((t - 7.7) / 0.5));
      done.style.opacity = String(clamp((t - 7.7) / 0.2) * (1 - prog(t, LOOP - 0.5, LOOP)));
      done.style.transform = `scale(${lerp(0.6, 1, clamp(dk))})`;
    };

    const io = new IntersectionObserver(([e]) => {
      const was = on;
      on = e.isIntersecting;
      if (on && !was) {
        start = performance.now();
        vid.play().catch(() => {});
        raf = requestAnimationFrame(draw);
      } else if (!on) {
        vid.pause();
        cancelAnimationFrame(raf);
      }
    }, { threshold: 0.25 });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={root} className="bs lp-glass">
      <video ref={video} className="lp-hero-src" muted loop playsInline preload="metadata" aria-hidden />
      <div className="bs-bar">
        <span className="bs-rec" /> <b>Bastidores</b> <span className="bs-muted">· montando o corte 1</span>
        <span className="bs-now">Lendo a live…</span>
      </div>
      <div className="bs-body">
        <div className="bs-left">
          <div className="bs-mon"><canvas ref={mon} aria-label="Live de GTA 6 sendo enquadrada" /></div>
          <ol className="bs-crew">
            {STAGES.map((s) => (
              <li key={s.who} style={{ ["--c" as string]: s.color }} data-state="wait">
                <i /> <b>{s.who}</b> <span className="bs-st">na fila</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="bs-phone">
          <canvas ref={phone} aria-label="O corte vertical tomando forma" />
          <div className="bs-done">✓ Pronto</div>
        </div>
      </div>
      <div className="bs-lanes">
        <div className="bs-lane"><span>Vídeo</span><div>
          {[1, 2, 3].map((i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} className="bs-piece" src={`/hero/thumb${i}.jpg`} alt="" />
          ))}
        </div></div>
        <div className="bs-lane"><span>Título</span><div><b className="bs-title" /></div></div>
        <div className="bs-lane"><span>Legenda</span><div>
          {CAPS.map((c) => <b key={c} className="bs-cap">{c}</b>)}
        </div></div>
        <i className="bs-head" />
      </div>
      <div className="bs-cursor"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.6L9.8 19z" fill="var(--c)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" /></svg><span /></div>
    </div>
  );
}
