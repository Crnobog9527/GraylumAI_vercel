/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { handleReportRead, handleTurnStop, type ReportHttpDeps } from './reportHttp';

const SESSION = '00000000-0000-4000-8000-000000000001', ROUND = '00000000-0000-4000-8000-000000000003';
function deps(answer: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string } },
  over: Partial<ReportHttpDeps> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { rpc: async (name: string, args: Record<string, unknown>) => { calls.push([name, args]);
    const a = answer(name, args); return { data: a.data ?? null, error: a.error ?? null }; }, from: () => { throw new Error('no'); } };
  return { calls, deps: { authenticate: async () => 'actor', databaseHost: { declared: 'db.test', actual: 'db.test' },
    clients: { write: client, read: client }, stopSignal: { raise: async () => undefined, raised: async () => false }, ...over } as unknown as ReportHttpDeps };
}
const post = (body: unknown) => new Request('https://app.test/api/turn/stop', { method: 'POST', body: JSON.stringify(body) });
const answerOf = async (res: Response) => [res.status, await res.json()];

describe('report stop and read (CORE-PATH-V2 V2-7a)', () => {
  it('records the stop with what the page showed; a third stop asks first, then is sent confirmed', async () => {
    const d = deps((_n, a) => ({ data: a.p_confirmed ? { turnId: 9, state: 'stopping', chargeable: true, replay: false }
      : { turnId: 9, state: 'confirmation_required', chargeable: true, fixedCredits: 500, replay: false } }));
    expect(await answerOf(await handleTurnStop(post({ turnId: 9, stopAt: 12 }), d.deps)))
      .toEqual([200, { turnId: 9, state: 'confirmation_required', chargeable: true, fixedCredits: 500, replay: false }]);
    expect(await answerOf(await handleTurnStop(post({ turnId: 9, stopAt: 12, confirmed: true }), d.deps)))
      .toEqual([200, { turnId: 9, state: 'stopping', chargeable: true, replay: false }]);
    expect(d.calls).toEqual([['turn_stop', { p_actor_id: 'actor', p_turn_id: 9, p_confirmed: false, p_stop_at: 12 }],
      ['turn_stop', { p_actor_id: 'actor', p_turn_id: 9, p_confirmed: true, p_stop_at: 12 }]]);
  });

  it('raises the flag for the running turn only once the stop is recorded, and a failed flag does not fail the stop', async () => {
    const raised: number[] = [], stopSignal = { raise: async (id: number) => { raised.push(id); }, raised: async () => false };
    const asked = deps(() => ({ data: { turnId: 9, state: 'confirmation_required', chargeable: true, fixedCredits: 500, replay: false } }), { stopSignal });
    await handleTurnStop(post({ turnId: 9 }), asked.deps);
    expect(raised).toEqual([]);
    const stopping = deps(() => ({ data: { turnId: 9, state: 'stopping', chargeable: false, replay: false } }), { stopSignal });
    await handleTurnStop(post({ turnId: 9 }), stopping.deps);
    expect(raised).toEqual([9]);
    const down = deps(() => ({ data: { turnId: 9, state: 'stopping', chargeable: false, replay: false } }),
      { stopSignal: { raise: async () => { throw new Error('redis down'); }, raised: async () => false } });
    expect((await answerOf(await handleTurnStop(post({ turnId: 9 }), down.deps)))[0]).toBe(200);
  });

  it('refuses: bad shape, no account, wrong database, a chat (no stop), someone else\'s turn; database text never leaks', async () => {
    const ok = deps(() => ({ data: { turnId: 9, state: 'stopping', chargeable: false, replay: false } }));
    expect((await answerOf(await handleTurnStop(post({ turnId: 'x' }), ok.deps)))[0]).toBe(400);
    expect((await answerOf(await handleTurnStop(post({ turnId: 9, extra: 1 }), ok.deps)))[0]).toBe(400);
    expect(await answerOf(await handleTurnStop(post({ turnId: 9 }), deps(() => ({}), { authenticate: async () => null }).deps)))
      .toEqual([401, { error: 'TURN_UNAUTHENTICATED' }]);
    expect(await answerOf(await handleTurnStop(post({ turnId: 9 }),
      deps(() => ({}), { databaseHost: { declared: 'db.other', actual: 'db.test' } }).deps))).toEqual([503, { error: 'TURN_DATABASE_MISMATCH' }]);
    for (const [message, status, code] of [['TURN_STOP_NOT_ALLOWED at turn_stop line 5', 403, 'TURN_STOP_NOT_ALLOWED'],
      ['TURN_DENIED', 404, 'TURN_DENIED'], ['connection reset by peer', 503, 'TURN_DATABASE_UNAVAILABLE']] as const)
      expect(await answerOf(await handleTurnStop(post({ turnId: 9 }), deps(() => ({ error: { message } })).deps)))
        .toEqual([status, { error: code }]);
  });

  it('reads the newest report of a round with its saved text', async () => {
    const turn = { turnId: 9, requestId: '00000000-0000-4000-8000-000000000009', state: 'closed', closeKind: 'stopped', delivered: false,
      chargedCredits: 0, settlement: 'done',
      fixedCredits: 500, stopChargeable: false, report: { roundId: ROUND }, body: '## One', openedAt: 'a', closedAt: 'b' };
    const d = deps(() => ({ data: turn }));
    const res = await handleReportRead(new Request(`https://app.test/api/turn/report?sessionId=${SESSION}&roundId=${ROUND}`), d.deps);
    expect(await answerOf(res)).toEqual([200, { report: turn }]);
    expect(d.calls[0]).toEqual(['turn_report_read', { p_actor_id: 'actor', p_session_id: SESSION, p_round_id: ROUND, p_turn_id: null }]);
    expect((await handleReportRead(new Request('https://app.test/api/turn/report?sessionId=bad'), d.deps)).status).toBe(400);
  });
});
