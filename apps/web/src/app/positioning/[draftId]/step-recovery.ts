/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { parseStepEnvelope, type MentorStepEnvelope } from "./mentor-turn";
import { stopSaving } from "./stop-reply";

/**
 * After a reload, a tab switch or a lost connection the page no longer owns
 * the stream of a turn that may still be running on the server. These rules
 * decide when the page re-reads the Runtime history by itself, when a
 * retained step envelope finishes through the same idempotent recovery as the
 * user's retry action, and when the user has to be asked.
 */
export const HISTORY_POLL_MS = 2000;
/** How long an envelope with no execution in history yet may still be admitted by a request in flight. */
export const UNMATCHED_POLL_MS = 30000;
/** Re-reads of a history that has never loaded: their interval and how many failed reads end them. */
export const HISTORY_RETRY_MS = 5000;
export const HISTORY_RETRY_LIMIT = 10;

/**
 * Execution states that will not change any more (see runtime_sessions' state check). A BILL-PAYG
 * pause only changes on the user's explicit "继续" (runtime.resume), never through an envelope.
 */
const TERMINAL_STATES = ["completed", "cancelled", "cost_pending", "waiting_credits", "waiting_resume"];
/** States the server is still advancing by itself. `interrupted` waits for an explicit resume. */
const PROGRESSING_STATES = ["prepared", "running"];

export type RecoveryExecution = {
  executionId: string;
  state: string;
  request?: { requestId?: string } | null;
  billing?: { pausedReason?: string | null; cancelRequested?: boolean } | null;
  /** A user stop is recorded and its result is not saved yet (stop-reply.ts). */
  userStopPending?: boolean;
};
export type RecoveryHistory = {
  activeExecution?: string | null;
  executions?: RecoveryExecution[] | null;
};
/** True once history shows this execution terminal and no longer owning the session. */
export function executionSettled(history: RecoveryHistory | undefined, executionId: string) {
  const execution = history?.executions?.find(candidate => candidate.executionId === executionId);
  return Boolean(execution && TERMINAL_STATES.includes(execution.state) && history?.activeExecution !== executionId);
}
export type StoredStepEnvelope = {
  stepId: string;
  raw: string;
  parsed: MentorStepEnvelope<unknown> | null;
};

type EnvelopeReader = Pick<Storage, "getItem">;

export function stepEnvelopeKey(draftId: string, stepId: string) {
  return "opc-step:" + draftId + ":" + stepId;
}

/** The retained mentor envelopes of these steps, read fresh from storage. */
export function readStepEnvelopes(storage: EnvelopeReader, draftId: string, stepIds: readonly string[]) {
  const envelopes: StoredStepEnvelope[] = [];
  for (const stepId of stepIds) {
    const raw = storage.getItem(stepEnvelopeKey(draftId, stepId));
    if (raw) envelopes.push({ stepId, raw, parsed: parseStepEnvelope(raw) });
  }
  return envelopes;
}

/** The execution an envelope belongs to: its admitted id, else the server-persisted request id. */
export function envelopeExecution(history: RecoveryHistory, envelope: MentorStepEnvelope<unknown>) {
  const executions = history.executions ?? [];
  if (envelope.executionId) {
    const admitted = executions.find(execution => execution.executionId === envelope.executionId);
    if (admitted) return admitted;
  }
  return executions.find(execution => execution.request?.requestId === envelope.request.requestId);
}

/**
 * What a retained envelope waits for:
 * - `wait`: the server is still advancing its turn (or another one that owns
 *   the session), or a request in flight may still be admitted. Poll.
 * - `auto`: its execution is terminal and no execution owns the session. The
 *   page may run the same idempotent recovery as the retry action by itself.
 * - `stopped`: the user stopped its turn and it is still saving. The stop
 *   follow-up (use-live-reply.ts) re-reads it a bounded number of times; the
 *   envelope neither polls, recovers by itself nor asks for a retry.
 * - `user`: nothing will change by itself (unreadable envelope, interrupted
 *   execution, or a request that was never admitted), or the history cannot
 *   be read (a failed read, or none after the grace period). Ask the user;
 *   the retry still replays the envelope's own identities.
 */
export function envelopeRecovery(
  history: RecoveryHistory | undefined,
  envelope: StoredStepEnvelope,
  elapsedMs: number,
  historyFailed = false,
): "wait" | "auto" | "user" | "stopped" {
  if (!envelope.parsed) return "user";
  if (!history) return historyFailed || elapsedMs >= UNMATCHED_POLL_MS ? "user" : "wait";
  const executions = history.executions ?? [];
  const active = history.activeExecution
    ? executions.find(execution => execution.executionId === history.activeExecution) ?? { state: "running" }
    : null;
  const execution = envelopeExecution(history, envelope.parsed);
  if (execution && stopSaving(execution)) return "stopped";
  if (execution && PROGRESSING_STATES.includes(execution.state)) return "wait";
  if (active && PROGRESSING_STATES.includes(active.state)) return "wait";
  if (execution) return TERMINAL_STATES.includes(execution.state) && !active ? "auto" : "user";
  return elapsedMs < UNMATCHED_POLL_MS ? "wait" : "user";
}

/**
 * The polling interval for runtime.view, or false. The page polls only while
 * the server is still advancing a turn (the active execution, or the
 * execution of a retained envelope), and for a short grace period while a
 * retained envelope has no execution in history yet. A terminal or
 * interrupted execution stops polling. A history that has never loaded is
 * re-read after failed reads, HISTORY_RETRY_LIMIT times at most, so the page
 * picks up again once the connection returns.
 */
export function historyPollInterval(
  history: RecoveryHistory | undefined,
  envelopes: readonly StoredStepEnvelope[],
  elapsedMs: number,
  failedReads = 0,
): number | false {
  if (!history) return failedReads > 0 && failedReads < HISTORY_RETRY_LIMIT ? HISTORY_RETRY_MS : false;
  if (history.activeExecution) {
    const active = (history.executions ?? []).find(execution => execution.executionId === history.activeExecution);
    if (!active || PROGRESSING_STATES.includes(active.state)) return HISTORY_POLL_MS;
  }
  return envelopes.some(envelope => envelopeRecovery(history, envelope, elapsedMs) === "wait") ? HISTORY_POLL_MS : false;
}

/** Delay before each automatic recovery attempt of one envelope; its length is the attempt limit. */
export const AUTO_RECOVERY_DELAYS_MS = [0, 3000, 10000];

export type RecoveryAttempt = { count: number; notBefore: number };

/** One envelope's identity: a new request on the same step is a new envelope. */
export function envelopeIdentity(envelope: StoredStepEnvelope) {
  return envelope.stepId + ":" + (envelope.parsed?.request.requestId ?? envelope.raw);
}

/**
 * The next envelope the page may recover by itself now, if any. Every attempt
 * replays the same stored identities; after the last one the envelope waits
 * for the user's retry. An unreadable envelope is never recovered by itself.
 */
export function autoRecoveryTarget(
  history: RecoveryHistory | undefined,
  envelopes: readonly StoredStepEnvelope[],
  attempts: ReadonlyMap<string, RecoveryAttempt>,
  elapsedMs: number,
  now: number,
): StoredStepEnvelope | null {
  return envelopes.find(envelope => {
    const attempt = attempts.get(envelopeIdentity(envelope));
    if (attempt && (attempt.count >= AUTO_RECOVERY_DELAYS_MS.length || now < attempt.notBefore)) return false;
    return envelopeRecovery(history, envelope, elapsedMs) === "auto";
  }) ?? null;
}

/** True when the envelope needs the user's retry: nothing else will finish it. */
export function envelopeNeedsUser(
  history: RecoveryHistory | undefined,
  envelope: StoredStepEnvelope,
  attempts: ReadonlyMap<string, RecoveryAttempt>,
  elapsedMs: number,
  historyFailed = false,
) {
  const state = envelopeRecovery(history, envelope, elapsedMs, historyFailed);
  const count = attempts.get(envelopeIdentity(envelope))?.count ?? 0;
  return state === "user" || (state === "auto" && count >= AUTO_RECOVERY_DELAYS_MS.length);
}

/**
 * The page's own recovery timers. Disposing (unmount, which also covers a
 * draft switch because the page is keyed by draft) clears every pending timer,
 * and a recovery that finishes later can no longer schedule another one.
 */
export class RecoveryTimers {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  schedule(delayMs: number, callback: () => void) {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) callback();
    }, delayMs);
    this.timers.add(timer);
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  get pending() {
    return this.timers.size;
  }
}
