/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';

// Exercises the real 0144 migration through local SQL and PostgREST (no mocks).
const BANNER = 'announcements?select=id,title,content,type,banner_style,banner_link,tag'
  + '&active=eq.true&announcement_type=eq.banner&order=priority.desc';
const ADMIN_PROFILE = 'id,email,nickname,avatar_url,role,status,membership_level,credits,is_deleted,created_at';
const ACTIVITY = 'id,user_id,admin_id,action,action_type,details,created_at';
const TRANSACTIONS = 'id,user_id,amount,type,description,balance_before,balance_after,ledger_type,'
  + 'reason_code,source_type,created_at';
export const CHANGED_TABLES = ['profiles', 'announcements', 'user_activity_logs'];

const helpers = http => ({
  async denied(role, sub, path, method, body) {
    const response = await http(role, sub, path, method, body);
    assert.equal(response.body?.code, '42501', `${role ?? 'anon'} ${method ?? 'GET'} ${path} must be 42501`);
    assert.equal(response.status, role ? 403 : 401);
  },
  async ok(role, sub, path, method, body) {
    const response = await http(role, sub, path, method, body);
    assert.ok(response.status >= 200 && response.status < 300,
      `${role ?? 'anon'} ${method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  },
});

// Pre-0144 staging state: each S1 A-item fails at the database, not in the router.
export async function verifyBlockers({ sql, http, owner, admin }) {
  const { denied, ok } = helpers(http);
  await denied('authenticated', owner, `profiles?id=eq.${owner}`, 'PATCH', { nickname: 'n' });
  await denied(null, null, BANNER);
  await denied('authenticated', owner, BANNER);
  await denied('service_role', admin, `profiles?select=${ADMIN_PROFILE}`);
  await denied('service_role', admin, `profiles?id=eq.${owner}`, 'PATCH', { status: 'disabled' });
  await denied('service_role', admin, `profiles?id=eq.${owner}`, 'PATCH', { email: 'x@example.test' });
  await denied('service_role', admin, 'announcements', 'POST', { title: 't', content: 'c' });
  await denied('service_role', admin, `user_activity_logs?select=${ACTIVITY}`);
  await denied('service_role', admin, 'user_activity_logs', 'POST', { action: 'x' });
  await denied('service_role', admin, 'credit_transactions?select=*');
  assert.equal((await ok('service_role', admin, `credit_transactions?select=${TRANSACTIONS}`)).length, 2);
  assert.deepEqual(await ok('authenticated', owner, 'system_settings?select=key&key=eq.checkin_day1'), []);
  for (const role of ['anon', 'authenticated']) {
    sql(`BEGIN; SET ROLE ${role}; TRUNCATE user_activity_logs; RESET ROLE; ROLLBACK;`);
  }
}

export async function verifyRepair({ sql, http, deniedSql, owner, other, admin }) {
  const { denied, ok } = helpers(http);
  // A-01 allowed: own nickname only, with the same 1..80 trimmed length as the router.
  const renamed = await ok('authenticated', owner, `profiles?id=eq.${owner}&select=id,nickname`, 'PATCH',
    { nickname: 'renamed' });
  assert.deepEqual(renamed, [{ id: owner, nickname: 'renamed' }]);
  assert.deepEqual(await ok('authenticated', owner, `profiles?id=eq.${other}`, 'PATCH', { nickname: 'x' }), []);
  assert.equal(sql(`SELECT nickname FROM profiles WHERE id='${other}'`), 'other');
  for (const nickname of ['', '   ', 'x'.repeat(81), null]) {
    await denied('authenticated', owner, `profiles?id=eq.${owner}`, 'PATCH', { nickname });
  }
  for (const column of ['role', 'status', 'credits', 'membership_level', 'email', 'avatar_url', 'is_deleted',
    'last_ip', 'id']) {
    const value = column === 'credits' ? 99999 : column === 'id' ? other : 'admin';
    await denied('authenticated', owner, `profiles?id=eq.${owner}`, 'PATCH', { [column]: value });
  }
  await denied('authenticated', owner, 'profiles', 'POST', { id: owner });
  await denied('authenticated', owner, `profiles?id=eq.${owner}`, 'DELETE');
  assert.deepEqual((await ok('authenticated', owner, 'profiles?select=id')).map(x => x.id), [owner]);
  sql(`UPDATE profiles SET is_deleted='true' WHERE id='${other}'`);
  assert.deepEqual(await ok('authenticated', other, `profiles?id=eq.${other}`, 'PATCH', { nickname: 'z' }), []);
  sql(`UPDATE profiles SET is_deleted='false' WHERE id='${other}'`);
  await denied(null, null, 'profiles?select=id');
  await denied(null, null, `profiles?id=eq.${owner}`, 'PATCH', { nickname: 'anon' });

  // A-02 public banner: only granted columns, only rows the existing active policy exposes.
  for (const [role, sub] of [[null, null], ['authenticated', owner], ['authenticated', admin]]) {
    const banners = await ok(role, sub, BANNER);
    // The pre-existing admin SELECT policy also shows an admin JWT expired rows, still column-limited.
    assert.deepEqual(banners.map(x => x.title), sub === admin ? ['expired', 'live'] : ['live']);
    await denied(role, sub, 'announcements?select=icon,created_by');
    await denied(role, sub, 'announcements', 'POST', { title: 't', content: 'c' });
    await denied(role, sub, 'announcements?id=not.is.null', 'PATCH', { title: 'x' });
    await denied(role, sub, 'announcements?id=not.is.null', 'DELETE');
  }

  // A-02/A-04/A-10 service_role: exactly the admin router capabilities.
  const profiles = await ok('service_role', admin, `profiles?select=${ADMIN_PROFILE}&order=email`);
  assert.equal(profiles.length, 3);
  await denied('service_role', admin, 'profiles?select=last_ip');
  await denied('service_role', admin, 'profiles?select=last_login_at');
  const disabled = await ok('service_role', admin, `profiles?id=eq.${other}&select=${ADMIN_PROFILE}`, 'PATCH',
    { status: 'disabled' });
  assert.equal(disabled[0].status, 'disabled');
  await ok('service_role', admin, `profiles?id=eq.${other}&select=id`, 'PATCH', { status: 'active', role: 'user' });
  await ok('service_role', admin, `profiles?id=eq.${other}&select=id`, 'PATCH', { email: 'other@example.test' });
  for (const column of ['credits', 'nickname', 'avatar_url', 'is_deleted', 'last_ip']) {
    await denied('service_role', admin, `profiles?id=eq.${other}`, 'PATCH', { [column]: column === 'credits' ? 1 : 'x' });
  }
  const created = await ok('service_role', admin, 'announcements?select=id', 'POST', {
    title: 't', content: 'c', announcement_type: 'banner', banner_link: '/pricing', created_by: admin,
  });
  await ok('service_role', admin, `announcements?id=eq.${created[0].id}`, 'PATCH', { title: 'u', updated_at: new Date().toISOString() });
  await denied('service_role', admin, `announcements?id=eq.${created[0].id}`, 'PATCH', { created_by: owner });
  await ok('service_role', admin, `announcements?id=eq.${created[0].id}`, 'DELETE');
  // Like the router (no returning *): ip_address stays unreadable to service_role.
  await ok('service_role', admin, 'user_activity_logs?select=id', 'POST', {
    user_id: other, admin_id: admin, action: 'fixture', action_type: 'status_change', details: {},
  });
  await denied('service_role', admin, 'user_activity_logs', 'POST', { action: 'x', ip_address: '192.0.2.9' });
  const logs = await ok('service_role', admin, `user_activity_logs?select=${ACTIVITY},`
    + 'user:profiles!user_id(id,email,nickname,avatar_url),admin:profiles!admin_id(id,email,nickname,avatar_url)');
  assert.equal(logs.length, 2);
  assert.equal(logs[0].admin.id, admin);
  await denied('service_role', admin, 'user_activity_logs?select=ip_address');
  await denied('service_role', admin, 'user_activity_logs?id=not.is.null', 'PATCH', { action: 'rewrite' });
  await denied('service_role', admin, 'user_activity_logs?id=not.is.null', 'DELETE');
  assert.equal((await ok('service_role', admin, `credit_transactions?select=${TRANSACTIONS}`)).length, 2);
  await denied('service_role', admin, 'credit_transactions?select=*');

  // Audit history stays server-only; the admin JWT path does not bypass it.
  for (const [role, sub] of [[null, null], ['authenticated', owner], ['authenticated', admin]]) {
    await denied(role, sub, `user_activity_logs?select=${ACTIVITY}`);
    await denied(role, sub, 'user_activity_logs', 'POST', { action: 'x' });
  }
  for (const table of CHANGED_TABLES) {
    for (const role of ['anon', 'authenticated']) {
      deniedSql(role, `TRUNCATE ${table}`);
      for (const privilege of ['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
        assert.equal(sql(`SELECT has_table_privilege('${role}','${table}','${privilege}')`), 'f');
      }
    }
  }
}
