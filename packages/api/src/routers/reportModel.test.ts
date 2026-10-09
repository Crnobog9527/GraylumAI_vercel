/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { reportModelRouter } from './reportModel';
import { pricingConfig } from '../services/__tests__/fixtures/runtimePricing';
const mocks = vi.hoisted(() => ({ host: vi.fn(), pricing: vi.fn(), unit: vi.fn(), reasoning: vi.fn() }));
vi.mock('../services/runtime/stagingEnvironment', () => ({ stagingRuntimeWindow: () => id(8) }));
vi.mock('../services/runtime/stagingPolicy', () => ({ parseStagingPolicy: (value: unknown) => value }));
vi.mock('../services/runtime/paygHostPolicy', async original => ({
  ...await original<typeof import('../services/runtime/paygHostPolicy')>(), readPaygHostPolicies: mocks.host,
}));
vi.mock('../services/runtime/paygPricing', () => ({ freezeStagingPaygPricing: mocks.pricing }));
vi.mock('../services/runtime/billingUnitAdmission', () => ({ freezeWindowBillingUnit: mocks.unit }));
vi.mock('../services/runtime/reasoningAdmission', () => ({ admitReasoning: mocks.reasoning }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.host.mockImplementation(async (_db, _window, quotes) => quotes.map((q: object) => ({ ...q, payg: {} })));
  mocks.pricing.mockResolvedValue([]); mocks.unit.mockResolvedValue({}); mocks.reasoning.mockReturnValue({ parameter: 'none' });
});
function fixture(role = 'admin') {
  const model = { id: id(3), name: 'Synthetic report', model_id: 'anthropic/claude-sonnet-5.5',
    provider: 'openrouter', is_active: 'true', input_limit: 250000, max_tokens: 32768,
    config: pricingConfig('anthropic/claude-sonnet-5.5', 'anthropic', '1', '1') };
  const module = { id: id(2), model_id: id(4), report_model_id: null as string | null };
  const quote = { modelId: model.id, model: model.model_id, inputLimit: 196608, outputLimit: 32768, multiplier: '6',
    providerLimits: { providerSlug: 'anthropic', contextTokens: 250000 } };
  const window = { id: id(8), expiresAt: '2099-01-01T00:00:00Z', creditsPerUsd: '100', callPolicies: [quote] };
  const settings = new Map<string, unknown>([['billing_payg_start_thresholds',
    { version: 'test', thresholds: [{ model: model.model_id, purpose: 'report', credits: 1 }] }]]);
  const writes: unknown[] = [];
  let conflict = false;
  const db = { rpc: vi.fn(async () => ({ data: window, error: null })), from(table: string) {
    let key = '', patch: Record<string, unknown> | undefined, expected: unknown = undefined;
    const q = {
      select() { return q; },
      eq(field: string, value: string) { if (field === 'key') key = value; if (field === 'report_model_id') expected = value; return q; },
      is(_field: string, value: null) { expected = value; return q; },
      update(value: Record<string, unknown>) { patch = value; return q; },
      in() { return Promise.resolve({ data: [model], error: null }); },
      async maybeSingle() { return { data: table === 'modules' ? { ...module } : table === 'ai_models' ? model
        : settings.has(key) ? { value: settings.get(key) } : null, error: null }; },
      async single() { return { data: { id: id(1), role, status: 'active', credits: 0 }, error: null }; },
      then(resolve: (v: unknown) => unknown) {
        if (!patch) throw new Error('Unexpected query');
        if (conflict || expected !== module.report_model_id) return Promise.resolve(resolve({ data: [], error: null }));
        writes.push(patch); module.report_model_id = patch.report_model_id as string | null;
        return Promise.resolve(resolve({ data: [{ id: module.id }], error: null }));
      },
    }; return q;
  } };
  const caller = reportModelRouter.createCaller({ headers: new Headers(),
    user: role === 'anonymous' ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  const update = () => caller.update({ moduleId: module.id, reportModelId: model.id, expectedReportModelId: null });
  return { caller, module, model, window, settings, db, writes, update, conflict: () => { conflict = true; } };
}
it('admin reads default, lists ready report models, sets one and clears to dialogue model', async () => {
  const f = fixture();
  expect(await f.caller.get({ moduleId: f.module.id })).toMatchObject({ reportModelId: null, effectiveModelId: id(4) });
  expect(await f.caller.options()).toEqual({ models: [{ id: f.model.id, name: f.model.name, model: f.model.model_id }] });
  expect(await f.update()).toMatchObject({ reportModelId: f.model.id, effectiveModelId: f.model.id });
  expect(mocks.host.mock.calls[0][3]).toEqual([{ modelId: f.model.id, phase: 'report', outputLimit: 32768,
    reasoning: { parameter: 'none' }, requestFormat: 'agent-turn-v5-stream' }]);
  expect(await f.caller.update({ moduleId: f.module.id, reportModelId: null, expectedReportModelId: f.model.id }))
    .toMatchObject({ reportModelId: null, effectiveModelId: id(4) });
  expect(f.writes).toHaveLength(2);
});
it.each(['user', 'anonymous'])('%s cannot read, list or modify report models', async role => {
  const f = fixture(role);
  for (const call of [() => f.caller.get({ moduleId: f.module.id }), () => f.caller.options(), f.update])
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  expect(f.writes).toEqual([]); expect(f.db.rpc).not.toHaveBeenCalled();
});
it.each(['inactive', 'quote', 'profile', 'price', 'threshold', 'reasoning'])(
  'unavailable %s is absent from options and rejected without writing', async condition => {
    const f = fixture();
    if (condition === 'inactive') f.model.is_active = 'false';
    if (condition === 'quote') f.window.callPolicies = [];
    if (condition === 'profile') mocks.host.mockResolvedValue(undefined);
    if (condition === 'price') f.model.config = {} as typeof f.model.config;
    if (condition === 'threshold') f.settings.clear();
    if (condition === 'reasoning') mocks.reasoning.mockImplementation(() => { throw new Error('RUNTIME_REASONING_NOT_CONFIGURED'); });
    expect(await f.caller.options()).toEqual({ models: [] });
    await expect(f.update()).rejects.toMatchObject({ message: condition === 'inactive' ? 'REPORT_MODEL_UNAVAILABLE'
      : condition === 'price' ? 'REPORT_MODEL_PRICING_UNAVAILABLE' : 'REPORT_MODEL_ADMISSION_REQUIRED' });
    expect(f.writes).toEqual([]);
  });
it('compare-and-swap rejects stale administrator writes', async () => {
  const f = fixture(); f.conflict();
  await expect(f.update()).rejects.toMatchObject({ code: 'CONFLICT', message: 'REPORT_MODEL_CONFLICT' });
  expect(f.writes).toEqual([]);
});
it('clearing a stale setting does not require a working window or current quote', async () => {
  const f = fixture(); f.module.report_model_id = f.model.id;
  f.db.rpc.mockRejectedValue(new Error('unavailable'));
  expect(await f.caller.update({ moduleId: f.module.id, reportModelId: null, expectedReportModelId: f.model.id }))
    .toMatchObject({ reportModelId: null, effectiveModelId: id(4) });
  expect(f.db.rpc).not.toHaveBeenCalled();
});

it.each(['valid', 'overflow', 'both'])('typical USD threshold validation: %s', async condition => {
  const f = fixture();
  f.settings.set('billing_payg_start_thresholds', { version: 'test', thresholds: [{ model: f.model.model_id,
    purpose: 'report', typicalUsd: condition === 'overflow' ? '999999999999' : '0.01',
    ...(condition === 'both' ? { credits: 1 } : {}) }] });
  if (condition === 'valid') expect(await f.update()).toMatchObject({ reportModelId: f.model.id });
  else {
    await expect(f.update()).rejects.toThrow('REPORT_MODEL_ADMISSION_REQUIRED');
    expect(f.writes).toEqual([]);
  }
});
