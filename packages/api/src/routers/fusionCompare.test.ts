/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const s = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('../services/turn/compareCards', async importOriginal => ({ ...await importOriginal<typeof import('../services/turn/compareCards')>(),
  readTurnCompare: (...args: unknown[]) => s.read(...args), listTurnCompares: (...args: unknown[]) => s.list(...args) }));
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

describe('fusionCompare router', () => {
  // CORE-PATH-V2 V2-12 B4: a compare is priced and started on POST /api/turn/estimate and /api/turn/compare only.
  it('exposes only the turn-path reads and the free adoption', () => {
    const procedures = Object.keys(appRouter._def.procedures).filter(name => name.startsWith('fusionCompare.'));
    expect(procedures.sort()).toEqual(['fusionCompare.options', 'fusionCompare.turnAdopt', 'fusionCompare.turnList', 'fusionCompare.turnRead']);
  });
  it('keeps exact compare refusals for the page, with a status that says what kind they are', async () => {
    for (const [message, code] of [['FUSION_COMPARE_DISABLED', 'FORBIDDEN'], ['FUSION_COMPARE_ACTIVE', 'CONFLICT'],
      ['FUSION_COMPARE_SESSION_BUSY', 'CONFLICT'], ['FUSION_COMPARE_INPUT_TOO_LARGE', 'BAD_REQUEST'],
      ['REPORT_MEMBERSHIP_REQUIRED', 'FORBIDDEN'], ['REPORT_ENTITLEMENTS_UNAVAILABLE', 'BAD_REQUEST']] as const) {
      s.read.mockRejectedValueOnce(new Error(message));
      await expect(caller().fusionCompare.turnRead({ compareId: id(5) })).rejects.toMatchObject({ code, message });
    }
  });
  it('never shows database detail for anything else', async () => {
    s.read.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    await expect(caller().fusionCompare.turnRead({ compareId: id(5) })).rejects.not.toMatchObject({ message: expect.stringContaining('relation') });
  });
  it('lists the conversation\'s cards even when the model-name lookup fails', async () => {
    const cards = [{ compareId: id(5), state: 'running', config: { models: [id(3), id(4)] } }];
    s.list.mockResolvedValueOnce(cards);
    // The test client has no model table: the name lookup throws, and the cards still come back.
    await expect(caller().fusionCompare.turnList({ sessionId: id(2) })).resolves.toEqual({ cards, names: {} });
  });
});
