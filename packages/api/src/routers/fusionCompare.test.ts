/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const s = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock('../services/fusion/compareLive', async importOriginal => ({ ...await importOriginal<typeof import('../services/fusion/compareLive')>(),
  liveCompare: async () => s.live() }));
import { appRouter } from '../root';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile = { id: id(1), role: 'user', status: 'active', credits: 0, nickname: 'fixture' };
const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }),
  single: async () => ({ data: profile, error: null }) };
const db = { rpc: vi.fn(), from: () => q } as unknown as SupabaseClient;
const caller = () => appRouter.createCaller({ headers: new Headers(),
  user: { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
  isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db,
  userScopedSupabase: db, hasSupabaseAdminPrivileges: true } as never);
const input = { sessionId: id(2), question: '问题', modelIds: [id(3), id(4)] };

describe('fusionCompare router', () => {
  it('exposes the compare procedures', () => {
    const procedures = Object.keys(appRouter._def.procedures).filter(name => name.startsWith('fusionCompare.'));
    expect(procedures.sort()).toEqual(['fusionCompare.adopt', 'fusionCompare.estimate', 'fusionCompare.list', 'fusionCompare.options',
      'fusionCompare.read', 'fusionCompare.start', 'fusionCompare.stop', 'fusionCompare.stream']);
  });
  it('keeps exact compare refusals for the page, with a status that says what kind they are', async () => {
    for (const [message, code] of [['FUSION_COMPARE_DISABLED', 'FORBIDDEN'], ['FUSION_COMPARE_ACTIVE', 'CONFLICT'],
      ['FUSION_COMPARE_SESSION_BUSY', 'CONFLICT'], ['FUSION_COMPARE_INPUT_TOO_LARGE', 'BAD_REQUEST'],
      ['REPORT_MEMBERSHIP_REQUIRED', 'FORBIDDEN'], ['REPORT_ENTITLEMENTS_UNAVAILABLE', 'BAD_REQUEST']] as const) {
      s.live.mockResolvedValueOnce({ estimate: async () => { throw new Error(message); } });
      await expect(caller().fusionCompare.estimate(input)).rejects.toMatchObject({ code, message });
    }
  });
  it('never shows database detail for anything else', async () => {
    s.live.mockResolvedValueOnce({ estimate: async () => { throw new Error('relation "x" does not exist'); } });
    await expect(caller().fusionCompare.estimate(input)).rejects.not.toMatchObject({ message: expect.stringContaining('relation') });
  });
  it('reads and stops without the staging call window (no provider call is needed)', async () => {
    s.live.mockRejectedValue(new Error('RUNTIME_TEST_WINDOW_DENIED'));
    const views: Record<string, unknown> = { fusion_compare_read: { compareId: id(5), state: 'finished', columns: [] },
      fusion_compare_stop: { compareId: id(5), state: 'stopped' } };
    (db.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => name in views ? { data: views[name], error: null } : undefined);
    await expect(caller().fusionCompare.read({ compareId: id(5) })).resolves.toMatchObject({ state: 'finished' });
    await expect(caller().fusionCompare.stop({ compareId: id(5) })).resolves.toMatchObject({ state: 'stopped' });
    s.live.mockReset();
    (db.rpc as ReturnType<typeof vi.fn>).mockReset();
  });
  it('validates input before any work: a start needs the shown quote', async () => {
    await expect(caller().fusionCompare.start({ ...input, requestId: id(9) } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
