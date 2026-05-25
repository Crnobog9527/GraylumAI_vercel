import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_MODULE_SELECT, getPublicReadClient, modulesRouter, toPublicModule } from './modules';

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
      is_featured: true,
      active: true,
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
      is_featured: true,
      active: true,
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

describe('module boolean flag migration', () => {
  it('normalizes text or boolean module flags without grants or seeds', () => {
    const migrationSql = readFileSync(
      new URL('../../../db/migrations/0038_normalize_module_boolean_flags.sql', import.meta.url),
      'utf8',
    );

    expect(migrationSql).toContain('ALTER COLUMN active TYPE boolean');
    expect(migrationSql).toContain('ALTER COLUMN is_featured TYPE boolean');
    expect(migrationSql).toContain('active::text');
    expect(migrationSql).toContain('is_featured::text');
    expect(migrationSql).toContain("IN ('true', 't', '1', 'yes', 'on')");
    expect(migrationSql).toContain('USING (active IS TRUE)');
    expect(migrationSql).toContain('DROP POLICY IF EXISTS "modules_select_active_public"');
    expect(migrationSql.indexOf('DROP POLICY IF EXISTS "modules_select_active_public"')).toBeLessThan(
      migrationSql.indexOf('ALTER COLUMN active TYPE boolean'),
    );
    expect(migrationSql.indexOf('ALTER COLUMN active TYPE boolean')).toBeLessThan(
      migrationSql.indexOf('CREATE POLICY "modules_select_active_public"'),
    );
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});

type ModuleRow = Record<string, any>;

function createModulesCaller(rows: ModuleRow[] = []) {
  const operations: Array<Record<string, unknown>> = [];
  const supabasePublic = {
    from(table: string) {
      operations.push({ op: 'from', table });
      const filters: Array<{ column: string; value: unknown }> = [];
      const orders: Array<{ column: string; ascending?: boolean }> = [];

      const executeRows = () => {
        const filtered = rows.filter((row) =>
          filters.every((filter) => row[filter.column] === filter.value),
        );

        return [...filtered].sort((a, b) => {
          for (const order of orders) {
            const left = a[order.column];
            const right = b[order.column];
            if (left === right) continue;
            const direction = order.ascending ? 1 : -1;
            return left > right ? direction : -direction;
          }
          return 0;
        });
      };

      const builder = {
        select(columns: string, options?: unknown) {
          operations.push({ op: 'select', columns, options });
          return builder;
        },
        eq(column: string, value: unknown) {
          operations.push({ op: 'eq', column, value });
          filters.push({ column, value });
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          operations.push({ op: 'order', column, ascending: options?.ascending });
          orders.push({ column, ascending: options?.ascending });
          return builder;
        },
        range(from: number, to: number) {
          operations.push({ op: 'range', from, to });
          const result = executeRows();
          return Promise.resolve({ data: result.slice(from, to + 1), error: null, count: result.length });
        },
        limit(limit: number) {
          operations.push({ op: 'limit', limit });
          return Promise.resolve({ data: executeRows().slice(0, limit), error: null });
        },
        single() {
          const [row] = executeRows();
          return Promise.resolve(row
            ? { data: row, error: null }
            : { data: null, error: { code: 'PGRST116' } });
        },
      };

      return builder;
    },
  };

  return {
    operations,
    caller: modulesRouter.createCaller({
      supabase: supabasePublic,
      supabasePublic,
      supabaseAdmin: {},
      hasSupabaseAdminPrivileges: false,
    } as any),
  };
}

describe('modulesRouter public marketplace queries', () => {
  it('lists only active modules using admin-controlled sort order before created date', async () => {
    const { caller, operations } = createModulesCaller([
      { id: 'inactive', title: 'Inactive', active: false, is_featured: true, sort_order: 999, created_at: '2026-01-03' },
      { id: 'second', title: 'Second', active: true, is_featured: false, sort_order: 10, created_at: '2026-01-02' },
      { id: 'first', title: 'First', active: true, is_featured: true, sort_order: 99, created_at: '2026-01-01' },
    ]);

    const result = await caller.getModules({ limit: 12, offset: 0, sortBy: 'newest' });

    expect(result.modules.map((module) => module.id)).toEqual(['first', 'second']);

    expect(operations).toEqual(expect.arrayContaining([
      { op: 'from', table: 'modules' },
      { op: 'eq', column: 'active', value: true },
      { op: 'order', column: 'sort_order', ascending: false },
      { op: 'order', column: 'created_at', ascending: false },
      { op: 'range', from: 0, to: 11 },
    ]));
  });

  it('returns featured modules from active featured rows ordered by admin sort order', async () => {
    const { caller, operations } = createModulesCaller([
      { id: 'inactive-featured', active: false, is_featured: true, sort_order: 999, created_at: '2026-01-04' },
      { id: 'not-featured', active: true, is_featured: false, sort_order: 998, created_at: '2026-01-03' },
      { id: 'featured-second', active: true, is_featured: true, sort_order: 10, created_at: '2026-01-02' },
      { id: 'featured-first', active: true, is_featured: true, sort_order: 20, created_at: '2026-01-01' },
    ]);

    const result = await caller.getFeaturedModules({ limit: 4 });

    expect(result.map((module) => module.id)).toEqual(['featured-first', 'featured-second']);

    expect(operations).toEqual(expect.arrayContaining([
      { op: 'from', table: 'modules' },
      { op: 'eq', column: 'active', value: true },
      { op: 'eq', column: 'is_featured', value: true },
      { op: 'order', column: 'sort_order', ascending: false },
      { op: 'order', column: 'created_at', ascending: false },
      { op: 'limit', limit: 4 },
    ]));
  });

  it('requires active modules when resolving a marketplace module by id', async () => {
    const { caller, operations } = createModulesCaller([
      { id: '00000000-0000-4000-8000-000000000001', active: false, title: 'Hidden' },
    ]);

    await expect(caller.getModuleById({
      id: '00000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(operations).toEqual(expect.arrayContaining([
      { op: 'eq', column: 'id', value: '00000000-0000-4000-8000-000000000001' },
      { op: 'eq', column: 'active', value: true },
    ]));
  });
});
