/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { modelRouter } from './model';
import { aiRouter } from './ai';
import { settingsRouter } from './settings';
import { DiagnosticsService } from '../services/diagnostics';
import { getAvailableModels, selectModel } from '../services/modelRouter';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(role: 'admin' | 'user' = 'admin') {
  const secret = randomUUID() + randomUUID();
  const row = { id, name: 'Synthetic model', model_id: 'synthetic/model', provider: 'openai',
    api_key: secret, api_endpoint: '', config: {}, is_active: 'true', max_tokens: 1024,
    input_limit: 8192, input_token_cost: 1000000, output_token_cost: 1000000 };
  const calls: { admin: boolean; columns: string }[] = [];
  function client(admin: boolean) {
    return { from(table: string) {
      let single = false;
      let columns = '*';
      const builder: any = {
        select(value = '*') {
          columns = value;
          if (table === 'ai_models') calls.push({ admin, columns });
          return builder;
        },
        eq: () => builder, in: () => builder, order: () => builder, limit: () => builder,
        insert: () => builder, update: () => builder, not: () => builder,
        single() { single = true; return builder; },
        maybeSingle() { single = true; return builder; },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          if (table === 'profiles') return Promise.resolve({ data: {
            id, role, status: 'active', is_deleted: 'false', credits: 1000,
          }, error: null }).then(resolve, reject);
          if (table === 'system_settings') return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          if (table === 'diagnostic_results') return Promise.resolve({ error: null }).then(resolve, reject);
          if (table !== 'ai_models') throw new Error('Unexpected table: ' + table);
          if (!admin && (columns === '*' || columns.split(',').map(s => s.trim()).includes('api_key'))) {
            return Promise.resolve({ data: null, error: { code: '42501' } }).then(resolve, reject);
          }
          const data = columns === '*' ? row : Object.fromEntries(columns.split(',').map(s => s.trim())
            .map(key => [key, row[key as keyof typeof row]]));
          return Promise.resolve({ data: single ? data : [data], error: null }).then(resolve, reject);
        },
      };
      return builder;
    } };
  }
  const user = client(false), admin = client(true);
  const context: any = { headers: new Headers(), user: { id, app_metadata: { provider: 'email' } },
    isEmailVerified: true, authProvider: 'email', supabase: user, supabaseAuth: user,
    supabasePublic: user, supabaseAdmin: admin, hasSupabaseAdminPrivileges: true };
  function noSecret(value: unknown) {
    const json = JSON.stringify(value);
    expect(json).not.toContain('api_key');
    expect(json).not.toContain(secret.slice(0, 20));
    expect(json).not.toContain(secret.slice(-20));
  }
  return { context, user, admin, row, secret, calls, noSecret };
}

describe('B01 model credential boundary', () => {
  it('user routing, preferred-model selection, catalog and cost estimation survive column denial', async () => {
    const f = fixture('user');
    const models = await getAvailableModels(f.user as any);
    expect(models[0].id).toBe(id);
    expect(models[0].apiKey).toBeNull();
    const selected = await selectModel({ supabase: f.user as any, userPreferredModel: id,
      message: 'hello', conversationTurns: 0 });
    expect(selected.modelConfig.id).toBe(id);
    const caller = aiRouter.createCaller(f.context);
    f.noSecret(await caller.getAvailableModels());
    const estimate = await caller.estimateCost({ message: 'hello', modelId: id });
    expect(estimate.modelId).toBe(f.row.model_id);
    f.noSecret(estimate);
    const active = await modelRouter.createCaller(f.context).getActiveModels();
    expect(active?.[0].id).toBe(id);
    expect(f.calls.length).toBeGreaterThan(3);
    expect(f.calls.every(call => !call.admin && call.columns !== '*' && !call.columns.includes('api_key'))).toBe(true);
  });

  it('admin lists and eligibility use service role, returning metadata or booleans only', async () => {
    const f = fixture();
    const caller = modelRouter.createCaller(f.context);
    for (const result of [await caller.getAvailableModels(), await caller.getAdminModelsDashboard(),
      await caller.getConnectionStatus(), await settingsRouter.createCaller(f.context).getSummaryModels()]) f.noSecret(result);
    expect((await caller.getConnectionStatus())[0].hasApiKey).toBe(true);
    expect((await settingsRouter.createCaller(f.context).getSummaryModels())[0].available).toBe(true);
    expect(f.calls.every(call => call.admin)).toBe(true);
  });

  it('create, update and legacy config responses omit credentials, including failed provider checks', async () => {
    const f = fixture();
    const caller = modelRouter.createCaller(f.context);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(f.secret, { status: 401 }));
    try {
      for (const result of [
        await caller.createModel({ name: f.row.name, modelId: f.row.model_id, provider: 'openai', apiKey: f.secret }),
        await caller.updateModel({ id, name: f.row.name, apiKey: f.secret }),
        await caller.updateModelConfig({ id, config: {} }),
        await caller.testConnection({ id }),
      ]) f.noSecret(result);
      expect(f.calls.every(call => call.admin)).toBe(true);
    } finally { fetchMock.mockRestore(); }
  });

  it('diagnostic model status reads credentials only through service role', async () => {
    const f = fixture();
    const service = new DiagnosticsService({ supabase: f.user as any, supabaseAdmin: f.admin as any, userId: id });
    const result = (await service.runCategoryTests('ai')).results.find(row => row.testId === 'ai_model_status');
    expect(result?.status).toBe('passed');
    f.noSecret(result);
    expect(f.calls.filter(call => call.columns.includes('api_key'))).toEqual([
      { admin: true, columns: 'id, name, model_id, provider, is_active, api_key, config' },
    ]);
  });

  it('non-admin users cannot call credential-bearing administration paths', async () => {
    const f = fixture('user');
    await expect(modelRouter.createCaller(f.context).getAvailableModels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(settingsRouter.createCaller(f.context).getSummaryModels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.calls).toEqual([]);
  });
});
