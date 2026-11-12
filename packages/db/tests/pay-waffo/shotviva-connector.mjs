/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** INTEGRATION-SHOTVIVA PR A migration: profiles.shotviva_account_id (service-written, unique, erased with the account)
 * and the 'shotviva' partner-key slot. In this suite because it is a CI suite that builds the whole schema; the connect
 * flow itself is unit-tested (packages/api/src/services/connectors/shotviva). */
export async function shotvivaConnectorCases({ admin, service, connect }) {
  const migrations = resolve(import.meta.dirname, '../../migrations');
  const file = readdirSync(migrations).find(name => /^\d{4}_shotviva_connector\.sql$/.test(name));
  assert.ok(file, 'the connector migration exists');
  const privilege = async (role, kind) => (await admin.query(
    "SELECT has_column_privilege($1,'public.profiles','shotviva_account_id',$2) AS v", [role, kind])).rows[0].v;
  assert.equal(await privilege('service_role', 'UPDATE'), true);
  assert.equal(await privilege('service_role', 'SELECT'), true);
  for (const role of ['anon', 'authenticated']) assert.equal(await privilege(role, 'UPDATE'), false, role);

  const newProfile = async () => {
    const id = randomUUID();
    await admin.query("INSERT INTO profiles(id,credits,status) VALUES($1,0,'active')", [id]);
    return id;
  };
  const [a, b] = [await newProfile(), await newProfile()];
  const account = randomUUID();
  const link = (id, value) => service.query('UPDATE profiles SET shotviva_account_id=$2 WHERE id=$1 RETURNING id', [id, value]);
  assert.equal((await link(a, account)).rowCount, 1);
  await assert.rejects(() => link(b, account), e => e.code === '23505', 'one Shotviva account, one Graylum account');
  assert.equal((await link(a, account)).rowCount, 1, 'linking the same account again is fine');

  // A signed-in user cannot set it, not even on their own row.
  const self = await connect();
  await self.query('BEGIN');
  await self.query("SELECT set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true)",
    [JSON.stringify({ sub: b, role: 'authenticated' }), b]);
  await self.query('SET LOCAL ROLE authenticated');
  await assert.rejects(() => self.query('UPDATE profiles SET shotviva_account_id=$2 WHERE id=$1', [b, randomUUID()]), /permission denied/);
  await self.query('ROLLBACK');

  // Erasure: the id counts as remaining local data, is cleared by the local cleanup, and cannot be written back after.
  const remaining = async id => Number((await admin.query('SELECT account_erasure_local_remaining($1) AS n', [id])).rows[0].n);
  const withLink = await remaining(a);
  await admin.query('UPDATE profiles SET shotviva_account_id=NULL WHERE id=$1', [a]);
  assert.equal(withLink - await remaining(a), 1, 'a stored Shotviva id is one remaining item');
  await link(a, account);
  await admin.query('SELECT account_erasure_confirm($1,$2)', [a, randomUUID()]);
  await admin.query('SELECT account_erasure_local_cleanup($1,true)', [a]);
  assert.equal((await admin.query('SELECT shotviva_account_id FROM profiles WHERE id=$1', [a])).rows[0].shotviva_account_id, null);
  await assert.rejects(() => link(a, account), /ACCOUNT_ERASURE_IDENTITY_REFILL/);
  assert.equal((await link(b, account)).rowCount, 1, 'the erased account no longer holds the Shotviva account');

  // The partner-key slot: listed, empty until the Owner enters it, unknown slots still refused.
  const slots = (await service.query('SELECT platform_secret_status() v')).rows[0].v.map(row => row.slot);
  assert.equal(slots.at(-1), 'shotviva');
  assert.equal((await service.query("SELECT platform_secret_read('shotviva') v")).rows[0].v, null);
  await assert.rejects(() => service.query("SELECT platform_secret_read('shotviva2') v"), e => e.code === '23514');
  await assert.rejects(() => admin.query("INSERT INTO platform_secrets(slot,vault_secret_id,last4,revision) VALUES('shotviva2',gen_random_uuid(),'abcd',1)"),
    e => e.code === '23514');

  // Re-running the migration changes nothing.
  await admin.query(readFileSync(resolve(migrations, file), 'utf8'));
  assert.equal(await privilege('authenticated', 'UPDATE'), false);
  assert.equal((await admin.query('SELECT shotviva_account_id FROM profiles WHERE id=$1', [b])).rows[0].shotviva_account_id, account);
  return ['shotviva-id-service-write-only', 'shotviva-id-unique', 'shotviva-id-user-direct-write-denied',
    'shotviva-id-erasure-remaining', 'shotviva-id-erasure-cleared', 'shotviva-id-erasure-refill-denied',
    'shotviva-secret-slot', 'shotviva-migration-rerun'];
}
