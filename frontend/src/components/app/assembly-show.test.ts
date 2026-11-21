import { describe, expect, it } from "vitest";
import { captionLines } from "./assembly-show";

const words = ["bem", "tá", "agora", "a", "gente", "vem", "aqui"].map((text, i) => ({ text, start: i, end: i + 0.6 }));

describe("captionLines", () => {
  it("cuts every N words, like the render's caption chunks", () => {
    const lines = captionLines(words, 4);
    expect(lines.map((l) => l.words.map((w) => w.text).join(" "))).toEqual(["bem tá agora a", "gente vem aqui"]);
    expect(lines[1]).toMatchObject({ start: 4, end: 6.6 });
  });

  it("never makes empty or zero-size lines", () => {
    expect(captionLines([], 4)).toEqual([]);
    expect(captionLines(words, 0)).toHaveLength(words.length);
  });
});
