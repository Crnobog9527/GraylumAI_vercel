import { describe, expect, it, vi } from 'vitest';
import { invitationRouter } from './invitation';

const profileId = 'synthetic-owner';
const visibleFields = ['id', 'created_at', 'invitee_email', 'inviter_reward', 'status'];
const ownCode = { code: 'OWNCODE', created_by: profileId, status: 'active' };

type Row = Record<string, unknown>;
function fixture(options: {
  invitations?: Row[];
  records?: Row[];
  countErrorAt?: number;
  settings?: Row[];
  privileged?: boolean;
  insertError?: { code: string; message: string };
  readError?: { message: string };
} = {}) {
  const invitations = options.invitations ?? [
    { ...ownCode, code: 'FOREIGN', created_by: 'synthetic-other' },
    { ...ownCode, code: 'INACTIVE', status: 'used' },
    ownCode,
  ];
  const records = options.records ?? [
    { id: 'record-own', created_at: '2026-09-29', invitee_email: 'synthetic',
      inviter_reward: 70, status: 'rewarded', inviter_id: profileId, risk_level: 'private' },
    { id: 'record-foreign', inviter_id: 'synthetic-other' },
  ];
  function query(rows: Row[], error: unknown = null) {
    let columns: string | undefined;
    let head = false;
    let rowLimit = Infinity;
    let orderKey: string | undefined;
    let ascending = true;
    const inclusions: Array<[string, unknown[]]> = [];
    const filters: Array<[string, unknown]> = [];
    let inserted: Row | undefined;
    const result = () => {
      const selected = (inserted ? [inserted] : rows).filter(row => (
        filters.every(([key, value]) => row[key] === value)
        && inclusions.every(([key, values]) => values.includes(row[key]))
      ));
      if (orderKey) selected.sort((a, b) => String(a[orderKey!]).localeCompare(String(b[orderKey!])) * (ascending ? 1 : -1));
      const data = selected.slice(0, rowLimit).map(row => columns ? Object.fromEntries(
        columns.split(',').map(key => key.trim()).map(key => [key, row[key]]),
      ) : row);
      return { data, count: head ? selected.length : null, error: inserted ? options.insertError ?? null : error };
    };
    const builder = {
      select: vi.fn((value?: string, config?: { head?: boolean }) => {
        columns = value; head = config?.head ?? false; return builder;
      }),
      eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return builder; }),
      order: vi.fn((key: string, config: { ascending: boolean }) => {
        orderKey = key; ascending = config.ascending; return builder;
      }),
      limit: vi.fn((value: number) => { rowLimit = value; return builder; }),
      in: vi.fn((key: string, values: unknown[]) => { inclusions.push([key, values]); return builder; }),
      insert: vi.fn((value: Row) => { inserted = value; return builder; }),
      maybeSingle: vi.fn(async () => ({ ...result(), data: result().data[0] ?? null })),
      single: vi.fn(async () => ({ ...result(), data: result().data[0] ?? null })),
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(result()).then(resolve, reject);
      },
    };
    return builder;
  }
  const invitationQueries: ReturnType<typeof query>[] = [];
  const recordQueries: ReturnType<typeof query>[] = [];
  const settingsQuery = query(options.settings ?? []);
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'profiles') return query([
        { id: profileId, role: 'user', status: 'active', nickname: 'Synthetic' },
      ]);
      if (table === 'invitation_records') {
        const error = recordQueries.length === options.countErrorAt
          ? { code: '42501', message: 'private count details' } : null;
        const builder = query(records, error);
        recordQueries.push(builder);
        return builder;
      }
      throw new Error(`User client must not access ${table}`);
    }),
  };
  const supabaseAdmin = {
    from: vi.fn((table: string) => {
      if (table === 'invitations') {
        const builder = query(invitations, options.readError);
        invitationQueries.push(builder);
        return builder;
      }
      if (table === 'system_settings') return settingsQuery;
      throw new Error(`Admin client must not access ${table}`);
    }),
  };
  const caller = invitationRouter.createCaller({
    headers: new Headers(),
    user: { id: profileId, app_metadata: { provider: 'email' }, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email',
    supabase, supabaseAuth: supabase, supabaseAdmin,
    hasSupabaseAdminPrivileges: options.privileged ?? true,
  } as any);
  return { caller, supabase, supabaseAdmin, invitationQueries, recordQueries, settingsQuery };
}

describe('getMyInvitationDashboard privileged boundary', () => {
  it('reads only the authenticated profile active code through the admin client', async () => {
    const f = fixture();
    const result = await f.caller.getMyInvitationDashboard();
    expect(result.invitationCode).toBe('OWNCODE');
    expect(f.invitationQueries).toHaveLength(1);
    expect(f.invitationQueries[0].eq).toHaveBeenCalledWith('created_by', profileId);
    expect(f.invitationQueries[0].eq).toHaveBeenCalledWith('status', 'active');
    expect(f.invitationQueries[0].insert).not.toHaveBeenCalled();
    expect(f.supabase.from).not.toHaveBeenCalledWith('invitations');
  });

  it('generates a server code owned by the authenticated profile when only foreign codes exist', async () => {
    const f = fixture({ invitations: [{ ...ownCode, created_by: 'synthetic-other' }] });
    const result = await f.caller.getMyInvitationDashboard();
    expect(f.invitationQueries).toHaveLength(2);
    expect(f.invitationQueries[1].insert).toHaveBeenCalledExactlyOnceWith({
      code: result.invitationCode, created_by: profileId, status: 'active',
    });
    expect(result.invitationCode).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(f.invitationQueries[1].eq).toHaveBeenCalledWith('created_by', profileId);
  });

  it.each([
    { settings: [], expected: { inviterReward: 50, inviteeReward: 30 } },
    { settings: [{ key: 'invite_inviter_reward', value: '75' }, { key: 'invite_invitee_reward', value: 45 }],
      expected: { inviterReward: 75, inviteeReward: 45 } },
    { settings: [{ key: 'invite_inviter_reward', value: 0 }, { key: 'invite_invitee_reward', value: 'invalid' }],
      expected: { inviterReward: 0, inviteeReward: 30 } },
  ])('uses runtime settings and its defaults: $expected', async ({ settings, expected }) => {
    const f = fixture({ settings });
    expect((await f.caller.getMyInvitationDashboard()).rewards).toEqual(expected);
    expect(f.supabaseAdmin.from).toHaveBeenCalledWith('system_settings');
    expect(f.supabase.from).not.toHaveBeenCalledWith('system_settings');
  });

  it('fails safely without service role and never falls back to user queries', async () => {
    const f = fixture({ privileged: false });
    await expect(f.caller.getMyInvitationDashboard()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR', message: '读取邀请码面板失败，请稍后重试',
    });
    expect(f.supabaseAdmin.from).not.toHaveBeenCalled();
    expect(f.supabase.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true);
  });

  it('preserves user-scoped record filtering and exactly five response keys', async () => {
    const f = fixture();
    const result = await f.caller.getMyInvitationDashboard();
    expect(result.records).toHaveLength(1);
    expect(Object.keys(result.records[0]).sort()).toEqual([...visibleFields].sort());
    expect(result.records[0].id).toBe('record-own');
    expect(f.recordQueries[0].select).toHaveBeenCalledExactlyOnceWith(visibleFields.join(', '));
    expect(f.recordQueries[0].eq).toHaveBeenCalledExactlyOnceWith('inviter_id', profileId);
    expect(f.recordQueries[0].limit).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.supabaseAdmin.from).not.toHaveBeenCalledWith('invitation_records');
  });

  it('sanitizes unique collisions and does not retry the insert', async () => {
    const f = fixture({ invitations: [], insertError: { code: '23505', message: 'private constraint details' } });
    await expect(f.caller.getMyInvitationDashboard()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR', message: '生成邀请码失败，请稍后重试',
    });
    expect(f.invitationQueries).toHaveLength(2);
    expect(f.invitationQueries[1].insert).toHaveBeenCalledTimes(1);
  });

  it('sanitizes admin lookup errors without generating a replacement code', async () => {
    const f = fixture({ readError: { message: 'private database details' } });
    await expect(f.caller.getMyInvitationDashboard()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR', message: '读取邀请码面板失败，请稍后重试',
    });
    expect(f.invitationQueries).toHaveLength(1);
    expect(f.invitationQueries[0].insert).not.toHaveBeenCalled();
  });
});


describe('getMyInvitationDashboard complete summary', () => {
  it('counts every own record while returning only the latest ten display rows', async () => {
    const records = Array.from({ length: 16 }, (_, i) => ({
      id: `record-${i}`, created_at: new Date(Date.UTC(2026, 8, i + 1)).toISOString(),
      status: ['rewarded', 'pending', 'registered', 'rejected'][i % 4],
      inviter_id: profileId, invitee_email: 'synthetic', inviter_reward: 50,
      ip_address: 'private', user_agent: 'private', risk_level: 'private', block_reason: 'private',
    }));
    const f = fixture({ records: [
      ...records,
      ...records.map(row => ({ ...row, inviter_id: 'synthetic-other' })),
    ] });
    const result = await f.caller.getMyInvitationDashboard();
    expect(result.summary).toEqual({ totalInvites: 16, rewardedInvites: 4, pendingInvites: 8 });
    expect(result.records.map(row => row.id)).toEqual(records.slice(6).reverse().map(row => row.id));
    for (const row of result.records) expect(Object.keys(row).sort()).toEqual([...visibleFields].sort());
    expect(f.recordQueries).toHaveLength(4);
    for (const query of f.recordQueries.slice(1)) {
      expect(query.select).toHaveBeenCalledExactlyOnceWith('status', { count: 'exact', head: true });
      expect(query.eq).toHaveBeenCalledWith('inviter_id', profileId);
      expect(query.limit).not.toHaveBeenCalled();
    }
    expect(f.supabaseAdmin.from).not.toHaveBeenCalledWith('invitation_records');
  });

  it('returns zero counts for an empty invitation history', async () => {
    const f = fixture({ records: [] });
    const result = await f.caller.getMyInvitationDashboard();
    expect(result.summary).toEqual({ totalInvites: 0, rewardedInvites: 0, pendingInvites: 0 });
    expect(result.records).toEqual([]);
  });

  it.each([1, 2, 3])('throws a sanitized error when count query %s fails', async countErrorAt => {
    const f = fixture({ countErrorAt });
    await expect(f.caller.getMyInvitationDashboard()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR', message: '读取邀请码面板失败，请稍后重试',
    });
  });
});
