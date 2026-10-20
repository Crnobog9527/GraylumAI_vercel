/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { fusionReviewRouter, revisionHooks } from './fusionReview';

describe('fusion review router', () => {
  it('has no user stop or end (Owner 2026-10-17: once started a review runs to its end)', () => {
    const procedures = Object.keys(fusionReviewRouter._def.procedures);
    expect(procedures).not.toContain('stop');
    expect(procedures).not.toContain('end');
  });

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
it('available tells a signed-in user whether the review is switched on, and fails closed', async () => {
  const settings = await import('../services/fusion/settings');
  const read = vi.spyOn(settings, 'readFusionSettings');
  read.mockResolvedValueOnce({ review: { enabled: true } } as never);
  expect(await mineFixture().caller.available()).toEqual({ enabled: true });
  read.mockResolvedValueOnce({ review: { enabled: false } } as never);
  expect(await mineFixture().caller.available()).toEqual({ enabled: false });
  read.mockRejectedValueOnce(new Error('down'));
  expect(await mineFixture().caller.available()).toEqual({ enabled: false });
  await expect(mineFixture(false).caller.available()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  read.mockRestore();
});

function marksCaller(draftOwner: string, signedIn = true) {
  const draft = id(3);
  const table = (rows: unknown): never => { const q: Record<string, unknown> = {}; for (const key of ['select', 'in', 'is', 'eq', 'order']) q[key] = () => q;
    q.limit = async () => ({ data: rows, error: null }); q.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }); return q as never; };
  const profile = { id: id(1), role: 'user', status: 'active', credits: 0, nickname: 'fixture' };
  const from = (name: string) => name === 'opc_drafts' ? table([{ draft_id: draft, project_id: id(5), actor_id: draftOwner }])
    : name === 'artifact_versions' ? table([{ id: id(4), source: null, from: null }])
    : name === 'fusion_reviews' ? table([{ id: id(2), draft_id: id(3), source_version_id: id(4), state: 'completed', ended_at: '2026-10-19T10:00:00Z', adoption: null }])
    : (() => { const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: profile, error: null });
      q.single = q.maybeSingle; return q as never; })();
  const db = { rpc: vi.fn(), from };
  const caller = fusionReviewRouter.createCaller({ headers: new Headers(),
    user: signedIn ? { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } } : null,
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true, scheduleAfter: vi.fn() } as never);
  return { caller, draft };
}
it('versionMarks answers for the caller\'s own analyses and refuses another user\'s with FORBIDDEN, never an empty answer', async () => {
  const own = marksCaller(id(1));
  expect(await own.caller.versionMarks({ draftIds: [own.draft] })).toMatchObject({ [id(4)]: { mark: 'reviewed', reviewId: id(2), draftId: id(3), adoptedCount: 0 } });
  const foreign = marksCaller(id(99));
  await expect(foreign.caller.versionMarks({ draftIds: [foreign.draft] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(marksCaller(id(1), false).caller.versionMarks({ draftIds: [id(3)] })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(own.caller.versionMarks({ draftIds: [] })).rejects.toThrow();
  await expect(own.caller.versionMarks({ draftIds: Array.from({ length: 51 }, (_, i) => id(100 + i)) })).rejects.toThrow();
});
