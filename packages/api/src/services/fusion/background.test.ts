/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const alerts = vi.hoisted(() => [] as Array<[string, string, unknown]>);
vi.mock('../../lib/logger', () => ({ logger: { error: (c: string, m: string, x: unknown) => alerts.push([c, m, x]),
  warn: (c: string, m: string, x: unknown) => alerts.push([c, m, x]) } }));
const turn = vi.hoisted(() => ({ view: null as unknown, advance: (async () => ({ next: false, reason: 'idle' })) as (id: string) => Promise<unknown>,
  advances: [] as string[] }));
vi.mock('./reviewRecord', async importOriginal => ({ ...await importOriginal<typeof import('./reviewRecord')>(),
  reviewRecord: () => ({ read: async () => turn.view }) }));
vi.mock('../turn/jury', () => ({ juryTurn: () => ({ advance: (id: string) => { turn.advances.push(id); return turn.advance(id); } }) }));
vi.mock('../turn/db', () => ({ turnClients: () => ({}) }));
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
/** The review the record read returns: on the turn path it carries its turn. */
const onTurn = { turnId: 7, state: 'running' };
const jury = { slots: {} as never, calls: (async () => ({ allowed: true })) as never };
const advance = (admin: SupabaseClient) => advanceReview({ admin, reviewId, jury });

describe('review background', () => {
  beforeEach(() => { alerts.length = 0; turn.view = onTurn; turn.advances.length = 0; turn.advance = async () => ({ next: false, reason: 'idle' }); });

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

  it('two advancers at once: only one runs the step, the group is advanced once', async () => {
    const { db } = leaseDb();
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    turn.advance = async () => { await gate; return { next: true, reason: 'advanced', dispatched: 2 }; };
    const first = advance(db);
    const second = await advance(db);
    open();
    expect(second).toEqual({ next: false, reason: 'leased' });
    expect(await first).toEqual({ next: true, reason: 'advanced', dispatched: 2 });
    expect(turn.advances).toEqual([reviewId]);
  });

  it('an expected stop is passed on as it is and refunds its attempt', async () => {
    for (const reason of ['in_flight', 'waiting_credits', 'ended', 'idle', 'gated']) {
      const { db, lease } = leaseDb();
      turn.advance = async () => ({ next: false, reason });
      expect(await advance(db)).toEqual({ next: false, reason });
      expect(lease.count).toBe(0);
    }
  });

  it('more than 30 credit waits still resume after top-up without exhausting the cap', async () => {
    const { db, lease } = leaseDb({ count: MAX_ADVANCES - 1 });
    turn.advance = async () => ({ next: false, reason: 'waiting_credits' });
    for (let i = 0; i < 35; i++) expect(await advance(db)).toEqual({ next: false, reason: 'waiting_credits' });
    expect(lease.count).toBe(MAX_ADVANCES - 1);
    turn.advance = async () => ({ next: true, reason: 'advanced', dispatched: 1 });
    expect(await advance(db)).toMatchObject({ next: true, dispatched: 1 });
    expect(lease.count).toBe(MAX_ADVANCES);
  });

  it('a failing step stops the relay with its attempt refunded; the lease is released', async () => {
    const { db, lease } = leaseDb({ count: MAX_ADVANCES - 1 });
    turn.advance = async () => { throw new Error('TURN_CALL_UNAVAILABLE'); };
    for (let i = 0; i < 35; i++) expect(await advance(db)).toEqual({ next: false, reason: 'failed' });
    expect(lease.count).toBe(MAX_ADVANCES - 1);
    expect(lease.token).toBeNull();
    expect(alerts).toContainEqual(['billing', 'fusion_review_advance_failed', { reviewId, code: 'TURN_CALL_UNAVAILABLE' }]);
  });

  // CORE-PATH-V2 V2-12 B5: nothing starts on the BILL2 path any more, so a review without a turn is never advanced.
  it('a review without a turn (the retired BILL2 path) or one that cannot be read is not advanced', async () => {
    const { db, lease } = leaseDb();
    turn.view = { turnId: null, state: 'running' };
    expect(await advance(db)).toEqual({ next: false, reason: 'no_turn' });
    turn.view = null;
    expect(await advance(db)).toEqual({ next: false, reason: 'failed' });
    expect(turn.advances).toEqual([]);
    expect(lease.count).toBe(0);
  });

  it('past the advance limit nothing runs and an alert is logged', async () => {
    const capped = leaseDb({ count: MAX_ADVANCES });
    expect(await advance(capped.db)).toEqual({ next: false, reason: 'limit' });
    expect(turn.advances).toEqual([]);
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

  it.each([
    ['https://attacker.test', 'https://graylum.test'],
    ['https://graylum.test.attacker.test', 'https://graylum.test'],
    ['https://graylum.test:444', 'https://graylum.test'],
    ['http://graylum.test', 'http://graylum.test'],
    ['https://user:pass@graylum.test', 'https://graylum.test'],
    ['https://graylum.test', undefined],
    ['https://graylum.test', 'not-a-url'],
  ])('never sends credentials to an untrusted target %s', async (origin, configured) => {
    const fetcher = vi.fn();
    expect(await kickAdvance(origin, reviewId, 0,
      { CRON_SECRET: 'test-only', NEXT_PUBLIC_APP_URL: configured }, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts only the configured deployment host and refuses redirects', async () => {
    const env = { CRON_SECRET: 'test-only', VERCEL_URL: 'current-deploy.vercel.app' };
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://attacker.test' } }));
    expect(await kickAdvance('https://other-deploy.vercel.app', reviewId, 0, env, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await kickAdvance('https://current-deploy.vercel.app', reviewId, 0, env, fetcher)).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([new URL('https://current-deploy.vercel.app/api/fusion/advance'),
      expect.objectContaining({ redirect: 'error' })]);
  });

  it('checks the secret exactly; kicks only with a secret and a bounded hop; the daily kick stops at its time limit', async () => {
    expect(advanceAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    for (const [header, secret] of [['Bearer s3creT', 's3cret'], ['s3cret', 's3cret'], [null, 's3cret'], ['Bearer ', '']] as const)
      expect(advanceAuthorized(header, secret)).toBe(false);
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await kickAdvance('https://graylum.test', reviewId, 1, { CRON_SECRET: 's3cret', NEXT_PUBLIC_APP_URL: 'https://graylum.test' }, fetcher as never)).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://graylum.test/api/fusion/advance');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify({ reviewId, hop: 1 }) });
    expect(await kickAdvance('https://graylum.test', reviewId, 0, {}, fetcher as never)).toBe(false);
    expect(await kickAdvance('https://graylum.test', reviewId, 11, { CRON_SECRET: 's3cret', NEXT_PUBLIC_APP_URL: 'https://graylum.test' }, fetcher as never)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    let clock = 0;
    const kick = vi.fn(async () => { clock += 20_000; return true; });
    expect(await kickStalledReviews(leaseDb().db, 'https://graylum.test', { now: () => clock, timeLimitMs: 10_000, kick }))
      .toEqual({ success: false, kicked: 1, listed: 2 });
  });
});
