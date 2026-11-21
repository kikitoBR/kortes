import { describe, expect, it } from "vitest";
import {
  gameCut,
  gameplayTiles,
  isGameplay,
  outputSize,
  resizeWebcam,
  webcamCut,
  type Framing,
} from "./document";
import { draft } from "./document.test-fixture";

const webcam = { x: 0.02, y: 0.6, w: 0.25, h: 0.32 };
const gameplay: Framing = { ...draft.framing, layout: "gameplay", webcam };

describe("gameplay layout", () => {
  it("only applies with a webcam box and always renders 9:16", () => {
    expect(isGameplay(gameplay)).toBe(true);
    expect(isGameplay({ ...gameplay, webcam: null })).toBe(false);
    expect(isGameplay(draft.framing)).toBe(false);
    const doc = { ...draft, framing: { ...gameplay, aspect: "original" as const } };
    expect(outputSize(doc, 1920, 1080)).toEqual({ width: 1080, height: 1920 });
  });

  it("cover-fits the webcam box to the top tile around its centre", () => {
    const cut = webcamCut(webcam, 1920, 1080, 1080 / 768);
    expect(cut.w / cut.h).toBeCloseTo(1080 / 768);
    expect(cut.x + cut.w / 2).toBeCloseTo((webcam.x + webcam.w / 2) * 1920);
    expect(cut.y + cut.h).toBeLessThanOrEqual(1080);
  });

  it("cuts the full game height at zoom 1 and slides with x", () => {
    const centre = gameCut(gameplay, 1920, 1080, 1080 / 1152);
    expect(centre.h).toBeCloseTo(1080);
    expect(centre.x).toBeCloseTo((1920 - centre.w) / 2);
    expect(gameCut({ ...gameplay, x: 0 }, 1920, 1080, 1080 / 1152).x).toBe(0);
    expect(gameCut({ ...gameplay, zoom: 2 }, 1920, 1080, 1080 / 1152).h).toBeCloseTo(540);
  });

  it("stacks the webcam tile (40%) over the game tile", () => {
    const { cam, game } = gameplayTiles(
      gameplay as Framing & { webcam: typeof webcam },
      1920,
      1080,
      1080,
      1920,
    );
    expect(cam.tile).toEqual({ x: 0, y: 0, width: 1080, height: 768 });
    expect(game.tile).toEqual({ x: 0, y: 768, width: 1080, height: 1152 });
    // The cut lands exactly on the tile: its left edge at the tile's left edge.
    const cut = webcamCut(webcam, 1920, 1080, 1080 / 768);
    expect(cam.rect.x + (cut.x / 1920) * cam.rect.width).toBeCloseTo(0);
    expect(cam.rect.y + (cut.y / 1080) * cam.rect.height).toBeCloseTo(0);
  });

  it("resizes the webcam box around its centre inside the frame", () => {
    const bigger = resizeWebcam(webcam, 0.5);
    expect(bigger.w).toBeCloseTo(0.5);
    expect(bigger.h / bigger.w).toBeCloseTo(webcam.h / webcam.w);
    expect(bigger.x).toBeGreaterThanOrEqual(0);
    expect(bigger.y + bigger.h).toBeLessThanOrEqual(1);
  });
});

describe("more layouts", () => {
  const box = { x: 0.02, y: 0.6, w: 0.25, h: 0.32 };
  it("puts the webcam at the bottom when asked", () => {
    const { cam, game } = gameplayTiles({ ...draft.framing, layout: "gameplay", camPosition: "bottom", webcam: box }, 1920, 1080, 1080, 1920);
    expect(game.tile).toEqual({ x: 0, y: 0, width: 1080, height: 1152 });
    expect(cam.tile).toEqual({ x: 0, y: 1152, width: 1080, height: 768 });
  });
  it("floats the webcam over a full-screen game", () => {
    const tiles = gameplayTiles({ ...draft.framing, layout: "float", webcam: box }, 1920, 1080, 1080, 1920);
    expect(tiles.game.tile).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(tiles.cam.tile).toEqual({ x: 40, y: 300, width: 480, height: 342 });
    expect(tiles.border).toBe(6);
    expect(isGameplay({ ...draft.framing, layout: "float", webcam: box })).toBe(true);
  });
});
