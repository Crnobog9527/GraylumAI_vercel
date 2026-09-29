import { describe, expect, it } from 'vitest';
import { checkinRouter } from './checkin';

function query(result: unknown, calls: Array<[string, unknown]>, table: string) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([`${table}.${method}`, args]);
      return builder;
    };
  }
  builder.in = (column: string, values: unknown) => {
    calls.push([`${table}.in`, [column, values]]);
    return Promise.resolve(result);
  };
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

function createCaller(hasSupabaseAdminPrivileges: boolean) {
  const userTables: string[] = [];
  const adminTables: string[] = [];
  const calls: Array<[string, unknown]> = [];
  const profile = { id: 'user-1', role: 'user', status: 'active', nickname: 'User', email: 'u@example.com' };
  const supabase = {
    from(table: string) {
      userTables.push(table);
      if (table === 'profiles') {
        return { select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) };
      }
      if (table === 'system_settings') return query({ data: [], error: null }, calls, 'user_settings');
      return query({ data: [], error: null, count: 0 }, calls, table);
    },
  };
  const supabaseAdmin = {
    from(table: string) {
      adminTables.push(table);
      return query({ data: [{ key: 'checkin_day1', value: 7 }, { key: 'checkin_monthly_bonus', value: '60' }],
        error: null }, calls, 'admin_settings');
    },
  };
  const caller = checkinRouter.createCaller({
    headers: new Headers(),
    user: { id: 'user-1', email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin,
    hasSupabaseAdminPrivileges,
  } as any);
  return { caller, userTables, adminTables, calls };
}

describe('checkinRouter settings source', () => {
  it('reads only the fixed check-in keys through the server client', async () => {
    const { caller, userTables, adminTables, calls } = createCaller(true);

    const status = await caller.getCheckinStatus();

    expect(adminTables).toEqual(['system_settings']);
    expect(userTables).not.toContain('system_settings');
    expect(calls).toContainEqual(['admin_settings.in', ['key', [
      'checkin_day1', 'checkin_day2', 'checkin_day3', 'checkin_day4', 'checkin_day5', 'checkin_monthly_bonus',
    ]]]);
    expect(status.cycleRewards).toEqual({ 1: 7, 2: 10, 3: 15, 4: 20, 5: 25 });
    expect(status.monthlyBonusCredits).toBe(60);
    expect(userTables).toContain('user_checkins');
  });

  it('falls back to the user client when no server client is configured', async () => {
    const { caller, userTables, adminTables } = createCaller(false);

    const status = await caller.getCheckinStatus();

    expect(adminTables).toEqual([]);
    expect(userTables).toContain('system_settings');
    expect(status.cycleRewards[1]).toBe(5);
  });
});
