"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Facecam box as 0-1 fractions of the source frame. */
export type WebcamRegion = { x: number; y: number; w: number; h: number };

/** Top tile of the gameplay layout (1080x768): the box keeps this aspect. */
const CAM_ASPECT = 1080 / 768;
const MIN_W = 0.06;
/** Where in the video each frame choice is taken from. */
const FRAME_POSITIONS = [0.25, 0.5, 0.75];
const FRAME_LABELS = ["Início", "Meio", "Fim"];

type Drag = { mode: "move" | "resize"; startX: number; startY: number; origin: WebcamRegion };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** YouTube answers a missing maxres still with a 120x90 placeholder or a 404. */
const fallbackFrame = (src: string) =>
  src.includes("/maxres") ? src.replace(/\/maxres(\d)\.jpg/, "/mq$1.jpg") : null;

/**
 * Lets the user mark where the streamer's webcam sits on a real frame of the
 * source video. The box is locked to the gameplay layout's top-tile aspect so
 * what they mark is exactly what ends up on top of the clip.
 */
export function WebcamRegionPicker({
  frames,
  videoFile,
  videoSrc,
  value,
  onChange,
}: {
  /** Still images of the video (YouTube auto frames). */
  frames?: string[];
  /** Local upload; frames are seeked from the file itself. */
  videoFile?: File | null;
  /** Video already on the server (the clip editor's source cut). */
  videoSrc?: string | null;
  value: WebcamRegion | null;
  onChange: (region: WebcamRegion | null) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [frameAspect, setFrameAspect] = useState(16 / 9);
  const [frameIndex, setFrameIndex] = useState(0);
  const [imageSrc, setImageSrc] = useState<string | null>(frames?.[0] ?? null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const videoUrl = fileUrl ?? videoSrc ?? null;

  const frameCount = videoUrl ? FRAME_POSITIONS.length : frames?.length ?? 0;

  useEffect(() => {
    setImageSrc(frames?.[frameIndex] ?? null);
  }, [frames, frameIndex]);

  useEffect(() => {
    if (!videoFile) {
      setFileUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(videoFile);
    setFileUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [videoFile]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = video.duration * FRAME_POSITIONS[frameIndex];
    }
  }, [frameIndex]);

  // Height fraction that keeps the box at CAM_ASPECT in real pixels.
  const heightFor = (w: number) => (w * frameAspect) / CAM_ASPECT;

  const fit = (region: WebcamRegion): WebcamRegion => {
    let w = clamp(region.w, MIN_W, 1);
    let h = heightFor(w);
    if (h > 1) {
      h = 1;
      w = CAM_ASPECT / frameAspect;
    }
    return { x: clamp(region.x, 0, 1 - w), y: clamp(region.y, 0, 1 - h), w, h };
  };

  const pointerFraction = (event: React.PointerEvent) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { fx: 0, fy: 0 };
    return {
      fx: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      fy: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const startDrag = (event: React.PointerEvent, mode: Drag["mode"], origin: WebcamRegion) => {
    event.preventDefault();
    event.stopPropagation();
    frameRef.current?.setPointerCapture(event.pointerId);
    const { fx, fy } = pointerFraction(event);
    dragRef.current = { mode, startX: fx, startY: fy, origin };
  };

  const onFramePointerDown = (event: React.PointerEvent) => {
    // Clicking empty space drops a new box centred on the pointer.
    const { fx, fy } = pointerFraction(event);
    const w = 0.24;
    const next = fit({ x: fx - w / 2, y: fy - heightFor(w) / 2, w, h: heightFor(w) });
    onChange(next);
    startDrag(event, "move", next);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { fx, fy } = pointerFraction(event);
    const dx = fx - drag.startX;
    const dy = fy - drag.startY;
    const { origin } = drag;
    if (drag.mode === "move") {
      onChange(fit({ ...origin, x: origin.x + dx, y: origin.y + dy }));
    } else {
      // Resize from the bottom-right corner; follow whichever axis moved more.
      const byWidth = origin.w + dx;
      const byHeight = ((origin.h + dy) * CAM_ASPECT) / frameAspect;
      const w = clamp(Math.max(byWidth, byHeight), MIN_W, 1 - origin.x);
      const h = heightFor(w);
      if (origin.y + h > 1) return;
      onChange({ ...origin, w, h });
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    frameRef.current?.releasePointerCapture?.(event.pointerId);
  };

  const applyFallback = () => {
    const next = imageSrc ? fallbackFrame(imageSrc) : null;
    if (next) setImageSrc(next);
  };

  const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    if (img.naturalWidth < 200 && imageSrc && fallbackFrame(imageSrc)) {
      applyFallback();
      return;
    }
    if (img.naturalWidth && img.naturalHeight) setFrameAspect(img.naturalWidth / img.naturalHeight);
  };

  const onVideoMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth && video.videoHeight) setFrameAspect(video.videoWidth / video.videoHeight);
    if (Number.isFinite(video.duration)) video.currentTime = video.duration * FRAME_POSITIONS[frameIndex];
  };

  if (!imageSrc && !videoUrl) {
    return (
      <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
        Cole um link ou envie um vídeo para marcar onde fica a webcam. Sem marcação, ela é detectada pelo rosto.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {frameCount > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Quadro do vídeo:</span>
          <div className="inline-flex rounded-lg border p-0.5" role="radiogroup" aria-label="Quadro do vídeo">
            {Array.from({ length: frameCount }, (_, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={frameIndex === i}
                onClick={() => setFrameIndex(i)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  frameIndex === i ? "bg-foreground text-background" : "hover:bg-accent",
                )}
              >
                {FRAME_LABELS[i] ?? i + 1}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div
        ref={frameRef}
        className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-muted"
        style={{ aspectRatio: String(frameAspect) }}
        onPointerDown={onFramePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {videoUrl ? (
          <video ref={videoRef} src={videoUrl} muted playsInline preload="auto" onLoadedMetadata={onVideoMetadata} className="pointer-events-none absolute inset-0 size-full object-fill" />
        ) : imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageSrc} alt="" draggable={false} onLoad={onImageLoad} onError={applyFallback} className="pointer-events-none absolute inset-0 size-full object-fill" />
        ) : null}
        {value ? (
          <div
            role="group"
            aria-roledescription="área arrastável"
            aria-label={`Webcam em x ${Math.round(value.x * 100)}%, y ${Math.round(value.y * 100)}%, largura ${Math.round(value.w * 100)}%. Use as setas para mover.`}
            tabIndex={0}
            onPointerDown={(event) => startDrag(event, "move", value)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.05 : 0.01;
              const moves: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
              };
              const move = moves[event.key];
              if (!move) return;
              event.preventDefault();
              onChange(fit({ ...value, x: value.x + move[0], y: value.y + move[1] }));
            }}
            className="absolute cursor-move rounded-sm border-2 border-brand shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.w * 100}%`, height: `${value.h * 100}%` }}
          >
            <span className="absolute left-1 top-1 rounded bg-brand px-1 text-[10px] font-medium text-white">Webcam</span>
            <span
              aria-hidden
              onPointerDown={(event) => startDrag(event, "resize", value)}
              className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full border-2 border-white bg-brand"
            />
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {value
          ? "Arraste a caixa para mover e a bolinha para redimensionar. O que está dentro dela vai para a parte de cima do clipe."
          : "Clique em cima da webcam para marcar. Se a webcam não aparece neste quadro, troque o quadro acima."}
      </p>
    </div>
  );
}
