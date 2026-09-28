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
  const tables: string[] = [];
  const db = {
    from(table: string) {
      tables.push(table);
      if (table === 'profiles') return { select() { return this; }, eq() { return this; },
        single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'Admin', email: 'admin@example.test' }, error: null }) };
      if (table !== 'ai_models') throw new Error('unexpected table ' + table);
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: { id: modelId, model_id: 'deepseek/deepseek-v4.1-flash', max_tokens: 8192, config: stored }, error: null }),
        update(payload: Record<string, unknown>) {
          updates.push(payload); stored = payload.config as Record<string, unknown>;
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  const caller = modelReasoningRouter.createCaller({
    headers: new Headers(), user: { id: 'actor', email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true,
  } as never);
  return { caller, updates, tables };
}
const deepseekOff = { interactive: { mode: 'off', wire: 'reasoning_effort' } } as const;

describe('modelReasoning router', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is administrator only', async () => {
    const t = harness('user', null);
    await expect(t.caller.get({ modelId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.caller.save({ modelId, route: 'deepinfra', purposes: deepseekOff })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(t.tables).not.toContain('ai_models');expect(t.updates).toEqual([]);
  });

  it('saves a checked setting and keeps every other config key', async () => {
    const t = harness('admin', { connection_status: 'connected', reasoning: { catalog, route: null, purposes: {} } });
    const result = await t.caller.save({ modelId, route: 'deepinfra', purposes: deepseekOff });
    expect(result.issues).toEqual([]);
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
  });

  it('reports a catalog failure plainly and keeps the stored snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const t = harness('admin', { reasoning: { catalog, route: 'deepinfra', purposes: deepseekOff } });
    await expect(t.caller.refreshCatalog({ modelId })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '暂时无法读取 OpenRouter 目录，请稍后重试' });
    expect(t.updates).toEqual([]);
  });
});
