/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { accountRouter } from './account';

const id = '00000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);

// The protected procedure reads the caller's own active profile before the route runs.
const profile = { id: 'user-1', role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
const userScoped = {
  from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }),
    maybeSingle: async () => ({ data: profile, error: null }) }),
};

function caller(rpc: ReturnType<typeof vi.fn>) {
  return accountRouter.createCaller({
    headers: new Headers(),
    user: { id: 'user-1', email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    profileId: 'user-1',
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScoped, supabaseAuth: userScoped, supabasePublic: {},
    supabaseAdmin: { ...userScoped, rpc },
    hasSupabaseAdminPrivileges: true,
  } as never);
}

describe('user-facing content erasure scope (Owner 2026-10-13: whole conversations only)', () => {
  it('refuses a single answer before touching the database, for preview and confirm', async () => {
    const rpc = vi.fn();
    await expect(caller(rpc).contentErasurePreview({ kind: 'answer', id }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CONTENT_ERASURE_SCOPE_DISABLED' });
    await expect(caller(rpc).contentErasureConfirm({ kind: 'answer', id, previewHash: hash, acknowledged: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CONTENT_ERASURE_SCOPE_DISABLED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['session', 'artifact', 'content'] as const)('still previews a whole %s', async kind => {
    const result = { kind, id, alreadyDeleted: false, affectedExecutions: 2, affectedSources: [],
      preservedSavedVersions: 0, previewHash: hash };
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    await expect(caller(rpc).contentErasurePreview({ kind, id })).resolves.toEqual(result);
    expect(rpc).toHaveBeenCalledWith('content_erasure_preview', { a: 'user-1', k: kind, target: id });
  });
});

describe('one-click conversation deletion (Owner 2026-10-13: no impact list, 0231 mark then clean up)', () => {
  const deleted = { data: { kind: 'session', id, status: 'deleted', alreadyDeleted: false, preservedSavedVersions: 0,
    financialReviewCount: 0 }, error: null };

  it('allows the owner: one mark call on this session only, no preview', async () => {
    const rpc = vi.fn().mockResolvedValueOnce(deleted);
    await expect(caller(rpc).conversationErasure({ sessionId: id })).resolves.toEqual(deleted.data);
    expect(rpc.mock.calls).toEqual([['content_erasure_mark_session', { a: 'user-1', target: id }]]);
  });

  it('denies a conversation the caller does not own', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'CONTENT_NOT_FOUND' } });
    await expect(caller(rpc).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'CONTENT_NOT_FOUND' });
    await expect(caller(rpc).conversationErasureCleanup({ sessionId: id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'CONTENT_NOT_FOUND' });
  });

  it('accepts only a session id: no kind, no client hash', async () => {
    const rpc = vi.fn();
    for (const call of [caller(rpc).conversationErasure, caller(rpc).conversationErasureCleanup]) {
      await expect(call({ sessionId: id, kind: 'answer' } as never)).rejects.toThrow();
      await expect(call({ sessionId: id, previewHash: hash } as never)).rejects.toThrow();
      await expect(call({ sessionId: 'not-a-uuid' })).rejects.toThrow();
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a busy conversation as a failure, and a mismatched answer as unavailable', async () => {
    const busy = vi.fn().mockResolvedValue({ data: null, error: { code: '55P03', message: 'CONTENT_ERASURE_BUSY' } });
    await expect(caller(busy).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: 'CONTENT_ERASURE_BUSY' });
    const other = vi.fn().mockResolvedValue({ data: { ...deleted.data, id: hash.slice(0, 8) }, error: null });
    await expect(caller(other).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('cleans up a marked conversation through confirm without a hash; busy is left for the sweep', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { ...deleted.data, alreadyDeleted: true }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'CONTENT_ERASURE_BUSY' } });
    await expect(caller(rpc).conversationErasureCleanup({ sessionId: id })).resolves.toEqual({ cleaned: true });
    expect(rpc.mock.calls[0]).toEqual(['content_erasure_confirm', { a: 'user-1', k: 'session', target: id, expected_hash: null }]);
    await expect(caller(rpc).conversationErasureCleanup({ sessionId: id })).resolves.toEqual({ cleaned: false });
  });

  it('never lets cleanup erase an unmarked conversation', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '40001', message: 'CONTENT_ERASURE_PREVIEW_CHANGED' } });
    await expect(caller(rpc).conversationErasureCleanup({ sessionId: id }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: 'CONTENT_ERASURE_PREVIEW_CHANGED' });
  });
});

describe('conversation cleanup sweep (cron backstop)', () => {
  const page = (over: Record<string, unknown>) => ({ data: { cleaned: 0, pending: 0, failed: 0, more: false,
    afterAt: null, afterId: null, ...over }, error: null });
  it('pages with the cursor until the backlog is drained and sums the counts', async () => {
    const { sweepErasedConversations } = await import('../services/accountErasure/content');
    const cursor = { afterAt: '2026-10-13T00:00:00Z', afterId: id };
    const rpc = vi.fn().mockResolvedValueOnce(page({ cleaned: 49, pending: 1, more: true, ...cursor }))
      .mockResolvedValueOnce(page({ cleaned: 3, failed: 1 }));
    await expect(sweepErasedConversations({ rpc } as never)).resolves.toEqual({ cleaned: 52, pending: 1, failed: 1, more: false });
    expect(rpc.mock.calls[0][1]).toEqual({ lim: 50, after_at: null, after_id: null });
    expect(rpc.mock.calls[1][1]).toEqual({ lim: 50, after_at: cursor.afterAt, after_id: id });
  });
  it('stops at the time budget and reports the backlog', async () => {
    const { sweepErasedConversations } = await import('../services/accountErasure/content');
    let clock = 0;
    const rpc = vi.fn().mockImplementation(async () => { clock += 10_000; return page({ cleaned: 50, more: true,
      afterAt: '2026-10-13T00:00:00Z', afterId: id }); });
    await expect(sweepErasedConversations({ rpc } as never, 25_000, () => clock)).resolves.toMatchObject({ more: true });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('throws a private error when the sweep itself fails', async () => {
    const { sweepErasedConversations } = await import('../services/accountErasure/content');
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'private detail' } });
    await expect(sweepErasedConversations({ rpc } as never)).rejects.toThrow('CONTENT_ERASURE_SWEEP_FAILED');
  });
});
