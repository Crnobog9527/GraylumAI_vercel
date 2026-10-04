/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { mentorTailNotices, mentorTurnNotice, RETRY_PENDING_NOTICE } from "./mentor-notices";

const base = { livePhase: null, replying: false, lastTurnOpen: false, saving: false, recovery: null, error: "", notice: "", freeError: "" };

describe("mentorTailNotices", () => {
  it("is empty when nothing is happening", () => {
    expect(mentorTailNotices(base)).toEqual([]);
  });

  it("shows 正在回复… once: not with a live stream or an open turn that says so", () => {
    expect(mentorTailNotices({ ...base, replying: true })).toMatchObject([{ id: "replying", text: "正在回复…" }]);
    expect(mentorTailNotices({ ...base, replying: true, lastTurnOpen: true })).toEqual([]);
    expect(mentorTailNotices({ ...base, replying: true, livePhase: "mentor" }).map(notice => notice.id)).toEqual(["live"]);
  });

  it("marks an interrupted stream as a warning without a spinner", () => {
    expect(mentorTailNotices({ ...base, livePhase: "incomplete" })[0]).toMatchObject({ tone: "warning", busy: false });
  });

  it("keeps the 恢复提示 name and one 重试 action for a retained request", () => {
    const onClick = vi.fn();
    const [notice] = mentorTailNotices({ ...base, recovery: { readable: true, onClick } });
    expect(notice).toMatchObject({ label: "恢复提示", tone: "warning" });
    expect(notice.actions?.map(action => action.label)).toEqual(["重试"]);
    notice.actions![0].onClick();
    expect(onClick).toHaveBeenCalled();
  });

  it("does not repeat a failed retry under its retry notice", () => {
    const notices = mentorTailNotices({ ...base, error: RETRY_PENDING_NOTICE, recovery: { readable: true, onClick: vi.fn() } });
    expect(notices.map(notice => notice.id)).toEqual(["recovery"]);
    expect(mentorTailNotices({ ...base, error: RETRY_PENDING_NOTICE }).map(notice => notice.id)).toEqual(["error"]);
  });

  it("puts the page error, notice and free-conversation error in the conversation", () => {
    const notices = mentorTailNotices({ ...base, error: "保存失败", notice: "引导没有加载成功", freeError: "开始失败" });
    expect(notices.map(notice => [notice.id, notice.tone])).toEqual([["error", "error"], ["notice", "warning"], ["free", "error"]]);
  });
});

describe("mentorTurnNotice", () => {
  it("attaches 重试 to the turn's own notice instead of adding a second line", () => {
    const notice = mentorTurnNotice("e1", { tone: "warning", text: "回复暂未完成，请继续核对。" }, { onClick: vi.fn() });
    expect(notice).toMatchObject({ id: "e1", text: "回复暂未完成，请继续核对。" });
    expect(notice?.actions?.map(action => action.label)).toEqual(["重试"]);
  });

  it("shows a stalled turn with text a retry, and nothing for a finished one", () => {
    expect(mentorTurnNotice("e1", undefined, { onClick: vi.fn() })?.actions?.[0].label).toBe("重试");
    expect(mentorTurnNotice("e1", undefined, null)).toBeNull();
  });
});

it("does not repeat an error the last turn already shows", () => {
  const error = "服务暂时不可用，没有扣积分。";
  expect(mentorTailNotices({ ...base, error, lastTurnText: error + "\n较早的部分对话记录无法使用，本轮回复未参考它们" })).toEqual([]);
  expect(mentorTailNotices({ ...base, error, lastTurnText: "本次执行已停止" }).map(notice => notice.id)).toEqual(["error"]);
});
