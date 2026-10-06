/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeGateMessages } from "../../../../packages/api/src/shared/runtimeGateMessages";
import {
  ORGANIZER_PENDING_NOTICE, ORGANIZER_SKIPPED_NOTICE, ORGANIZER_STILL_SHORT_NOTICE, ORGANIZER_WAITING_CREDITS_NOTICE, RESUME_ADMIN_NOTICE, RESUME_CONFLICT_NOTICE, RESUME_UNKNOWN_NOTICE,
  RESUMING_NOTICE, STILL_SHORT_NOTICE, TOP_UP_HREF, UNNAMED_ORGANIZER, WAITING_CREDITS_NOTICE, WAITING_RESUME_NOTICE,
  blockedAdmission, isOrganizerPendingError, openTopUp, organizerBlockedNotices, organizerSkipped, paygResumeController,
  paygResumeToken, paygTurnNotices, resumeFailureNotice, resumeOutcome, type PaygTurn,
} from "./payg-wait";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const turn = (extra: Partial<PaygTurn> = {}): PaygTurn => ({ executionId: ID, state: "waiting_credits", cursor: 2, epoch: 3, remainingCalls: 2, ...extra });
const ctx = (extra = {}) => ({ resumingId: null, onResume: vi.fn(), onTopUp: vi.fn(), ...extra });
const labels = (notice: { actions?: Array<{ label: string }> }) => notice.actions?.map(action => action.label);
const refused = (message: string) => new Error(message);

afterEach(() => vi.unstubAllGlobals());

describe("paygResumeToken", () => {
  it("is the turn's own executionId, cursor and epoch while paused", () => {
    expect(paygResumeToken(turn())).toEqual({ executionId: ID, cursor: 2, epoch: 3 });
    expect(paygResumeToken(turn({ state: "waiting_resume", cursor: 0, epoch: 0 }))).toEqual({ executionId: ID, cursor: 0, epoch: 0 });
  });

  it("is absent for any other state or a view without a valid position", () => {
    expect(paygResumeToken(turn({ state: "running" }))).toBeNull();
    expect(paygResumeToken(turn({ state: "completed" }))).toBeNull();
    expect(paygResumeToken(turn({ cursor: null }))).toBeNull();
    expect(paygResumeToken(turn({ epoch: -1 }))).toBeNull();
    expect(paygResumeToken(turn({ cursor: 1.5 }))).toBeNull();
  });
});

describe("paygTurnNotices", () => {
  it("waiting_credits: the fixed notice with 继续 and 去充值", () => {
    const c = ctx();
    const [notice, ...rest] = paygTurnNotices(turn(), c);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ tone: "warning", text: WAITING_CREDITS_NOTICE });
    expect(labels(notice)).toEqual(["继续", "去充值"]);
    notice.actions![0].onClick();
    expect(c.onResume).toHaveBeenCalledWith({ executionId: ID, cursor: 2, epoch: 3 });
    notice.actions![1].onClick();
    expect(c.onTopUp).toHaveBeenCalledOnce();
  });

  it("waiting_resume: paused, 继续 only", () => {
    const [notice] = paygTurnNotices(turn({ state: "waiting_resume" }), ctx());
    expect(notice.text).toBe(WAITING_RESUME_NOTICE);
    expect(labels(notice)).toEqual(["继续"]);
  });

  it("disables 继续 while the page is busy or another resume runs", () => {
    expect(paygTurnNotices(turn(), ctx({ disabled: true }))[0].actions![0].disabled).toBe(true);
    expect(paygTurnNotices(turn(), ctx({ resumingId: OTHER }))[0].actions![0].disabled).toBe(true);
    expect(paygTurnNotices(turn(), ctx())[0].actions![0].disabled).toBe(false);
    // 去充值 never depends on the page state.
    expect(paygTurnNotices(turn(), ctx({ disabled: true }))[0].actions![1].disabled).toBeUndefined();
  });

  it("shows progress without actions while this turn resumes", () => {
    expect(paygTurnNotices(turn(), ctx({ resumingId: ID }))).toEqual([
      expect.objectContaining({ tone: "status", busy: true, text: RESUMING_NOTICE }),
    ]);
    expect(paygTurnNotices(turn(), ctx({ resumingId: ID }))[0].actions).toBeUndefined();
  });

  it("returns to the waiting notice, not an error, when credits are still short", () => {
    const notices = paygTurnNotices(turn(), ctx({ outcome: { kind: "short" } }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tone: "warning", text: STILL_SHORT_NOTICE });
    expect(labels(notices[0])).toEqual(["继续", "去充值"]);
  });

  it("says the reply is done and only the organizer waits for credits", () => {
    const waiting = turn({ primaryBody: "导师的完整回复", organizerComplete: false });
    const [notice] = paygTurnNotices(waiting, ctx());
    expect(notice).toMatchObject({ tone: "warning", text: ORGANIZER_WAITING_CREDITS_NOTICE });
    expect(notice.text).toContain("回复已完成");
    expect(notice.text).toContain("整理在等积分");
    expect(labels(notice)).toEqual(["继续", "去充值"]);
    expect(paygTurnNotices(waiting, ctx({ outcome: { kind: "short" } }))[0]).toMatchObject({ text: ORGANIZER_STILL_SHORT_NOTICE });
  });

  it("keeps the general pause text when no finished reply is waiting for its organizer", () => {
    for (const extra of [{}, { primaryBody: "回复", organizerComplete: true }, { primaryBody: null, organizerComplete: false }])
      expect(paygTurnNotices(turn(extra), ctx())[0]).toMatchObject({ text: WAITING_CREDITS_NOTICE });
    expect(paygTurnNotices(turn({ state: "waiting_resume", primaryBody: "回复", organizerComplete: false }), ctx())[0])
      .toMatchObject({ text: WAITING_RESUME_NOTICE });
  });

  it("adds a fixed outcome notice under the pause", () => {
    const notices = paygTurnNotices(turn(), ctx({ outcome: { kind: "notice", text: RESUME_ADMIN_NOTICE } }));
    expect(notices.map(n => n.text)).toEqual([WAITING_CREDITS_NOTICE, RESUME_ADMIN_NOTICE]);
  });

  it("shows nothing for turns that are not paused", () => {
    for (const state of ["running", "completed", "cancelled", "interrupted", "cost_pending"])
      expect(paygTurnNotices(turn({ state }), ctx())).toEqual([]);
    expect(paygTurnNotices(turn({ cursor: undefined }), ctx())).toEqual([]);
  });

  it("marks an organizer closed after its calls ran out: 本轮未整理, main reply kept", () => {
    const skipped = turn({ state: "cancelled", primaryBody: "主回复", organizerComplete: false, remainingCalls: 0 });
    expect(organizerSkipped(skipped)).toBe(true);
    expect(paygTurnNotices(skipped, ctx())).toEqual([expect.objectContaining({ tone: "status", text: ORGANIZER_SKIPPED_NOTICE })]);
    expect(ORGANIZER_SKIPPED_NOTICE).toContain("主回复已保留");
  });

  it("does not call other cancelled turns unorganized", () => {
    expect(organizerSkipped(turn({ state: "cancelled", primaryBody: null, organizerComplete: false, remainingCalls: 0 }))).toBe(false);
    expect(organizerSkipped(turn({ state: "cancelled", primaryBody: "x", organizerComplete: true, remainingCalls: 0 }))).toBe(false);
    expect(organizerSkipped(turn({ state: "cancelled", primaryBody: "x", organizerComplete: false, remainingCalls: 1 }))).toBe(false);
    expect(organizerSkipped(turn({ state: "completed", primaryBody: "x", organizerComplete: false, remainingCalls: 0 }))).toBe(false);
  });
});

describe("Q1 refusals of a new message", () => {
  it("recognizes the organizer's wait returned instead of an admission", () => {
    expect(blockedAdmission({ admitted: false, blockedRequestId: OTHER, executionId: ID, state: "waiting_credits" })).toEqual({ executionId: ID });
    expect(blockedAdmission({ executionId: ID, state: "completed" })).toBeNull();
    expect(blockedAdmission({ admitted: false })).toBeNull();
    expect(blockedAdmission(null)).toBeNull();
  });

  it("recognizes the fixed RUNTIME_ORGANIZER_PENDING refusal only", () => {
    expect(isOrganizerPendingError(refused("RUNTIME_ORGANIZER_PENDING：上一轮整理尚未完成，新消息尚未准入，请先处理原任务。"))).toBe(true);
    expect(isOrganizerPendingError(refused("RUNTIME_RESUME_CONFLICT：x"))).toBe(false);
    expect(isOrganizerPendingError("RUNTIME_ORGANIZER_PENDING")).toBe(false);
  });

  const organizer = turn({ primaryBody: "主回复", organizerComplete: false });

  it("offers 继续 of the paused organizer turn", () => {
    const onResume = vi.fn();
    const [notice] = organizerBlockedNotices([organizer], ID, { resumingId: null, onResume });
    expect(notice).toMatchObject({ tone: "warning", text: ORGANIZER_PENDING_NOTICE });
    expect(labels(notice)).toEqual(["继续"]);
    notice.actions![0].onClick();
    expect(onResume).toHaveBeenCalledWith({ executionId: ID, cursor: 2, epoch: 3 });
    expect(organizerBlockedNotices([organizer], ID, { resumingId: ID, onResume })[0].actions![0].disabled).toBe(true);
  });

  it("asks to wait, without 继续, while the organizer runs", () => {
    const [notice] = organizerBlockedNotices([{ ...organizer, state: "running" }], UNNAMED_ORGANIZER, { resumingId: null, onResume: vi.fn() });
    expect(notice.text).toBe(ORGANIZER_PENDING_NOTICE);
    expect(notice.actions).toBeUndefined();
  });

  it("ends once the organizer finished, and shows nothing without a refusal", () => {
    const done = { ...organizer, state: "completed", organizerComplete: true };
    expect(organizerBlockedNotices([done], ID, { resumingId: null, onResume: vi.fn() })).toEqual([]);
    expect(organizerBlockedNotices([done], UNNAMED_ORGANIZER, { resumingId: null, onResume: vi.fn() })).toEqual([]);
    expect(organizerBlockedNotices([organizer], null, { resumingId: null, onResume: vi.fn() })).toEqual([]);
  });

  it("keeps the notice when the view has not loaded the named turn yet", () => {
    expect(organizerBlockedNotices([], ID, { resumingId: null, onResume: vi.fn() })[0].actions).toBeUndefined();
    expect(organizerBlockedNotices(undefined, UNNAMED_ORGANIZER, { resumingId: null, onResume: vi.fn() })).toHaveLength(1);
  });
});

describe("resume results", () => {
  it("treats a still-short pause as the waiting notice, not an error", () => {
    expect(resumeOutcome({ state: "waiting_credits", executionId: ID, cursor: 3, epoch: 4 })).toEqual({ kind: "short" });
  });

  it("clears the outcome when the turn moved on", () => {
    expect(resumeOutcome({ state: "completed" })).toBeNull();
    expect(resumeOutcome({ state: "waiting_resume" })).toBeNull();
  });

  it("maps gate and configuration stops to fixed text", () => {
    expect(resumeOutcome({ state: "waiting_credits", unavailable: "call_limited" })).toEqual({ kind: "notice", text: runtimeGateMessages.minute });
    expect(resumeOutcome({ state: "waiting_credits", unavailable: "paused" })).toEqual({ kind: "notice", text: runtimeGateMessages.paused });
    for (const unavailable of ["usage_configuration_required", "RUNTIME_PRICE_UNCONFIRMED", "RUNTIME_PRICE_CONFIGURATION_PENDING"])
      expect(resumeOutcome({ state: "waiting_resume", unavailable })).toEqual({ kind: "notice", text: RESUME_ADMIN_NOTICE });
  });

  it("maps refusals by code and never shows server text", () => {
    expect(resumeFailureNotice(refused("RUNTIME_RESUME_CONFLICT：任务状态已更新，请刷新原任务后继续。"))).toBe(RESUME_CONFLICT_NOTICE);
    expect(resumeFailureNotice(refused("RUNTIME_PRICE_CONFIGURATION_PENDING"))).toBe(RESUME_ADMIN_NOTICE);
    expect(resumeFailureNotice(refused("RUNTIME_RESUME_CONFLICTX"))).toBe(RESUME_UNKNOWN_NOTICE);
    expect(resumeFailureNotice(new Error("fetch failed"))).toBe(RESUME_UNKNOWN_NOTICE);
  });
});

describe("paygResumeController", () => {
  const token = { executionId: ID, cursor: 2, epoch: 3 };
  const setup = (call: (t: typeof token) => Promise<unknown>) => {
    const refetch = vi.fn(async () => undefined);
    const states: unknown[] = [];
    const controller = paygResumeController({ call, refetch, onChange: state => states.push(state) });
    return { controller, refetch, states };
  };

  it("sends exactly the turn's token, then re-reads the session", async () => {
    const call = vi.fn(async () => ({ state: "completed" }));
    const { controller, refetch } = setup(call);
    await controller.resume(token);
    expect(call).toHaveBeenCalledExactlyOnceWith(token);
    expect(refetch).toHaveBeenCalledOnce();
    expect(controller.state()).toEqual({ resumingId: null, blockedId: null, outcomes: {} });
  });

  it("ignores a second click while the first resume runs", async () => {
    let finish!: (value: unknown) => void;
    const call = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { controller } = setup(call);
    const first = controller.resume(token);
    expect(controller.state().resumingId).toBe(ID);
    expect(await controller.resume(token)).toBe(false);
    expect(await controller.resume({ ...token, executionId: OTHER })).toBe(false);
    finish({ state: "completed" });
    expect(await first).toBe(true);
    expect(call).toHaveBeenCalledOnce();
    expect(controller.state().resumingId).toBeNull();
  });

  it("records a still-short result without an error, and clears it after success", async () => {
    const call = vi.fn().mockResolvedValueOnce({ state: "waiting_credits" }).mockResolvedValueOnce({ state: "completed" });
    const { controller } = setup(call);
    await controller.resume(token);
    expect(controller.state().outcomes).toEqual({ [ID]: { kind: "short" } });
    await controller.resume(token);
    expect(controller.state().outcomes).toEqual({});
  });

  it("keeps a refusal as a fixed notice and still re-reads", async () => {
    const { controller, refetch } = setup(async () => { throw refused("RUNTIME_RESUME_CONFLICT：x"); });
    expect(await controller.resume(token)).toBe(true);
    expect(controller.state().outcomes[ID]).toEqual({ kind: "notice", text: RESUME_CONFLICT_NOTICE });
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("ends the resume even when the re-read fails", async () => {
    const controller = paygResumeController({ call: async () => ({ state: "completed" }),
      refetch: async () => { throw new Error("offline"); }, onChange: () => {} });
    await controller.resume(token);
    expect(controller.state().resumingId).toBeNull();
  });

  it("tracks Q1 refusals and clears them on the next admission", () => {
    const { controller } = setup(async () => null);
    expect(controller.admitted({ admitted: false, blockedRequestId: OTHER, executionId: ID, state: "waiting_credits" })).toBe(false);
    expect(controller.state().blockedId).toBe(ID);
    expect(controller.admitted({ executionId: OTHER })).toBe(true);
    expect(controller.state().blockedId).toBeNull();
    controller.block();
    expect(controller.state().blockedId).toBe(UNNAMED_ORGANIZER);
  });
});

describe("去充值", () => {
  it("opens the recharge entry in a new tab so the paused turn stays", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    openTopUp();
    expect(open).toHaveBeenCalledWith(TOP_UP_HREF, "_blank", "noopener");
    expect(TOP_UP_HREF).toBe("/profile?tab=subscription");
  });
});
