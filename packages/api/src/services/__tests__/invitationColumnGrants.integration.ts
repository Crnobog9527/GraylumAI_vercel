/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { invitationRouter } from '../../routers/invitation';
import { createTRPCContext } from '../../trpc';

const enabled = process.env.C4B_LOCAL_ONLY === 'true';
const root = resolve(import.meta.dirname, '../../../../..');
const allowed = ['id', 'created_at', 'invitee_email', 'inviter_reward', 'status', 'inviter_id'];
const displayed = allowed.filter(column => column !== 'inviter_id').sort();
const denied = ['invite_code', 'inviter_email', 'invitee_id', 'risk_level', 'block_reason',
  'invitee_reward', 'ip_address', 'user_agent', 'rewarded_at'];
const columns = [...allowed, ...denied].sort();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const local = (value: string | undefined) => {
  if (!value || new URL(value).hostname !== '127.0.0.1') throw new Error('Local runner required');
  return value;
};

describe.skipIf(!enabled).sequential('C4b real local Auth/PostgREST invitation permissions', () => {
  let db: ReturnType<typeof postgres>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let migration: string;
  let beforeAcl: unknown;
  let beforeRows: unknown;
  let beforeOtherAcl: unknown;
  let beforeServiceAcl: unknown;
  type Identity = { id: string; email: string; token: string; client: SupabaseClient };
  const people: Identity[] = [];
  let recordId: string;
  let claimCode: string;
  const caller = async (person: Identity) => invitationRouter.createCaller(await createTRPCContext({
    headers: new Headers({ Authorization: `Bearer ${person.token}`, 'x-forwarded-for': '192.0.2.9',
      'user-agent': 'synthetic-c4b-local' }),
  }));
  const acl = async () => ({
    columns: await db`SELECT r, a.attname,
      has_column_privilege(r, a.attrelid, a.attnum, 'SELECT') AS readable
      FROM pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE a.attrelid='public.invitation_records'::regclass AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY r,a.attname`,
    policies: await db`SELECT policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies WHERE schemaname='public' AND tablename='invitation_records' ORDER BY policyname`,
  });
  const rows = () => db`SELECT md5(string_agg(row_to_json(r)::text, '' ORDER BY id)) AS digest
    FROM public.invitation_records r`;
  const otherAcl = () => db`SELECT c.relname,c.relacl::text,a.attname,a.attacl::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'invitation_records'
    ORDER BY c.relname,a.attname`;
  const serviceAcl = () => db`SELECT p, has_table_privilege('service_role','public.invitation_records',p) AS granted
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`;
  const apply = () => db.unsafe(migration);

  beforeAll(async () => {
    const url = local(process.env.NEXT_PUBLIC_SUPABASE_URL);
    db = postgres(local(process.env.C4B_LOCAL_DB), { max: 1, onnotice: () => {} });
    const names = readdirSync(resolve(root, 'packages/db/migrations'))
      .filter(name => /^\d{4}_invitation_records_column_grants\.sql$/.test(name));
    expect(names).toHaveLength(1);
    migration = read(`packages/db/migrations/${names[0]}`);
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
    anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);
    for (let i = 0; i < 4; i++) {
      // Generated identities and passwords exist only in this disposable local run.
      const email = `${randomUUID()}@example.test`, password = randomUUID() + 'Aa1!';
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);
      const signed = await client.auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull();
      people.push({ id, email, token: signed.data.session!.access_token, client });
      const profile = await admin.from('profiles').insert({ id, email, nickname: 'Synthetic',
        role: i === 3 ? 'admin' : 'user', credits: 100, created_at: '2026-01-01T00:00:00Z' });
      expect(profile.error).toBeNull();
    }
    claimCode = randomUUID();
    expect((await admin.from('invitations').insert({ code: claimCode, created_by: people[0].id })).error).toBeNull();
    recordId = randomUUID();
    const seeded = await admin.from('invitation_records').insert([
      { id: recordId, invite_code: randomUUID(), inviter_id: people[0].id, inviter_email: people[0].email,
        invitee_id: people[1].id, invitee_email: people[1].email, status: 'pending', ip_address: '192.0.2.1',
        user_agent: 'synthetic-c4b', risk_level: 'medium', block_reason: 'synthetic-only' },
      { invite_code: randomUUID(), inviter_id: people[2].id, inviter_email: people[2].email,
        invitee_id: people[0].id, invitee_email: people[0].email, status: 'pending' },
    ], { defaultToNull: false });
    expect(seeded.error).toBeNull();
    const actual = await db`SELECT attname FROM pg_attribute WHERE attrelid='invitation_records'::regclass
      AND attnum>0 AND NOT attisdropped ORDER BY attname`;
    expect(actual.map(row => row.attname)).toEqual(columns);
    beforeAcl = await acl(); beforeRows = await rows(); beforeOtherAcl = await otherAcl();
    beforeServiceAcl = await serviceAcl();
  }, 30000);
  afterAll(async () => { if (db) await db.end(); });

  it('reproduces both original direct-read leaks using real signed-in clients', async () => {
    const inviter = await people[0].client.from('invitation_records').select('*').eq('id', recordId).single();
    expect(inviter.error).toBeNull();
    expect(inviter.data.ip_address).toBe('192.0.2.1');
    const invitee = await people[1].client.from('invitation_records').select('inviter_email').eq('id', recordId).single();
    expect(invitee.error).toBeNull();
    expect(invitee.data.inviter_email).toBe(people[0].email);
  });

  it('applies twice with identical ACL and rows, preserving service and unrelated grants', async () => {
    await apply();
    const first = await acl();
    await apply();
    expect(await acl()).toEqual(first);
    expect(await rows()).toEqual(beforeRows);
    expect(await otherAcl()).toEqual(beforeOtherAcl);
    expect(await serviceAcl()).toEqual(beforeServiceAcl);
    for (const row of first.columns) {
      expect(row.readable).toBe(row.r === 'service_role' || (row.r === 'authenticated' && allowed.includes(row.attname)));
    }
    expect(first.policies.map(row => row.policyname)).toEqual(['invitation_records_select_own']);
  });

  it('both unchanged protected API procedures return the five display fields and existing summary', async () => {
    const user = await caller(people[0]);
    const records = await user.getMyInvitationRecords();
    const dashboard = await user.getMyInvitationDashboard();
    for (const list of [records, dashboard.records]) {
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(recordId);
      expect(Object.keys(list[0]).sort()).toEqual(displayed);
    }
    expect(dashboard.invitationCode).toBe(claimCode);
    expect(dashboard.summary).toEqual({ totalInvites: 1, rewardedInvites: 0, pendingInvites: 1 });
    expect(dashboard.rewards).toEqual({ inviterReward: 50, inviteeReward: 30 });
    // The no-existing-code branch still inserts and returns an invitation.
    const newDashboard = await (await caller(people[1])).getMyInvitationDashboard();
    expect(newDashboard.invitationCode).toBeTruthy();
    expect(newDashboard.records).toEqual([]);
  });

  it.each(denied)('denies direct SELECT and filter access to %s', async column => {
    for (const query of [people[0].client.from('invitation_records').select(column),
      people[0].client.from('invitation_records').select('id').not(column, 'is', null)]) {
      const result = await query;
      expect(result.error?.code).toBe('42501');
      expect(result.data).toBeNull();
    }
  });

  it('denies SELECT *, invitee identity disclosure, other users, and anonymous reads', async () => {
    for (const person of people) {
      const all = await person.client.from('invitation_records').select('*');
      expect(all.error?.code).toBe('42501');
      expect(all.data).toBeNull();
    }
    for (const index of [1, 2, 3]) {
      const scoped = await people[index].client.from('invitation_records').select(allowed.join(',')).eq('id', recordId);
      expect(scoped.error).toBeNull();
      expect(scoped.data).toEqual([]);
    }
    const email = await people[1].client.from('invitation_records').select('inviter_email');
    expect(email.error?.code).toBe('42501');
    for (const selection of ['*', 'id', allowed.join(',')]) {
      const anonymous = await anon.from('invitation_records').select(selection);
      expect(anonymous.error?.code).toBe('42501');
      expect(anonymous.data).toBeNull();
    }
  });

  it('proves RLS may reference an ungranted column while explicit WHERE requires SELECT', async () => {
    const privilege = await db`SELECT has_column_privilege('authenticated','invitation_records','invitee_id','SELECT') AS allowed`;
    expect(privilege[0].allowed).toBe(false);
    await expect(db.begin(async tx => {
      await tx.unsafe(`DROP POLICY invitation_records_select_own ON invitation_records;
        CREATE POLICY invitation_records_select_own ON invitation_records FOR SELECT TO authenticated
        USING (auth.uid() = invitee_id);`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: people[1].id })}, true)`;
      await tx.unsafe('SET LOCAL ROLE authenticated');
      expect((await tx`SELECT id FROM invitation_records WHERE id=${recordId}`)).toHaveLength(1);
      throw new Error('ROLLBACK_C4B_PROBE');
    })).rejects.toThrow('ROLLBACK_C4B_PROBE');
    const filter = await people[1].client.from('invitation_records').select('id').eq('invitee_id', people[1].id);
    expect(filter.error?.code).toBe('42501');
    const owner = await people[0].client.from('invitation_records').select('id').eq('inviter_id', people[0].id);
    expect(owner.error).toBeNull();
    expect(owner.data).toHaveLength(1);
  });

  it('adminProcedure retains all columns through service_role and ordinary users cannot call it', async () => {
    const result = await (await caller(people[3])).getAllInvitationRecords();
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]).sort()).toEqual(columns);
    await expect((await caller(people[0])).getAllInvitationRecords()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rollback restores the baseline ACL/policies and exposure; reapplication closes them again', async () => {
    await db.unsafe(read('packages/db/tests/invitation-column-grants-rollback.sql'));
    expect(await acl()).toEqual(beforeAcl);
    expect(await rows()).toEqual(beforeRows);
    expect(await otherAcl()).toEqual(beforeOtherAcl);
    const restored = await people[1].client.from('invitation_records').select('inviter_email').eq('id', recordId).single();
    expect(restored.error).toBeNull();
    expect(restored.data.inviter_email).toBe(people[0].email);
    await apply();
    expect((await people[0].client.from('invitation_records').select('*')).error?.code).toBe('42501');
  });

  it('removes stray column/PUBLIC grants and grants to a future internal column', async () => {
    await db.unsafe(`ALTER TABLE invitation_records ADD COLUMN c4b_internal_probe text;
      GRANT SELECT (ip_address, c4b_internal_probe) ON invitation_records TO authenticated;
      GRANT SELECT (user_agent) ON invitation_records TO anon;
      GRANT SELECT (risk_level) ON invitation_records TO PUBLIC;`);
    try {
      await apply();
      for (const role of ['anon', 'authenticated']) {
        const result = await db`SELECT has_column_privilege(${role},'invitation_records','c4b_internal_probe','SELECT') AS allowed`;
        expect(result[0].allowed).toBe(false);
      }
      expect((await people[0].client.from('invitation_records').select('ip_address')).error?.code).toBe('42501');
      expect((await anon.from('invitation_records').select('user_agent')).error?.code).toBe('42501');
    } finally { await db.unsafe('ALTER TABLE invitation_records DROP COLUMN c4b_internal_probe'); }
    expect(await serviceAcl()).toEqual(beforeServiceAcl);
  });

  it('claimInvitationCode awards both parties exactly once with concurrent retries', async () => {
    const [first, second] = await Promise.all([
      (await caller(people[1])).claimInvitationCode({ code: claimCode }),
      (await caller(people[1])).claimInvitationCode({ code: claimCode }),
    ]);
    expect([first.status, second.status].sort()).toEqual(['already_claimed', 'claimed']);
    const balances = await db`SELECT id,credits FROM profiles WHERE id IN (${people[0].id},${people[1].id})`;
    expect(balances.find(row => row.id === people[0].id)?.credits).toBe(150);
    expect(balances.find(row => row.id === people[1].id)?.credits).toBe(130);
    const records = await admin.from('invitation_records').select('*').eq('invite_code', claimCode);
    expect(records.error).toBeNull();
    expect(records.data).toHaveLength(1);
    expect(records.data![0].status).toBe('rewarded');
    const ledger = await db`SELECT amount FROM credit_transactions WHERE user_id IN (${people[0].id},${people[1].id})`;
    expect(ledger.map(row => row.amount).sort((a,b) => a-b)).toEqual([30, 50]);
    const dashboard = await (await caller(people[0])).getMyInvitationDashboard();
    expect(dashboard.summary).toEqual({ totalInvites: 2, rewardedInvites: 1, pendingInvites: 1 });
  });
});
