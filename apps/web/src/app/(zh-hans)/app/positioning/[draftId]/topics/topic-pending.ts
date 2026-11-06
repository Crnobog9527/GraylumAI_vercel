/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect } from 'react';

/*
 * The page keeps every operation it sends (a message, a save, an adoption) as a frozen pending record until the server's answer
 * is known. That record is not by itself an unknown outcome: while this tab is still waiting for the answer it is simply in
 * flight, and a message whose reply the read back already shows has completed. Only what is left is unknown and gets the
 * "结果尚未确认" notice with its retry (Codex batch F: the auto first turn 6644 completed normally, charged once, and the page
 * showed that notice the whole time it was answering).
 */
type Pending = { kind: string; request: { requestId: string; input?: string } };
type Execution = { executionId: string; state: string };

export type PendingState = 'none' | 'in_flight' | 'completed' | 'unknown';

export function pendingState(pending: Pending | null, inFlight: boolean, executions: ReadonlyArray<Execution> | undefined): PendingState {
  if (!pending) return 'none';
  if (inFlight) return 'in_flight';
  // A topic reply is saved with its turn: a completed execution under this request id is the message's answer.
  if (pending.kind === 'chat' && executions?.some(e => e.executionId === pending.request.requestId && e.state === 'completed')) return 'completed';
  return 'unknown';
}

/**
 * Releases the frozen record of a message whose reply is saved, as a finished send does. `released`: this call released it;
 * `gone`: no record is left (another tab released it); `other`: another tab froze a different operation since, which stays.
 */
export function releaseCompleted(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string,
  requestId: string): 'released' | 'gone' | 'other' {
  const raw = storage.getItem(key);
  if (!raw) return 'gone';
  let op: Pending | null = null;
  try { op = JSON.parse(raw) as Pending; } catch { /* unreadable: kept, the page's own restore reports it */ }
  if (op?.kind !== 'chat' || op.request?.requestId !== requestId) return 'other';
  storage.setItem(key + ':completed:' + requestId, raw);
  storage.removeItem(key);
  return 'released';
}

/** A pending message the read back shows as answered (a reload mid-reply, a dropped stream) is completed, not unknown. */
export function useReleaseCompleted(o: { pending: Pending | null; inFlight: boolean; executions: ReadonlyArray<Execution> | undefined;
  storageKey: string; onReleased: () => void }) {
  const state = pendingState(o.pending, o.inFlight, o.executions), requestId = o.pending?.request.requestId ?? '';
  useEffect(() => {
    if (state !== 'completed' || !o.storageKey || !requestId) return;
    // The same lock as a send, so a retry in another tab never runs beside the release.
    void navigator.locks.request(o.storageKey, () => {
      if (releaseCompleted(localStorage, o.storageKey, requestId) !== 'other') o.onReleased();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, requestId, o.storageKey]);
  return state;
}
