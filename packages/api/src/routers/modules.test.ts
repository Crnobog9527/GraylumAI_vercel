import { describe, expect, it } from 'vitest';
import { getPublicReadClient, toPublicModule } from './modules';

describe('toPublicModule', () => {
  it('omits internal prompt fields from public module payloads', () => {
    const result = toPublicModule({
      id: 'module-1',
      title: 'Public module',
      description: 'safe description',
      full_description: 'safe long description',
      icon: 'Sparkles',
      category: 'writing',
      platform: 'all',
      features: ['feature-a'],
      examples: ['example-a'],
      preparation_questions: ['question-a'],
      usage_count: 42,
      credits_multiplier: '1.00',
      sort_order: 1,
      is_featured: 'true',
      active: 'true',
      created_at: '2026-03-27T00:00:00.000Z',
      updated_at: '2026-03-27T00:00:00.000Z',
      prompt_content: 'secret prompt body',
      system_prompt: 'secret system prompt',
      user_prompt_template: 'secret user template',
      model_id: 'model-1',
      created_by: 'admin-1',
    });

    expect(result).toEqual({
      id: 'module-1',
      title: 'Public module',
      description: 'safe description',
      full_description: 'safe long description',
      icon: 'Sparkles',
      category: 'writing',
      platform: 'all',
      features: ['feature-a'],
      examples: ['example-a'],
      preparation_questions: ['question-a'],
      usage_count: 42,
      credits_multiplier: '1.00',
      sort_order: 1,
      is_featured: 'true',
      active: 'true',
      created_at: '2026-03-27T00:00:00.000Z',
      updated_at: '2026-03-27T00:00:00.000Z',
    });

    expect(result).not.toHaveProperty('prompt_content');
    expect(result).not.toHaveProperty('system_prompt');
    expect(result).not.toHaveProperty('user_prompt_template');
    expect(result).not.toHaveProperty('model_id');
    expect(result).not.toHaveProperty('created_by');
  });
});

describe('getPublicReadClient', () => {
  it('uses the public client even when admin credentials are configured', () => {
    const publicClient = { role: 'public' };
    const adminClient = { role: 'admin' };

    expect(
      getPublicReadClient({
        supabase: { role: 'auth-scoped' } as any,
        supabasePublic: publicClient as any,
        supabaseAdmin: adminClient as any,
        hasSupabaseAdminPrivileges: true,
      }),
    ).toBe(publicClient);
  });
});
