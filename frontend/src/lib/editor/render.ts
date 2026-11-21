import {
  captionGroups,
  frameRect,
  gameplayTiles,
  isGameplay,
  mappedWords,
  type EditDocument,
} from "./document";

const groupCache = new WeakMap<
  EditDocument,
  ReturnType<typeof captionGroups>
>();
const loaded = new Map<string, Promise<void>>();
export function loadEditorFont(name: string) {
  if (!loaded.has(name))
    loaded.set(
      name,
      (async () => {
        const font = new FontFace(
          `Editor-${name}`,
          `url(/api/fonts/${encodeURIComponent(name)})`,
        );
        await font.load();
        document.fonts.add(font);
      })().catch((error) => {
        loaded.delete(name);
        throw error;
      }),
    );
  return loaded.get(name)!;
}
export function drawEditorFrame(
  ctx: CanvasRenderingContext2D,
  doc: EditDocument,
  sourceWidth: number,
  sourceHeight: number,
  time: number,
  draw: (rect: ReturnType<typeof frameRect>) => void,
) {
  const { width, height } = ctx.canvas,
    fx = doc.effects;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.filter = `brightness(${fx.brightness}%) contrast(${fx.contrast}%) saturate(${fx.saturation}%) blur(${(fx.blur * width) / 1080}px) hue-rotate(${fx.hue}deg)`;
  if (isGameplay(doc.framing)) {
    const tiles = gameplayTiles(doc.framing, sourceWidth, sourceHeight, width, height);
    const { cam, game } = tiles;
    // Game first: a floating webcam sits on top of it.
    for (const { tile, rect } of [game, cam]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(tile.x, tile.y, tile.width, tile.height);
      ctx.clip();
      draw(rect);
      ctx.restore();
    }
    if (tiles.border) {
      ctx.save();
      ctx.filter = "none";
      ctx.strokeStyle = "white";
      ctx.lineWidth = tiles.border;
      const b = tiles.border / 2;
      ctx.strokeRect(cam.tile.x - b, cam.tile.y - b, cam.tile.width + 2 * b, cam.tile.height + 2 * b);
      ctx.restore();
    }
  } else {
    const rect = frameRect(doc.framing, sourceWidth, sourceHeight, width, height);
    if (doc.framing.fit === "contain" && doc.framing.background === "blur") {
      // The same picture, cropped to fill and blurred, behind the whole one.
      const scale = Math.max(width / sourceWidth, height / sourceHeight);
      ctx.save();
      ctx.filter = `${ctx.filter === "none" ? "" : ctx.filter} blur(${(20 * width) / 1080}px)`.trim();
      draw({
        x: (width - sourceWidth * scale) / 2,
        y: (height - sourceHeight * scale) / 2,
        width: sourceWidth * scale,
        height: sourceHeight * scale,
      });
      ctx.restore();
    }
    draw(rect);
  }
  ctx.restore();
  if (!doc.captions.enabled) return;
  let groups = groupCache.get(doc);
  if (!groups) {
    groups = captionGroups(mappedWords(doc), doc.captions.wordsPerLine);
    groupCache.set(doc, groups);
  }
  const group = groups.find(
    (group) =>
      time >= group[0].start && time < Math.max(...group.map((w) => w.end)),
  );
  if (!group) return;
  const style = doc.captions,
    size = (style.size * width) / 1080;
  ctx.font = `${size}px "Editor-${style.font}", sans-serif`;
  ctx.textBaseline = "middle";
  // Fit each phrase in the safe width, using the same font for preview and browser export.
  const space = ctx.measureText(" ").width;
  const lines: (typeof group)[] = [];
  let line: typeof group = [],
    lineWidth = 0;
  for (const word of group) {
    const wordWidth = ctx.measureText(word.text).width;
    if (line.length && lineWidth + space + wordWidth > width * 0.84) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    line.push(word);
    lineWidth += wordWidth + (line.length > 1 ? space : 0);
  }
  if (line.length) lines.push(line);
  lines.forEach((words, index) => {
    const total =
      words.reduce((sum, w) => sum + ctx.measureText(w.text).width, 0) +
      space * (words.length - 1);
    let x = (width - total) / 2;
    const y = height * style.y + (index - (lines.length - 1) / 2) * size * 1.2;
    if (style.background) {
      ctx.fillStyle = "#101010";
      ctx.fillRect(
        x - size * 0.1,
        y - size * 0.6,
        total + size * 0.2,
        size * 1.2,
      );
    }
    for (const word of words) {
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#101010";
      if (!style.background) ctx.strokeText(word.text, x, y);
      ctx.fillStyle = word.highlight ? style.accent : style.color;
      ctx.fillText(word.text, x, y);
      x += ctx.measureText(word.text).width + space;
    }
  });
}
