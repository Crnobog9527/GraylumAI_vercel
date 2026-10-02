/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from "react";
import {
  AUTO_RECOVERY_DELAYS_MS,
  autoRecoveryTarget,
  envelopeIdentity,
  envelopeNeedsUser,
  historyPollInterval,
  readStepEnvelopes,
  UNMATCHED_POLL_MS,
  type RecoveryAttempt,
  type RecoveryHistory,
} from "./step-recovery";

/**
 * The refetch interval of the draft's Runtime history. It re-reads while the
 * server is still advancing a turn this page did not stream (for example
 * after a reload) and stops as soon as that turn is terminal.
 */
export function useHistoryPolling(draftId: string, steps: readonly { id: string }[]) {
  const [openedAt] = useState(() => Date.now());
  // The server render also evaluates the option; it never polls and has no storage.
  return (query: { state: { data: unknown } }) => typeof window === "undefined" ? false : historyPollInterval(
    query.state.data as RecoveryHistory | undefined,
    readStepEnvelopes(sessionStorage, draftId, steps.map(step => step.id)),
    Date.now() - openedAt,
  );
}

/**
 * Finish retained envelopes without the user: once history proves an
 * envelope's execution is terminal, run the same recovery as the retry action
 * (`recover(step, true)`, which stays quiet on failure). A failed or uncertain
 * attempt keeps the envelope and is retried with growing delays up to
 * AUTO_RECOVERY_DELAYS_MS.length times, always with its stored identities.
 * Returns the envelopes that need the user's retry.
 */
export function useAutoStepRecovery<S extends { id: string }>(options: {
  history: RecoveryHistory | undefined;
  draftId: string;
  steps: readonly S[];
  /** False until the page restored its local state for this draft. */
  ready: boolean;
  /** True while any user action or opening is in progress. */
  blocked: boolean;
  recover: (step: S, quiet: boolean) => Promise<unknown>;
}): Array<{ step: S; readable: boolean }> {
  const [openedAt] = useState(() => Date.now());
  const [retry, setRetry] = useState(0);
  const latest = useRef(options);
  const attempts = useRef(new Map<string, RecoveryAttempt>());
  const running = useRef(false);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    // A request never admitted only needs the user after the grace period; show its retry line then.
    const timer = setTimeout(() => setRetry(value => value + 1), Math.max(0, openedAt + UNMATCHED_POLL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [openedAt]);
  const { history, ready, blocked, draftId, steps } = options;
  useEffect(() => {
    if (!ready || blocked || running.current) return;
    const { draftId, steps, recover } = latest.current;
    const stepIds = steps.map(step => step.id);
    const now = Date.now();
    const envelopes = readStepEnvelopes(sessionStorage, draftId, stepIds);
    const target = autoRecoveryTarget(history, envelopes, attempts.current, now - openedAt, now);
    const step = target && steps.find(candidate => candidate.id === target.stepId);
    if (!target || !step) return;
    const identity = envelopeIdentity(target), count = (attempts.current.get(identity)?.count ?? 0) + 1;
    attempts.current.set(identity, { count, notBefore: Infinity });
    running.current = true;
    void recover(step, true).catch(() => undefined).finally(() => {
      running.current = false;
      const delay = AUTO_RECOVERY_DELAYS_MS[count] ?? 0;
      attempts.current.set(identity, { count, notBefore: Date.now() + delay });
      // Re-evaluate after the delay; a released envelope simply has no target any more.
      setTimeout(() => setRetry(value => value + 1), delay);
    });
  }, [history, ready, blocked, retry, openedAt]);
  if (!ready || typeof window === "undefined") return [];
  const envelopes = readStepEnvelopes(sessionStorage, draftId, steps.map(step => step.id));
  return envelopes.flatMap(envelope => {
    const step = steps.find(candidate => candidate.id === envelope.stepId);
    if (!step || !envelopeNeedsUser(history, envelope, attempts.current, Date.now() - openedAt)) return [];
    return [{ step, readable: Boolean(envelope.parsed) }];
  });
}
