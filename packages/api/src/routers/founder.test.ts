/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { founderRouter } from './founder';
import { readFounderWallPublic } from '../services/founder/member';

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const status = { state: 'active', orderId: id(9), foundedAt: '2026-10-01T00:00:00Z', periodEnd: '2027-10-01T00:00:00Z',
  deadline: null, endedAt: null, endedReason: null };
const member = { founder: status, consent: { purpose: 'founder_wall', currentVersion: 'fw-v1', granted: true,
  version: 'fw-v1', grantedAt: '2026-10-02T00:00:00Z', revokedAt: null }, entry: null, listed: false, community: null };
const entry = { displayName: '小灰', socialAccounts: [], productName: null, productUrl: null, intro: null };

function fixture(options: { user?: boolean; role?: string; error?: string; data?: unknown; setting?: unknown } = {}) {
  const rpc = vi.fn((name: string) => Promise.resolve(options.error ? { data: null, error: { message: options.error } }
    : { data: options.data ?? (name.startsWith('founder_member') || name.startsWith('founder_wall_') ? member : []), error: null }));
  const profile = { id: id(1), role: options.role ?? 'user', status: 'active', credits: 0, nickname: 'n' };
  let table = '';
  const reads: string[] = [];
  const adminReads: string[] = [];
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({
    data: table === 'system_settings' ? options.setting === undefined ? null : { value: options.setting } : profile,
    error: null,
  }),
    single: async () => ({ data: profile, error: null }) };
  const userDb = { rpc, from: (name: string) => { table = name; reads.push(name); return q; } };
  const adminDb = { rpc, from: (name: string) => { adminReads.push(name); return q; } };
  const caller = founderRouter.createCaller({ headers: new Headers(),
    user: options.user === false ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: userDb, supabaseAuth: userDb, supabasePublic: {},
    supabaseAdmin: adminDb, hasSupabaseAdminPrivileges: true } as never);
  const calls = () => rpc.mock.calls.filter(([name]) => /founder/.test(String(name)));
  return { caller, rpc, calls, reads, adminReads };
}

it('members read, submit and withdraw only their own card', async () => {
  const f = fixture();
  expect(await f.caller.me()).toEqual(member);
  await f.caller.submitWall({ entry, consentVersion: 'fw-v1' });
  await f.caller.withdrawWall();
  expect(f.calls()).toEqual([
    ['founder_member_state', { a: id(1) }],
    ['founder_wall_submit', { a: id(1), p_entry: entry, p_version: 'fw-v1' }],
    ['founder_wall_withdraw', { a: id(1) }],
  ]);
});

it('input cannot name another profile or carry an unsafe link', async () => {
  const f = fixture();
  await expect(f.caller.submitWall({ entry: { ...entry, userId: id(2) }, consentVersion: 'fw-v1' } as never))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(f.caller.submitWall({ entry: { ...entry, productName: 'p', productUrl: 'javascript:alert(1)' },
    consentVersion: 'fw-v1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.calls()).toEqual([]);
});

it('anonymous callers and non-admins are refused before any founder RPC', async () => {
  const anonymous = fixture({ user: false });
  await expect(anonymous.caller.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  const user = fixture();
  await expect(user.caller.admin.overview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(user.caller.admin.markCommunity({ userId: id(2), action: 'joined' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(user.caller.admin.recordLivestream({ requestId: id(3), heldOn: '2026-10-15', topic: 't', replayUrl: null }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect([...anonymous.calls(), ...user.calls()]).toEqual([]);
});

it('admin actions pass the admin id from the session and the card version the admin saw', async () => {
  const f = fixture({ role: 'admin', data: { ...entry, reviewState: 'approved', reviewedAt: 'x', updatedAt: 'y', listed: true } });
  await f.caller.admin.reviewWall({ userId: id(2), decision: 'approved', seenUpdatedAt: '2026-10-16 01:02:03.123456+00' });
  expect(f.calls()).toEqual([['founder_wall_review', { p_actor: id(1), p_user: id(2), p_decision: 'approved',
    p_seen_updated_at: '2026-10-16 01:02:03.123456+00' }]]);
});

it('admins can read the current community entry from the settings row', async () => {
  const current = { url: 'https://example.com/community', note: '申请时注明创始会员',
    updatedBy: id(1), updatedAt: '2026-10-18T12:00:00Z' };
  const f = fixture({ role: 'admin', setting: current });
  await expect(f.caller.admin.communityEntry()).resolves.toEqual(current);
  expect(f.reads).toContain('system_settings');
  expect(f.adminReads).not.toContain('system_settings');
  expect(f.calls()).toEqual([]);
});

it('admins receive null when no community entry has been configured', async () => {
  const f = fixture({ role: 'admin' });
  await expect(f.caller.admin.communityEntry()).resolves.toBeNull();
});

it('non-admins cannot read the current community entry', async () => {
  const f = fixture();
  await expect(f.caller.admin.communityEntry()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.reads).not.toContain('system_settings');
  expect(f.calls()).toEqual([]);
});

it.each([
  ['FOUNDER_WALL_VERSION_STALE', 'CONFLICT'], ['FOUNDER_WALL_NOT_FOUNDER', 'FORBIDDEN'],
  ['FOUNDER_ACCOUNT_CLOSED', 'FORBIDDEN'], ['FOUNDER_WALL_INPUT_INVALID', 'BAD_REQUEST'],
  ['relation does not exist', 'INTERNAL_SERVER_ERROR'],
])('maps %s to %s without leaking database text', async (message, code) => {
  const f = fixture({ error: message });
  const error = await f.caller.submitWall({ entry, consentVersion: 'fw-v1' }).catch(e => e);
  expect(error).toMatchObject({ code });
  expect(error.message).toMatch(/^FOUNDER_[A-Z_]+$/);
});

it('the public read drops a card whose stored link no longer passes the render check', async () => {
  const ok = { ...entry, productName: 'p', productUrl: 'https://example.com/' };
  const bad = { ...entry, socialAccounts: [{ platform: 'x', handle: 'h', url: 'https://u@evil.example/' }] };
  const rpc = vi.fn(async () => ({ data: [ok, bad], error: null }));
  expect(await readFounderWallPublic({ rpc } as never)).toEqual([ok]);
});
