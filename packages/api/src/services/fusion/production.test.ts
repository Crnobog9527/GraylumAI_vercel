/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RUNTIME-PROD: the review panel on the production host freezes production runs (no test window).
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ policy: undefined as unknown, staging: vi.fn(), production: vi.fn() }));
const ids = { reviewer: '00000000-0000-4000-8000-0000000000a1', summary: '00000000-0000-4000-8000-0000000000b1',
  draft: '00000000-0000-4000-8000-0000000000d1', group: '00000000-0000-4000-8000-0000000000e1',
  run: '00000000-0000-4000-8000-0000000000f1', session: '00000000-0000-4000-8000-0000000000c1' };
vi.mock('../runtime/stagingPolicy', async original => ({ ...(await original<typeof import('../runtime/stagingPolicy')>()),
  loadStagingPolicy: async () => mocks.policy }));
vi.mock('../runtime/paygHostPolicy', async original => ({ ...(await original<typeof import('../runtime/paygHostPolicy')>()),
  readPaygHostPolicies: mocks.staging }));
vi.mock('../runtime/productionPolicy', async original => ({ ...(await original<typeof import('../runtime/productionPolicy')>()),
  readPaygProductionPolicies: mocks.production }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()), readFusionSettings: async () => ({ review: { enabled: true, reviewerModelIds: [ids.reviewer],
  summaryModelId: ids.summary, opinionOutputTokens: 1000, summaryOutputTokens: 2000, dispatchMinutes: 10 } }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()), readMembershipEntitlements: async () => ({}), assertFusionEntitlement: () => {} }));
vi.mock('../runtime/paygPricing', async original => ({ ...(await original<typeof import('../runtime/paygPricing')>()),
  freezeStagingPaygPricing: async (_db: unknown, policies: unknown[]) => policies }));
vi.mock('../runtime/billingUnitAdmission', async original => ({ ...(await original<typeof import('../runtime/billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2',
  creditsPerUsd: '100', defaultMultiplier: '6', models: {}, providers: {}, hash: 'f'.repeat(64) }) }));
vi.mock('../runtime/paygRuntime', async original => ({ ...(await original<typeof import('../runtime/paygRuntime')>()),
  fitNativeRequestOutput: (body: string) => body,
  runtimePaygCall: () => ({ call: { runtimeEpoch: 1, upperUsd: '0.1' }, upperCredits: 10 }) }));
vi.mock('./request', async original => ({ ...(await original<typeof import('./request')>()), fusionRequestBody: () => 'body' }));
vi.mock('./models', async original => ({ ...(await original<typeof import('./models')>()),
  admitFusionModel: async (_db: unknown, _w: unknown, row: { id: string }) => ({ quote: { modelId: row.id },
    policy: { modelId: row.id }, outputLimit: 1000, reasoning: { parameter: 'none' } }) }));
vi.mock('../bill2/service', async original => ({ ...(await original<typeof import('../bill2/service')>()),
  frozenPaygRunSchema: { parse: (value: unknown) => value } }));

const { admitFusionGroup } = await import('./admission');
const { admitFusionModel: realAdmitFusionModel } = await vi.importActual<typeof import('./models')>('./models');

const production = { mode: 'production', id: 'prod-v1', creditsPerUsd: '100', multiplier: '6',
  expiresAt: new Date(Date.now() + 3600000).toISOString(), callPolicies: [] };

it('freezes each panel run as a production v2 run without a test window', async () => {
  mocks.policy = production;
  const admitted: Array<{ payload: Record<string, unknown> & { rules: Record<string, unknown> } }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'bill2_create_draft') return { data: ids.draft, error: null };
    if (name === 'fusion_group_admit' && (args.p_runs as unknown[]).length === 0) return { data: null, error: { message: 'FUSION_GROUP_INVALID' } };
    admitted.push(...(args.p_runs as typeof admitted));
    return { data: { groupId: ids.group, replayed: false, runs: [] }, error: null };
  });
  const rows = { data: [{ id: ids.reviewer }, { id: ids.summary }], error: null };
  const admin = { rpc, from: () => ({ select: () => ({ in: async () => rows }) }) } as unknown as SupabaseClient;
  await admitFusionGroup({ admin, actorId: ids.draft, requestId: ids.run, sourceSessionId: ids.session,
    members: [{ modelId: ids.reviewer, phase: 'fusion_review', request: {} as never }] }).catch(() => undefined);
  expect(admitted).toHaveLength(1);
  expect(admitted[0]!.payload).toMatchObject({ contractVersion: 'bill2.v2', mode: 'production',
    rules: { version: 'runtime-production-v1', quoteVersion: 'prod-v1', creditsPerUsd: '100' } });
  expect(admitted[0]!.payload).not.toHaveProperty('testWindowId');
});

it('a panel model on production is checked against the production profile, never the staging setting', async () => {
  const { createHash } = await import('node:crypto');
  const { configuredReasoning } = await import('../__tests__/fixtures/runtimeReasoning');
  const key = 'SYNTHETIC_LOCAL_ONLY', model = 'anthropic/claude-sonnet-5.5';
  const reasoning = configuredReasoning(model, { mode: 'off', wire: 'reasoning_effort' }, 'review' as never).reasoning;
  const row = { id: ids.reviewer, name: 'Synthetic', model_id: model, provider: 'openrouter', is_active: 'true', input_limit: 250000,
    max_tokens: 8192, api_endpoint: 'https://openrouter.ai/api/v1',
    config: { reasoning: { ...reasoning, route: 'synthetic/fp8' } } };
  const providerLimits = { providerSlug: 'synthetic/fp8', contextTokens: 250000, promptUsdPerMillion: '1',
    completionUsdPerMillion: '1', requestUsd: '0' };
  const quote = { modelId: row.id, model, provider: 'openrouter', protocol: 'openrouter-chat-v1', providerLimits,
    account: 'openrouter-key:' + createHash('sha256').update(key).digest('hex'), upperUsd: '1', inputLimit: 196608, outputLimit: 8192,
    automaticRetry: false, hiddenTools: false, lookupSupported: true, multiplier: '6' };
  mocks.production.mockResolvedValue([{ ...quote, payg: {} }]);
  // The one platform OpenRouter key (Vault, OR-1) is passed in, as the settings listing does.
  const admitted = await realAdmitFusionModel({} as SupabaseClient, { ...production, callPolicies: [quote] } as never, row as never,
    'fusion_review', 4096, new Date().toISOString(), {}, key);
  expect(admitted.policy).toMatchObject({ modelId: row.id });
  expect(mocks.production).toHaveBeenCalledTimes(1);
  expect(mocks.staging).not.toHaveBeenCalled();
});
