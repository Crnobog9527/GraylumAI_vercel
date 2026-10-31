/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TurnEvent } from '@repo/api/src/services/turn/sse';

/*
 * CORE-PATH-V2 V2-10: the page's side of POST /api/turn, one turn per request, answered as one event stream (2.2). `opened`
 * comes first, then the text as it arrives, then exactly one `result` or `error`. The stream can end without either (the
 * connection dropped); the turn still runs to its close on the server, so the caller reads GET /api/turn, never resends.
 */
export type TurnOutcome =
  | { state: 'finished'; last: Extract<TurnEvent, { type: 'result' | 'error' }> }
  | { state: 'refused'; code: string; status: number }
  | { state: 'lost' };

/** Splits the bytes of an event stream into events; a chunk may end anywhere, even inside one character. */
export function turnEventDecoder(onEvent: (event: TurnEvent) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    if (!data) return;
    let event: TurnEvent;
    try { event = JSON.parse(data) as TurnEvent; } catch { return; }
    onEvent(event);
  };
  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) { take(buffer.slice(0, end)); buffer = buffer.slice(end + 2); end = buffer.indexOf('\n\n'); }
    },
  };
}

/** Sends one turn and hands each event to `onEvent`. A refused request names its fixed code; a dropped stream is `lost`. */
export async function runTurn(request: unknown, onEvent: (event: TurnEvent) => void,
  deps: { fetch: typeof fetch; signal?: AbortSignal } = { fetch: (...args) => globalThis.fetch(...args) }): Promise<TurnOutcome> {
  let last: Extract<TurnEvent, { type: 'result' | 'error' }> | null = null;
  try {
    const response = await deps.fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      return { state: 'refused', code: body?.error ?? 'TURN_FAILED', status: response.status };
    }
    const decoder = turnEventDecoder(event => {
      if (event.type === 'result' || event.type === 'error') last = event;
      onEvent(event);
    });
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      decoder.push(value);
    }
  } catch { return last ? { state: 'finished', last } : { state: 'lost' }; }
  return last ? { state: 'finished', last } : { state: 'lost' };
}
