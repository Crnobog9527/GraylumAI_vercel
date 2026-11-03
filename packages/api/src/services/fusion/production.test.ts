/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RUNTIME-PROD: a review panel model on the production host is admitted against the production profile (no test window). The old
// group admission that froze each run as a production v2 run (admitFusionGroup) went with the BILL2 review.
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ policy: undefined as unknown, staging: vi.fn(), production: vi.fn() }));
const ids = { reviewer: '00000000-0000-4000-8000-0000000000a1', summary: '00000000-0000-4000-8000-0000000000b1',
  draft: '00000000-0000-4000-8000-0000000000d1', group: '00000000-0000-4000-8000-0000000000e1',
  run: '00000000-0000-4000-8000-0000000000f1', session: '00000000-0000-4000-8000-0000000000c1' };
vi.mock('../turn/settings/stagingPolicy', async original => ({ ...(await original<typeof import('../turn/settings/stagingPolicy')>()),
  loadStagingPolicy: async () => mocks.policy }));
vi.mock('../turn/admission/paygHostPolicy', async original => ({ ...(await original<typeof import('../turn/admission/paygHostPolicy')>()),
  readPaygHostPolicies: mocks.staging }));
vi.mock('../turn/settings/productionPolicy', async original => ({ ...(await original<typeof import('../turn/settings/productionPolicy')>()),
  readPaygProductionPolicies: mocks.production }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()), readFusionSettings: async () => ({ review: { enabled: true, reviewerModelIds: [ids.reviewer],
  summaryModelId: ids.summary, opinionOutputTokens: 1000, summaryOutputTokens: 2000, dispatchMinutes: 10 } }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()), readMembershipEntitlements: async () => ({}), assertFusionEntitlement: () => {} }));
vi.mock('../turn/admission/paygPricing', async original => ({ ...(await original<typeof import('../turn/admission/paygPricing')>()),
  freezeStagingPaygPricing: async (_db: unknown, policies: unknown[]) => policies }));
vi.mock('../turn/admission/billingUnitAdmission', async original => ({ ...(await original<typeof import('../turn/admission/billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2',
  creditsPerUsd: '100', defaultMultiplier: '6', models: {}, providers: {}, hash: 'f'.repeat(64) }) }));
const { admitFusionModel: realAdmitFusionModel } = await vi.importActual<typeof import('./models')>('./models');

const production = { mode: 'production', id: 'prod-v1', creditsPerUsd: '100', multiplier: '6',
  expiresAt: new Date(Date.now() + 3600000).toISOString(), callPolicies: [] };

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
