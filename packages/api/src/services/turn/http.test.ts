/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDeps } from './chat';
import { handleTurnRequest, type TurnHttpDeps } from './http';

const run = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
vi.mock('./chat', () => ({ runChatTurn: run }));
vi.mock('./report', async original => ({ ...await original<object>(), runReportTurn: report }));

const SESSION = '00000000-0000-4000-8000-000000000001', REQUEST = '00000000-0000-4000-8000-000000000002';
const post = (body: unknown) => new Request('https://app.test/api/turn', { method: 'POST', body: JSON.stringify(body) });
const valid = { kind: 'chat', sessionId: SESSION, requestId: REQUEST, text: 'Hello' };
const deps = (over: Partial<TurnHttpDeps> = {}): TurnHttpDeps => ({
  authenticate: async () => 'actor-1', rateLimited: async () => false,
  databaseHost: { declared: 'db.test', actual: 'db.test' }, chat: {} as ChatDeps, ...over,
});

describe('POST /api/turn entry (CORE-PATH-V2 2.2, 2.8)', () => {
  beforeEach(() => { run.mockReset(); report.mockReset(); });

  it('refuses before any turn work: bad shape, wrong or undeclared database host, no account, rate limited', async () => {
    const status = async (body: unknown, d: TurnHttpDeps) => {
      const res = await handleTurnRequest(post(body), d);
      return [res.status, (await res.json()).error];
    };
    expect(await status({ ...valid, kind: 'report' }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status({ ...valid, text: '   ' }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status({ ...valid, extra: 1 }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status(valid, deps({ databaseHost: { declared: 'db.other', actual: 'db.test' } }))).toEqual([503, 'TURN_DATABASE_MISMATCH']);
    expect(await status(valid, deps({ databaseHost: { declared: undefined, actual: 'db.test' } }))).toEqual([503, 'TURN_DATABASE_MISMATCH']);
    expect(await status(valid, deps({ authenticate: async () => null }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(valid, deps({ authenticate: async () => { throw new Error('auth down'); } }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(valid, deps({ rateLimited: async () => true }))).toEqual([429, 'TURN_RATE_LIMITED']);
    // A limiter that cannot answer refuses rather than letting the turn through.
    expect(await status(valid, deps({ rateLimited: async () => { throw new Error('redis down'); } }))).toEqual([429, 'TURN_RATE_LIMITED']);
    expect(run).not.toHaveBeenCalled();
  });

  it('streams the turn as events for the signed-in account, and an unknown error text never reaches the client', async () => {
    run.mockImplementation(async (_deps, input, emit) => {
      emit({ type: 'opened', turnId: 7, reservedCredits: 40, replay: false });
      emit({ type: 'text', delta: 'Hi' });
      emit({ type: 'error', code: 'relation "turns" does not exist', turnId: 7 });
      expect(input).toEqual({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, text: 'Hello' });
    });
    const res = await handleTurnRequest(post(valid), deps());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body.split('\n\n').filter(Boolean).map(chunk => chunk.split('\n')[0])).toEqual(['event: opened', 'event: text', 'event: error']);
    expect(body).toContain('"code":"TURN_FAILED"');
    expect(body).not.toContain('relation');
  });

  it('keeps the turn running to its close after the client goes away', async () => {
    let finish!: () => void, closed = false;
    run.mockImplementation(async (_deps, _input, emit) => {
      emit({ type: 'opened', turnId: 1, reservedCredits: 1, replay: false });
      await new Promise<void>(resolve => { finish = resolve; });
      emit({ type: 'text', delta: 'late' });
      closed = true;
    });
    const res = await handleTurnRequest(post(valid), deps());
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    finish();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('a report (V2-7a) gets its own input and hears when the page drops the stream; a chat never does', async () => {
    let gone: AbortSignal | undefined;
    report.mockImplementation(async (_deps, input, emit, signal) => {
      gone = signal;
      expect(input).toEqual({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, moduleId: SESSION, projectId: SESSION,
        roundId: SESSION, acceptedCredits: 500 });
      emit({ type: 'opened', turnId: 3, reservedCredits: 680, replay: false });
      await new Promise(resolve => signal.addEventListener('abort', resolve));
    });
    const body = { kind: 'report', sessionId: SESSION, requestId: REQUEST, moduleId: SESSION, projectId: SESSION, roundId: SESSION,
      acceptedCredits: 500 };
    expect((await handleTurnRequest(post({ ...body, acceptedCredits: undefined }), deps())).status).toBe(400);
    const res = await handleTurnRequest(post(body), deps());
    const reader = res.body!.getReader();
    await reader.read();
    expect(gone?.aborted).toBe(false);
    await reader.cancel();
    expect(gone?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
