/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { OPENING_INPUT } from "@repo/api/src/shared/opcQuestions";
import { readFileSync } from "node:fs";
import { isStepSummaryInput, offersStepSummary, STEP_SUMMARY_INPUT, STEP_SUMMARY_LABEL, stepSummaryRequest, summaryRefusal, summaryShown } from "./step-summary";
import { isHostAction, refusedTurn, shownInput } from "./checklist-nudge";
import { releaseRejectedAnswer } from "./mentor-turn";
import { admissionMessage } from "./admission-message";

function memory() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k) };
}

describe("这一步先到这里 (R16)", () => {
  it("uses the same marker as the server", () => {
    const server = readFileSync(new URL("../../../../../../packages/api/src/shared/opcStepSummary.ts", import.meta.url), "utf8");
    expect(server).toContain(`export const STEP_SUMMARY_INPUT = '${STEP_SUMMARY_INPUT}';`);
  });

  it("sends the versioned host marker with no card, field or organizer", () => {
    const request = stepSummaryRequest("d1", "s1", "r1");
    expect(request).toEqual({ draftId: "d1", stepId: "s1", purpose: "mentor", requestId: "r1", input: STEP_SUMMARY_INPUT });
    expect(request).not.toHaveProperty("organizeAfter");
    expect(request).not.toHaveProperty("questionId");
    expect(request).not.toHaveProperty("answerSource");
  });

  it("recognizes only the exact marker; typed words are an ordinary message", () => {
    expect(isStepSummaryInput(STEP_SUMMARY_INPUT)).toBe(true);
    for (const input of ["这一步先到这里", "HOST_STEP_SUMMARY:v2", ` ${STEP_SUMMARY_INPUT}`, null, undefined])
      expect(isStepSummaryInput(input)).toBe(false);
  });

  it("shows the button's words in the conversation, never the raw marker, and is not an answer", () => {
    expect(shownInput(STEP_SUMMARY_INPUT)).toBe(STEP_SUMMARY_LABEL);
    expect(isHostAction(STEP_SUMMARY_INPUT)).toBe(true);
    expect(isHostAction("我想做小红书")).toBe(false);
  });

  it("offers the button after the user has talked in the step, and not right after a readable summary", () => {
    const shown = { input: STEP_SUMMARY_INPUT, state: "completed", completeness: "complete", body: "本步小结" };
    expect(offersStepSummary([])).toBe(false);
    expect(offersStepSummary([{ input: OPENING_INPUT }])).toBe(false);
    expect(offersStepSummary([{ input: OPENING_INPUT }, { input: "我做职场内容" }])).toBe(true);
    expect(offersStepSummary([{ input: "我做职场内容" }, shown])).toBe(false);
    expect(offersStepSummary([shown, { input: "补充一下预算" }])).toBe(true);
  });

  it("offers it again after a summary that was stopped, cut off, refused or failed", () => {
    const talk = { input: "我做职场内容" };
    const summary = { input: STEP_SUMMARY_INPUT, state: "completed", completeness: "complete", body: "本步小结" };
    for (const failed of [{ ...summary, state: "cancelled" }, { ...summary, state: "failed" }, { ...summary, stopped: true },
      { ...summary, completeness: "length_limit" }, { ...summary, completeness: "stopped" }, { ...summary, body: "" },
      { ...summary, unavailableReason: "provider_rejected" }])
      expect(offersStepSummary([talk, failed])).toBe(true);
    expect(summaryShown({ ...summary, primaryBody: "x", body: null })).toBe(true);
    // Still settling its charge, but readable: asking again would pay twice.
    expect(offersStepSummary([talk, { ...summary, state: "cost_pending" }])).toBe(false);
    expect(offersStepSummary([talk, { ...summary, state: "cost_pending", stopped: true }])).toBe(true);
    expect(summaryShown({ ...summary, input: "我做职场内容" })).toBe(false);
  });

  it("puts nothing back into the message box when the server does not admit the click", () => {
    const restore = vi.fn();
    refusedTurn(memory(), "d1", "s1", STEP_SUMMARY_INPUT, restore);
    expect(restore).not.toHaveBeenCalled();
  });

  it("releases only a summary envelope on its definite refusals", () => {
    const storage = memory();
    const summary = JSON.stringify({ request: stepSummaryRequest("d1", "s1", "r1") });
    const typed = JSON.stringify({ request: { draftId: "d1", stepId: "s1", purpose: "mentor", requestId: "r2", input: "你好" } });
    storage.setItem("k", typed);
    expect(releaseRejectedAnswer(storage, "k", "r2", new Error("OPC_CAPTURE_INPUT_LIMIT"))).toBe(false);
    expect(storage.getItem("k")).toBe(typed);
    storage.setItem("k", summary);
    expect(releaseRejectedAnswer(storage, "k", "r1", new Error("network timeout"))).toBe(false);
    expect(releaseRejectedAnswer(storage, "k", "r1", new Error("RUNTIME_REQUEST_CONFLICT"))).toBe(false);
    expect(storage.getItem("k")).toBe(summary);
    const stale = JSON.stringify({ request: { ...stepSummaryRequest("d1", "s1", "r1"), input: "HOST_STEP_SUMMARY:v2" } });
    storage.setItem("k", stale);
    expect(releaseRejectedAnswer(storage, "k", "r1", new Error("OPC_STEP_SUMMARY_INVALID"))).toBe(true);
    expect(storage.getItem("k")).toBeNull();
    for (const code of ["OPC_STEP_SUMMARY_INVALID", "OPC_CAPTURE_INPUT_LIMIT"]) {
      storage.setItem("k", summary);
      expect(releaseRejectedAnswer(storage, "k", "r1", new Error(code))).toBe(true);
      expect(storage.getItem("k")).toBeNull();
    }
  });

  it("explains a released summary refusal; an ordinary turn's refusal keeps its own notice", () => {
    for (const code of ["OPC_STEP_SUMMARY_INVALID", "OPC_CAPTURE_INPUT_LIMIT"]) {
      const marked = summaryRefusal(stepSummaryRequest("d1", "s1", "r1"), new Error(code));
      const text = admissionMessage(marked);
      expect(text).toContain("没有扣费");
      expect(text).not.toMatch(/积分|已确认/);
      const ordinary = new Error(code);
      expect(summaryRefusal({ input: "你好" }, ordinary)).toBe(ordinary);
      expect(admissionMessage(ordinary)).toBeNull();
    }
    const other = new Error("RUNTIME_REQUEST_CONFLICT");
    expect(summaryRefusal(stepSummaryRequest("d1", "s1", "r1"), other)).toBe(other);
  });
});
