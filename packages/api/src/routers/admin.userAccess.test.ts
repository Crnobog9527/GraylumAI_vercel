import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerError = vi.hoisted(() => vi.fn());
vi.mock('../lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger')>();
  return { ...actual, logger: { ...actual.logger, error: loggerError } };
});

import { adminRouter } from './admin';

type Call = { table: string; op: string; args: unknown[] };

function createRecordingSupabase(options: { activityInsertError?: { code: string } } = {}) {
  const calls: Call[] = [];
  const rows: Record<string, unknown> = {
    profiles: [{ id: 'u1', email: 'u1@example.com', nickname: 'U1', status: 'active', role: 'user' }],
    credit_transactions: [{ id: 't1', user_id: 'u1', amount: 5, type: 'addition' }],
    user_activity_logs: [{ id: 'l1', action: 'x' }],
  };
  const from = (table: string) => {
    let op = 'select';
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'or', 'order', 'range', 'limit', 'update', 'insert']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, op: method, args });
        if (method === 'update' || method === 'insert') op = method;
        return builder;
      };
    }
    const result = () => {
      if (table === 'user_activity_logs' && op === 'insert') {
        return { data: null, error: options.activityInsertError ?? null };
      }
      const data = rows[table] ?? [];
      return { data, error: null, count: Array.isArray(data) ? data.length : 1 };
    };
    builder.single = async () => {
      const value = result();
      return { ...value, data: Array.isArray(value.data) ? value.data[0] : value.data };
    };
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  return { supabase: { from }, calls };
}

function createCaller(adminSupabase: unknown) {
  const profile = { id: 'admin-user', role: 'admin', status: 'active', nickname: 'A', email: 'a@example.com' };
  const userScoped = {
    from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) }),
  };
  return adminRouter.createCaller({
    headers: new Headers(),
    user: { id: 'admin-user', email: 'a@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScoped,
    supabaseAuth: userScoped,
    supabasePublic: {},
    supabaseAdmin: adminSupabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

const selectedColumns = (calls: Call[], table: string) =>
  calls.filter((call) => call.table === table && call.op === 'select').map((call) => call.args[0]);

describe('admin user access projections (0144 column grants)', () => {
  beforeEach(() => loggerError.mockClear());

  it('never selects wildcard or unrecorded login columns for users, details, transactions and logs', async () => {
    const { supabase, calls } = createRecordingSupabase();
    const caller = createCaller(supabase);

    const list = await caller.getAllUsers({ limit: 20, offset: 0 });
    const details = await caller.getUserDetails({ userId: '11111111-1111-4111-8111-111111111111' });
    await caller.getAllTransactions({ limit: 20, offset: 0 });
    await caller.getUserActivityLogs({ limit: 20, offset: 0 });

    for (const table of ['profiles', 'credit_transactions', 'user_activity_logs']) {
      for (const columns of selectedColumns(calls, table)) {
        expect(typeof columns).toBe('string');
        expect(columns).not.toMatch(/(^|[\s,(])\*/);
        expect(columns).not.toMatch(/last_login_at|last_ip|source_id|source_refund_id|bill2_run_id/);
      }
    }
    expect(selectedColumns(calls, 'user_activity_logs')).toContainEqual(
      expect.stringContaining('user:profiles!user_id(id, email, nickname, avatar_url)'),
    );
    const unrecorded = { last_login_at: null, last_ip: null, login_record_status: 'unrecorded' };
    expect(list.users[0]).toMatchObject(unrecorded);
    expect(details.profile).toMatchObject({ id: 'u1', ...unrecorded });
  });

  it.each([
    ['updateUserStatus', { status: 'disabled' as const }, { status: 'disabled' }, 'status_change'],
    ['updateUserRole', { role: 'admin' as const }, { role: 'admin' }, 'role_change'],
  ])('%s writes only the managed column and records the audit entry', async (name, input, update, actionType) => {
    const { supabase, calls } = createRecordingSupabase();
    const caller = createCaller(supabase) as any;

    await caller[name]({ userId: '11111111-1111-4111-8111-111111111111', ...input });

    expect(calls.filter((call) => call.op === 'update').map((call) => call.args[0])).toEqual([update]);
    const insert = calls.find((call) => call.table === 'user_activity_logs' && call.op === 'insert');
    expect(insert?.args[0]).toMatchObject({ admin_id: 'admin-user', action_type: actionType });
    expect(Object.keys(insert?.args[0] as object).sort()).toEqual(
      ['action', 'action_type', 'admin_id', 'details', 'user_id'],
    );
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('keeps the completed admin action and logs a failed audit write without retrying it', async () => {
    const { supabase, calls } = createRecordingSupabase({ activityInsertError: { code: '42501' } });
    const caller = createCaller(supabase);

    await expect(caller.updateUserStatus({
      userId: '11111111-1111-4111-8111-111111111111', status: 'banned',
    })).resolves.toMatchObject({ id: 'u1' });

    expect(calls.filter((call) => call.op === 'update')).toHaveLength(1);
    expect(calls.filter((call) => call.op === 'insert')).toHaveLength(1);
    expect(loggerError).toHaveBeenCalledWith('security', 'admin_activity_log_write_failed', {
      actionType: 'status_change', code: '42501',
    });
  });
});
