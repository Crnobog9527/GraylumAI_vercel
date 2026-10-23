/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { OPENING_FAILED_NOTICE, openingNoticeResolved, stepHasTurn } from "./opening-notice";

const turn = (stepId: string, kind = "mentor", roundId: string | null = "r1") => ({ stepId, kind, roundId });

describe("failed coach opening notice", () => {
  it("clears once the failed step gets a coach turn in this round (10-22: a manual message succeeded, the banner stayed)", () => {
    const draft = { roundId: "r1", turns: [turn("diagnosis"), turn("positioning")] };
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft)).toBe(true);
  });

  it("stays while the failed step has no turn, or only turns of another step or round", () => {
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, { roundId: "r1", turns: [turn("diagnosis")] })).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE,
      { roundId: "r2", turns: [turn("positioning", "mentor", "r1")] })).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, { roundId: "r1", turns: [turn("positioning", "user")] }))
      .toBe(false);
  });

  it("never clears another notice or without a recorded failure", () => {
    const draft = { roundId: "r1", turns: [turn("positioning")] };
    expect(openingNoticeResolved("positioning", "本机旧请求无法读取，原记录已保留；没有开始新的生成。", draft)).toBe(false);
    expect(openingNoticeResolved(null, OPENING_FAILED_NOTICE, draft)).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, undefined)).toBe(false);
  });

  it("counts organizer and opening turns, and turns from a projection without round ownership", () => {
    expect(stepHasTurn([turn("positioning", "organizer")], "r1", "positioning")).toBe(true);
    expect(stepHasTurn([turn("positioning", "opening")], "r1", "positioning")).toBe(true);
    expect(stepHasTurn([{ stepId: "positioning", kind: "mentor" }], "r1", "positioning")).toBe(true);
  });
});
