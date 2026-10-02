/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { modelRouter } from './model';
import { pricingConfig } from '../services/__tests__/fixtures/runtimePricing';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(conflict = false, readError = false) {
  const original = { ...pricingConfig('synthetic/model'), connection_status: 'connected' };
  let stored = original;
  const filters: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    let payload: Record<string, unknown> | undefined;
    const condition: Record<string, unknown> = {};
    const read = async () => ({ data: readError ? null : { provider: 'openrouter', model_id: 'synthetic/model',
      api_endpoint: null, config: structuredClone(original), updated_at: 'v1' }, error: readError ? { code: '42501' } : null });
    const write = () => {
      filters.push(condition);
      if (conflict) {
        stored = { ...original, pricing: { ...original.pricing, pricingHash: 'b'.repeat(64) } };
        return false;
      }
      writes.push(payload!);
      stored = payload!.config as typeof stored;
      return true;
    };
    const q = {
      eq(key: string, value: unknown) { condition[key] = value; return q; },
      update(value: Record<string, unknown>) { payload = value; return q; },
      select() {
        if (!payload) return q;
        return {
          single: async () => write() ? { data: { id, ...payload }, error: null }
            : { data: null, error: { code: 'PGRST116' } },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: write() ? [{ id, ...payload }] : [], error: null }).then(resolve);
          },
        };
      },
      single: async () => table === 'profiles' ? { data: { id, role: 'admin', status: 'active' }, error: null } : read(),
      maybeSingle: read,
    };
    return q;
  } };
  const caller = modelRouter.createCaller({ headers: new Headers(), user: { id, app_metadata: { provider: 'email' } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: db,
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  return { caller, original, filters, writes, stored: () => stored };
}
afterEach(() => vi.unstubAllGlobals());

it.each(['updateModel', 'updateModelConfig'] as const)('%s conditions on the read version and discards forged managed keys', async operation => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NO_NETWORK'); }));
  const f = fixture();
  await f.caller[operation]({ id, config: { temperature: 0.2, pricing: { forged: true }, reasoning: { forged: true } } });
  expect(f.filters).toEqual([{ id, updated_at: 'v1' }]);
  expect(f.writes).toHaveLength(1);
  expect(f.stored()).toEqual({ temperature: 0.2, pricing: f.original.pricing, reasoning: f.original.reasoning });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['updateModel', 'updateModelConfig'] as const)('%s reports a concurrent version change without overwriting pricing', async operation => {
  const f = fixture(true);
  await expect(f.caller[operation]({ id, config: {} })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.filters).toEqual([{ id, updated_at: 'v1' }]);
  expect(f.writes).toEqual([]);
  expect(f.stored().pricing.pricingHash).toBe('b'.repeat(64));
});
it.each(['updateModel', 'updateModelConfig'] as const)('%s never writes after the version read fails', async operation => {
  const f = fixture(false, true);
  await expect(f.caller[operation]({ id, config: {} })).rejects.toBeDefined();
  expect(f.filters).toEqual([]);
  expect(f.writes).toEqual([]);
});
