// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
// Synthetic identities only; run with packages/db/tests/run-erasure-e.mjs --local-only.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { router, protectedProcedure, createRuntimeBudget } from '../../trpc';
import { confirmAccountErasure } from './service';
import { openingGrantDigests } from './openingGrantIdentity';

vi.mock('../redisRateLimiter', () => ({ checkRateLimitOrThrow: vi.fn().mockResolvedValue({ success: true }) }));
const restUrl = process.env.ERASURE_E_LOCAL_REST!;
const authUrl = process.env.ERASURE_E_LOCAL_AUTH!;
const dbUrl = process.env.ERASURE_E_LOCAL_DB!;
for (const url of [restUrl, authUrl]) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? '')) throw new Error('Local isolated runner required');
}
if (!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/erasure_e$/.test(dbUrl ?? '')) throw new Error('Local DB required');
const fetchLocal: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== restUrl) throw new Error('Non-local request forbidden');
  return fetch(new URL(target.pathname.replace(/^\/(auth|rest)\/v1/, '') + target.search,
    target.pathname.startsWith('/auth/v1') ? authUrl : restUrl), init);
};
const client = (key: string) => createClient(restUrl, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchLocal },
});
const admin = client(process.env.ERASURE_E_SERVICE_JWT!);
const db = new pg.Client({ connectionString: dbUrl });
const PASSWORD = 'test-only-erasure-e-password';
const oldKeys = process.env.OPENING_GRANT_HMAC_KEYS!;
const nextKeys = JSON.stringify({ active: 'test-v2', keys: {
  'test-v1': Buffer.from('test-only-opening-grant-key-00001').toString('base64'),
  'test-v2': Buffer.from('test-only-opening-grant-key-00002').toString('base64'),
} });
beforeAll(async () => { await db.connect(); });
afterAll(async () => { process.env.OPENING_GRANT_HMAC_KEYS = oldKeys; await db.end(); });
const balance = async (id: string) => (await db.query('SELECT credits FROM profiles WHERE id=$1', [id])).rows[0]?.credits;
const decisionCount = async (id: string) => Number((await db.query(
  "SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND idempotency_key='opening_grant:'||$1::text", [id],
)).rows[0].count);

async function account(email = `test-${randomUUID()}@example.test`) {
  const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (created.error || !created.data.user) throw new Error('Synthetic Auth account creation failed');
  const session = client(process.env.ERASURE_E_ANON_JWT!);
  const signed = await session.auth.signInWithPassword({ email: created.data.user.email!, password: PASSWORD });
  if (signed.error || !signed.data.user) throw new Error('Synthetic Auth sign-in failed');
  return { user: signed.data.user, session };
}

async function bootstrap(user: User, session: SupabaseClient) {
  const test = router({ probe: protectedProcedure.query(({ ctx }) => ctx.profileId) });
  const ctx = { user, headers: new Headers(), supabase: session, supabaseAuth: session, supabasePublic: session,
    supabaseAdmin: admin, hasSupabaseAdminPrivileges: true, isEmailVerified: true, authProvider: 'email',
    runtimeBudget: createRuntimeBudget() } as unknown as Parameters<typeof test.createCaller>[0];
  expect(await test.createCaller(ctx).probe()).toBe(user.id);
  return balance(user.id);
}

async function close(user: User, session: SupabaseClient) {
  const result = await confirmAccountErasure({ admin, authClient: session, userId: user.id,
    requestId: randomUUID(), nowMs: Date.now() });
  expect(result.created).toBe(true);
  expect(result.authRevoked).toBe(true);
  const blocked = await admin.rpc('opening_grant_claim', { p_profile_id: user.id, p_digests: openingGrantDigests(user) });
  expect(blocked.error?.code).toBe('42501');
  // Simulate PR-C Auth/identity removal, on this disposable fixture only. Financial profile stays.
  await db.query('UPDATE profiles SET email=NULL, nickname=NULL WHERE id=$1', [user.id]);
  expect((await admin.auth.admin.deleteUser(user.id)).error).toBeNull();
}

it('real Auth normalization, bootstrap, closure and same-email re-registration suppress the grant', async () => {
  const email = `Test.Case+Alias-${randomUUID()}@EXAMPLE.TEST`;
  // Auth rejects raw whitespace; the digest normalization also handles surrounding UI input.
  const invalid = await admin.auth.admin.createUser({ email: `  ${email}  `, password: PASSWORD, email_confirm: true });
  expect(invalid.error?.status).toBe(400);
  const first = await account(email);
  expect(first.user.email).toBe(email.toLowerCase());
  expect(openingGrantDigests({ ...first.user, email: ` ${email} ` })).toEqual(openingGrantDigests(first.user));
  expect(await bootstrap(first.user, first.session)).toBe(100);
  await close(first.user, first.session);
  const again = await account(email.toLowerCase());
  expect(again.user.id).not.toBe(first.user.id);
  expect(await bootstrap(again.user, again.session)).toBe(0);
  expect(await bootstrap(again.user, again.session)).toBe(0);
  expect(await decisionCount(again.user.id)).toBe(1);
  expect((await db.query('SELECT amount,reason_code FROM credit_transactions WHERE user_id=$1', [again.user.id])).rows)
    .toEqual([{ amount: 0, reason_code: 'opening_grant_ineligible' }]);
  // Purchases keep using the existing ledger without an identity eligibility restriction.
  const bought = await admin.rpc('atomic_apply_credit_ledger_entry', { p_user_id: again.user.id, p_amount: 50,
    p_type: 'purchase', p_description: 'Synthetic test purchase', p_idempotency_key: `test-purchase:${again.user.id}` });
  expect(bought.error).toBeNull();
  expect(await balance(again.user.id)).toBe(50);
  const other = await account();
  expect(await bootstrap(other.user, other.session)).toBe(100);
});

it('same Google issuer+subject after identity deletion is denied even with a different email', async () => {
  const subject = `test-google-${randomUUID()}`;
  const first = await account();
  // Only a local fixture: model the verified identity GoTrue stores after Google authentication.
  const google = async (user: User) => {
    await db.query("UPDATE auth.identities SET provider='google',provider_id=$2,identity_data="
      + "jsonb_build_object('sub',$2::text,'iss','https://accounts.google.com','email',$3::text) WHERE user_id=$1",
    [user.id, subject, user.email]);
    const result = await admin.auth.admin.getUserById(user.id);
    if (!result.data.user) throw new Error('Synthetic Google identity lookup failed');
    return result.data.user;
  };
  const original = await google(first.user);
  expect(await bootstrap(original, first.session)).toBe(100);
  await close(original, first.session);
  const second = await account();
  expect(await bootstrap(await google(second.user), second.session)).toBe(0);
  const distinct = await account();
  expect(await bootstrap(distinct.user, distinct.session)).toBe(100);
});

it('legacy ledger facts are remembered before closing; never fabricate a grant for an ungranted account', async () => {
  const legacy = await account();
  await db.query('INSERT INTO profiles(id,email) VALUES($1,$2)', [legacy.user.id, legacy.user.email]);
  await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1::uuid,100,'addition','Synthetic prior gift',"
    + "'opening_grant:'||($1::uuid)::text)", [legacy.user.id]);
  const grantedAt = (await db.query('SELECT created_at FROM credit_transactions WHERE user_id=$1', [legacy.user.id])).rows[0].created_at;
  await close(legacy.user, legacy.session);
  const digest = openingGrantDigests(legacy.user)[0];
  const stored = (await db.query('SELECT first_granted_at FROM opening_grant_identity_digests WHERE digest=$1', [digest.digest])).rows[0];
  expect(stored.first_granted_at).toEqual(grantedAt);
  const none = await account();
  await db.query('INSERT INTO profiles(id,email) VALUES($1,$2)', [none.user.id, none.user.email]);
  await close(none.user, none.session);
  const empty = await db.query('SELECT count(*) FROM opening_grant_identity_digests WHERE digest=$1',
    [openingGrantDigests(none.user)[0].digest]);
  expect(Number(empty.rows[0].count)).toBe(0);
});

it('old key version still matches after rotation and denial survives later email changes', async () => {
  const first = await account();
  expect(await bootstrap(first.user, first.session)).toBe(100);
  await close(first.user, first.session);
  process.env.OPENING_GRANT_HMAC_KEYS = nextKeys;
  try {
    const again = await account(first.user.email);
    expect(await bootstrap(again.user, again.session)).toBe(0);
    const all = openingGrantDigests(again.user);
    for (const digest of all) {
      expect(Number((await db.query('SELECT count(*) FROM opening_grant_identity_digests WHERE key_version=$1 AND digest=$2',
        [digest.key_version, digest.digest])).rows[0].count)).toBe(1);
    }
    const changed = { ...again.user, email: `test-new-${randomUUID()}@example.test` };
    const result = await admin.rpc('opening_grant_claim', { p_profile_id: changed.id, p_digests: openingGrantDigests(changed) });
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ granted: false });
    expect(await balance(changed.id)).toBe(0);
    const missingOldVersion = await admin.rpc('opening_grant_claim', { p_profile_id: changed.id,
      p_digests: openingGrantDigests(changed).filter(digest => digest.key_version === 'test-v2') });
    expect(missingOldVersion.error?.message).toContain('OPENING_GRANT_KEY_VERSION_MISSING');
  } finally {
    // A later test cannot legitimately drop v2 once this fixture has stored v2 facts.
    process.env.OPENING_GRANT_HMAC_KEYS = nextKeys;
  }
});

it('a real two-session advisory-lock barrier allows exactly one grant across new account IDs', async () => {
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await db.query('INSERT INTO profiles(id) VALUES($1)', [id]);
  const synthetic = { email: `test-race-${randomUUID()}@example.test`, identities: [] } as unknown as User;
  const digests = JSON.stringify(openingGrantDigests(synthetic));
  const a = new pg.Client({ connectionString: dbUrl }), b = new pg.Client({ connectionString: dbUrl });
  await a.connect(); await b.connect();
  try {
    await a.query('BEGIN; SET LOCAL ROLE service_role');
    await b.query('BEGIN; SET LOCAL ROLE service_role');
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    expect((await a.query('SELECT opening_grant_claim($1,$2) AS result', [ids[0], digests])).rows[0].result.granted).toBe(true);
    const waiting = b.query('SELECT opening_grant_claim($1,$2) AS result', [ids[1], digests]);
    let barrier = false;
    for (let n = 0; n < 100; n++) {
      const state = (await db.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      if (state?.wait_event_type === 'Lock' && state.wait_event === 'advisory') { barrier = true; break; }
      await new Promise(done => setTimeout(done, 20));
    }
    expect(barrier).toBe(true);
    await a.query('COMMIT');
    expect((await waiting).rows[0].result.granted).toBe(false);
    await b.query('COMMIT');
    expect(await balance(ids[0])).toBe(100);
    expect(await balance(ids[1])).toBe(0);
    expect(await decisionCount(ids[0])).toBe(1);
    expect(await decisionCount(ids[1])).toBe(1);
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); await a.end(); await b.end(); }
});

it('digest write failures roll back both grant and closure; failed PR-A prerequisites leave no digest', async () => {
  await db.query("CREATE FUNCTION erasure_e_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$"
    + "BEGIN RAISE EXCEPTION 'TEST_DIGEST_WRITE_FAILED'; END $$;"
    + 'CREATE TRIGGER erasure_e_test_fail BEFORE INSERT ON opening_grant_identity_digests'
    + ' FOR EACH ROW EXECUTE FUNCTION erasure_e_test_fail()');
  try {
    const user = await account();
    await db.query('INSERT INTO profiles(id,email) VALUES($1,$2)', [user.user.id, user.user.email]);
    const grant = await admin.rpc('opening_grant_claim', { p_profile_id: user.user.id, p_digests: openingGrantDigests(user.user) });
    expect(grant.error?.message).toContain('TEST_DIGEST_WRITE_FAILED');
    expect(await balance(user.user.id)).toBe(0);
    expect(await decisionCount(user.user.id)).toBe(0);
    await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1::uuid,100,'addition','Synthetic prior gift',"
      + "'opening_grant:'||($1::uuid)::text)", [user.user.id]);
    await expect(confirmAccountErasure({ admin, authClient: user.session, userId: user.user.id,
      requestId: randomUUID(), nowMs: Date.now() })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((await db.query('SELECT status FROM profiles WHERE id=$1', [user.user.id])).rows[0].status).toBe('active');
    expect(Number((await db.query('SELECT count(*) FROM account_erasure_requests WHERE profile_id=$1', [user.user.id])).rows[0].count)).toBe(0);
    expect(await balance(user.user.id)).toBe(100);
    const digest = openingGrantDigests(user.user)[0].digest;
    expect(Number((await db.query('SELECT count(*) FROM opening_grant_identity_digests WHERE digest=$1', [digest])).rows[0].count)).toBe(0);
  } finally { await db.query('DROP TRIGGER erasure_e_test_fail ON opening_grant_identity_digests; DROP FUNCTION erasure_e_test_fail()'); }
  const operator = await account();
  await db.query("INSERT INTO profiles(id,email,role) VALUES($1,$2,'admin')", [operator.user.id, operator.user.email]);
  await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1::uuid,100,'addition','Synthetic prior gift',"
    + "'opening_grant:'||($1::uuid)::text)", [operator.user.id]);
  await expect(confirmAccountErasure({ admin, authClient: operator.session, userId: operator.user.id,
    requestId: randomUUID(), nowMs: Date.now() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(Number((await db.query('SELECT count(*) FROM opening_grant_identity_digests WHERE digest=$1',
    [openingGrantDigests(operator.user)[0].digest])).rows[0].count)).toBe(0);
});

it('new sessions deny all client digest reads/writes and RPCs; service read allowed, bypass denied', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const statement of [
      'SELECT * FROM opening_grant_identity_digests',
      "INSERT INTO opening_grant_identity_digests(kind,key_version,digest,first_granted_at) VALUES('email','v1',repeat('0',64),now())",
      "UPDATE opening_grant_identity_digests SET expires_when='opening_grant_rule_removed'",
      'DELETE FROM opening_grant_identity_digests',
      "SELECT opening_grant_claim(NULL,'[]')",
      "SELECT opening_grant_remember(NULL,'[]',false)",
      "SELECT account_erasure_confirm_with_digests(NULL,NULL,'[]')",
    ]) {
      const session = new pg.Client({ connectionString: dbUrl });
      await session.connect();
      try { await session.query(`SET ROLE ${role}`); await expect(session.query(statement)).rejects.toMatchObject({ code: '42501' }); }
      finally { await session.end(); }
    }
  }
  const session = new pg.Client({ connectionString: dbUrl });
  await session.connect();
  try {
    await session.query('SET ROLE service_role');
    expect(Number((await session.query('SELECT count(*) FROM opening_grant_identity_digests')).rows[0].count)).toBeGreaterThan(0);
    await expect(session.query('SELECT account_erasure_confirm(NULL,NULL)')).rejects.toMatchObject({ code: '42501' });
    await expect(session.query("SELECT opening_grant_remember(NULL,'[]',false)")).rejects.toMatchObject({ code: '42501' });
  } finally { await session.end(); }
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public'"
    + " AND table_name='opening_grant_identity_digests' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  expect(columns).toEqual(['purpose', 'kind', 'key_version', 'digest', 'first_granted_at', 'expires_when']);
  const bad = await db.query("SELECT count(*) FROM opening_grant_identity_digests WHERE digest !~ '^[0-9a-f]{64}$'"
    + " OR purpose <> 'opening_grant' OR expires_when <> 'opening_grant_rule_removed'");
  expect(Number(bad.rows[0].count)).toBe(0);
  const rows = JSON.stringify((await db.query('SELECT * FROM opening_grant_identity_digests')).rows);
  for (const original of ['@', 'google.com', 'test-google-', 'test-only-opening-grant-key']) expect(rows).not.toContain(original);
});
