/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const limiter = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRateLimitOrThrow: limiter.check }));
import { issueAccountErasureProgress, readAccountErasureProgress } from './progress';
import type { BillingRpc } from '../bill2/service';

const actor = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const token = Buffer.alloc(32, 7).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const view = { stage: 'billing_pending', confirmedAt: '2026-10-07T00:00:00+00:00',
  updatedAt: '2026-10-07T01:00:00+00:00', needsReview: true };
function database(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    void name; void args; return { data, error };
  });
  return { rpc } as { rpc: typeof rpc } & BillingRpc;
}
beforeEach(() => { limiter.check.mockReset().mockResolvedValue({ success: true }); });

describe('restricted erasure progress capability', () => {
  it('issues 32 random bytes once and persists only the SHA256 digest', async () => {
    const db = database({ issued: true });
    const first = await issueAccountErasureProgress(db, actor, requestId);
    const second = await issueAccountErasureProgress(db, actor, requestId);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(Buffer.from(first!, 'base64url')).toHaveLength(32);
    expect(first).not.toBe(second);
    expect(db.rpc.mock.calls[0]).toEqual(['account_erasure_progress_issue', {
      p_profile_id: actor, p_request_id: requestId, p_token_hash: createHash('sha256').update(first!).digest('hex'),
    }]);
    expect(JSON.stringify(db.rpc.mock.calls)).not.toContain(first);
  });
  it.each([{ issued: false }, {}, null])('does not return a replacement or invalid token: %j', async data => {
    const db = database(data); expect(await issueAccountErasureProgress(db, actor, requestId)).toBeNull();
    expect(db.rpc).toHaveBeenCalledOnce();
  });
  it('does not retry an ambiguous issuance or leak a discarded token', async () => {
    const db = database(null); db.rpc.mockRejectedValue(new Error('private exception'));
    expect(await issueAccountErasureProgress(db, actor, requestId)).toBeNull(); expect(db.rpc).toHaveBeenCalledOnce();
  });
  it('reads only a safe projection using a hash-keyed limiter without an account session', async () => {
    const db = database(view); expect(await readAccountErasureProgress(db, { requestId, token })).toEqual(view);
    expect(limiter.check).toHaveBeenCalledExactlyOnceWith(`account-erasure-progress:${tokenHash.slice(0, 32)}`, 'auth');
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('account_erasure_progress_read', { p_request_id: requestId, p_token_hash: tokenHash });
    expect(JSON.stringify(db.rpc.mock.calls)).not.toContain(token);
    expect(JSON.stringify(limiter.check.mock.calls)).not.toContain(token);
  });
  it.each([
    { requestId: 'invalid', token }, { requestId, token: '' }, { requestId, token: 'x'.repeat(42) },
    { requestId, token: '/'.repeat(43) }, { requestId, token, profileId: actor }, null,
  ])('invalid inputs use the same NOT_FOUND result without database access', async input => {
    const db = database(view);
    await expect(readAccountErasureProgress(db, input)).rejects.toMatchObject({ code: 'NOT_FOUND', message: '注销进度凭证无效或已过期' });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([null, { ...view, profileId: actor }, { ...view, email: 'private@example.test' },
    { ...view, reason: 'PRIVATE' }, { ...view, updatedAt: null }])('expired/unknown/malformed data is indistinguishable: %j', async data => {
    const db = database(data);
    await expect(readAccountErasureProgress(db, { requestId, token })).rejects.toMatchObject({
      code: 'NOT_FOUND', message: '注销进度凭证无效或已过期',
    });
  });
  it('unavailable storage never leaks a database cause', async () => {
    const db = database(null, { message: 'PRIVATE ERROR' });
    await expect(readAccountErasureProgress(db, { requestId, token })).rejects.toMatchObject({
      code: 'NOT_FOUND', message: '注销进度凭证无效或已过期',
    });
  });
  it('rate-limit refusal precedes the progress database read', async () => {
    limiter.check.mockRejectedValue(new Error('rate limit'));
    const db = database(view); await expect(readAccountErasureProgress(db, { requestId, token })).rejects.toThrow('rate limit');
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('public router exposes a mutation that works without a login or profile bootstrap', async () => {
    const { accountRouter } = await import('../../routers/account');
    const db = database(view);
    const caller = accountRouter.createCaller({ user: null, supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
    expect(accountRouter._def.procedures.erasureProgress._def.type).toBe('mutation');
    expect(await caller.erasureProgress({ requestId, token })).toEqual(view);
    await expect(caller.erasureProgress({ requestId: 'invalid', token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});
