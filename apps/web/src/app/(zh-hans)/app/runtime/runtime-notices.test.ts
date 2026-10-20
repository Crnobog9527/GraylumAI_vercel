/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, PROVIDER_REJECTED_NOTICE, HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";
import { CAPACITY_NOTICE, ENDED_NOTICE, GUIDE_HELD_NOTICE, USER_STOP_NOTICE, runtimeTailNotices, runtimeTurnNotices, stopWithRecord, type RuntimeTurn } from "./runtime-notices";

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

  it("says 已停止 only for a stop this browser's user asked for", () => {
    expect(runtimeTurnNotices(turn({ state: "cancelled" }), ctx({ gateStop: "请求太频繁" }))[0]).toMatchObject({ tone: "warning", text: "请求太频繁" });
    expect(runtimeTurnNotices(turn({ state: "cancelled" }), ctx({ userStopped: true }))[0]).toMatchObject({ tone: "status", text: USER_STOP_NOTICE });
    // A turn the server ended (refusal, failed or timed-out call, recovery) is not a user stop.
    const ended = runtimeTurnNotices(turn({ state: "cancelled" }), ctx())[0];
    expect(ended).toMatchObject({ tone: "warning", text: ENDED_NOTICE });
    expect(ended.text).not.toContain("已停止");
  });

  // #973 Codex step 3: a stop that keeps the shown text ends completed with pausedReason user_stop.
  describe("a round the user stopped", () => {
    const savedStop = { stopped: true, billing: { pausedReason: "user_stop", cancelRequested: false } };
    const only = (notices: ReturnType<typeof runtimeTurnNotices>) => notices.map(notice => notice.text);

    it("says 已停止 the moment 停止 is clicked, while the view still shows it running", () => {
      for (const busy of [false, true]) {
        const notices = runtimeTurnNotices(turn({ state: "running" }), ctx({ userStopped: true, busy }));
        expect(notices).toEqual([expect.objectContaining({ tone: "status", text: USER_STOP_NOTICE })]);
        expect(notices[0].actions).toBeUndefined();
      }
    });

    it("keeps 已停止 while the server saves the stop, with no 回复尚未完成", () => {
      for (const state of ["prepared", "running"])
        expect(only(runtimeTurnNotices(turn({ state, userStopPending: true }), ctx()))).toEqual([USER_STOP_NOTICE]);
      // A save left interrupted offers 重试, which only finishes the saved stop.
      const [interrupted] = runtimeTurnNotices(turn({ state: "interrupted", userStopPending: true }), ctx());
      expect(interrupted.text).toBe(USER_STOP_NOTICE);
      expect(labels(interrupted)).toEqual(["重试"]);
      expect(labels(runtimeTurnNotices(turn({ state: "interrupted", billing: { pausedReason: "user_stop" } }), ctx())[0])).toEqual(["重试"]);
    });

    it("never offers 重试 on a stop only this tab knows about (#1013 review)", () => {
      // Without the server's record a retry could resume ordinary, charged provider work.
      for (const extra of [{}, { billing: { pausedReason: "user_stop", cancelRequested: true } }]) {
        const [notice] = runtimeTurnNotices(turn({ state: "interrupted", ...extra }), ctx({ userStopped: true }));
        expect(notice.text).toBe(USER_STOP_NOTICE);
        expect(notice.actions).toBeUndefined();
      }
    });

    it("says 已停止 for completed + user_stop, also after a reload without this tab's record", () => {
      expect(only(runtimeTurnNotices(turn({ state: "completed", ...savedStop }), ctx()))).toEqual([USER_STOP_NOTICE]);
      expect(only(runtimeTurnNotices(turn({ state: "completed", billing: savedStop.billing }), ctx()))).toEqual([USER_STOP_NOTICE]);
      expect(only(runtimeTurnNotices(turn({ state: "completed" }), ctx({ userStopped: true })))).toEqual([USER_STOP_NOTICE]);
    });

    it("says 已停止 for a cancelled stop from the view's own record too", () => {
      expect(only(runtimeTurnNotices(turn({ state: "cancelled", billing: savedStop.billing }), ctx()))).toEqual([USER_STOP_NOTICE]);
    });

    it("leaves every other state as it was", () => {
      // Ordinary completed round: nothing.
      expect(runtimeTurnNotices(turn({ state: "completed", billing: { pausedReason: null, cancelRequested: false } }), ctx())).toEqual([]);
      // An ordinary cancellation that once paused for a stop is not a user stop.
      expect(only(runtimeTurnNotices(turn({ state: "cancelled", billing: { pausedReason: "user_stop", cancelRequested: true } }), ctx())))
        .toEqual([ENDED_NOTICE]);
      // A really unfinished round keeps 回复尚未完成 with 重试 and 停止.
      const [open] = runtimeTurnNotices(turn({ state: "interrupted" }), ctx());
      expect(open.text).toBe("回复尚未完成，原请求已保留。");
      expect(labels(open)).toEqual(["重试", "停止"]);
      // A cost still being verified keeps its own notice, stopped or not.
      for (const extra of [{}, { userStopPending: true }])
        expect(only(runtimeTurnNotices(turn({ state: "cost_pending", ...extra }), ctx()))).toEqual(["费用待核实；重试只核对原调用。"]);
      // A BILL-PAYG pause carries its own notice (payg-wait.ts), stopped or not.
      for (const state of ["waiting_credits", "waiting_resume"])
        expect(runtimeTurnNotices(turn({ state, billing: { pausedReason: "insufficient_credits" } }), ctx())).toEqual([]);
      // Refusal reasons keep their own wording ahead of a stale stop record.
      expect(only(runtimeTurnNotices(turn({ state: "cancelled", unavailableReason: "provider_rejected" }), ctx({ userStopped: true }))))
        .toEqual([PROVIDER_REJECTED_NOTICE]);
    });
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

it.each(['preflight','platform_review'])('uses the persisted platform-failure reason %s after reload', unavailableReason => {
 const notices=runtimeTurnNotices(turn({state:'cancelled',unavailableReason}),ctx());
 expect(notices).toHaveLength(1);
 expect(notices[0].text).toContain('本轮不扣积分');
});

it('never claims "not charged" for a round whose cost is still being verified', () => {
 for (const unavailableReason of ['preflight','provider_history']) {
  const notices=runtimeTurnNotices(turn({state:'cost_pending',unavailableReason}),ctx());
  expect(notices.some(notice=>String(notice.text).includes('本轮不扣积分'))).toBe(false);
 }
});

it('uses the persisted history reason after reload, ahead of a stale local stop marker', () => {
 for (const context of [ctx(),ctx({userStopped:true}),ctx({gateStop:'stale gate'})]) {
  const notices=runtimeTurnNotices(turn({state:'cancelled',unavailableReason:'provider_history'}),context);
  expect(notices).toHaveLength(1);
  expect(notices[0].text).toBe(PROVIDER_HISTORY_NOTICE);
  expect(notices[0].text).not.toContain('已停止');
  expect(notices[0].actions).toBeUndefined();
  expect(runtimeTailNotices({error:PROVIDER_HISTORY_NOTICE,heldGuide:false,busy:false,onGuide:vi.fn(),
   lastTurn:{open:false,texts:notices.map(n=>String(n.text))}})).toEqual([]);
 }
});

it('shows the persisted older-history notice without blocking the completed reply',()=>{
 const notices=runtimeTurnNotices(turn({state:'completed',historyOmitted:true}),ctx());
 expect(notices).toEqual([{id:'e1:history-omitted',tone:'status',text:HISTORY_OMITTED_NOTICE}]);
 expect(notices[0].actions).toBeUndefined();
});

it('keeps 正在回复… while the view still shows a turn whose execute call already finished', () => {
 // The execute call returned; busy is off but the view has not been re-read yet.
 const [notice]=runtimeTurnNotices(turn({state:'running'}),ctx({finished:true}));
 expect(notice).toMatchObject({tone:'status',busy:true,text:'正在回复…'});
 expect(notice.text).not.toContain('回复尚未完成');
 expect(notice.actions!.map(action=>action.disabled)).toEqual([true,false]);
 // A finished turn's re-read view shows no open notice at all.
 expect(runtimeTurnNotices(turn({state:'completed'}),ctx({finished:true}))).toEqual([]);
 // Cost verification and capacity keep their own notices.
 // execute returned cost_pending and the view re-read it: the cost check stays available.
 const [cost]=runtimeTurnNotices(turn({state:'cost_pending'}),ctx({finished:true}));
 expect(cost.text).toBe('费用待核实；重试只核对原调用。');
 expect(cost.actions!.map(action=>action.disabled)).toEqual([false,false]);
 // Any other re-read open state ends the marker too: the retry is available again.
 for(const state of ['interrupted','unknown_state']){
  const [notice]=runtimeTurnNotices(turn({state}),ctx({finished:true}));
  expect(notice).toMatchObject({tone:'warning',text:'回复尚未完成，原请求已保留。'});
  expect(notice.actions!.map(action=>action.disabled)).toEqual([false,false]);
 }
 expect(runtimeTurnNotices(turn({state:'prepared'}),ctx({finished:true}))[0].text).toBe('正在回复…');
 expect(runtimeTurnNotices(turn({state:'running'}),ctx({finished:true,capacity:true}))[0].text).toBe(CAPACITY_NOTICE);
});

it('still says 回复尚未完成 when the server left the turn unfinished', () => {
 // A pending execute result is never recorded as finished (finishedExecution), so finished stays false.
 const [notice]=runtimeTurnNotices(turn({state:'interrupted'}),ctx({finished:false}));
 expect(notice).toMatchObject({tone:'warning',text:'回复尚未完成，原请求已保留。'});
});

it('shows the older-history notice and the running state together', () => {
 const texts=runtimeTurnNotices(turn({state:'running',historyOmitted:true}),ctx({busy:true})).map(n=>n.text);
 expect(texts).toEqual([HISTORY_OMITTED_NOTICE,'正在回复…']);
});
it('keeps the provider refusal notice for a cancelled turn after a reload, without actions', () => {
  const [notice] = runtimeTurnNotices(turn({ state: 'cancelled', unavailableReason: 'provider_rejected' }), ctx());
  expect(notice).toMatchObject({ tone: 'warning', text: PROVIDER_REJECTED_NOTICE });
  expect(notice.actions).toBeUndefined();
  // Unknown reasons and no reason keep the neutral ended notice.
  for (const unavailableReason of ['something_new', null])
    expect(runtimeTurnNotices(turn({ state: 'cancelled', unavailableReason }), ctx())[0].text).toBe(ENDED_NOTICE);
  // The live execute error is not repeated once the turn shows it.
  const texts = runtimeTurnNotices(turn({ state: 'cancelled', unavailableReason: 'provider_rejected' }), ctx()).map(n => String(n.text));
  expect(runtimeTailNotices({ error: PROVIDER_REJECTED_NOTICE, heldGuide: false, busy: false, onGuide: vi.fn(),
    lastTurn: { open: false, texts } })).toEqual([]);
});

describe("BILL-PAYG turns", () => {
  it("leaves a paused turn to its pause notice: no 重试 or 停止", () => {
    for (const state of ["waiting_credits", "waiting_resume"])
      expect(runtimeTurnNotices(turn({ state, cursor: 1, epoch: 1 }), ctx())).toEqual([]);
  });

  it("keeps the saved-main-reply status above a paused organizer", () => {
    const notices = runtimeTurnNotices(turn({ state: "waiting_credits", primaryBody: "主回复", organizerComplete: false }), ctx());
    expect(notices.map(n => n.text)).toEqual(["主回复已保存，附属整理未完成。"]);
  });

  it("does not call a quietly closed organizer an ended turn", () => {
    const skipped = turn({ state: "cancelled", primaryBody: "主回复", organizerComplete: false, remainingCalls: 0 });
    expect(runtimeTurnNotices(skipped, ctx())).toEqual([]);
    expect(runtimeTurnNotices({ ...skipped, remainingCalls: 1 }, ctx()).map(n => n.text)).toContain(ENDED_NOTICE);
  });
});

// POSITIONING-GATE: a refunded fallback refusal reads as "定位 first", not as a generic ended round.
describe("positioning refusal turn", () => {
  it("shows only the positioning notice for a cancelled positioning_required turn", async () => {
    const { POSITIONING_REQUIRED_NOTICE } = await import("./gate-notices");
    const notices = runtimeTurnNotices(turn({ state: "cancelled", unavailableReason: "positioning_required" }), ctx());
    expect(notices.map(n => n.text)).toEqual([POSITIONING_REQUIRED_NOTICE]);
    expect(notices[0]!.text).not.toBe(ENDED_NOTICE);
  });
});

// #1013 review: a failed stop request may still have been recorded (lost answer), so this tab's record
// is dropped only when a successful re-read proves the server recorded neither a stop nor a cancel.
describe("stopWithRecord", () => {
  const store = () => { const m = new Map<string, string>(); return Object.assign(Object.create(null), {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
  }) as Storage; };
  const at = (storage: Storage) => ({ storage, sessionId: "s", executionId: "e1" });
  const key = "opc-runtime-user-stop:s:e1";
  const view = (execution: Record<string, unknown> | null, isError = false) => async () =>
    ({ isError, data: execution ? { executions: [{ executionId: "e1", ...execution }] } : undefined });
  const fail = () => Promise.reject(new Error("timeout"));

  it("keeps the record when the stop succeeds", async () => {
    const storage = store();
    expect(await stopWithRecord(at(storage), async () => ({}), view({ state: "running", userStopPending: true }))).toBe(false);
    expect(storage.getItem(key)).toBe("1");
  });

  it("keeps the record when the request failed but the re-read cannot tell", async () => {
    const storage = store();
    expect(await stopWithRecord(at(storage), fail, view(null, true))).toBe(true);
    expect(storage.getItem(key)).toBe("1");
  });

  it("keeps the record when the re-read shows the server recorded the stop or a cancel", async () => {
    for (const execution of [{ state: "running", userStopPending: true }, { state: "completed", stopped: true },
      { state: "running", billing: { cancelRequested: true } }, { state: "cancelled" }]) {
      const storage = store();
      await stopWithRecord(at(storage), fail, view(execution));
      expect(storage.getItem(key)).toBe("1");
    }
  });

  it("drops the record only when the re-read proves nothing was recorded", async () => {
    const storage = store();
    expect(await stopWithRecord(at(storage), fail, view({ state: "running", billing: { cancelRequested: false } }))).toBe(true);
    expect(storage.getItem(key)).toBeNull();
  });
});
