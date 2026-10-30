/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logSwallowed } from '../../lib/swallow';

/*
 * CORE-PATH-V2 2.2: one POST /api/turn is one Server-Sent Events stream. `opened` comes first (the turn is admitted: frozen
 * credits, what the turn may use), then the model's text as it arrives, then exactly one `result` or `error`. An error names
 * a fixed code only; database and provider text never reach the client.
 */
export type TurnEvent =
  | { type: 'opened'; turnId: number; reservedCredits: number; replay: boolean }
  | { type: 'text'; delta: string }
  | { type: 'result'; turnId: number; body: string; chargedCredits: number | null; settlement: 'pending' | 'done' | null;
    /** V2-5: what the kind's close did (the mentor's checklist capture: applied fields, versions). */
    kindResult?: unknown }
  | { type: 'error'; code: string; turnId?: number };

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export function encodeEvent(event: TurnEvent): string {
  const safe = event.type === 'error' && !CODE.test(event.code) ? { ...event, code: 'TURN_FAILED' } : event;
  return `event: ${safe.type}\ndata: ${JSON.stringify(safe)}\n\n`;
}

/** A Response that streams the events of `run`; the turn keeps running to its close even if the client goes away. */
export function eventStream(run: (emit: (event: TurnEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: TurnEvent) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(encodeEvent(event))); } catch { open = false; }
      };
      run(emit).catch((error: unknown) => { logSwallowed('turn_stream_failed', error, { category: 'ai' }); emit({ type: 'error', code: 'TURN_FAILED' }); })
        .finally(() => { if (open) { open = false; try { controller.close(); } catch { /* already closed */ } } });
    },
    cancel() { open = false; },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    'x-accel-buffering': 'no' } });
}
