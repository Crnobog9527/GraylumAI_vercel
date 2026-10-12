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
