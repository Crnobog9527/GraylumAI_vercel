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

describe('one-click conversation deletion (Owner 2026-10-13: no impact list)', () => {
  const preview = (previewHash = hash) => ({ data: { kind: 'session', id, alreadyDeleted: false, affectedExecutions: 3,
    affectedSources: [], preservedSavedVersions: 0, previewHash }, error: null });
  const deleted = { data: { kind: 'session', id, status: 'deleted', alreadyDeleted: false, preservedSavedVersions: 0,
    financialReviewCount: 0 }, error: null };

  it('allows the owner: the server computes the session scope and confirms that exact hash', async () => {
    const rpc = vi.fn().mockResolvedValueOnce(preview()).mockResolvedValueOnce(deleted);
    await expect(caller(rpc).conversationErasure({ sessionId: id })).resolves.toEqual(deleted.data);
    expect(rpc.mock.calls).toEqual([
      ['content_erasure_preview', { a: 'user-1', k: 'session', target: id }],
      ['content_erasure_confirm', { a: 'user-1', k: 'session', target: id, expected_hash: hash }],
    ]);
  });

  it('denies a conversation the caller does not own and never confirms', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'CONTENT_NOT_FOUND' } });
    await expect(caller(rpc).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'CONTENT_NOT_FOUND' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('content_erasure_preview');
  });

  it('accepts only a session id: no kind, no client hash', async () => {
    const rpc = vi.fn();
    await expect(caller(rpc).conversationErasure({ sessionId: id, kind: 'answer' } as never)).rejects.toThrow();
    await expect(caller(rpc).conversationErasure({ sessionId: id, previewHash: hash } as never)).rejects.toThrow();
    await expect(caller(rpc).conversationErasure({ sessionId: 'not-a-uuid' })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('recomputes the scope when it grew between the two calls, then stops after three tries', async () => {
    const changed = { data: null, error: { code: '40001', message: 'CONTENT_ERASURE_PREVIEW_CHANGED' } };
    const retried = vi.fn().mockResolvedValueOnce(preview()).mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(preview('b'.repeat(64))).mockResolvedValueOnce(deleted);
    await expect(caller(retried).conversationErasure({ sessionId: id })).resolves.toEqual(deleted.data);
    expect(retried.mock.calls[3][1]).toMatchObject({ expected_hash: 'b'.repeat(64) });
    const stuck = vi.fn().mockImplementation(async (name: string) => name === 'content_erasure_preview' ? preview() : changed);
    await expect(caller(stuck).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: 'CONTENT_ERASURE_PREVIEW_CHANGED' });
    expect(stuck).toHaveBeenCalledTimes(6);
  });

  it('reports a busy conversation as a failure without retrying', async () => {
    const rpc = vi.fn().mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'CONTENT_ERASURE_BUSY' } });
    await expect(caller(rpc).conversationErasure({ sessionId: id }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: 'CONTENT_ERASURE_BUSY' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('returns an earlier deletion as already deleted', async () => {
    const gone = { ...preview(), data: { ...preview().data, alreadyDeleted: true } };
    const again = { data: { ...deleted.data, alreadyDeleted: true }, error: null };
    const rpc = vi.fn().mockResolvedValueOnce(gone).mockResolvedValueOnce(again);
    await expect(caller(rpc).conversationErasure({ sessionId: id })).resolves.toMatchObject({ alreadyDeleted: true });
  });
});
