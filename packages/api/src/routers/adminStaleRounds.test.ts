/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
const find = vi.hoisted(() => vi.fn());
vi.mock('../services/runtime/staleChargedRounds', () => ({ findStaleChargedRounds: find, compensateStaleRound: vi.fn(),
  STALE_ROUND_REFUSALS: [] }));
import { router } from '../trpc';
import { adminStaleRoundsRouter } from './adminStaleRounds';

const testRouter = router({ adminStaleRounds: adminStaleRoundsRouter });
const admin = '22222222-2222-4222-8222-222222222222';
const actor = (n: number) => `33333333-3333-4333-8333-00000000000${n}`;
const round = (n: number) => ({ kind: 'stale_charged_round', executionId: 'exec', runId: `run-${n}`, actorId: actor(n) });
function setup(profiles: { data: unknown; error: unknown }) {
  const lookup = { select: vi.fn(() => lookup), in: vi.fn(async () => profiles) };
  const from = vi.fn(() => lookup);
  const profile = { id: admin, role: 'admin', status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile }) }) };
  const caller = testRouter.createCaller({ headers: new Headers(),
    user: { id: admin, app_metadata: {}, user_metadata: {} }, isEmailVerified: true, authProvider: 'email',
    supabase: scoped, supabaseAuth: scoped, supabasePublic: {}, supabaseAdmin: { from }, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
  return { caller, lookup, from };
}
afterEach(() => vi.clearAllMocks());

it('shows each round with its user email so the operator can match user feedback', async () => {
  find.mockResolvedValue({ success: false, total: 3, truncated: false, findings: [round(1), round(2), round(1)] });
  const f = setup({ data: [{ id: actor(1), email: 'one@example.com' }], error: null });
  const result = await f.caller.adminStaleRounds.list();
  expect(f.from).toHaveBeenCalledWith('profiles');
  expect(f.lookup.select).toHaveBeenCalledWith('id, email');
  expect(f.lookup.in).toHaveBeenCalledWith('id', [actor(1), actor(2)]);
  expect(result.findings.map(item => item.userEmail)).toEqual(['one@example.com', null, 'one@example.com']);
});

it('still lists the rounds by account id when the email lookup fails, and skips it when there is nothing to show', async () => {
  find.mockResolvedValue({ success: false, total: 1, truncated: false, findings: [round(1)] });
  expect((await setup({ data: null, error: { message: 'down' } }).caller.adminStaleRounds.list()).findings)
    .toEqual([{ ...round(1), userEmail: null }]);
  find.mockResolvedValue({ success: true, total: 0, truncated: false, findings: [] });
  const empty = setup({ data: [], error: null });
  expect((await empty.caller.adminStaleRounds.list()).findings).toEqual([]);
  expect(empty.from).not.toHaveBeenCalled();
});
