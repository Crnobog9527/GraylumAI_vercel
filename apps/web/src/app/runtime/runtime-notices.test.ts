/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, HISTORY_OMITTED_NOTICE } from "@/lib/runtime-gate-notice";
import { CAPACITY_NOTICE, ENDED_NOTICE, GUIDE_HELD_NOTICE, USER_STOP_NOTICE, runtimeTailNotices, runtimeTurnNotices, type RuntimeTurn } from "./runtime-notices";

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
