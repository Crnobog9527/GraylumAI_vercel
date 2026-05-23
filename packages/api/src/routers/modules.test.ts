import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_MODULE_SELECT, getPublicReadClient, toPublicModule } from './modules';

const PUBLIC_DISPLAY_MODULE_FIELDS = [
  'image_url',
  'badge_type',
  'badge_text',
  'credits_display',
  'link_url',
  'link_module_id',
];

const INTERNAL_MODULE_FIELDS = [
  'prompt_content',
  'system_prompt',
  'user_prompt_template',
  'model_id',
  'created_by',
];

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
      image_url: 'https://example.com/module.png',
      badge_type: 'recommend',
      badge_text: 'Featured',
      credits_display: '10 credits',
      link_url: '/marketplace?module=module-1',
      link_module_id: '00000000-0000-4000-8000-000000000001',
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
      image_url: 'https://example.com/module.png',
      badge_type: 'recommend',
      badge_text: 'Featured',
      credits_display: '10 credits',
      link_url: '/marketplace?module=module-1',
      link_module_id: '00000000-0000-4000-8000-000000000001',
    });

    for (const field of INTERNAL_MODULE_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
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

describe('PUBLIC_MODULE_SELECT', () => {
  it('selects only public module columns', () => {
    const selectedColumns = PUBLIC_MODULE_SELECT.split(',');

    expect(PUBLIC_MODULE_SELECT).not.toBe('*');
    expect(selectedColumns).toEqual(expect.arrayContaining(['title', 'description']));
    expect(selectedColumns).toEqual(expect.arrayContaining(PUBLIC_DISPLAY_MODULE_FIELDS));
    for (const field of INTERNAL_MODULE_FIELDS) {
      expect(selectedColumns).not.toContain(field);
    }
  });
});

describe('public module display field migration', () => {
  it('grants display fields without granting prompt internals', () => {
    const migrationSql = readFileSync(
      new URL('../../../db/migrations/0036_public_module_display_fields.sql', import.meta.url),
      'utf8',
    );
    const grantBlock = migrationSql.match(
      /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.modules TO anon, authenticated;/,
    )?.[1];

    expect(grantBlock).toBeDefined();
    for (const field of PUBLIC_DISPLAY_MODULE_FIELDS) {
      expect(migrationSql).toContain(`ADD COLUMN IF NOT EXISTS ${field}`);
      expect(grantBlock).toContain(field);
    }
    for (const field of INTERNAL_MODULE_FIELDS) {
      expect(grantBlock).not.toContain(field);
    }
  });
});
