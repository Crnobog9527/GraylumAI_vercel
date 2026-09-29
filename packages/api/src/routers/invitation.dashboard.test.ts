import { describe, expect, it, vi } from 'vitest';
import { invitationRouter } from './invitation';

const profileId = 'synthetic-owner';
const visibleFields = ['id', 'created_at', 'invitee_email', 'inviter_reward', 'status'];
const ownCode = { code: 'OWNCODE', created_by: profileId, status: 'active' };

type Row = Record<string, unknown>;
function fixture(options: {
  invitations?: Row[];
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
  const records = [
    { id: 'record-own', created_at: '2026-09-29', invitee_email: 'synthetic',
      inviter_reward: 70, status: 'rewarded', inviter_id: profileId, risk_level: 'private' },
    { id: 'record-foreign', inviter_id: 'synthetic-other' },
  ];
  function query(rows: Row[], error: unknown = null) {
    let columns: string | undefined;
    const filters: Array<[string, unknown]> = [];
    let inserted: Row | undefined;
    const result = () => {
      const selected = (inserted ? [inserted] : rows).filter(row => (
        filters.every(([key, value]) => row[key] === value)
      ));
      const data = selected.map(row => columns ? Object.fromEntries(
        columns.split(',').map(key => key.trim()).map(key => [key, row[key]]),
      ) : row);
      return { data, error: inserted ? options.insertError ?? null : error };
    };
    const builder = {
      select: vi.fn((value?: string) => { columns = value; return builder; }),
      eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return builder; }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      in: vi.fn(() => builder),
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
  const recordQuery = query(records);
  const settingsQuery = query(options.settings ?? []);
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'profiles') return query([
        { id: profileId, role: 'user', status: 'active', nickname: 'Synthetic' },
      ]);
      if (table === 'invitation_records') return recordQuery;
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
  return { caller, supabase, supabaseAdmin, invitationQueries, recordQuery, settingsQuery };
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
    expect(f.recordQuery.select).toHaveBeenCalledExactlyOnceWith(visibleFields.join(', '));
    expect(f.recordQuery.eq).toHaveBeenCalledExactlyOnceWith('inviter_id', profileId);
    expect(f.recordQuery.limit).toHaveBeenCalledExactlyOnceWith(10);
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
