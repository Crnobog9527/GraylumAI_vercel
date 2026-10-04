/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeRouter } from './runtime';
import { createRuntimeBudget } from '../services/runtime/budget';
const id = '00000000-0000-4000-8000-000000000001';
afterEach(() => vi.unstubAllEnvs());
it('runtime.resume rejects a v1 execution through the real host and executor without mutation', async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('V3_RUNTIME_LOCAL_ENDPOINT', 'http://127.0.0.1:12345');
  const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .toString('base64url') + '.synthetic';
  const profile = { select() { return this; }, eq() { return this; }, single: async () => ({
    data: { id, role: 'user', status: 'active', credits: 100, nickname: 'Fixture', email: 'fixture@example.test' }, error: null,
  }) };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'runtime_execution' || args.p_action !== 'read') throw Error('UNEXPECTED_MUTATION');
    return { data: { executionId: id, state: 'running', billing: { contractVersion: 'bill2.v1' } }, error: null };
  });
  const client = { from: () => profile, rpc, auth: {
    getSession: async () => ({ data: { session: { access_token: token } }, error: null }),
    getUser: async () => ({ data: { user: { id } }, error: null }),
  } };
  const caller = runtimeRouter.createCaller({ headers: new Headers(), runtimeBudget: createRuntimeBudget(),
    user: { id, email: 'fixture@example.test' }, isEmailVerified: true,
    supabase: client, supabaseAuth: client, supabaseAdmin: client, hasSupabaseAdminPrivileges: true } as never);
  await expect(caller.resume({ executionId: id, cursor: 0, epoch: 0 })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED', message: expect.stringContaining('RUNTIME_RESUME_CONFLICT'),
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('runtime_execution', {
    p_actor_id: id, p_execution_id: id, p_action: 'read',
  });
});
