/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from "vitest";
import { startLiveReply, type LiveReply } from "./agent-turn-display";
import { reportStopController, type ReportStopPhase } from "./report-stop";
import { STOP_FOLLOW_UP_DELAYS_MS, type StopRequest } from "./stop-reply";

const id = "11111111-2222-4333-8444-555555555555";
const reply: LiveReply = { ...startLiveReply(id), text: "## 一\n正文", points: 7, rev: 1, source: "final" };

function setup(cancel: (request: StopRequest) => Promise<unknown>, states: Array<string | null> = []) {
  const phases: ReportStopPhase[] = [];
  const queued: Array<{ delay: number; run: () => void }> = [];
  const reread = vi.fn(async () => states.shift() ?? "running");
  const cancelSpy = vi.fn(cancel);
  const stop = reportStopController({ cancel: cancelSpy, reread, onChange: phase => phases.push(phase),
    schedule: (delay, run) => queued.push({ delay, run }) });
  const tick = async () => { const next = queued.shift(); next?.run(); await new Promise(resolve => setTimeout(resolve, 0)); return next?.delay; };
  return { stop, phases, queued, reread, cancel: cancelSpy, tick };
}

it("shows an unconfirmed stop and resends exactly the same stop request on retry", async () => {
  let fail = true;
  const s = setup(async () => { if (fail) throw new Error("network"); return { state: "completed" }; });
  await s.stop.stop(reply);
  expect(s.stop.phase()).toBe("unconfirmed");
  const first = s.cancel.mock.calls[0]![0];
  expect(first).toEqual({ executionId: id, stopAt: 7, source: "final" });
  // A later stream change does not move the fixed request.
  fail = false;
  await s.stop.stop({ ...reply, text: reply.text + "更多", points: 9 });
  expect(s.cancel).toHaveBeenCalledTimes(2);
  expect(s.cancel.mock.calls[1]![0]).toEqual(first);
  expect(s.stop.phase()).toBe("settled");
});

it("retry does nothing unless the last stop is unconfirmed", async () => {
  const s = setup(async () => ({ state: "completed" }));
  await s.stop.retry();
  expect(s.cancel).not.toHaveBeenCalled();
  await s.stop.stop(reply);
  await s.stop.retry();
  expect(s.cancel).toHaveBeenCalledOnce();
});

it("re-reads the status on the bounded follow-up until it is final", async () => {
  const s = setup(async () => { throw new Error("network"); }, ["running", null, "completed"]);
  await s.stop.stop(reply);
  expect(await s.tick()).toBe(STOP_FOLLOW_UP_DELAYS_MS[0]);
  expect(await s.tick()).toBe(STOP_FOLLOW_UP_DELAYS_MS[1]);
  expect(await s.tick()).toBe(STOP_FOLLOW_UP_DELAYS_MS[2]);
  expect(s.stop.phase()).toBe("settled");
  expect(s.queued).toHaveLength(0);
  expect(s.reread).toHaveBeenCalledTimes(3);
});

it("stops re-reading after the last follow-up delay and keeps the stop unconfirmed and retryable", async () => {
  const s = setup(async () => { throw new Error("network"); });
  await s.stop.stop(reply);
  for (let index = 0; index < STOP_FOLLOW_UP_DELAYS_MS.length; index++) await s.tick();
  expect(s.queued).toHaveLength(0);
  expect(s.reread).toHaveBeenCalledTimes(STOP_FOLLOW_UP_DELAYS_MS.length);
  expect(s.stop.phase()).toBe("unconfirmed");
  await s.stop.retry();
  expect(s.cancel).toHaveBeenCalledTimes(2);
});

it("a retry restarts the follow-up and retires the older chain", async () => {
  const s = setup(async () => { throw new Error("network"); });
  await s.stop.stop(reply);
  await s.stop.retry();
  // The first chain's timer still fires but no longer reads.
  await s.tick();
  expect(s.reread).not.toHaveBeenCalled();
  await s.tick();
  expect(s.reread).toHaveBeenCalledOnce();
});
