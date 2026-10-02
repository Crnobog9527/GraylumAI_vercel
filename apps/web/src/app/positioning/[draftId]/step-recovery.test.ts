/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentorRequest } from "./mentor-turn";
import {
  AUTO_RECOVERY_DELAYS_MS,
  HISTORY_POLL_MS,
  HISTORY_RETRY_LIMIT,
  HISTORY_RETRY_MS,
  RecoveryTimers,
  UNMATCHED_POLL_MS,
  autoRecoveryTarget,
  envelopeIdentity,
  envelopeNeedsUser,
  envelopeRecovery,
  historyPollInterval,
  readStepEnvelopes,
  stepEnvelopeKey,
  type RecoveryAttempt,
  type RecoveryHistory,
} from "./step-recovery";

const draftId = "11111111-1111-4111-8111-111111111111";
const executionId = "33333333-3333-4333-8333-333333333333";
const otherExecution = "55555555-5555-4555-8555-555555555555";
const request: MentorRequest = {
  draftId,
  stepId: "step-0",
  purpose: "mentor",
  requestId: "44444444-4444-4444-8444-444444444444",
  input: "我提供摄影入门练习课程",
  questionId: "product",
  organizeAfter: true,
};

function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}
const admitted = JSON.stringify({ request, executionId });
const unadmitted = JSON.stringify({ request });
const envelopesOf = (raw: string) => readStepEnvelopes(storage({ [stepEnvelopeKey(draftId, "step-0")]: raw }), draftId, ["step-0", "step-1"]);
const history = (state: string, activeExecution: string | null = null, id = executionId): RecoveryHistory => ({
  activeExecution,
  executions: [{ executionId: id, state, request: { requestId: request.requestId } }],
});

describe("historyPollInterval", () => {
  it("polls while the active execution is still advancing", () => {
    expect(historyPollInterval(history("running", executionId), [], 0)).toBe(HISTORY_POLL_MS);
    expect(historyPollInterval(history("prepared", executionId), [], 0)).toBe(HISTORY_POLL_MS);
    // An active id not projected yet is treated as running.
    expect(historyPollInterval({ activeExecution: executionId, executions: [] }, [], 0)).toBe(HISTORY_POLL_MS);
  });

  it("does not poll without an active execution or a retained envelope", () => {
    expect(historyPollInterval(undefined, [], 0)).toBe(false);
    expect(historyPollInterval(history("completed"), [], 0)).toBe(false);
    expect(historyPollInterval({ activeExecution: null, executions: [] }, [], 0)).toBe(false);
  });

  it("polls for a retained envelope until its execution is terminal", () => {
    expect(historyPollInterval(history("running"), envelopesOf(admitted), 0)).toBe(HISTORY_POLL_MS);
    for (const state of ["completed", "cancelled", "cost_pending"])
      expect(historyPollInterval(history(state), envelopesOf(admitted), 0)).toBe(false);
  });

  it("matches an envelope without an execution id by its persisted request id", () => {
    expect(historyPollInterval(history("running", null, otherExecution), envelopesOf(unadmitted), 0)).toBe(HISTORY_POLL_MS);
    expect(historyPollInterval(history("completed", null, otherExecution), envelopesOf(unadmitted), 0)).toBe(false);
  });

  it("waits only briefly for an envelope whose execution is not in history", () => {
    const empty = { activeExecution: null, executions: [] };
    expect(historyPollInterval(empty, envelopesOf(unadmitted), 0)).toBe(HISTORY_POLL_MS);
    expect(historyPollInterval(empty, envelopesOf(unadmitted), UNMATCHED_POLL_MS)).toBe(false);
  });

  it("does not poll an interrupted execution or an unreadable envelope", () => {
    expect(historyPollInterval(history("interrupted", executionId), envelopesOf(admitted), 0)).toBe(false);
    expect(historyPollInterval({ activeExecution: null, executions: [] }, envelopesOf("{broken"), 0)).toBe(false);
  });
});

describe("envelopeRecovery", () => {
  const [envelope] = envelopesOf(admitted);
  it("recovers by itself only after the execution is terminal and nothing owns the session", () => {
    for (const state of ["completed", "cancelled", "cost_pending"])
      expect(envelopeRecovery(history(state), envelope!, 0)).toBe("auto");
    expect(envelopeRecovery(history("running"), envelope!, 0)).toBe("wait");
    expect(envelopeRecovery(undefined, envelope!, 0)).toBe("wait");
    // Another execution still owns the session: wait for it instead of asking the user.
    const busy = { activeExecution: otherExecution, executions: [...history("completed").executions!,
      { executionId: otherExecution, state: "running" }] };
    expect(envelopeRecovery(busy, envelope!, 0)).toBe("wait");
  });

  it("asks the user when nothing will change by itself", () => {
    expect(envelopeRecovery(history("interrupted", executionId), envelope!, 0)).toBe("user");
    expect(envelopeRecovery(history("completed"), envelopesOf("{broken")[0]!, 0)).toBe("user");
    const empty = { activeExecution: null, executions: [] };
    expect(envelopeRecovery(empty, envelopesOf(unadmitted)[0]!, 0)).toBe("wait");
    expect(envelopeRecovery(empty, envelopesOf(unadmitted)[0]!, UNMATCHED_POLL_MS)).toBe("user");
  });
});

describe("autoRecoveryTarget", () => {
  const envelopes = envelopesOf(admitted), identity = envelopeIdentity(envelopes[0]!);
  const attempts = (count: number, notBefore = 0) => new Map<string, RecoveryAttempt>([[identity, { count, notBefore }]]);

  it("starts recovery only once the execution is terminal", () => {
    expect(autoRecoveryTarget(history("running", executionId), envelopes, new Map(), 0, 0)).toBeNull();
    expect(autoRecoveryTarget(history("running"), envelopes, new Map(), 0, 0)).toBeNull();
    expect(autoRecoveryTarget(history("completed"), envelopes, new Map(), 0, 0)).toBe(envelopes[0]);
  });

  it("does not start a second attempt while one runs or before its delay", () => {
    expect(autoRecoveryTarget(history("completed"), envelopes, attempts(1, Infinity), 0, 1000)).toBeNull();
    expect(autoRecoveryTarget(history("completed"), envelopes, attempts(1, 3000), 0, 2999)).toBeNull();
    expect(autoRecoveryTarget(history("completed"), envelopes, attempts(1, 3000), 0, 3000)).toBe(envelopes[0]);
  });

  it("stops after a fixed number of attempts and then asks the user", () => {
    const limit = AUTO_RECOVERY_DELAYS_MS.length;
    expect(limit).toBeGreaterThan(1);
    expect(AUTO_RECOVERY_DELAYS_MS.every((delay, index) => index === 0 || delay > AUTO_RECOVERY_DELAYS_MS[index - 1]!)).toBe(true);
    expect(envelopeNeedsUser(history("completed"), envelopes[0]!, attempts(limit - 1), 0)).toBe(false);
    expect(autoRecoveryTarget(history("completed"), envelopes, attempts(limit), 0, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(envelopeNeedsUser(history("completed"), envelopes[0]!, attempts(limit), 0)).toBe(true);
  });

  it("does not show the retry line while the turn is still advancing or being recovered", () => {
    expect(envelopeNeedsUser(history("running"), envelopes[0]!, new Map(), 0)).toBe(false);
    expect(envelopeNeedsUser(history("completed"), envelopes[0]!, new Map(), 0)).toBe(false);
  });

  it("never recovers an unreadable envelope by itself, and shows its retry line", () => {
    const broken = envelopesOf("{broken");
    expect(autoRecoveryTarget(history("completed"), broken, new Map(), 0, 0)).toBeNull();
    expect(envelopeNeedsUser(history("completed"), broken[0]!, new Map(), 0)).toBe(true);
  });

  it("keeps the stored envelope and its identity across failed attempts", () => {
    const key = stepEnvelopeKey(draftId, "step-0"), stored = storage({ [key]: admitted });
    const read = () => readStepEnvelopes(stored, draftId, ["step-0"]);
    // A failed attempt changes nothing in storage; the next attempt replays the same identities.
    expect(read()[0]!.parsed).toMatchObject({ executionId, request: { requestId: request.requestId } });
    expect(envelopeIdentity(read()[0]!)).toBe(identity);
    expect(stored.map.get(key)).toBe(admitted);
  });

  it("treats a new request on the same step as a new envelope", () => {
    const next = { ...request, requestId: "66666666-6666-4666-8666-666666666666" };
    const later: RecoveryHistory = { activeExecution: null,
      executions: [{ executionId: otherExecution, state: "completed", request: { requestId: next.requestId } }] };
    const fresh = envelopesOf(JSON.stringify({ request: next, executionId: otherExecution }));
    expect(autoRecoveryTarget(later, fresh, attempts(AUTO_RECOVERY_DELAYS_MS.length), 0, 0)).toBe(fresh[0]);
  });
});

describe("a history that never loaded", () => {
  const envelopes = envelopesOf(admitted);

  it("is still loading at first: no retry line, no extra polling", () => {
    expect(envelopeRecovery(undefined, envelopes[0]!, 0)).toBe("wait");
    expect(envelopeNeedsUser(undefined, envelopes[0]!, new Map(), 0)).toBe(false);
    expect(historyPollInterval(undefined, envelopes, 0, 0)).toBe(false);
  });

  it("shows the retry line once a read failed and re-reads a bounded number of times", () => {
    expect(envelopeRecovery(undefined, envelopes[0]!, 0, true)).toBe("user");
    expect(envelopeNeedsUser(undefined, envelopes[0]!, new Map(), 0, true)).toBe(true);
    // The retry line is the user's entry; nothing is recovered automatically without history.
    expect(autoRecoveryTarget(undefined, envelopes, new Map(), 0, 0)).toBeNull();
    expect(historyPollInterval(undefined, envelopes, 0, 1)).toBe(HISTORY_RETRY_MS);
    expect(historyPollInterval(undefined, envelopes, 0, HISTORY_RETRY_LIMIT - 1)).toBe(HISTORY_RETRY_MS);
    expect(historyPollInterval(undefined, envelopes, 0, HISTORY_RETRY_LIMIT)).toBe(false);
  });

  it("also shows the retry line when a read never returns within the grace period", () => {
    expect(envelopeNeedsUser(undefined, envelopes[0]!, new Map(), UNMATCHED_POLL_MS - 1)).toBe(false);
    expect(envelopeNeedsUser(undefined, envelopes[0]!, new Map(), UNMATCHED_POLL_MS)).toBe(true);
  });

  it("continues by itself once a later read succeeds", () => {
    // Connection back while the turn still runs: poll and hide the retry line.
    expect(historyPollInterval(history("running", executionId), envelopes, 0, 0)).toBe(HISTORY_POLL_MS);
    expect(envelopeNeedsUser(history("running", executionId), envelopes[0]!, new Map(), 60000, false)).toBe(false);
    // Connection back after the turn finished: recover automatically with the same envelope.
    expect(autoRecoveryTarget(history("completed"), envelopes, new Map(), 60000, 0)).toBe(envelopes[0]);
    expect(envelopeNeedsUser(history("completed"), envelopes[0]!, new Map(), 60000, false)).toBe(false);
  });
});

describe("RecoveryTimers", () => {
  afterEach(() => vi.useRealTimers());

  it("runs a scheduled callback after its delay", () => {
    vi.useFakeTimers();
    const timers = new RecoveryTimers(), callback = vi.fn();
    timers.schedule(3000, callback);
    vi.advanceTimersByTime(2999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(timers.pending).toBe(0);
  });

  it("clears pending timers on unmount and ignores a recovery that finishes afterwards", async () => {
    vi.useFakeTimers();
    const timers = new RecoveryTimers(), callback = vi.fn();
    timers.schedule(10000, callback);
    let finish!: () => void;
    const recovery = new Promise<void>(resolve => { finish = resolve; }).finally(() => timers.schedule(3000, callback));
    timers.dispose();
    expect(timers.pending).toBe(0);
    finish();
    await recovery;
    expect(timers.pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps a switched-away draft's timers from reaching the next draft", () => {
    vi.useFakeTimers();
    // The page is keyed by draft: switching unmounts the old instance and mounts a new one.
    const first = new RecoveryTimers(), second = new RecoveryTimers();
    const firstCallback = vi.fn(), secondCallback = vi.fn();
    first.schedule(3000, firstCallback);
    first.dispose();
    first.schedule(0, firstCallback);
    second.schedule(3000, secondCallback);
    vi.advanceTimersByTime(3000);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
  });
});
