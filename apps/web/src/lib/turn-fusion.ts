/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { StreamEvent } from '@repo/api/src/services/turn/sse';
import { runTurn } from './turn-stream';

/*
 * CORE-PATH-V2 V2-10: the compare and the jury on the turn path. POST /api/turn/estimate prices one without creating anything;
 * a compare starts on POST /api/turn/compare with the quote the user saw, a jury on POST /api/turn (kind=jury). A refusal reaches
 * the page as an Error whose message is the fixed code, the same words the old tRPC procedures threw, so the pages' texts stay.
 */
const send: typeof fetch = (...args) => globalThis.fetch(...args);

/** The maximum a compare or a jury would hold; the old estimates' fields. */
export async function estimateFusion<T>(body: unknown, deps: { fetch: typeof fetch } = { fetch: send }): Promise<T> {
  const response = await deps.fetch('/api/turn/estimate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const answer = await response.json().catch(() => null) as ({ error?: string } & Record<string, unknown>) | null;
  if (!response.ok || !answer || answer.error) throw new Error(answer?.error ?? 'TURN_FAILED');
  return answer as T;
}

export type CompareLive = { onOpened: (compareId: string) => void; onColumn: (compareId: string, index: number, delta: string) => void;
  onAnswer: (compareId: string, index: number, ok: boolean) => void };
export type CompareStarted = { compareId: string; turnId: number };

/**
 * Starts a compare and follows it to its end. Resolves with the compare as soon as it is opened (`opened`), while the stream
 * goes on feeding the columns; `finished` resolves when the turn has closed. Throws the refusal code before anything opened.
 */
export function startCompare(body: { sessionId: string; requestId: string; question: string; modelIds: string[]; skill?: unknown;
  shown: unknown }, live: CompareLive, deps: { fetch: typeof fetch } = { fetch: send }) {
  let opened!: (value: CompareStarted) => void, failed!: (error: Error) => void, done = false, compareId = '';
  const started = new Promise<CompareStarted>((resolve, reject) => { opened = resolve; failed = reject; });
  const finished = (async () => {
    const outcome = await runTurnTo('/api/turn/compare', body, event => {
      if (event.type === 'opened' && 'compareId' in event) {
        done = true; compareId = String(event.compareId); live.onOpened(compareId); opened({ compareId, turnId: event.turnId });
      } else if (event.type === 'column') live.onColumn(compareId, event.index, event.delta);
      else if (event.type === 'answer') live.onAnswer(compareId, event.index, event.ok);
    }, deps);
    if (!done) failed(outcome.state === 'refused' ? new Error(outcome.code)
      : outcome.state === 'finished' && outcome.last.type === 'error' ? new Error(outcome.last.code) : new Error('TURN_LOST'));
    return outcome;
  })();
  return { started, finished };
}

/** Starts a review (kind=jury): resolves with its id; the groups run on the server after this answer. */
export async function startJury(body: { requestId: string; draftId: string; sourceVersionId: string; acceptedCredits?: number },
  deps: { fetch: typeof fetch } = { fetch: send }): Promise<{ reviewId: string }> {
  let reviewId = '';
  const outcome = await runTurnTo('/api/turn', { kind: 'jury', ...body }, event => {
    if (event.type === 'review') reviewId = event.reviewId;
  }, deps);
  if (reviewId) return { reviewId };
  if (outcome.state === 'refused') throw new Error(outcome.code);
  if (outcome.state === 'finished' && outcome.last.type === 'error') throw new Error(outcome.last.code);
  // The answer was lost: the same request id finds the same review.
  throw new Error('TURN_LOST');
}

/** runTurn for the endpoint of the request (compare has its own path); the events are those of StreamEvent. */
function runTurnTo(path: string, body: unknown, onEvent: (event: StreamEvent) => void, deps: { fetch: typeof fetch }) {
  const to: typeof fetch = (_input, init) => deps.fetch(path, init);
  return runTurn(body, event => onEvent(event as StreamEvent), { fetch: to });
}
