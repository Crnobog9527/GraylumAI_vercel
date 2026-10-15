/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { fusionReviewRouter, revisionHooks } from './fusionReview';

describe('fusion review router', () => {
  it('gives the review flow every R14 call it needs, including decline', async () => {
    const revisions = {
      propose: vi.fn(async () => ({ revisionId: 'r', diffHash: 'h', diff: { changes: [], cascade: [] } }) as never),
      apply: vi.fn(async () => ({ versionId: 'v' }) as never),
      decline: vi.fn(async () => null as never),
    };
    const hooks = revisionHooks(revisions);
    expect(await hooks.propose({})).toEqual({ revisionId: 'r', diffHash: 'h', diff: { changes: [], cascade: [] } });
    expect(await hooks.apply({})).toEqual({ versionId: 'v' });
    await hooks.decline({});
    expect(revisions.decline).toHaveBeenCalledOnce();
  });
});

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function mineFixture(signedIn = true) {
  const item = { reviewId: id(2), draftId: id(3), sourceVersionId: id(4), state: 'running', round: 2, phase: 'summary',
    outcomeKind: null, awaitingChoice: false, createdAt: '2026-10-15T00:00:00.123456+00:00', endedAt: null, seenAt: null };
  const rpc = vi.fn(async () => ({ data: [item], error: null }));
  const profile = { id: id(1), role: 'user', status: 'active', credits: 0, nickname: 'fixture' };
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }),
    single: async () => ({ data: profile, error: null }) };
  const db = { rpc, from: () => q };
  const scheduleAfter = vi.fn();
  const caller = fusionReviewRouter.createCaller({ headers: new Headers(),
    user: signedIn ? { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } } : null,
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true, scheduleAfter } as never);
  return { caller, rpc, item, scheduleAfter };
}
it('mine binds the actor and draft cursor, preserves microseconds, returns a typed step and never advances', async () => {
  const f = mineFixture();
  const cursor = { createdAt: f.item.createdAt, reviewId: f.item.reviewId };
  expect(await f.caller.mine({ draftId: id(3), limit: 50, cursor })).toEqual([f.item]);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('fusion_review_mine', { p_actor_id: id(1), p_limit: 50,
    p_draft_id: id(3), p_before_created_at: cursor.createdAt, p_before_id: id(2) });
  expect(f.scheduleAfter).not.toHaveBeenCalled();
});
it('mine rejects anonymous access and incomplete cursors', async () => {
  const f = mineFixture(false);
  await expect(f.caller.mine({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(f.rpc).not.toHaveBeenCalled();
  const signed = mineFixture();
  await expect(signed.caller.mine({ cursor: { createdAt: signed.item.createdAt } } as never))
    .rejects.toThrow();
  expect(signed.rpc).not.toHaveBeenCalled();
});
