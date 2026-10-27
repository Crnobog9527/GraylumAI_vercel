/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { loadProductionPolicy, readPaygProductionPolicies, PAYG_PRODUCTION_SETTING } from './productionPolicy';
import { parseStagingPolicy } from './stagingPolicy';
import { clearCatalogCache, withCatalogRequest } from './catalogCache';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const key = vi.hoisted(() => ({ value: 'platform-key' as string | undefined }));
vi.mock('../models/openRouterKey', async original => ({ ...(await original<typeof import('../models/openRouterKey')>()),
  readOpenRouterKey: async () => key.value, readOpenRouterKeyOrUnset: async () => key.value }));
vi.mock('../models/openRouterCatalog', () => ({ readOpenRouterPricing: vi.fn(() => { throw new Error('offline'); }) }));

const actor = '30000000-0000-4000-8000-000000000003';
const env = {
  V3_RUNTIME_PRODUCTION_ENABLED: 'true', VERCEL: '1', VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com', VERCEL_GIT_COMMIT_REF: 'main',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  V3_RUNTIME_PRODUCTION_PROJECT_ID: 'p', VERCEL_PROJECT_ID: 'p',
  NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co', V3_RUNTIME_PRODUCTION_DATABASE_HOST: 'prod.supabase.co',
};
const MODELS = [
  { id: '10000000-0000-4000-8000-000000000001', model: 'anthropic/claude-sonnet-5.5', tag: 'anthropic' },
  { id: '10000000-0000-4000-8000-000000000002', model: 'openai/gpt-6-luna', tag: 'openai' },
];
// Synthetic evidence exercises validation only. It is never shipped as a real admission profile.
function profile(model: string, endpointTag: string) {
  return { model, endpointTag, protocol: 'openrouter-chat-v1', profileVersion: 'test-only', evidenceVersion: 'test-only',
    admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128, maxTools: 2,
    maxSchemaBytes: 16384, purposes: ['ordinary', 'organizer'], requestFormats: ['serial-tools-v2'],
    reasoningVariants: [{ reasoning: { parameter: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
      manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
    evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
      maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
      outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
      cacheCovered: true, costBoundPassed: true } };
}
type Row = Record<string, unknown>;
function fixture() {
  const settings: Row[] = [
    { key: PAYG_PRODUCTION_SETTING, value: { version: 1, enabled: true, policyVersion: 'prod-2026-10-17',
      profiles: MODELS.map(m => profile(m.model, m.tag)) } },
    { key: 'billing_credits_per_usd', value: 100 }, { key: 'billing_token_price_multiplier', value: 6 },
  ];
  const models: Row[] = MODELS.map(m => ({ id: m.id, model_id: m.model, provider: 'openrouter', is_active: 'true',
    api_endpoint: 'https://openrouter.ai/api/v1/chat/completions', price_multiplier: null,
    updated_at: '2026-10-01T00:00:00Z', config: pricingConfig(m.model, m.tag, '0.000003', '0.000015') }));
  const rpc = vi.fn<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>(
    async () => ({ data: true, error: null }));
  const filter = (rows: Row[]) => {
    let out = rows;
    const q = {
      in: (col: string, vals: unknown[]) => { out = out.filter(r => vals.includes(r[col])); return q; },
      eq: (col: string, val: unknown) => { out = out.filter(r => r[col] === val); return q; },
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: out, error: null }),
    };
    return q;
  };
  const admin = { rpc, from: vi.fn((table: string) => ({ select: () => filter(table === 'system_settings' ? settings : models) })) };
  return { admin: admin as unknown as SupabaseClient, settings, models, rpc };
}
const load = (f: ReturnType<typeof fixture>, e: Record<string, string | undefined> = env) => loadProductionPolicy(f.admin, actor, e);

it('derives every quote from the stored price snapshot and the configured q and m, with no window', async () => {
  const f = fixture();
  const policy = await load(f);
  expect(policy).toMatchObject({ mode: 'production', id: 'prod-2026-10-17', creditsPerUsd: '100', multiplier: '6' });
  expect(f.rpc).toHaveBeenCalledWith('runtime_production_access', { p_actor_id: actor });
  expect(policy.callPolicies).toHaveLength(2);
  for (const call of policy.callPolicies) {
    const m = MODELS.find(x => x.id === call.modelId)!;
    expect(call).toMatchObject({ provider: 'openrouter', protocol: 'openrouter-chat-v1', model: m.model, multiplier: '6',
      inputLimit: 196608, outputLimit: 8192, automaticRetry: false, hiddenTools: false, lookupSupported: true,
      account: 'openrouter-key:' + createHash('sha256').update('platform-key').digest('hex') });
    expect(call.providerLimits).toMatchObject({ providerSlug: m.tag, contextTokens: 1050000 });
    expect(call.upperUsd).toBe(openRouterBound(call.providerLimits!, 8192).upperUsd);
  }
  // Same shape the staging window carries, so every existing consumer validates it the same way.
  expect(() => parseStagingPolicy({ ...policy, id: MODELS[0].id })).not.toThrow();
});

it('uses a model override and follows a price change without approval', async () => {
  const f = fixture();
  f.models[0].price_multiplier = 8;
  f.models[1].config = pricingConfig(MODELS[1].model, MODELS[1].tag, '0.000009', '0.00003');
  const policy = await load(f);
  expect(policy.callPolicies.find(c => c.modelId === MODELS[0].id)!.multiplier).toBe('8');
  expect(policy.multiplier).toBe('8');
  const luna = policy.callPolicies.find(c => c.modelId === MODELS[1].id)!;
  expect(luna.providerLimits).toMatchObject({ promptUsdPerMillion: '0.000009', completionUsdPerMillion: '0.00003' });
});

it.each([
  ['the target binding', (f: ReturnType<typeof fixture>, e: Row) => { e.VERCEL_GIT_COMMIT_REF = 'staging'; }, 'RUNTIME_PRODUCTION_TARGET_DENIED'],
  ['the enable switch', (_f: ReturnType<typeof fixture>, e: Row) => { e.V3_RUNTIME_PRODUCTION_ENABLED = 'false'; }, 'RUNTIME_PRODUCTION_DISABLED'],
])('checks %s before any database read', async (_name, mutate, code) => {
  const f = fixture(); const e: Row = { ...env }; mutate(f, e);
  await expect(load(f, e as Record<string, string>)).rejects.toThrow(code);
  expect(f.rpc).not.toHaveBeenCalled(); expect(f.admin.from).not.toHaveBeenCalled();
});

it('refuses when the database does not confirm production access', async () => {
  const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'RUNTIME_PRODUCTION_DENIED' } });
  await expect(load(f)).rejects.toThrow(); expect(f.admin.from).not.toHaveBeenCalled();
});

it.each([
  ['missing production setting', (f: ReturnType<typeof fixture>) => { f.settings.splice(0, 1); }, 'RUNTIME_PRODUCTION_CONFIG_INVALID'],
  ['switched off', (f: ReturnType<typeof fixture>) => { (f.settings[0].value as Row).enabled = false; }, 'RUNTIME_PRODUCTION_DISABLED'],
  ['a staging-shaped setting', (f: ReturnType<typeof fixture>) => { (f.settings[0].value as Row).windowId = actor; }, 'RUNTIME_PRODUCTION_CONFIG_INVALID'],
  ['a profile with an expiry', (f: ReturnType<typeof fixture>) => {
    ((f.settings[0].value as Row).profiles as Row[])[0].expiresAt = '2099-01-01T00:00:00Z'; }, 'RUNTIME_PRODUCTION_CONFIG_INVALID'],
  ['two profiles for one model', (f: ReturnType<typeof fixture>) => {
    const profiles = (f.settings[0].value as Row).profiles as Row[]; profiles.push({ ...profiles[0], endpointTag: 'other' }); },
  'RUNTIME_PRODUCTION_CONFIG_INVALID'],
  ['q from the code default', (f: ReturnType<typeof fixture>) => { f.settings.splice(1, 1); }, 'RUNTIME_BILLING_UNIT_UNAVAILABLE'],
  ['m from the code default', (f: ReturnType<typeof fixture>) => { f.settings.splice(2, 1); }, 'RUNTIME_BILLING_UNIT_UNAVAILABLE'],
])('fails closed on %s', async (_name, mutate, code) => {
  const f = fixture(); mutate(f);
  await expect(load(f)).rejects.toThrow(code);
});

it('leaves out a model whose key, route or price is unusable and fails only when nothing remains', async () => {
  const f = fixture();
  f.models[1].api_endpoint = 'https://api.openai.com/v1/chat/completions';
  expect((await load(f)).callPolicies.map(c => c.modelId)).toEqual([MODELS[0].id]);
  const g = fixture();
  g.models[0].config = pricingConfig(MODELS[0].model, 'another/route');
  g.models[1].api_endpoint = 'https://api.openai.com/v1/chat/completions';
  await expect(load(g)).rejects.toThrow('RUNTIME_PRODUCTION_CONFIG_INVALID');
  // The one platform key (Vault, OR-1) is not filled in: no model can be dispatched.
  key.value = undefined;
  await expect(load(fixture())).rejects.toThrow('RUNTIME_PRODUCTION_CONFIG_INVALID');
  key.value = 'platform-key';
});

it('admission reads the production profiles without a window or calendar expiry', async () => {
  const f = fixture();
  const policy = await load(f);
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const result = await readPaygProductionPolicies(f.admin, policy, policy.callPolicies,
    [{ modelId: MODELS[0].id, phase: 'ordinary', outputLimit: 8192, requestFormat: 'serial-tools-v2' },
      { modelId: MODELS[1].id, phase: 'organizer', outputLimit: 8192, requestFormat: 'serial-tools-v2' }], env, deadline);
  expect(result.map(p => p.payg)).toEqual(policy.callPolicies.map(() => expect.objectContaining({
    version: 'production-host-v1', policyId: 'prod-2026-10-17', expiresAt: deadline })));
  (f.settings[0].value as Row).enabled = false;
  await expect(readPaygProductionPolicies(f.admin, policy, policy.callPolicies,
    [{ modelId: MODELS[0].id, phase: 'ordinary', outputLimit: 8192, requestFormat: 'serial-tools-v2' }], env, deadline))
    .rejects.toThrow('RUNTIME_PRODUCTION_DISABLED');
});

it('admission refuses an uncovered purpose and a changed policy version', async () => {
  const f = fixture();
  const policy = await load(f);
  const deadline = new Date(Date.now() + 3600000).toISOString();
  await expect(readPaygProductionPolicies(f.admin, policy, policy.callPolicies.slice(0, 1),
    [{ modelId: MODELS[0].id, phase: 'report', outputLimit: 8192, requestFormat: 'serial-tools-v2' }], env, deadline))
    .rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
  (f.settings[0].value as Row).policyVersion = 'prod-2026-10-18';
  await expect(readPaygProductionPolicies(f.admin, policy, policy.callPolicies.slice(0, 1),
    [{ modelId: MODELS[0].id, phase: 'ordinary', outputLimit: 8192, requestFormat: 'serial-tools-v2' }], env, deadline))
    .rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});

it('the shared host entry points choose production only on the production deployment', async () => {
  const { loadStagingPolicy, assertStagingReadAccess, loadStagingRecoveryPolicy } = await import('./stagingPolicy');
  const f = fixture();
  expect((await loadStagingPolicy(f.admin as never, actor, env)).mode).toBe('production');
  expect(f.rpc.mock.calls.map(c => c[0])).toEqual(['runtime_production_access']);
  await assertStagingReadAccess(f.admin as never, actor, { ...env, V3_RUNTIME_PRODUCTION_ENABLED: 'false' });
  expect(f.rpc.mock.calls.at(-1)![0]).toBe('runtime_production_access');
  const frozen = (await loadProductionPolicy(f.admin, actor, env));
  f.rpc.mockResolvedValueOnce({ data: { ...frozen, expiresAt: frozen.expiresAt }, error: null });
  const execution = '40000000-0000-4000-8000-000000000004';
  const recovered = await loadStagingRecoveryPolicy(f.admin as never, actor, execution, { ...env, V3_RUNTIME_PRODUCTION_ENABLED: 'false' });
  expect(f.rpc).toHaveBeenLastCalledWith('runtime_production_recovery_policy', { p_actor_id: actor, p_execution_id: execution });
  expect(recovered).toMatchObject({ mode: 'production', id: 'prod-2026-10-17' });
  // A recovered policy that is not production is refused on the production host (no window crosses over).
  f.rpc.mockResolvedValueOnce({ data: { ...frozen, mode: undefined, id: MODELS[0].id }, error: null });
  await expect(loadStagingRecoveryPolicy(f.admin as never, actor, execution, env)).rejects.toThrow('RUNTIME_PRODUCTION_TARGET_DENIED');
});

it('the staging deployment never reads production state', async () => {
  const { loadStagingPolicy } = await import('./stagingPolicy');
  const f = fixture();
  await expect(loadStagingPolicy(f.admin as never, actor, {})).rejects.toThrow('RUNTIME_STAGING_NOT_CONFIGURED');
  expect(f.rpc).not.toHaveBeenCalled();
});

it('a route outside the admitted request-shape list is never offered or frozen, even with schema-valid evidence', async () => {
  const f = fixture();
  ((f.settings[0].value as Row).profiles as Row[])[1]!.endpointTag = 'azure';
  f.models[1].config = pricingConfig(MODELS[1].model, 'azure', '0.000003', '0.000015');
  const policy = await load(f);
  expect(policy.callPolicies.map(c => c.modelId)).toEqual([MODELS[0].id]);
  const forged = { ...policy.callPolicies[0]!, modelId: MODELS[1].id, model: MODELS[1].model,
    providerLimits: { ...policy.callPolicies[0]!.providerLimits!, providerSlug: 'azure' } };
  await expect(readPaygProductionPolicies(f.admin, policy, [forged],
    [{ modelId: MODELS[1].id, phase: 'ordinary', outputLimit: 8192, requestFormat: 'serial-tools-v2' }], env,
    new Date(Date.now() + 3600000).toISOString())).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});

it('offline loading (admin settings pages) never renews a stale price snapshot over the network', async () => {
  const f = fixture();
  const stale = pricingConfig(MODELS[1].model, MODELS[1].tag, '0.000003', '0.000015');
  stale.pricing.fetchedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  f.models[1].config = stale;
  const read = vi.fn(async () => { throw new Error('network'); });
  const policy = await loadProductionPolicy(f.admin, actor, env, { read }, { offline: true });
  expect(read).not.toHaveBeenCalled();
  expect(policy.callPolicies.map(c => c.modelId)).toEqual([MODELS[0].id]);
});

it('DB-RW PR-B: with the catalog cache on, a later request reloads the policy with only the per-request reads', async () => {
  const f = fixture(), versions = { enabled: true, settings: 1, models: 1, skills: 1 };
  f.rpc.mockImplementation(async (name: string) => ({ data: name === 'catalog_versions_snapshot' ? { ...versions } : true, error: null }));
  const from = (f.admin.from as unknown as ReturnType<typeof vi.fn>);
  const reads = () => from.mock.calls.map(([table]) => table as string);
  const names = () => f.rpc.mock.calls.map(([name]) => name);
  clearCatalogCache();
  try {
    const first = await withCatalogRequest(() => load(f));
    // Cold: the settings (PAYG profiles, q and m), the model rows, each model's pricing row and the multipliers. q and m are
    // read twice by the code; the second read is already served from this request's cache.
    expect(reads()).toEqual(['system_settings', 'system_settings', 'ai_models', 'ai_models', 'ai_models', 'ai_models']);
    from.mockClear(); f.rpc.mockClear();
    // Warm: no catalog read at all. The actor's access decision is still made for this request, and the key is read fresh.
    expect(await withCatalogRequest(() => load(f))).toEqual({ ...first, expiresAt: expect.any(String) });
    expect(reads()).toEqual([]);
    expect(names().toSorted()).toEqual(['catalog_versions_snapshot', 'runtime_production_access']);
    // A model change (the price refresh writes the model row too) makes the next request read the model rows again.
    versions.models = 2;
    from.mockClear();
    await withCatalogRequest(() => load(f));
    expect(reads()).toEqual(['ai_models', 'ai_models', 'ai_models', 'ai_models']);
  } finally { clearCatalogCache(); }
});
