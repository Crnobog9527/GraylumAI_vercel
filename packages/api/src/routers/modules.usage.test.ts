import { describe, expect, it } from 'vitest';
import { modulesRouter } from './modules';

const moduleId = '11111111-1111-4111-8111-111111111111';

function createCaller(options: {
  counts?: number[];
  updateRows?: number[];
  moduleMissing?: boolean;
  readError?: { code: string };
  hasAdmin?: boolean;
}) {
  const updates: unknown[] = [];
  const filters: Array<[string, unknown]> = [];
  const userTables: string[] = [];
  let reads = 0;
  let writes = 0;
  const admin = {
    from(table: string) {
      expect(table).toBe('modules');
      let op = 'select';
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        update: (value: unknown) => { op = 'update'; updates.push(value); return builder; },
        maybeSingle: async () => {
          if (options.readError) return { data: null, error: options.readError };
          if (options.moduleMissing) return { data: null, error: null };
          const count = options.counts?.[reads] ?? 0;
          reads += 1;
          return { data: { usage_count: count }, error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = op === 'update' ? (options.updateRows?.[writes++] ?? 1) : 0;
          return Promise.resolve({ data: Array.from({ length: rows }, () => ({ id: moduleId })), error: null })
            .then(resolve);
        },
      };
      return builder;
    },
  };
  const profile = { id: 'user-1', role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
  const user = {
    from(table: string) {
      userTables.push(table);
      return { select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) };
    },
  };
  const caller = modulesRouter.createCaller({
    headers: new Headers(),
    user: { id: 'user-1', email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: user,
    supabaseAuth: user,
    supabasePublic: {},
    supabaseAdmin: admin,
    hasSupabaseAdminPrivileges: options.hasAdmin ?? true,
  } as any);
  return { caller, updates, filters, userTables };
}

describe('modules.incrementUsage', () => {
  it('increments an active module by exactly one through a server-side compare-and-swap', async () => {
    const { caller, updates, filters, userTables } = createCaller({ counts: [41] });

    await expect(caller.incrementUsage({ moduleId })).resolves.toEqual({ success: true });

    expect(updates).toEqual([{ usage_count: 42 }]);
    expect(filters).toEqual(expect.arrayContaining([['active', true], ['usage_count', 41]]));
    expect(userTables).not.toContain('modules');
  });

  it('retries a lost race and then succeeds without skipping a count', async () => {
    const { caller, updates } = createCaller({ counts: [5, 6], updateRows: [0, 1] });

    await expect(caller.incrementUsage({ moduleId })).resolves.toEqual({ success: true });
    expect(updates).toEqual([{ usage_count: 6 }, { usage_count: 7 }]);
  });

  it.each([
    ['a missing or inactive module', { moduleMissing: true }, 'NOT_FOUND'],
    ['a read failure', { readError: { code: '42501' } }, 'INTERNAL_SERVER_ERROR'],
    ['repeated conflicts', { counts: [1, 1, 1], updateRows: [0, 0, 0] }, 'CONFLICT'],
    ['missing server credentials', { hasAdmin: false }, 'INTERNAL_SERVER_ERROR'],
  ])('reports %s instead of success', async (_name, options, code) => {
    const { caller } = createCaller(options);
    await expect(caller.incrementUsage({ moduleId })).rejects.toMatchObject({ code });
  });
});
