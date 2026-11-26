"use client";

import { cn } from "@/lib/utils";
import {
  splitTitleLines,
  TITLE_COLORS,
  TITLE_DURATIONS,
  TITLE_POSITIONS,
  TITLE_PRESETS,
  TITLE_SIZES,
  titleCenter,
  titleScale,
  type TitleStyle,
} from "@/lib/title-style";

const WEBCAM_TOP = new Set(["vertical_gameplay"]);
const WEBCAM_BOTTOM = new Set(["vertical_gameplay_bottom"]);
const SAMPLE_TITLE = "Jason quer mostrar profissionalismo sem matar ninguém";

/** One title block drawn like the server draws it (captions.build_hook_title_ass), in CSS. */
function TitleBlock({ style, width, height, outputFormat, text }: {
  style: TitleStyle; width: number; height: number; outputFormat?: string; text: string;
}) {
  const boxed = style.preset === "faixa" || style.preset === "duas_cores" || style.preset === "faixa_cor";
  const upper = boxed;
  const shown = upper ? text.toUpperCase() : text;
  const scale = titleScale(style);
  const charW = upper ? 0.6 : 0.54;
  const usable = width * 0.86;
  const target = width * 0.068 * scale;
  const lines = splitTitleLines(shown, Math.max(10, Math.floor(usable / (target * charW))));
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const px = Math.max(width * 0.04, Math.min((usable * 0.92) / (longest * charW), width * 0.085 * scale));
  const pad = Math.max(width * (8 / 1080), px / 4);
  const step = boxed ? px * 1.12 + pad * 1.7 : px * 1.14;
  const block = step * lines.length;
  let center = titleCenter(style, outputFormat) * height;
  center = Math.min(Math.max(center, 0.05 * height + block / 2), Math.max(0.05 * height + block / 2, 0.95 * height - block / 2));

  return (
    <div className="pointer-events-none absolute inset-x-0" style={{ top: center - block / 2 }}>
      {lines.map((line, index) => {
        const last = index === lines.length - 1;
        let color = "#fff";
        let background: string | undefined;
        let outline: string | undefined;
        if (style.preset === "faixa") background = "rgba(0,0,0,0.78)";
        if (style.preset === "faixa_cor") background = style.color;
        if (style.preset === "duas_cores") {
          background = last ? style.color : "#fff";
          color = last ? "#fff" : "#000";
        }
        if (style.preset === "destaque") {
          color = style.color;
          outline = `${Math.max(1.5, px / 7)}px`;
        }
        if (style.preset === "classico") outline = `${Math.max(1, px / 11)}px`;
        return (
          <div key={index} className="flex justify-center" style={{ height: step }}>
            <span
              className="self-center whitespace-nowrap font-extrabold leading-none"
              style={{
                fontFamily: "var(--font-poppins), Poppins, system-ui, sans-serif",
                fontSize: px,
                color,
                background,
                padding: background ? `${pad * 0.55}px ${pad}px` : undefined,
                WebkitTextStroke: outline ? `${outline} #000` : undefined,
                paintOrder: "stroke fill",
                textShadow: outline ? "0 2px 3px rgba(0,0,0,0.45)" : undefined,
              }}
            >
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A phone with the layout's picture, a caption line and the title, as it will be rendered. */
export function TitlePreview({ style, outputFormat, width = 216, text = SAMPLE_TITLE, image }: {
  style: TitleStyle; outputFormat?: string; width?: number; text?: string; image?: string;
}) {
  const height = (width * 16) / 9;
  const camTop = WEBCAM_TOP.has(outputFormat ?? "");
  const camBottom = WEBCAM_BOTTOM.has(outputFormat ?? "");
  const webcam = "linear-gradient(160deg,#4a3a33,#2a201c)";
  const game = "linear-gradient(180deg,#3d7fb0,#24557d 60%,#1d4566)";
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-[22px] border-4 border-neutral-900 bg-neutral-800 shadow-xl"
      style={{ width, height }}
      aria-label="Prévia do título"
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="absolute inset-0 size-full object-cover" />
      ) : camTop || camBottom ? (
        <>
          <div className="absolute inset-x-0" style={{ top: camTop ? 0 : "60%", height: "40%", background: webcam }}>
            <div className="absolute left-1/2 top-[30%] size-[34%] -translate-x-1/2 rounded-full bg-[#c99a7d]/70" />
          </div>
          <div className="absolute inset-x-0" style={{ top: camTop ? "40%" : 0, height: "60%", background: game }}>
            <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(#fff3_1px,transparent_1px),linear-gradient(90deg,#fff3_1px,transparent_1px)] [background-size:18px_18px]" />
          </div>
        </>
      ) : (
        <div className="absolute inset-0" style={{ background: "linear-gradient(170deg,#5a4a42,#2c2421 55%,#1b1614)" }}>
          <div className="absolute left-1/2 top-[22%] size-[46%] -translate-x-1/2 rounded-full bg-[#c99a7d]/60" />
        </div>
      )}
      {image ? null : (
        <div className="absolute inset-x-0 top-[73%] text-center font-extrabold text-white" style={{ fontSize: width * 0.07, textShadow: "0 0 3px #000,0 2px 4px #000" }}>
          e aí, <span className="text-yellow-300">galera</span>
        </div>
      )}
      <TitleBlock style={style} width={width - 8} height={height - 8} outputFormat={outputFormat} text={text} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={cn(
            "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
            value === option.id ? "border-foreground bg-accent/60 ring-1 ring-foreground" : "hover:bg-accent/40",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Band style, position, colour, size and duration of the title, with the live preview beside. */
export function TitleStylePicker({ value, onChange, outputFormat, disabled, text, image, showPreview = true, showDuration = true }: {
  value: TitleStyle;
  onChange: (next: TitleStyle) => void;
  outputFormat?: string;
  disabled?: boolean;
  text?: string;
  image?: string;
  /** Off when the page shows its own preview (the cover, rendered by the server). */
  showPreview?: boolean;
  showDuration?: boolean;
}) {
  const set = <K extends keyof TitleStyle>(key: K, next: TitleStyle[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      {showPreview ? (
        <div className="flex justify-center sm:sticky sm:top-4">
          <TitlePreview style={value} outputFormat={outputFormat} text={text} image={image} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Estilo da faixa</p>
          <div className="grid grid-cols-2 gap-2">
            {TITLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                onClick={() => set("preset", preset.id)}
                aria-pressed={value.preset === preset.id}
                className={cn(
                  "rounded-xl border p-2 text-left transition-colors disabled:opacity-50",
                  value.preset === preset.id ? "border-foreground ring-1 ring-foreground" : "hover:bg-accent/40",
                )}
              >
                <PresetSwatch preset={preset.id} color={value.color} />
                <span className="mt-1.5 block text-xs font-semibold">{preset.label}</span>
                <span className="block text-[11px] leading-tight text-muted-foreground">{preset.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Posição</p>
          <Segmented value={value.position} options={TITLE_POSITIONS} onChange={(next) => set("position", next)} disabled={disabled} />
          {value.position === "auto" ? (
            <p className="text-[11px] text-muted-foreground">Na linha entre a webcam e o jogo; no topo nos outros formatos.</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Cor</p>
          <div className="flex flex-wrap items-center gap-2">
            {TITLE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                disabled={disabled}
                onClick={() => set("color", color)}
                aria-label={`Cor ${color}`}
                aria-pressed={value.color === color}
                className={cn("size-7 rounded-full border-2 transition-transform hover:scale-110", value.color === color ? "border-foreground" : "border-transparent")}
                style={{ background: color, boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.35)" }}
              />
            ))}
            <label className="relative size-7 cursor-pointer overflow-hidden rounded-full border border-dashed" title="Outra cor">
              <input type="color" value={value.color} disabled={disabled} onChange={(event) => set("color", event.target.value.toUpperCase())} className="absolute -inset-2 size-12 cursor-pointer opacity-0" />
              <span className="flex size-full items-center justify-center text-xs text-muted-foreground">+</span>
            </label>
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Tamanho</p>
            <Segmented value={value.size} options={TITLE_SIZES} onChange={(next) => set("size", next)} disabled={disabled} />
          </div>
          {showDuration ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Aparece</p>
              <Segmented value={value.duration} options={TITLE_DURATIONS} onChange={(next) => set("duration", next)} disabled={disabled} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PresetSwatch({ preset, color }: { preset: TitleStyle["preset"]; color: string }) {
  const bar = "inline-block px-1 text-[8px] font-extrabold leading-[13px] uppercase";
  return (
    <div className="flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg bg-gradient-to-b from-[#3d7fb0] to-[#1d4566]">
      {preset === "duas_cores" ? (
        <>
          <span className={cn(bar, "bg-white text-black")}>Título</span>
          <span className={bar} style={{ background: color, color: "#fff" }}>do corte</span>
        </>
      ) : preset === "faixa_cor" ? (
        <>
          <span className={bar} style={{ background: color, color: "#fff" }}>Título</span>
          <span className={bar} style={{ background: color, color: "#fff" }}>do corte</span>
        </>
      ) : preset === "faixa" ? (
        <>
          <span className={cn(bar, "bg-black/80 text-white")}>Título</span>
          <span className={cn(bar, "bg-black/80 text-white")}>do corte</span>
        </>
      ) : (
        <span
          className="text-[11px] font-extrabold"
          style={{ color: preset === "destaque" ? color : "#fff", WebkitTextStroke: "1px #000", paintOrder: "stroke fill" }}
        >
          Título do corte
        </span>
      )}
    </div>
  );
}
