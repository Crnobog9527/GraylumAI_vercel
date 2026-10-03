/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_TRUNCATED_NOTICE } from "@/lib/runtime-gate-notice";
import { CAPACITY_NOTICE, GUIDE_HELD_NOTICE, runtimeTailNotices, runtimeTurnNotices, type RuntimeTurn } from "./runtime-notices";

const turn = (extra: Partial<RuntimeTurn> = {}): RuntimeTurn => ({
  executionId: "e1", state: "completed", primaryBody: null, organizerComplete: null, needsTask: false, unavailableReason: null, ...extra,
});
const ctx = (extra = {}) => ({ busy: false, capacity: false, stopping: false, onRetry: vi.fn(), onStop: vi.fn(), ...extra });
const labels = (notice: { actions?: Array<{ label: string }> }) => notice.actions?.map(action => action.label);

describe("runtimeTurnNotices", () => {
  it("shows nothing under a completed turn", () => {
    expect(runtimeTurnNotices(turn(), ctx())).toEqual([]);
  });

  it("gives an open turn one notice with 重试 and 停止", () => {
    const [notice] = runtimeTurnNotices(turn({ state: "running" }), ctx());
    expect(notice.text).toBe("回复尚未完成，原请求已保留。");
    expect(labels(notice)).toEqual(["重试", "停止"]);
    notice.actions![0].onClick();
    notice.actions![1].onClick();
  });

  it("shows a running turn as progress and keeps 停止 available", () => {
    const [notice] = runtimeTurnNotices(turn({ state: "running" }), ctx({ busy: true }));
    expect(notice).toMatchObject({ tone: "status", busy: true, text: "正在回复…" });
    expect(notice.actions!.map(action => action.disabled)).toEqual([true, false]);
  });

  it("offers only 停止 when the material exceeds the input capacity", () => {
    const [notice] = runtimeTurnNotices(turn({ state: "running" }), ctx({ capacity: true }));
    expect(notice.text).toBe(CAPACITY_NOTICE);
    expect(labels(notice)).toEqual(["停止"]);
  });

  it("shows a gate stop or a plain stop under a cancelled turn", () => {
    expect(runtimeTurnNotices(turn({ state: "cancelled" }), ctx({ gateStop: "请求太频繁" }))[0]).toMatchObject({ tone: "warning", text: "请求太频繁" });
    expect(runtimeTurnNotices(turn({ state: "cancelled" }), ctx())[0].text).toBe("已停止，保留原记录。");
  });

  it("shows output truncation once, with the shared wording", () => {
    const notices = runtimeTurnNotices(turn({ unavailableReason: "output_truncated" }), ctx());
    expect(notices.map(notice => notice.text)).toEqual([OUTPUT_TRUNCATED_NOTICE]);
  });
});

describe("runtimeTailNotices", () => {
  const onGuide = vi.fn();
  it("offers the guidance retry from the held request, whatever the last error says", () => {
    // The old page compared the error with a different sentence, so the inline button never appeared.
    for (const error of ["", GUIDE_HELD_NOTICE, "请求太频繁，请 1 分钟后再试。"]) {
      const guide = runtimeTailNotices({ error, heldGuide: true, busy: false, onGuide }).find(notice => notice.id === "guide");
      expect(guide?.text).toBe(GUIDE_HELD_NOTICE);
      expect(labels(guide!)).toEqual(["重试"]);
      guide!.actions![0].onClick();
    }
    expect(onGuide).toHaveBeenCalledTimes(3);
  });

  it("shows no guidance retry without a held request, even with the held wording", () => {
    const notices = runtimeTailNotices({ error: GUIDE_HELD_NOTICE, heldGuide: false, busy: false, onGuide });
    expect(notices.map(notice => notice.id)).toEqual(["error"]);
  });

  it("does not repeat the held wording as a second error", () => {
    expect(runtimeTailNotices({ error: GUIDE_HELD_NOTICE, heldGuide: true, busy: false, onGuide }).map(notice => notice.id)).toEqual(["guide"]);
  });

  it("does not repeat an error the last turn already shows", () => {
    const lastTurn = { open: false, texts: [OUTPUT_TRUNCATED_NOTICE] };
    expect(runtimeTailNotices({ error: OUTPUT_TRUNCATED_NOTICE, heldGuide: false, busy: false, onGuide, lastTurn })).toEqual([]);
  });

  it("shows the busy status only when the last turn is not already showing progress", () => {
    expect(runtimeTailNotices({ error: "", heldGuide: false, busy: true, onGuide }).map(notice => notice.id)).toEqual(["busy"]);
    expect(runtimeTailNotices({ error: "", heldGuide: false, busy: true, onGuide, lastTurn: { open: true, texts: [] } })).toEqual([]);
  });
});
