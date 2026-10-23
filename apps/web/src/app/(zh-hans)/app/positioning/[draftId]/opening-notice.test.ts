/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { OPENING_FAILED_NOTICE, openingNoticeResolved, stepHasReply } from "./opening-notice";

const turn = (executionId: string, stepId: string, kind = "mentor", roundId: string | null = "r1") => ({ executionId, stepId, kind, roundId });
const done = (executionId: string, state = "completed") => ({ executionId, state, body: "教练的回复", primaryBody: null });

describe("failed coach opening notice", () => {
  it("clears once the failed step gets a finished coach reply in this round (10-22: a manual message succeeded, the banner stayed)", () => {
    const draft = { roundId: "r1", turns: [turn("e1", "diagnosis"), turn("e2", "positioning")] };
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft, [done("e1"), done("e2")])).toBe(true);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft, [done("e2", "cost_pending")])).toBe(true);
  });

  it("stays when the failed opening itself is projected as a turn but never replied", () => {
    const draft = { roundId: "r1", turns: [turn("e3", "positioning", "opening")] };
    for (const state of ["failed", "cancelled", "running"])
      expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft, [{ executionId: "e3", state, body: null }])).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft, [{ executionId: "e3", state: "completed", body: "" }]))
      .toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, draft, undefined)).toBe(false);
  });

  it("stays while only another step, another round or a non-coach turn replied", () => {
    const executions = [done("e1")];
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, { roundId: "r1", turns: [turn("e1", "diagnosis")] }, executions))
      .toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE,
      { roundId: "r2", turns: [turn("e1", "positioning", "mentor", "r1")] }, executions)).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, { roundId: "r1", turns: [turn("e1", "positioning", "user")] },
      executions)).toBe(false);
  });

  it("never clears another notice or without a recorded failure", () => {
    const draft = { roundId: "r1", turns: [turn("e1", "positioning")] };
    expect(openingNoticeResolved("positioning", "本机旧请求无法读取，原记录已保留；没有开始新的生成。", draft, [done("e1")])).toBe(false);
    expect(openingNoticeResolved(null, OPENING_FAILED_NOTICE, draft, [done("e1")])).toBe(false);
    expect(openingNoticeResolved("positioning", OPENING_FAILED_NOTICE, undefined, [done("e1")])).toBe(false);
  });

  it("counts organizer and opening replies, and turns from a projection without round ownership", () => {
    expect(stepHasReply([turn("e1", "positioning", "organizer")], [done("e1")], "r1", "positioning")).toBe(true);
    expect(stepHasReply([turn("e1", "positioning", "opening")], [done("e1")], "r1", "positioning")).toBe(true);
    expect(stepHasReply([{ executionId: "e1", stepId: "positioning", kind: "mentor" }], [done("e1")], "r1", "positioning")).toBe(true);
  });
});
