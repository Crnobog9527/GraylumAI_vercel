/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readStuckCleanup, requeueStuckCleanup, resolveStuckCleanup } from './stuckCleanup';

const rpc = (data: unknown, error: unknown = null) => {
  const calls: Array<[string, unknown]> = [];
  return { calls, db: { rpc: async (name: string, args: unknown) => { calls.push([name, args]); return { data, error }; } } as never };
};
const id = '00000000-0000-4000-8000-000000000001';

describe('stopped Post for Me cleanup (plan §9 item 25)', () => {
  it('reads the list through the definer function and refuses an unexpected shape', async () => {
    const ok = rpc({ totals: { connections: 1, requests: 0 }, connections: [{ id, kind: 'deletion', platform: 'x', providerAccountId: 'spc_1', attempts: 50,
      error: 'PROVIDER_RETRY', updatedAt: '2026-10-23T00:00:00Z' }], requests: [] });
    expect((await readStuckCleanup(ok.db)).connections).toHaveLength(1);
    expect(ok.calls).toEqual([['publish_monitor_stuck_list', { p_limit: 200 }]]);
    await expect(readStuckCleanup(rpc({ totals: { connections: 1, requests: 0 }, connections: [{ id, actorId: 'x' }], requests: [] }).db))
      .rejects.toThrow('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
    await expect(readStuckCleanup(rpc(null, { message: 'x' }).db)).rejects.toThrow('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
  });
  it('re-queues one record and reports whether anything changed', async () => {
    const yes = rpc(true);
    expect(await requeueStuckCleanup(yes.db, { kind: 'request', id })).toEqual({ requeued: true });
    expect(yes.calls).toEqual([['publish_monitor_stuck_requeue', { p_kind: 'request', p_id: id }]]);
    expect(await requeueStuckCleanup(rpc(false).db, { kind: 'connection', id })).toEqual({ requeued: false });
    await expect(requeueStuckCleanup(rpc(null).db, { kind: 'connection', id })).rejects.toThrow();
  });
  it('ends a record a person verified as gone, and reports whether anything changed', async () => {
    const yes = rpc(true);
    expect(await resolveStuckCleanup(yes.db, { kind: 'connection', id })).toEqual({ resolved: true });
    expect(yes.calls).toEqual([['publish_monitor_stuck_resolve', { p_kind: 'connection', p_id: id }]]);
    expect(await resolveStuckCleanup(rpc(false).db, { kind: 'request', id })).toEqual({ resolved: false });
    await expect(resolveStuckCleanup(rpc(null, { message: 'x' }).db, { kind: 'request', id })).rejects.toThrow();
  });
});
