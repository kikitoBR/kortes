"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Facecam box as 0-1 fractions of the source frame. */
export type WebcamRegion = { x: number; y: number; w: number; h: number };

/** Top tile of the gameplay layout (1080x768): the box keeps this aspect. */
const CAM_ASPECT = 1080 / 768;
const MIN_W = 0.06;

type Drag = { mode: "move" | "resize"; startX: number; startY: number; origin: WebcamRegion };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Lets the user mark where the streamer's webcam sits on a frame of the
 * source video. The box is locked to the gameplay layout's top-tile aspect so
 * what they mark is exactly what ends up on top of the clip.
 */
export function WebcamRegionPicker({
  imageSrc,
  videoFile,
  value,
  onChange,
}: {
  imageSrc?: string | null;
  videoFile?: File | null;
  value: WebcamRegion | null;
  onChange: (region: WebcamRegion | null) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [frameAspect, setFrameAspect] = useState(16 / 9);
  const [image, setImage] = useState<string | null>(imageSrc ?? null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => setImage(imageSrc ?? null), [imageSrc]);

  useEffect(() => {
    if (!videoFile) {
      setVideoUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(videoFile);
    setVideoUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [videoFile]);

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
    const w = 0.28;
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

  const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    // YouTube answers a missing maxres thumbnail with a tiny placeholder.
    if (img.naturalWidth < 200 && image?.includes("maxresdefault")) {
      setImage(image.replace("maxresdefault", "mqdefault"));
      return;
    }
    if (img.naturalWidth && img.naturalHeight) setFrameAspect(img.naturalWidth / img.naturalHeight);
  };

  const onVideoMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth && video.videoHeight) setFrameAspect(video.videoWidth / video.videoHeight);
    if (Number.isFinite(video.duration)) video.currentTime = Math.min(5, video.duration / 3);
  };

  if (!image && !videoUrl) {
    return (
      <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
        Cole um link ou envie um vídeo para marcar onde fica a webcam. Sem marcação, ela é detectada pelo rosto.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted-foreground">
          {value ? "Arraste para ajustar a webcam" : "Clique na webcam para marcar (opcional)"}
        </p>
        {value ? (
          <button type="button" onClick={() => onChange(null)} className="text-xs font-medium underline-offset-2 hover:underline">
            Detectar automaticamente
          </button>
        ) : null}
      </div>
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
          <video src={videoUrl} muted playsInline preload="metadata" onLoadedMetadata={onVideoMetadata} className="pointer-events-none absolute inset-0 size-full object-fill" />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" draggable={false} onLoad={onImageLoad}
            onError={() => image.includes("maxresdefault") && setImage(image.replace("maxresdefault", "mqdefault"))} className="pointer-events-none absolute inset-0 size-full object-fill" />
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
              className={cn("absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-brand")}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
