export interface Segment {
  id: string;
  start: number;
  end: number;
}
export interface CaptionWord {
  id: string;
  start: number;
  end: number;
  text: string;
  highlight: boolean;
}
export interface CaptionStyle {
  enabled: boolean;
  font: "TikTokSans-Regular" | "Poppins-ExtraBold" | "THEBOLDFONT";
  size: number;
  color: string;
  accent: string;
  y: number;
  background: boolean;
  wordsPerLine: number;
}
/** Where the streamer's webcam sits, as 0-1 fractions of the source frame. */
export interface WebcamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Framing {
  aspect: "vertical" | "square" | "original";
  fit: "contain" | "cover";
  /** zoom/x/y place the picture; in the gameplay layout they place the game cut. */
  zoom: number;
  x: number;
  y: number;
  /** "gameplay": the webcam box on top (1080x768), the game below (1080x1152). */
  layout?: "single" | "gameplay";
  webcam?: WebcamBox | null;
}
/** Webcam box and game cut that match the generated gameplay clip. */
export type GameplayFraming = Pick<Framing, "zoom" | "x" | "y"> & {
  layout: "gameplay";
  webcam: WebcamBox;
};
export interface Effects {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  hue: number;
}
export interface EditDocument {
  version: 1;
  segments: Segment[];
  words: CaptionWord[];
  captions: CaptionStyle;
  framing: Framing;
  effects: Effects;
  volume: number;
  muted: boolean;
}
export interface ExportJob {
  id: string;
  status: "queued" | "rendering" | "completed" | "failed" | "cancelled";
  progress: number;
  error?: string;
}
export interface EditorState {
  status: "unprepared" | "preparing" | "ready" | "failed";
  basis: string;
  error?: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  waveform: number[];
  /** Gameplay framing found when the clip was prepared (gameplay tasks only). */
  gameplay?: GameplayFraming | null;
  draft: { revision: number; document: EditDocument };
  original: EditDocument;
  jobs: ExportJob[];
}
export const DEFAULT_EFFECTS: Effects = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  hue: 0,
};
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export const editDuration = (doc: EditDocument) =>
  doc.segments.reduce((total, s) => total + s.end - s.start, 0);
export const timecode = (time: number) =>
  `${Math.floor(Math.max(0, time) / 60)}:${(Math.max(0, time) % 60).toFixed(2).padStart(5, "0")}`;
export const uid = () => crypto.randomUUID();
export const isGameplay = (
  frame: Framing,
): frame is Framing & { webcam: WebcamBox } =>
  frame.layout === "gameplay" && !!frame.webcam;
/** Share of the frame height taken by the webcam tile (768 of 1920). */
export const GAMEPLAY_CAM_SHARE = 768 / 1920;
type Rect = { x: number; y: number; width: number; height: number };
type Cut = { x: number; y: number; w: number; h: number };
/** Source rect for the webcam tile: the box cover-fitted to the tile aspect around its centre. */
export function webcamCut(box: WebcamBox, sw: number, sh: number, aspect: number): Cut {
  const bw = box.w * sw,
    bh = box.h * sh;
  const [w, h] = bw / bh > aspect ? [bh * aspect, bh] : [bw, bw / aspect];
  const cx = (box.x + box.w / 2) * sw,
    cy = (box.y + box.h / 2) * sh;
  return {
    x: clamp(cx - w / 2, 0, sw - w),
    y: clamp(cy - h / 2, 0, sh - h),
    w,
    h,
  };
}
/** Source rect for the game tile: a full-height cut, narrowed by zoom and slid by x/y. */
export function gameCut(frame: Framing, sw: number, sh: number, aspect: number): Cut {
  let h = sh / frame.zoom,
    w = h * aspect;
  if (w > sw) [w, h] = [sw, sw / aspect];
  return { x: (sw - w) * frame.x, y: (sh - h) * frame.y, w, h };
}
/**
 * Gameplay tiles for an output of width x height. `tile` is where the cut shows;
 * `rect` is where the whole source frame is drawn (clipped to the tile) so that
 * the cut fills it, which keeps one draw call shape for preview and export.
 */
export function gameplayTiles(
  frame: Framing & { webcam: WebcamBox },
  sw: number,
  sh: number,
  width: number,
  height: number,
) {
  const camHeight = Math.round((height * GAMEPLAY_CAM_SHARE) / 2) * 2;
  const place = (tile: Rect, cut: Cut) => {
    const scale = tile.width / cut.w;
    return {
      tile,
      rect: {
        x: tile.x - cut.x * scale,
        y: tile.y - cut.y * scale,
        width: sw * scale,
        height: sh * scale,
      },
    };
  };
  return {
    cam: place(
      { x: 0, y: 0, width, height: camHeight },
      webcamCut(frame.webcam, sw, sh, width / camHeight),
    ),
    game: place(
      { x: 0, y: camHeight, width, height: height - camHeight },
      gameCut(frame, sw, sh, width / (height - camHeight)),
    ),
  };
}
/** Scale the webcam box around its centre, keeping it inside the frame. */
export function resizeWebcam(box: WebcamBox, w: number): WebcamBox {
  const width = clamp(w, 0.04, 1),
    height = clamp((box.h * width) / box.w, 0.02, 1);
  return {
    x: clamp(box.x + box.w / 2 - width / 2, 0, 1 - width),
    y: clamp(box.y + box.h / 2 - height / 2, 0, 1 - height),
    w: width,
    h: height,
  };
}
export function outputSize(doc: EditDocument, width: number, height: number) {
  if (doc.framing.aspect === "vertical" || isGameplay(doc.framing))
    return { width: 1080, height: 1920 };
  if (doc.framing.aspect === "square") return { width: 1080, height: 1080 };
  const scale = Math.min(1, 1920 / Math.max(width, height));
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}
export function frameRect(
  frame: Framing,
  sw: number,
  sh: number,
  width: number,
  height: number,
) {
  const scale =
    (frame.fit === "cover" ? Math.max : Math.min)(width / sw, height / sh) *
    frame.zoom;
  const w = Math.round((sw * scale) / 2) * 2,
    h = Math.round((sh * scale) / 2) * 2;
  return {
    x: (width - w) * frame.x,
    y: (height - h) * frame.y,
    width: w,
    height: h,
  };
}
export function mappedWords(doc: EditDocument): CaptionWord[] {
  const result: CaptionWord[] = [];
  let cursor = 0;
  const orderedWords = [...doc.words].sort((a, b) => a.start - b.start);
  for (const segment of doc.segments) {
    for (const word of orderedWords) {
      const start = Math.max(segment.start, word.start),
        end = Math.min(segment.end, word.end);
      if (end > start && word.text.trim())
        result.push({
          ...word,
          start: cursor + start - segment.start,
          end: cursor + end - segment.start,
        });
    }
    cursor += segment.end - segment.start;
  }
  return result;
}
export function captionGroups(words: CaptionWord[], count: number) {
  const groups: CaptionWord[][] = [];
  let group: CaptionWord[] = [];
  for (const word of words) {
    if (
      group.length &&
      (group.length >= count || word.start - group[group.length - 1].end > 0.6)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  return groups;
}
export function outputTime(
  doc: EditDocument,
  segmentIndex: number,
  sourceTime: number,
) {
  return (
    doc.segments
      .slice(0, segmentIndex)
      .reduce((sum, s) => sum + s.end - s.start, 0) +
    sourceTime -
    doc.segments[segmentIndex].start
  );
}
export function splitSegment(
  doc: EditDocument,
  index: number,
  at: number,
): EditDocument {
  const segment = doc.segments[index];
  if (!segment || at - segment.start < 0.04 || segment.end - at < 0.04)
    return doc;
  const segments = [...doc.segments];
  segments.splice(
    index,
    1,
    { ...segment, end: at },
    { id: uid(), start: at, end: segment.end },
  );
  return { ...doc, segments };
}
/** Correcting a phrase retains existing time anchors; inserted words share only the replaced span. */
export function replaceWords(
  words: CaptionWord[],
  text: string,
  duration: number,
): CaptionWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  // LCS anchors preserve unchanged words, including those after an insertion/deletion.
  const rows = words.length + 1,
    cols = tokens.length + 1;
  if (rows * cols > 1_000_000)
    throw new Error("Edite esta transcrição longa uma palavra por vez.");
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = words.length - 1; i >= 0; i--)
    for (let j = tokens.length - 1; j >= 0; j--)
      table[i][j] =
        words[i].text === tokens[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const anchors: [number, number][] = [[-1, -1]];
  let i = 0,
    j = 0;
  while (i < words.length && j < tokens.length) {
    if (words[i].text === tokens[j]) {
      anchors.push([i++, j++]);
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  anchors.push([words.length, tokens.length]);
  const result: CaptionWord[] = [];
  for (let k = 1; k < anchors.length; k++) {
    const [prevI, prevJ] = anchors[k - 1],
      [nextI, nextJ] = anchors[k];
    const count = nextJ - prevJ - 1;
    const start =
      nextI > prevI + 1 ? words[prevI + 1].start : (words[prevI]?.end ?? 0);
    const end =
      nextI > prevI + 1
        ? words[nextI - 1].end
        : (words[nextI]?.start ?? duration);
    for (let n = 0; n < count; n++) {
      const from = start + (Math.max(0.01, end - start) * n) / count;
      result.push({
        id: uid(),
        text: tokens[prevJ + n + 1].slice(0, 120),
        start: clamp(from, 0, duration - 0.01),
        end: clamp(
          start + (Math.max(0.01, end - start) * (n + 1)) / count,
          from + 0.001,
          duration,
        ),
        highlight: false,
      });
    }
    if (nextI < words.length) result.push({ ...words[nextI] });
  }
  return result;
}
