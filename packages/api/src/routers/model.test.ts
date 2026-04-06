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

function createAdminCaller(supabase: { from(table: string): unknown }) {
  return modelRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin: supabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('modelRouter admin model redaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not expose api_key values in admin model payloads', async () => {
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
                    model_id: 'gpt-4o',
                    provider: 'openai',
                    api_key: 'sk-test',
                    api_endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    description: '',
                    max_tokens: 4096,
                    input_limit: 180000,
                    enable_web_search: 'false',
                    input_token_cost: 100,
                    output_token_cost: 400,
                    input_token_cost_above_200k: 100,
                    output_token_cost_above_200k: 400,
                    web_search_cost: 0,
                    token_counting_supported: 'true',
                    token_counting_method: 'verified_openai_tokenizer',
                    tokenizer_family: 'openai',
                    is_active: 'true',
                    config: {},
                    created_at: '2026-04-06T00:00:00.000Z',
                    updated_at: '2026-04-06T00:00:00.000Z',
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

    const caller = createAdminCaller(supabase);
    const result = await caller.getAvailableModels();

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('api_key');
  });
});
