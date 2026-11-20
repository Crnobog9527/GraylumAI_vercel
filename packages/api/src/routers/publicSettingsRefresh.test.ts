import { describe, expect, it, vi } from 'vitest';
import { settingsRouter } from './settings';

function setup(role: string | null = 'admin', writeError: unknown = null) {
  const profile = { id: 'admin-user', role, status: 'active', is_deleted: 'false', nickname: 'Admin', email: 'admin@example.test' };
  const refresh = vi.fn();
  const upsert = vi.fn((rows: unknown) => ({ select: async () => ({ data: rows, error: writeError }) }));
  const client = { from(table: string) {
    if (table === 'profiles') return { select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) };
    if (table === 'system_settings') return { upsert };
    throw new Error('Unexpected table');
  } };
  const caller = settingsRouter.createCaller({ headers: new Headers(),
    user: role ? { id: profile.id, email: profile.email, app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } } : null,
    isEmailVerified: !!role, authProvider: 'email', hasSupabaseAdminPrivileges: true,
    supabase: client, supabaseAdmin: client, supabasePublic: {}, refreshPublicSite: refresh,
  } as unknown as Parameters<typeof settingsRouter.createCaller>[0]);
  return { caller, refresh, upsert };
}

describe('public settings refresh', () => {
  it.each([false, true])('refreshes only after a successful relevant write (bulk=%s)', async bulk => {
    const t = setup();
    const item = { key: 'site_name', value: 'Example' };
    await (bulk ? t.caller.updateSystemSettingsBulk([item]) : t.caller.updateSystemSettings(item));
    expect(t.refresh).toHaveBeenCalledOnce();
    const other = setup();
    await other.caller.updateSystemSettingsBulk([{ key: 'max_input_characters', value: '10000' }]);
    expect(other.refresh).not.toHaveBeenCalled();
  });
  it.each([false, true])('does not refresh after a failed write or unauthorized request (bulk=%s)', async bulk => {
    for (const t of [setup('admin', { code: 'ERROR' }), setup('user'), setup(null)]) {
      const item = { key: 'support_email', value: 'test@example.test' };
      await expect(bulk ? t.caller.updateSystemSettingsBulk([item]) : t.caller.updateSystemSettings(item)).rejects.toThrow();
      expect(t.refresh).not.toHaveBeenCalled();
    }
  });
  it('refreshes for support email in a mixed batch', async () => {
    const t = setup();
    await t.caller.updateSystemSettingsBulk([{ key: 'max_input_characters', value: '10000' }, { key: 'support_email', value: 'test@example.test' }]);
    expect(t.refresh).toHaveBeenCalledOnce();
  });
});
