/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tier = vi.hoisted(() => vi.fn());
vi.mock('../membershipEntitlements', () => ({ readOwnDataTier: tier }));
import {
  deleteUserConnection, markUserConnectionFailed, paidConnectorMember, readUserConnection, readUserConnectionSecret,
  saveUserConnection, UserConnectionError,
} from './userConnections';

const me = '00000000-0000-4000-8000-000000000001';
type Result = { data: unknown; error: { message: string } | null };
function fakeAdmin(row: Result = { data: null, error: null }, rpc: Result = { data: null, error: null }) {
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(async () => row) };
  return { from: vi.fn(() => query), rpc: vi.fn(async () => rpc), query };
}
const code = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => (e as UserConnectionError).code);

beforeEach(() => vi.clearAllMocks());

describe('user connections', () => {
  it('reads the row of this user and provider only, without the credential', async () => {
    const admin = fakeAdmin({ data: { provider: 'feishu_base', target: { appToken: 'bascn1' }, label: '选题库', last4: 'ab12',
      failed_at: null, created_at: '2026-11-14T00:00:00Z' }, error: null });
    expect(await readUserConnection(admin as never, me, 'feishu_base')).toEqual({ provider: 'feishu_base',
      target: { appToken: 'bascn1' }, label: '选题库', last4: 'ab12', failed: false, connectedAt: '2026-11-14T00:00:00Z' });
    expect(admin.from).toHaveBeenCalledWith('user_connections');
    expect(admin.query.select).toHaveBeenCalledWith('provider,target,label,last4,failed_at,created_at');
    expect(admin.query.eq).toHaveBeenCalledWith('profile_id', me);
    expect(admin.query.eq).toHaveBeenCalledWith('provider', 'feishu_base');
    expect(await readUserConnection(fakeAdmin() as never, me, 'feishu_base')).toBeNull();
  });

  it('refuses a bad profile id or an unknown provider before touching the database', async () => {
    const admin = fakeAdmin();
    expect(await code(readUserConnection(admin as never, 'nope', 'feishu_base'))).toBe('CONNECTION_INPUT_INVALID');
    expect(await code(deleteUserConnection(admin as never, me, 'notion'))).toBe('CONNECTION_INPUT_INVALID');
    expect(admin.from).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('writes, reads, marks and deletes only through the service-role functions', async () => {
    const admin = fakeAdmin(undefined, { data: 'pt-secret-value-1234', error: null });
    await saveUserConnection(admin as never, { profileId: me, provider: 'feishu_base', secret: 'pt-secret-value-1234',
      target: { appToken: 'bascn1' }, label: null });
    expect(admin.rpc).toHaveBeenLastCalledWith('user_connection_set', { p_profile_id: me, p_provider: 'feishu_base',
      p_secret: 'pt-secret-value-1234', p_target: { appToken: 'bascn1' }, p_label: null });
    expect(await readUserConnectionSecret(admin as never, me, 'feishu_base')).toBe('pt-secret-value-1234');
    await markUserConnectionFailed(admin as never, me, 'feishu_base', '1234');
    expect(admin.rpc).toHaveBeenLastCalledWith('user_connection_failed', { p_profile_id: me, p_provider: 'feishu_base', p_last4: '1234' });
    const removed = fakeAdmin(undefined, { data: true, error: null });
    expect(await deleteUserConnection(removed as never, me, 'feishu_base')).toBe(true);
    expect(removed.rpc).toHaveBeenCalledWith('user_connection_delete', { p_profile_id: me, p_provider: 'feishu_base' });
  });

  it('maps database refusals to fixed codes and never passes the raw error on', async () => {
    const closed = fakeAdmin(undefined, { data: null, error: { message: 'CONNECTION_ACCOUNT_CLOSED' } });
    const input = { profileId: me, provider: 'feishu_base', secret: 'pt-secret-value-1234', target: {}, label: null };
    expect(await code(saveUserConnection(closed as never, input))).toBe('CONNECTION_ACCOUNT_CLOSED');
    const other = fakeAdmin(undefined, { data: null, error: { message: 'connection refused at 10.0.0.1' } });
    const error = await saveUserConnection(other as never, input).catch((e: Error) => e);
    expect(error).toBeInstanceOf(UserConnectionError);
    expect((error as Error).message).toBe('CONNECTION_UNAVAILABLE');
    const readFail = fakeAdmin({ data: null, error: { message: 'boom' } });
    expect(await code(readUserConnection(readFail as never, me, 'feishu_base'))).toBe('CONNECTION_UNAVAILABLE');
  });

  it('Pro and Gold only; a failed membership read is "unavailable", not "free"', async () => {
    for (const [level, paid] of [['pro', true], ['gold', true], ['free', false], [undefined, false]] as const) {
      tier.mockResolvedValueOnce(level === undefined ? null : { level });
      expect(await paidConnectorMember({} as never, me)).toBe(paid);
    }
    tier.mockRejectedValueOnce(new Error('db down'));
    expect(await code(paidConnectorMember({} as never, me))).toBe('CONNECTION_UNAVAILABLE');
  });
});
