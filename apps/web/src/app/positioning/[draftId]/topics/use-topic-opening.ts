/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from 'react';

type OpeningRequest = { draftId: string; requestId: string; input: string; executionId?: string | null };

/** Whether this browser already saw the server refuse this request (kept under `<key>:rejected:<id>`). */
export function topicRequestRefused(storage: Pick<Storage, 'getItem'>, key: string, requestId: string) {
  try { return Boolean(key && storage.getItem(key + ':rejected:' + requestId)); } catch { return false; }
}

/**
 * Opening is authorized by the persisted consent, never by this page/URL. All tabs recover the exact
 * same ID/input; existing conversations without that consent remain passive until an explicit action.
 * One attempt per mounted accepted intent; failures expose explicit recovery. A first turn the server
 * already refused is never sent again by itself: the user sends explicitly. Returns that refused id.
 */
export function useTopicOpening(options: {
  opening: OpeningRequest | null | undefined; ready: boolean; executions: ReadonlyArray<{ input?: string | null }> | undefined;
  storageKey: string; send: (request: { draftId: string; requestId: string; input: string }) => void;
}) {
  const { opening, ready, executions, storageKey } = options;
  const attempt = useRef('');
  const [refused, setRefused] = useState('');
  useEffect(() => {
    if (!opening || !ready) return;
    if (topicRequestRefused(localStorage, storageKey, opening.requestId)) { setRefused(opening.requestId); return; }
    if (attempt.current === opening.requestId) return;
    const already = opening.executionId || executions?.some(e => e.input === opening.input);
    attempt.current = opening.requestId;
    if (!already) options.send({ draftId: opening.draftId, requestId: opening.requestId, input: opening.input });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening?.requestId, ready, executions, storageKey]);
  return refused;
}
