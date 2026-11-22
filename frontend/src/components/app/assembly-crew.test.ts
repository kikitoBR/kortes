import { describe, expect, it } from "vitest";
import { crewStatus, currentStep, cutsPlan, framePlan, type CrewInput } from "./assembly-crew";

const base: CrewInput = {
  stage: "cortes",
  blocks: 4,
  teaser: 1,
  lines: 10,
  words: 38,
  title: true,
  pieces: ["Webcam", "Jogo"],
  cuts: null,
  frame: null,
  duration: 42.3,
};

describe("cutsPlan", () => {
  it("drops one piece at a time, then types the title and lays the captions after the pieces", () => {
    const plan = cutsPlan(4, true, 10);
    plan.blocks.forEach((b, i) => {
      expect(b.drop).toBeGreaterThan(b.start);
      if (i) expect(b.start).toBeGreaterThanOrEqual(plan.blocks[i - 1].drop);
    });
    expect(plan.lines[0]).toBeGreaterThan(plan.blocksEnd);
    expect(plan.lines).toEqual([...plan.lines].sort((a, b) => a - b));
    expect(plan.end).toBeGreaterThan(plan.lines[9]);
  });

  it("stays short for clips cut into many pieces with many lines", () => {
    const plan = cutsPlan(30, true, 60);
    expect(plan.blocksEnd).toBeLessThan(4);
    expect(plan.end).toBeLessThan(8.5);
  });
});

describe("framePlan", () => {
  it("lands each crop before the next one is selected", () => {
    const plan = framePlan(2);
    expect(plan.pieces[0].land).toBeLessThanOrEqual(plan.pieces[1].select + 0.1);
    expect(plan.title).toBeGreaterThan(plan.pieces[1].land);
  });
});

describe("currentStep", () => {
  it("finds the last started step", () => {
    expect(currentStep([0.3, 0.8, 1.3], 0.1)).toBe(-1);
    expect(currentStep([0.3, 0.8, 1.3], 0.9)).toBe(1);
  });
});

describe("crewStatus", () => {
  it("says what each agent is doing while the timeline is built", () => {
    const plan = cutsPlan(4, true, 10);
    const crew = crewStatus({ ...base, cuts: plan.blocks[1].start + 0.01 });
    expect(crew.diretor).toEqual({ state: "working", text: "arrastando o pedaço 2 de 4" });
    expect(crew.legendista).toEqual({ state: "working", text: "escrevendo o título" });
    expect(crew.camera.state).toBe("idle");
    const later = crewStatus({ ...base, cuts: plan.lines[4] + 0.05 });
    expect(later.diretor).toEqual({ state: "done", text: "4 pedaços do original · gancho na frente" });
    expect(later.legendista.text).toBe("colocando a legenda 5 de 10");
  });

  it("follows the crop, the render and the review", () => {
    const frame = framePlan(2);
    const cropping = crewStatus({ ...base, stage: "enquadramento", cuts: 99, frame: frame.pieces[1].fly + 0.1 });
    expect(cropping.camera).toEqual({ state: "working", text: "levando jogo para o celular" });
    const dressing = crewStatus({ ...base, stage: "enquadramento", cuts: 99, frame: frame.title + 0.2 });
    expect(dressing.camera.state).toBe("done");
    expect(dressing.legendista).toEqual({ state: "working", text: "pondo o título e a legenda no celular" });
    const rendering = crewStatus({ ...base, stage: "render", cuts: 99, frame: 99, webcam: "webcam em 77%, 45%" });
    expect(rendering.camera).toEqual({ state: "done", text: "webcam em 77%, 45%" });
    expect(rendering.montador).toEqual({ state: "working", text: "renderizando 42 s em 1080×1920" });
    // The review reads the moment before it is cut.
    const reading = crewStatus({ ...base, stage: "revisao" });
    expect(reading.revisor).toEqual({ state: "working", text: "lendo o momento, o antes e o depois" });
    expect(reading.diretor).toEqual({ state: "idle", text: "esperando o Revisor" });
    expect(reading.camera.state).toBe("idle");
    const fixed = crewStatus({ ...base, stage: "cortes", cuts: 0, review: { score: 5, changes: ["começa 3 s antes para dar contexto"] } });
    expect(fixed.revisor).toEqual({ state: "done", text: "nota 5/10 · começa 3 s antes para dar contexto" });
    const done = crewStatus({ ...base, stage: "pronto", cuts: 99, frame: 99, review: { score: 8, changes: [] } });
    expect(Object.values(done).every((m) => m.state === "done")).toBe(true);
    expect(done.revisor.text).toBe("nota 8/10 · aprovado");
  });
});
