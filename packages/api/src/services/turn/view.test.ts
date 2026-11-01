/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { TurnClients } from './db';
import { handleTurnView, type TurnViewDeps } from './view';

const SESSION = '00000000-0000-4000-8000-000000000001';
const get = (query: string) => new Request('https://app.test/api/turn' + query);
const view = { activeTurn: { turnId: 7, kind: 'mentor', state: 'running', pauseReason: null, openedAt: 't', updatedAt: 't' }, lastTurn: null,
  messages: [], calls: [] };
const deps = (rpc: (...args: never[]) => Promise<unknown> = async () => ({ data: view, error: null }),
  over: Partial<TurnViewDeps> = {}): TurnViewDeps => ({
  authenticate: async () => 'actor-1', databaseHost: { declared: 'db.test', actual: 'db.test' },
  clients: { read: { rpc }, write: { rpc: vi.fn() } } as unknown as TurnClients, ...over });

describe('GET /api/turn: the refresh-recovery read (V2-5b, #595)', () => {
  it('reads the running turn on the read client for the signed-in account', async () => {
    const rpc = vi.fn(async () => ({ data: view, error: null }));
    const res = await handleTurnView(get(`?sessionId=${SESSION}&afterSeq=4`), deps(rpc));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(rpc).toHaveBeenCalledWith('turn_session_view', { p_actor_id: 'actor-1', p_session_id: SESSION, p_after_seq: 4 });
  });

  it('refuses a bad request, the wrong database, no account; a denial and an outage are fixed codes', async () => {
    const status = async (query: string, d: TurnViewDeps) => { const r = await handleTurnView(get(query), d); return [r.status, (await r.json()).error]; };
    expect(await status('?sessionId=nope', deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status(`?sessionId=${SESSION}`, deps(undefined, { databaseHost: { declared: 'x', actual: 'y' } }))).toEqual([503, 'TURN_DATABASE_MISMATCH']);
    expect(await status(`?sessionId=${SESSION}`, deps(undefined, { authenticate: async () => null }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(`?sessionId=${SESSION}`, deps(vi.fn(async () => ({ data: null, error: { message: 'TURN_SESSION_DENIED' } })))))
      .toEqual([403, 'TURN_SESSION_DENIED']);
    expect(await status(`?sessionId=${SESSION}`, deps(vi.fn(async () => ({ data: null, error: { message: 'TURN_ACCOUNT_DENIED' } })))))
      .toEqual([403, 'TURN_ACCOUNT_DENIED']);
    expect(await status(`?sessionId=${SESSION}`, deps(vi.fn(async () => ({ data: null, error: { message: 'connection reset' } })))))
      .toEqual([503, 'TURN_VIEW_UNAVAILABLE']);
  });
});

describe('handleTurnView scope (V2-5d)', () => {
  it('checks the scope first and refuses without reading the conversation', async () => {
    const rpc = vi.fn(async (name: string) => ({ data: name === 'session_view_allowed' ? false : view, error: null }));
    const res = await handleTurnView(get(`?sessionId=${SESSION}`), deps(rpc as never));
    expect(res.status).toBe(403);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
