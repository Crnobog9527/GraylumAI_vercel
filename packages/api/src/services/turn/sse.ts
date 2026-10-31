/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logSwallowed } from '../../lib/swallow';
import type { ResearchTurnEvent } from '../../shared/researchTurn';
import type { CompareEvent } from './compare';
import type { ToolAvailability } from './tools/types';

/*
 * CORE-PATH-V2 2.2: one POST /api/turn is one Server-Sent Events stream. `opened` comes first (the turn is admitted: frozen
 * credits, what the turn may use), then the model's text as it arrives, then exactly one `result` or `error`. An error names
 * a fixed code only; database and provider text never reach the client. A compare streams its columns; a jury answers once
 * (`review`, or `error`), because its groups run on the server after the response.
 */
export type TurnEvent =
  // tools: what this turn can use and what was trimmed and why (2.7, V2-6); absent for a turn without tools.
  | { type: 'opened'; turnId: number; reservedCredits: number; replay: boolean; tools?: ToolAvailability;
    /** Fallback B (Owner 10-20): the user may generate with what exists; the counts are the draft's (V2-5c). */
    fallbackEligible?: boolean }
  | { type: 'text'; delta: string }
  // V2-5c: the mentor's benchmark flow (a lookup's progress, a selection card, a round to continue), as the old stream sent them.
  | ResearchTurnEvent
  | { type: 'result'; turnId: number; body: string; chargedCredits: number | null; settlement: 'pending' | 'done' | null;
    /** V2-5: what the kind's close did (the mentor's checklist capture: applied fields, versions). */
    kindResult?: unknown;
    /** A report: how it closed (completed, or stopped by its user) and whether it is a complete report. */
    closeKind?: string; delivered?: boolean }
  | { type: 'error'; code: string; turnId?: number };
/** Everything one stream may carry, whichever kind of turn it is. */
export type StreamEvent = TurnEvent | CompareEvent | { type: 'review'; turnId: number; reviewId: string; state: string; reservedCredits: number };

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export function encodeEvent(event: StreamEvent): string {
  const safe = event.type === 'error' && !CODE.test(event.code) ? { ...event, code: 'TURN_FAILED' } : event;
  return `event: ${safe.type}\ndata: ${JSON.stringify(safe)}\n\n`;
}

/**
 * A Response that streams the events of `run`; the turn keeps running to its close even if the client goes away. `onCancel`
 * hears that the client went away (a report then checks once whether its user stopped it).
 */
export function eventStream(run: (emit: (event: StreamEvent) => void) => Promise<void>, onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: StreamEvent) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(encodeEvent(event))); } catch { open = false; }
      };
      run(emit).catch((error: unknown) => { logSwallowed('turn_stream_failed', error, { category: 'ai' }); emit({ type: 'error', code: 'TURN_FAILED' }); })
        .finally(() => { if (open) { open = false; try { controller.close(); } catch { /* already closed */ } } });
    },
    cancel() { open = false; onCancel?.(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    'x-accel-buffering': 'no' } });
}
