/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelReasoningRouter } from './modelReasoning';

const modelId = '11111111-1111-4111-8111-111111111111';
const catalog = {
  fetchedAt: '2026-09-29T00:00:00.000Z', model: 'deepseek/deepseek-v4.1-flash',
  reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'high', supportsMaxTokens: false },
  endpoints: [{ tag: 'deepinfra', providerName: 'DeepInfra', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1000000, maxCompletionTokens: 64000 }],
};

function harness(role: 'admin' | 'user', config: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  let stored = config;
  // Each stored change gets a new updated_at; writes are conditional on the version read.
  let version = 1, model = 'deepseek/deepseek-v4.1-flash', bumpBeforeWrite = false;
  const stamp = () => `2026-10-02T00:00:0${version}.000Z`;
  const tables: string[] = [];
  const db = {
    from(table: string) {
      tables.push(table);
      if (table === 'profiles') return { select() { return this; }, eq() { return this; },
        single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'Admin', email: 'admin@example.test' }, error: null }) };
      if (table !== 'ai_models') throw new Error('unexpected table ' + table);
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: { id: modelId, name: 'DeepSeek', model_id: model, max_tokens: 8192, input_limit: 100000,
          provider: 'openai', is_active: 'true', api_key: 'SECRET_CANARY', api_endpoint: '', config: stored, updated_at: stamp() }, error: null }),
        update(payload: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const write = {
            eq(column: string, value: unknown) { filters[column] = value; return write; },
            select: async () => {
              // Simulates another writer committing between this read and this write.
              if (bumpBeforeWrite) version += 1;
              if (filters.updated_at !== stamp()) return { data: [], error: null };
              updates.push(payload); stored = payload.config as Record<string, unknown>; version += 1;
              return { data: [{ id: modelId }], error: null };
            },
          };
          return write;
        },
      };
    },
  };
  const caller = modelReasoningRouter.createCaller({
    headers: new Headers(), user: { id: 'actor', email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true,
  } as never);
  return { caller, updates, tables, set: (value: Record<string, unknown>) => { stored = value; version += 1; },
    setModel: (value: string) => { model = value; }, bumpOnWrite: () => { bumpBeforeWrite = true; } };
}
const deepseekOff = { interactive: { mode: 'off', wire: 'reasoning_effort' } } as const;

describe('modelReasoning router', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('is administrator only', async () => {
    const t = harness('user', null);
    await expect(t.caller.get({ modelId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.caller.refreshCatalog({ modelId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.caller.save({ modelId, route: 'deepinfra', purposes: deepseekOff })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(t.tables).not.toContain('ai_models');expect(t.updates).toEqual([]);
  });

  it('saves a checked setting and keeps every other config key', async () => {
    const t = harness('admin', { connection_status: 'connected', reasoning: { catalog, route: null, purposes: {} } });
    const result = await t.caller.save({ modelId, route: 'deepinfra', purposes: deepseekOff });
    expect(result.issues).toEqual([]);
    expect(t.updates[0]).not.toHaveProperty('max_tokens');
    expect(t.updates[0]).not.toHaveProperty('input_limit');
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]!.config).toEqual({ connection_status: 'connected', reasoning: { catalog, route: 'deepinfra', purposes: deepseekOff } });
  });

  it('refuses a setting that fails the checks without writing', async () => {
    const t = harness('admin', { reasoning: { catalog, route: null, purposes: {} } });
    await expect(t.caller.save({ modelId, route: 'deepinfra', purposes: { interactive: { mode: 'effort', effort: 'medium', wire: 'reasoning_effort' } } }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('medium') });
    await expect(t.caller.save({ modelId, route: 'deepinfra', purposes: { interactive: { mode: 'budget', maxTokens: 100 }, bogus: {} } as never }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(t.updates).toEqual([]);
  });

  it('refreshes the catalog snapshot, keeping route, purposes and other keys', async () => {
    const list = { data: [{ id: 'deepseek/deepseek-v4.1-flash', reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['low'] } }] };
    const endpoints = { data: { id: 'deepseek/deepseek-v4.1-flash', endpoints: [{ tag: 'deepinfra', provider_name: 'DeepInfra', supported_parameters: ['tools'] }] } };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/endpoints') ? endpoints : list)));
    vi.stubGlobal('fetch', fetchMock);
    const t = harness('admin', { last_error: null, reasoning: { catalog: null, route: 'deepinfra', purposes: deepseekOff } });
    const result = await t.caller.refreshCatalog({ modelId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.config.catalog?.reasoning?.supportedEfforts).toEqual(['low']);
    expect(t.updates[0]!.config).toMatchObject({ last_error: null, reasoning: { route: 'deepinfra', purposes: deepseekOff } });
    expect(t.updates[0]).not.toHaveProperty('input_limit');
    expect(t.updates[0]).not.toHaveProperty('max_tokens');
    expect(result.capacity.maxTokens).toEqual({ supplier: null, current: 8192, matches: null });
  });

  it('updates supplier capacities only on explicit refresh and returns before/after comparisons', async () => {
    const t = harness('admin', { reasoning: { catalog, route: 'deepinfra', purposes: deepseekOff } });
    const before = await t.caller.get({ modelId });
    expect(before.capacity.inputLimit.matches).toBe(false);
    expect(t.updates).toEqual([]);
    const list = { data: [{ id: catalog.model }] };
    const endpoints = { data: { id: catalog.model, endpoints: [{ tag: 'deepinfra', provider_name: 'DeepInfra',
      context_length: 1000000, max_completion_tokens: 128000 }] } };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).endsWith('/endpoints') ? endpoints : list))));
    const result = await t.caller.refreshCatalog({ modelId });
    expect(t.updates[0]).toMatchObject({ input_limit: 1000000, max_tokens: 128000 });
    expect(result.capacity.maxTokens).toEqual({ supplier: 128000, current: 128000, matches: true });
    expect(result.previousCapacity.maxTokens).toEqual({ supplier: 128000, current: 8192, matches: false });
  });

  it('reports a catalog failure plainly and keeps the stored snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const t = harness('admin', { reasoning: { catalog, route: 'deepinfra', purposes: deepseekOff } });
    await expect(t.caller.refreshCatalog({ modelId })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '暂时无法读取 OpenRouter 目录，请稍后重试' });
    expect(t.updates).toEqual([]);
  });

  it('keeps a save made while the catalog read is in flight (Codex P2 on 88398c40)', async () => {
    const t = harness('admin', { reasoning: { catalog: null, route: null, purposes: {} } });
    const list = { data: [{ id: 'deepseek/deepseek-v4.1-flash', reasoning: { mandatory: false, supported_efforts: ['low'] } }] };
    const endpoints = { data: { id: 'deepseek/deepseek-v4.1-flash', endpoints: [{ tag: 'deepinfra/fp8', provider_name: 'DeepInfra', supported_parameters: ['tools'] }] } };
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      // Another request saves a route and purposes before the catalog arrives.
      t.set({ connection_status: 'connected', reasoning: { catalog, route: 'deepinfra', purposes: deepseekOff } });
      return new Response(JSON.stringify(String(url).endsWith('/endpoints') ? endpoints : list));
    }));
    await t.caller.refreshCatalog({ modelId });
    expect(t.updates[0]!.config).toMatchObject({ connection_status: 'connected', reasoning: { route: 'deepinfra', purposes: deepseekOff } });
  });

  it('stores the price snapshot with the catalog and reports field changes on the next read', async () => {
    const list = { data: [{ id: 'openai/gpt-6-luna' }] };
    let prompt = '0.0000001';
    const endpoints = () => ({ data: { id: 'openai/gpt-6-luna', endpoints: [{ tag: 'openai', provider_name: 'OpenAI', supported_parameters: ['tools'],
      context_length: 1050000, pricing: { prompt, completion: '0.0000005', input_cache_write: '0.000000125', discount: 0,
        overrides: [{ min_prompt_tokens: 272000, prompt: '0.0000002', completion: '0.00000075' }] } }] } });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/endpoints') ? endpoints() : list))));
    const t = harness('admin', { connection_status: 'connected', reasoning: { catalog: null, route: 'openai', purposes: {} } });
    t.setModel('openai/gpt-6-luna');
    const first = await t.caller.refreshCatalog({ modelId });
    expect(first.pricing).toMatchObject({ model: 'openai/gpt-6-luna', source: 'openrouter:/api/v1/models/openai/gpt-6-luna/endpoints',
      endpoints: [{ tag: 'openai', admissible: true, base: { prompt: '0.1', completion: '0.5', input_cache_write: '0.125' },
        overrides: [{ when: { minPromptTokens: 272000 }, prices: { prompt: '0.2', completion: '0.75' } }] }] });
    expect(first.priceChanges).toEqual([]);
    expect(t.updates[0]!.config).toMatchObject({ connection_status: 'connected', reasoning: { route: 'openai' }, pricing: { pricingHash: first.pricing!.pricingHash } });
    prompt = '0.00000011';
    const second = await t.caller.refreshCatalog({ modelId });
    expect(second.priceChanges).toEqual([{ tag: 'openai', change: 'changed', field: 'prompt', before: '0.1', after: '0.11' }]);
    expect(second.pricing!.pricingHash).not.toBe(first.pricing!.pricingHash);
  });

  it('stores nothing when the model ID changes while the catalog is read', async () => {
    const t = harness('admin', { reasoning: { catalog: null, route: null, purposes: {} } });
    const list = { data: [{ id: 'deepseek/deepseek-v4.1-flash' }] };
    const endpoints = { data: { id: 'deepseek/deepseek-v4.1-flash', endpoints: [{ tag: 'deepinfra', provider_name: 'DeepInfra' }] } };
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      t.setModel('deepseek/deepseek-v4.2-flash');
      return new Response(JSON.stringify(String(url).endsWith('/endpoints') ? endpoints : list));
    }));
    await expect(t.caller.refreshCatalog({ modelId })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.updates).toEqual([]);
  });

  it('refuses to overwrite a config changed between its read and its write', async () => {
    const t = harness('admin', { reasoning: { catalog, route: null, purposes: {} } });
    t.bumpOnWrite();
    await expect(t.caller.save({ modelId, route: 'deepinfra', purposes: deepseekOff })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.updates).toEqual([]);
  });

  it('tries once per model within the interval, admin only, and a refusal does not use the slot', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100000);
    const stored = { reasoning: { catalog: { ...catalog, endpoints: [{ ...catalog.endpoints[0]!, tag: 'deepinfra/fp8' }] }, route: 'deepinfra/fp8', purposes: deepseekOff } };
    const sse = 'data: ' + JSON.stringify({ id: 'g', model: 'deepseek/deepseek-v4.1-flash', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: 'stop' }] }) + '\n\n' +
      'data: ' + JSON.stringify({ id: 'g', model: 'deepseek/deepseek-v4.1-flash', choices: [], usage: { completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n';
    const fetchMock = vi.fn(async () => new Response(sse));
    vi.stubGlobal('fetch', fetchMock);
    await expect(harness('user', stored).caller.tryOnce({ modelId, purpose: 'interactive' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const t = harness('admin', stored);
    // An unset review purpose is refused before any call and leaves the slot free.
    await expect(t.caller.tryOnce({ modelId, purpose: 'review' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await t.caller.tryOnce({ modelId, purpose: 'interactive' });
    expect(result).toMatchObject({ ok: true, hasText: true });
    expect(JSON.stringify(result)).not.toMatch(/你好|SECRET_CANARY/);
    await expect(t.caller.tryOnce({ modelId, purpose: 'organize' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.updates).toEqual([]);
    now.mockReturnValue(130000);
    await expect(t.caller.tryOnce({ modelId, purpose: 'organize' })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

