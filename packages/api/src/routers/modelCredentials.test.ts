/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelRouter } from './model';
import { settingsRouter } from './settings';
import { DiagnosticsService } from '../services/diagnostics';
import { resetPlatformSecretCacheForTests } from '../services/platformSecrets/reader';

beforeEach(() => resetPlatformSecretCacheForTests());

const id = '11111111-1111-4111-8111-111111111111';
const legacyModelKey = 'synthetic-legacy-model-column-key';
function fixture(role: 'admin' | 'user' = 'admin') {
  const secret = randomUUID() + randomUUID();
  const row = { id, name: 'Synthetic model', model_id: 'synthetic/model', provider: 'openai',
    api_endpoint: '', config: {}, is_active: 'true', max_tokens: 1024,
    input_limit: 8192, input_token_cost: 1000000, output_token_cost: 1000000, api_key: legacyModelKey };
  const calls: { admin: boolean; columns: string }[] = [];
  const secretReads: boolean[] = [];
  function client(admin: boolean) {
    // ADMIN-SECRETS OR-1: the OpenRouter key comes only from platform_secret_read, which only service role may call.
    const rpc = (name: string) => ({ abortSignal: async () => {
      if (name !== 'platform_secret_read') throw new Error('Unexpected rpc: ' + name);
      secretReads.push(admin);
      return admin ? { data: secret, error: null } : { data: null, error: { code: '42501' } };
    } });
    return { rpc, from(table: string) {
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
          if (!admin && columns === '*') {
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
    expect(json).not.toContain(secret.slice(0, 20));
    expect(json).not.toContain(secret.slice(-20));
    expect(json).not.toContain(legacyModelKey);
  }
  return { context, user, admin, row, secret, calls, secretReads, noSecret };
}

describe('B01 model credential boundary', () => {
  it('users cannot read the administrator model catalog', async () => {
    const f = fixture('user');
    // MODEL-IDENTITY-GUARD: name-bearing model procedures are administrator-only.
    await expect(modelRouter.createCaller(f.context).getActiveModels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.calls.every(call => !call.admin && call.columns !== '*')).toBe(true);
    expect(f.secretReads).toEqual([]);
  });

  it('admin lists and eligibility use service role, returning metadata or booleans only', async () => {
    const f = fixture();
    const caller = modelRouter.createCaller(f.context);
    for (const result of [await caller.getAvailableModels(), await caller.getAdminModelsDashboard(),
      await caller.getConnectionStatus(), await settingsRouter.createCaller(f.context).getSummaryModels()]) f.noSecret(result);
    expect((await caller.getConnectionStatus())[0].hasApiKey).toBe(true);
    expect((await settingsRouter.createCaller(f.context).getSummaryModels())[0].available).toBe(true);
    expect(f.calls.every(call => call.admin)).toBe(true);
    expect(f.secretReads.every(Boolean)).toBe(true);
  });

  it('create, update and legacy config responses omit Vault and pre-OR-2 model credentials', async () => {
    const f = fixture();
    const caller = modelRouter.createCaller(f.context);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(f.secret, { status: 401 }));
    try {
      for (const result of [
        await caller.createModel({ name: f.row.name, modelId: f.row.model_id, provider: 'openai' }),
        await caller.updateModel({ id, name: f.row.name, modelId: f.row.model_id }),
        await caller.updateModelConfig({ id, config: {} }),
        await caller.testConnection({ id }),
      ]) f.noSecret(result);
      expect(f.calls.every(call => call.admin)).toBe(true);
      expect(f.secretReads.every(Boolean)).toBe(true);
    } finally { fetchMock.mockRestore(); }
  });

  it('diagnostic model status reads the platform key only through service role', async () => {
    const f = fixture();
    const service = new DiagnosticsService({ supabase: f.user as any, supabaseAdmin: f.admin as any, userId: id });
    const result = (await service.runCategoryTests('ai')).results.find(row => row.testId === 'ai_model_status');
    expect(result?.status).toBe('passed');
    f.noSecret(result);
    expect(f.secretReads).toEqual([true]);
  });

  it('non-admin users cannot call credential-bearing administration paths', async () => {
    const f = fixture('user');
    await expect(modelRouter.createCaller(f.context).getAvailableModels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(settingsRouter.createCaller(f.context).getSummaryModels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.calls).toEqual([]);
    expect(f.secretReads).toEqual([]);
  });
});
