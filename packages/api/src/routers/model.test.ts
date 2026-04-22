import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelRouter } from './model';

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
  };
}

function createProtectedCaller(options: {
  role?: 'user' | 'admin';
  supabase: {
    from(table: string): unknown;
  };
  supabaseAdmin?: {
    from(table: string): unknown;
  };
}) {
  const role = options.role ?? 'user';

  return modelRouter.createCaller({
    headers: new Headers(),
    user: {
      id: role === 'admin' ? 'admin-user' : 'user-1',
      email: role === 'admin' ? 'admin@example.com' : 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: options.supabase,
    supabaseAuth: options.supabase,
    supabasePublic: {},
    supabaseAdmin: options.supabaseAdmin ?? options.supabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('modelRouter error sanitization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizes active model query failures for end users', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'ai_models') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            order() {
              return Promise.resolve({
                data: null,
                error: { message: 'permission denied for table ai_models' },
              });
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase });

    await expect(caller.getActiveModels()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取可用模型失败，请稍后重试',
    });
  });

  it('sanitizes createModel insert failures', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'admin-user',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'ai_models') {
          return {
            insert() {
              return {
                select() {
                  return {
                    single() {
                      return Promise.resolve({
                        data: null,
                        error: { message: 'duplicate key value violates unique constraint' },
                      });
                    },
                  };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ role: 'admin', supabase });

    await expect(
      caller.createModel({
        name: 'OpenRouter',
        modelId: 'gpt-4o',
        provider: 'openai',
        apiKey: 'sk-or-test',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '创建模型失败，请稍后重试',
    });
  });

  it('returns a safe connection error while keeping persisted diagnostics sanitized', async () => {
    const updatePayloads: Array<Record<string, unknown>> = [];
    const createdModel = {
      id: 'model-1',
      name: 'OpenRouter',
      model_id: 'gpt-4o',
      provider: 'openai' as const,
      api_key: 'sk-or-test',
      api_endpoint: 'https://openrouter.ai/api/v1',
      config: null,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'openrouter quota exceeded' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'admin-user',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'ai_models') {
          return {
            insert() {
              return {
                select() {
                  return {
                    single() {
                      return Promise.resolve({
                        data: createdModel,
                        error: null,
                      });
                    },
                  };
                },
              };
            },
            update(payload: Record<string, unknown>) {
              updatePayloads.push(payload);
              return {
                eq() {
                  return Promise.resolve({
                    data: null,
                    error: null,
                  });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ role: 'admin', supabase });
    const result = await caller.createModel({
      name: 'OpenRouter',
      modelId: 'gpt-4o',
      provider: 'openai',
      apiKey: 'sk-or-test',
      apiEndpoint: 'https://openrouter.ai/api/v1',
    });

    expect(result.connectionCheck).toMatchObject({
      success: false,
      status: 'error',
      error: 'API 连接失败，请检查配置后重试',
    });

    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].config).toMatchObject({
      connection_status: 'error',
      last_error: 'API 连接失败，请检查配置后重试',
      last_error_detail: '连接测试失败，请查看服务端日志',
    });
  });

  it('aggregates admin models dashboard from one ai_models query', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'admin-user',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'ai_models') {
          return {
            select() {
              return this;
            },
            order() {
              return Promise.resolve({
                data: [
                  {
                    id: 'model-1',
                    name: 'Model 1',
                    api_key: 'sk-test',
                    config: { connection_status: 'connected', last_tested: '2026-03-29T00:00:00.000Z' },
                    is_active: 'true',
                  },
                  {
                    id: 'model-2',
                    name: 'Model 2',
                    api_key: null,
                    config: {},
                    is_active: 'false',
                  },
                ],
                error: null,
              });
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ role: 'admin', supabase });
    const result = await caller.getAdminModelsDashboard();

    expect(result.models).toHaveLength(2);
    expect(result.models[0]).not.toHaveProperty('api_key');
    expect(result.models[1]).not.toHaveProperty('api_key');
    expect(result.connectionStatus).toEqual([
      expect.objectContaining({
        id: 'model-1',
        hasApiKey: true,
        connectionStatus: 'connected',
      }),
      expect.objectContaining({
        id: 'model-2',
        hasApiKey: false,
        connectionStatus: 'no_key',
      }),
    ]);
  });

  it('marks testConnection as no_key and persists sanitized diagnostics when the model has no API key', async () => {
    const updatePayloads: Array<Record<string, unknown>> = [];

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'admin-user',
                role: 'admin',
                status: 'active',
                nickname: 'Admin',
                email: 'admin@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'ai_models') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            single() {
              return Promise.resolve({
                data: {
                  id: '123e4567-e89b-42d3-a456-426614174000',
                  name: 'No Key Model',
                  model_id: 'anthropic/claude-sonnet-4.6',
                  provider: 'openai',
                  api_key: null,
                  api_endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                  config: {},
                },
                error: null,
              });
            },
            update(payload: Record<string, unknown>) {
              updatePayloads.push(payload);
              return {
                eq() {
                  return Promise.resolve({
                    data: null,
                    error: null,
                  });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ role: 'admin', supabase });
    const result = await caller.testConnection({ id: '123e4567-e89b-42d3-a456-426614174000' });

    expect(result).toMatchObject({
      success: false,
      status: 'no_key',
      error: 'API 密钥未配置',
    });
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].config).toMatchObject({
      connection_status: 'no_key',
      last_error: 'API 密钥未配置',
      last_error_detail: null,
    });
  });
});
