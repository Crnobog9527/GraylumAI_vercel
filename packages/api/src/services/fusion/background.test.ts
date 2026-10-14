/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const alerts = vi.hoisted(() => [] as Array<[string, string, unknown]>);
vi.mock('../../lib/logger', () => ({ logger: { error: (c: string, m: string, x: unknown) => alerts.push([c, m, x]),
  warn: (c: string, m: string, x: unknown) => alerts.push([c, m, x]) } }));
import { advanceAuthorized, advanceReview, kickAdvance, kickStalledReviews, MAX_ADVANCES, withAdvanceLease } from './background';

const reviewId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
/** A lease store with the semantics of 0258: one live holder, every grant counted, release only by the holder. */
function leaseDb(options: { count?: number; state?: string } = {}) {
  const lease = { token: null as string | null, count: options.count ?? 0 };
  const calls: string[] = [];
  const cleared: string[] = [];
  const db = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === 'fusion_review_kick_reset') { cleared.push(String(args.p_review_id)); return { data: true, error: null }; }
    if (name === 'fusion_review_advance_lease') {
      if (options.state && options.state !== 'running') return { data: { acquired: false, reason: 'ended' }, error: null };
      if (lease.token) return { data: { acquired: false, reason: 'leased', actorId }, error: null };
      if (lease.count >= Number(args.p_max)) return { data: { acquired: false, reason: 'limit', count: lease.count }, error: null };
      lease.token = String(args.p_token); lease.count++;
      return { data: { acquired: true, reason: 'acquired', actorId, count: lease.count }, error: null };
    }
    if (name === 'fusion_review_advance_release') {
      const own = lease.token === args.p_token;
      if (own) { lease.token = null; if (args.p_refund) lease.count--; }
      return { data: own, error: null };
    }
    if (name === 'fusion_review_kick_stalled') return { data: [{ review_id: reviewId, kicked_at: '2026-10-15T00:00:00Z' },
      { review_id: actorId, kicked_at: '2026-10-15T00:00:00Z' }], error: null };
    return { data: null, error: { message: 'unexpected' } };
  } };
  return { db: db as unknown as SupabaseClient, lease, calls, cleared };
}
type Call = { callId: string; dispatched: boolean };
function fakeFlow(step: { state?: string; waiting?: 'credits' | 'calls'; calls?: Call[] }, dispatched: string[], gate?: Promise<void>) {
  return () => ({
    continue: async () => ({ review: { state: step.state ?? 'running' }, calls: step.calls ?? [], waiting: step.waiting }),
    dispatch: async (_review: string, callId: string) => { await gate; dispatched.push(callId); },
  }) as never;
}

describe('review background', () => {
  beforeEach(() => { alerts.length = 0; });

  it('runs work only under the lease and always releases it, also after a failure', async () => {
    const { db, lease } = leaseDb();
    expect(await withAdvanceLease(db, reviewId, async () => 'done')).toEqual({ ran: true, value: 'done' });
    expect(lease.token).toBeNull();
    await expect(withAdvanceLease(db, reviewId, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lease.token).toBeNull();
    lease.token = 'someone-else';
    let ran = false;
    expect(await withAdvanceLease(db, reviewId, async () => { ran = true; })).toEqual({ ran: false, reason: 'leased' });
    expect(ran).toBe(false);
    expect(lease.token).toBe('someone-else'); // another holder's lease is never released
  });

  it('two advancers at once: only one runs the step, each call is dispatched once', async () => {
    const { db } = leaseDb();
    const dispatched: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const flow = fakeFlow({ calls: [{ callId: 'a', dispatched: false }, { callId: 'b', dispatched: false }] }, dispatched, gate);
    const first = advanceReview({ admin: db, reviewId, flow });
    const second = await advanceReview({ admin: db, reviewId, flow });
    open();
    expect(second).toEqual({ next: false, reason: 'leased' });
    expect(await first).toEqual({ next: true, reason: 'advanced', dispatched: 2 });
    expect(dispatched.sort()).toEqual(['a', 'b']);
  });

  it('never re-dispatches a call already dispatched elsewhere; stops for credits, an end state or nothing to do', async () => {
    const dispatched: string[] = [];
    const run = (step: Parameters<typeof fakeFlow>[0]) => advanceReview({ admin: leaseDb().db, reviewId, flow: fakeFlow(step, dispatched) });
    expect(await run({ calls: [{ callId: 'x', dispatched: true }], waiting: 'calls' })).toEqual({ next: false, reason: 'in_flight' });
    expect(await run({ waiting: 'credits' })).toEqual({ next: false, reason: 'waiting_credits' });
    expect(await run({ state: 'completed' })).toEqual({ next: false, reason: 'ended' });
    expect(await run({})).toEqual({ next: false, reason: 'idle' });
    expect(dispatched).toEqual([]);
  });

  it('more than 30 credit waits still resume after top-up without exhausting the cap', async () => {
    const { db, lease } = leaseDb({ count: MAX_ADVANCES - 1 });
    const dispatched: string[] = [];
    for (let i = 0; i < 35; i++) {
      expect(await advanceReview({ admin: db, reviewId, flow: fakeFlow({ waiting: 'credits' }, dispatched) }))
        .toEqual({ next: false, reason: 'waiting_credits' });
    }
    expect(lease.count).toBe(MAX_ADVANCES - 1);
    expect(await advanceReview({ admin: db, reviewId,
      flow: fakeFlow({ calls: [{ callId: 'resumed', dispatched: false }] }, dispatched) }))
      .toMatchObject({ next: true, dispatched: 1 });
    expect(dispatched).toEqual(['resumed']);
    expect(lease.count).toBe(MAX_ADVANCES);
  });

  it('a failing step stops the relay with the lease released; past the advance limit nothing runs and an alert is logged', async () => {
    const { db, lease } = leaseDb();
    const failing = () => ({ continue: async () => { throw new Error('FUSION_REVIEW_UNAVAILABLE'); } }) as never;
    expect(await advanceReview({ admin: db, reviewId, flow: failing })).toEqual({ next: false, reason: 'failed' });
    expect(lease.token).toBeNull();
    const capped = leaseDb({ count: MAX_ADVANCES });
    expect(await advanceReview({ admin: capped.db, reviewId, flow: failing })).toEqual({ next: false, reason: 'limit' });
    expect(alerts).toContainEqual(['billing', 'fusion_review_advance_limit', { reviewId, count: MAX_ADVANCES }]);
  });

  it('clears refused and unattempted kick reservations and reports failure', async () => {
    const { db, cleared } = leaseDb();
    let clock = 0;
    const kick = vi.fn(async () => { clock = 20_000; return false; });
    expect(await kickStalledReviews(db, 'https://graylum.test', { now: () => clock, timeLimitMs: 10_000, kick }))
      .toEqual({ success: false, kicked: 0, listed: 2 });
    expect(cleared).toEqual([reviewId, actorId]);
    expect(kick).toHaveBeenCalledOnce();
  });

  it('checks the secret exactly; kicks only with a secret and a bounded hop; the daily kick stops at its time limit', async () => {
    expect(advanceAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    for (const [header, secret] of [['Bearer s3creT', 's3cret'], ['s3cret', 's3cret'], [null, 's3cret'], ['Bearer ', '']] as const)
      expect(advanceAuthorized(header, secret)).toBe(false);
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await kickAdvance('https://graylum.test', reviewId, 1, { CRON_SECRET: 's3cret' }, fetcher as never)).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://graylum.test/api/fusion/advance');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ reviewId, hop: 1 }) });
    expect(await kickAdvance('https://graylum.test', reviewId, 0, {}, fetcher as never)).toBe(false);
    expect(await kickAdvance('https://graylum.test', reviewId, 11, { CRON_SECRET: 's3cret' }, fetcher as never)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    let clock = 0;
    const kick = vi.fn(async () => { clock += 20_000; return true; });
    expect(await kickStalledReviews(leaseDb().db, 'https://graylum.test', { now: () => clock, timeLimitMs: 10_000, kick }))
      .toEqual({ success: false, kicked: 1, listed: 2 });
  });
});
