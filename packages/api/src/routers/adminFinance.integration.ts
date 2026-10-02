/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { adminRouter } from './admin';
import { router } from '../trpc';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { normalizeEndpointPricing } from '../shared/modelPricing';

const origin = process.env.FINANCE_LOCAL_REST!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('Isolated finance runner required');
const requests: Array<{ path: string; status: number }> = [];
const nativeFetch = globalThis.fetch;
const localFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) throw new Error('Non-local request forbidden');
  url.pathname = url.pathname.replace(/^\/rest\/v1/, '');
  const response = await nativeFetch(url, init);
  requests.push({ path: url.pathname, status: response.status });
  return response;
};
const client = (key: string) => createClient(origin, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const service = client(process.env.FINANCE_SERVICE_JWT!);
const auth = client(process.env.FINANCE_ADMIN_JWT!);
const context = { headers: new Headers(),
  user: { id: '00000000-0000-4000-8000-000000000003', app_metadata: { provider: 'email' }, user_metadata: {} },
  isEmailVerified: true, authProvider: 'email', supabase: auth, supabaseAuth: auth,
  supabasePublic: auth, supabaseAdmin: service, hasSupabaseAdminPrivileges: true,
} as Parameters<typeof adminRouter.createCaller>[0];
const caller = adminRouter.createCaller(context);

it('loads finance before and after saving an empty provider-price configuration', async () => {
  const settings = await service.from('system_settings').upsert([
    { key: 'billing_credits_per_usd', value: 100 }, { key: 'billing_token_price_multiplier', value: 3 },
  ]);
  expect(settings.error).toBeNull();
  const before = await caller.getFinanceStats();
  const saved = await service.from('system_settings').upsert({ key: 'billing_provider_prices', value: { version: 1, entries: [] } });
  expect(saved.error).toBeNull();
  const after = await caller.getFinanceStats();
  expect(after).toEqual(before);
});

it('loads a renamed model with a refreshed snapshot and retained manual costs', async () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const inserted = await service.from('ai_models').insert({ id, name: 'Synthetic deepseek', model_id: 'deepseek/example',
    provider: 'openrouter', input_token_cost: 200000, output_token_cost: 400000,
    input_token_cost_above_200k: 300000, output_token_cost_above_200k: 600000, web_search_cost: 50000 });
  expect(inserted.error).toBeNull();
  const model = 'openai/gpt-6.1-sol';
  const changed = await service.from('ai_models').update({ name: model, model_id: model, config: {
    pricing: { model, fetchedAt: new Date().toISOString(), source: 'fixture', pricingHash: 'a'.repeat(64),
      endpoints: [normalizeEndpointPricing('openai', 1000000, { prompt: '0.000002', completion: '0.000005' })] },
    reasoning: { route: 'openai', purposes: {} },
  } }).eq('id', id);
  expect(changed.error).toBeNull();
  requests.length = 0;
  const result = await caller.getFinanceStats();
  const retained = await service.from('ai_models').select('input_token_cost,output_token_cost').eq('id', id).single();
  expect(retained.data).toEqual({ input_token_cost: 200000, output_token_cost: 400000 });
  expect(result.modelStats).toEqual(expect.arrayContaining([expect.objectContaining({ id, modelId: model })]));
  expect(requests.every(request => request.status === 200 || request.status === 206)).toBe(true);
});


it('accepts persisted checkin and unknown types alongside both original suspect scenarios', async () => {
  requests.length = 0;
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc', req: new Request('http://localhost/api/trpc/admin.getFinanceStats'),
    router: router({ admin: adminRouter }), createContext: () => context,
  });
  expect(response.status).toBe(200);
  const result = (await response.json()).result.data;
  expect(result.transactions).toMatchObject({ totalCheckins: 7, totalAdditions: 0, unknownTypeCount: 1,
    unknownTypes: { future_reward: 1 } });
  expect(result.financeOverview.creditsGiven).toBe(7);
  expect(requests.every(request => request.status === 200 || request.status === 206)).toBe(true);
});

it('accepts a persisted package active value without a database CHECK constraint', async () => {
  const saved = await service.from('credit_packages').insert({ name: 'Synthetic archived', price: 100,
    credits_amount: 10, active: 'archived' });
  expect(saved.error).toBeNull();
  const result = await caller.getFinanceStats();
  expect(result.packages).toMatchObject({ unknownActiveCount: 1 });
});


it('accepts the migrated model active text column without treating unknown values as active', async () => {
  const changed = await service.from('ai_models').update({ is_active: 'archived' })
    .eq('id', '10000000-0000-4000-8000-000000000001');
  expect(changed.error).toBeNull();
  const result = await caller.getFinanceStats();
  expect(result.runtimeBilling).toMatchObject({ activeModelCount: 0, unknownModelActiveCount: 1 });
  expect(result.modelStats[0].isActive).toBe('archived');
});
