/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '@repo/api/src/services/turn/sse';
import { runTurn, turnEventDecoder } from './turn-stream';

const bytes = (text: string) => new TextEncoder().encode(text);
// The wire format of services/turn/sse.ts encodeEvent.
const encodeEvent = (event: TurnEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const stream = (chunks: Uint8Array[], fail = false) => new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (fail) controller.error(new Error('dropped')); else controller.close(); },
});
const opened: TurnEvent = { type: 'opened', turnId: 7, reservedCredits: 20, replay: false };
const result: TurnEvent = { type: 'result', turnId: 7, body: '好', chargedCredits: 3, settlement: 'done' };

describe('turn event stream', () => {
  it('reads an event split across chunks, even inside one character', () => {
    const seen: TurnEvent[] = [];
    const decoder = turnEventDecoder(event => seen.push(event));
    const all = bytes(encodeEvent({ type: 'text', delta: '灰度' }));
    decoder.push(all.slice(0, all.length - 6));
    expect(seen).toEqual([]);
    decoder.push(all.slice(all.length - 6));
    expect(seen).toEqual([{ type: 'text', delta: '灰度' }]);
  });

  it('finishes on the result, after every event went to the page', async () => {
    const seen: TurnEvent[] = [];
    const fetcher = vi.fn(async () => new Response(stream([bytes(encodeEvent(opened) + encodeEvent(result))])));
    await expect(runTurn({ kind: 'chat' }, event => seen.push(event), { fetch: fetcher as typeof fetch }))
      .resolves.toEqual({ state: 'finished', last: result });
    expect(seen).toEqual([opened, result]);
  });

  it('names a refused request by its fixed code', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'TURN_RATE_LIMITED' }), { status: 429 }));
    await expect(runTurn({}, () => {}, { fetch: fetcher as typeof fetch }))
      .resolves.toEqual({ state: 'refused', code: 'TURN_RATE_LIMITED', status: 429 });
  });

  it('a stream that ends or drops before its result is lost, so the page reads instead of resending', async () => {
    const ended = vi.fn(async () => new Response(stream([bytes(encodeEvent(opened))])));
    await expect(runTurn({}, () => {}, { fetch: ended as typeof fetch })).resolves.toEqual({ state: 'lost' });
    const dropped = vi.fn(async () => new Response(stream([bytes(encodeEvent(opened))], true)));
    await expect(runTurn({}, () => {}, { fetch: dropped as typeof fetch })).resolves.toEqual({ state: 'lost' });
  });
});
