/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Opt-in disposable local PostgreSQL only. No environment URLs or provider credentials are used.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { buildFromFiles, installPgCronStub } from '../../packages/db/tests/baseline/build-from-files.mjs';
import { POSTGRES_IMAGE } from '../../packages/db/tests/v3/images.mjs';
import { closeOne, inventory, processOrder } from '../legacy-checkout/database.mjs';
import { fixture } from './legacy-checkout-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const commandOptions = { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
  maxBuffer: 64 * 1024 * 1024 };
const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], commandOptions).trim();
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
const docker = (args, input) => execFileSync('docker', ['--host', endpoint, ...args], { ...commandOptions, input }).trim();
const name = `graylum-legacy-${randomUUID()}`;
let started = false;
let port;
const clients = [];
async function connect(role = 'service_role') {
  const db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'fixture' });
  await db.connect(); clients.push(db);
  assert.ok(['service_role', 'postgres', 'anon', 'authenticated'].includes(role));
  await db.query(`SET ROLE ${role}`);
  return db;
}
let admin;
before(async () => {
  docker(['image', 'inspect', POSTGRES_IMAGE]);
  docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=fixture',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  started = true;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'fixture']).includes('accepting'); }
    catch { /* local container starting */ }
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready);
  port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
  assert.ok(Number.isInteger(port) && port > 0);
  installPgCronStub(root, name, (args, input) => docker(['exec', ...args], input));
  const sql = text => {
    try {
      docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'fixture',
        '-v', 'ON_ERROR_STOP=1', '-c', text]);
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error.stderr) }; }
  };
  const report = buildFromFiles(root, { applyFile: path => sql(readFileSync(resolve(root, path), 'utf8')), applyServerOnly: sql });
  assert.equal(report.failed, null, JSON.stringify(report.failed));
  admin = await connect('postgres');
}, { timeout: 240000 });
after(async () => {
  await Promise.all(clients.map(db => db.end()));
  if (started) docker(['rm', '-f', '-v', name]);
});

async function seed() {
  const t = fixture();
  t.order.id = randomUUID(); t.order.user_id = randomUUID(); t.order.item_id = randomUUID();
  t.order.stripe_checkout_session_id = 'cs_test_' + randomUUID().replaceAll('-', '');
  t.session.id = t.order.stripe_checkout_session_id;
  t.session.client_reference_id = t.session.metadata.userId = t.order.user_id;
  t.session.metadata.itemId = t.order.item_id;
  await admin.query('INSERT INTO profiles(id,membership_level) VALUES($1,\'free\')', [t.order.user_id]);
  const fields = ['id','user_id','item_id','item_type','billing_cycle','mode','stripe_checkout_session_id',
    'stripe_customer_id','stripe_price_id','amount_total','currency','created_at','status','payment_status'];
  await admin.query(`INSERT INTO payment_orders(${fields.join(',')}) VALUES(${fields.map((_, i) => '$' + (i + 1)).join(',')})`,
    fields.map(key => t.order[key]));
  t.db = await connect();
  t.order = (await inventory(t.db, t.order.id))[0];
  return t;
}
const read = async t => (await admin.query('SELECT * FROM payment_orders WHERE id=$1', [t.order.id])).rows[0];
const rpc = (db, t, session = t.session.id, checkout = 'legacy_expired', mode = 'test') =>
  db.query('SELECT pay_common_close_checkout($1,$2,$3,$4,$5,$6,$7) AS closed',
    [t.order.user_id,t.order.id,session,t.scope.merchant,mode,checkout,'unpaid']);

test('dry run is read-only; verified close preserves facts and repeated close is a no-op', async () => {
  const t = await seed();
  const beforeRow = await read(t);
  assert.equal((await processOrder(t)).outcome, 'eligible');
  assert.deepEqual(await read(t), beforeRow);
  assert.equal(await closeOne(t.db, t.stripe, t.order, t.scope), 'closed');
  const closed = await read(t);
  assert.equal(closed.status, 'expired'); assert.equal(closed.payment_status, 'unpaid');
  assert.equal(closed.payment_channel, null); assert.equal(closed.fulfilled_at, null);
  assert.equal(closed.purchase_close_ref, t.session.id);
  assert.equal((await processOrder({ ...t, apply: true })).outcome, 'already_closed');
  assert.deepEqual(await read(t), closed);
});
test('two concurrent closers produce exactly one transition', async () => {
  const t = await seed(); const other = await connect();
  const result = await Promise.all([processOrder({ ...t, apply: true }), processOrder({ ...t, db: other, apply: true })]);
  assert.deepEqual(result.map(row => row.outcome).sort(), ['already_closed', 'closed']);
});
test('paid state arriving after inventory is preserved before provider read', async () => {
  const t = await seed();
  await admin.query("UPDATE payment_orders SET payment_status='paid',status='completed' WHERE id=$1", [t.order.id]);
  assert.equal((await processOrder({ ...t, apply: true })).outcome, 'unresolved');
  assert.deepEqual(t.calls, []); assert.equal((await read(t)).status, 'completed');
});
test('competing writer holds profile/order: closer rechecks after writer commits', async () => {
  const t = await seed(); const writer = await connect('postgres');
  await writer.query('BEGIN');
  await writer.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [t.order.user_id]);
  const closing = processOrder({ ...t, apply: true });
  await writer.query("UPDATE payment_orders SET stripe_invoice_id='in_race' WHERE id=$1", [t.order.id]);
  await writer.query('COMMIT');
  assert.equal((await closing).outcome, 'unresolved');
  assert.equal((await read(t)).status, 'pending');
});
test('Stripe retrieval failure rolls back with no database change', async () => {
  const t = await seed(); const prior = await read(t);
  t.stripe.checkout.sessions.retrieve = async () => { throw new Error('synthetic timeout'); };
  assert.equal((await processOrder({ ...t, apply: true })).outcome, 'unresolved');
  assert.deepEqual(await read(t), prior);
  assert.equal((await t.db.query('SELECT 1 AS n')).rows[0].n, 1);
});
test('direct RPC rejects all missing or conflicting local facts', async () => {
  for (const update of ["payment_status=NULL", "payment_status='paid'", "fulfilled_at=now()",
    "stripe_invoice_id='in_fixture'", "stripe_subscription_id='sub_fixture'", "status='failed'",
    "created_at='2026-09-23T00:00:00Z'", "payment_amount_facts='[]'::jsonb"]) {
    const t = await seed(); await admin.query(`UPDATE payment_orders SET ${update} WHERE id=$1`, [t.order.id]);
    await assert.rejects(rpc(t.db, t), { code: '23514' });
    assert.equal((await read(t)).purchase_closed_at, null);
  }
});
test('RPC requires explicit legacy path and matching session/mode', async () => {
  const t = await seed();
  await assert.rejects(rpc(t.db, t, 'cs_test_other'), { code: '23514' });
  await assert.rejects(rpc(t.db, t, t.session.id, 'expired'), { code: '23514' });
  await assert.rejects(rpc(t.db, t, t.session.id, 'legacy_expired', 'live'), { code: '23514' });
});
test('anon and authenticated roles cannot invoke close; service role cannot bypass closure columns', async () => {
  const t = await seed();
  for (const role of ['anon', 'authenticated']) await assert.rejects(rpc(await connect(role), t), { code: '42501' });
  await assert.rejects(t.db.query('UPDATE payment_orders SET purchase_closed_at=now() WHERE id=$1', [t.order.id]), { code: '42501' });
});
test('guard rejects schema drift; same migration already replayed twice by buildFromFiles', async () => {
  const definition = (await admin.query(`SELECT pg_get_functiondef(
    'pay_common_close_checkout(uuid,uuid,text,text,text,text,text)'::regprocedure) AS body`)).rows[0].body;
  await admin.query(definition.replace('DECLARE intent public.payment_orders;', 'DECLARE intent public.payment_orders; /* drift */'));
  try {
    await assert.rejects(admin.query(readFileSync(resolve(root, 'packages/db/migrations/0179_pay_common_legacy_close.sql'), 'utf8')),
      /PAY_COMMON_CLOSE_SCHEMA_DRIFT/);
    await admin.query('ROLLBACK');
  } finally { await admin.query(definition); }
});

test('legacy pending blocks Pro purchase; verified closure allows a new local intent', async () => {
  const t = await seed();
  let plan = (await admin.query("SELECT id FROM membership_plans WHERE level='pro' LIMIT 1")).rows[0]?.id;
  if (!plan) plan = (await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,monthly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES('Synthetic Pro','pro',990,100,false,false,0) RETURNING id`)).rows[0].id;
  await admin.query("UPDATE membership_plans SET monthly_price=990,monthly_credits=100,is_active='true' WHERE id=$1", [plan]);
  await admin.query('UPDATE payment_orders SET item_id=$2 WHERE id=$1', [t.order.id, plan]);
  t.session.metadata.itemId = plan;
  t.order = (await inventory(t.db, t.order.id))[0];
  await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel','{"channel":"stripe","version":1}')
    ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('channel','stripe',
    'version',(system_settings.value->>'version')::bigint+1)`);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current) VALUES('stripe','acct_fixture','test','price',$1,$2,'monthly',true)`,
    ['price_' + randomUUID().replaceAll('-', ''), plan]);
  const purchase = () => t.db.query(`SELECT (pay_common_create_purchase($1,'membership_plan',$2,
    'monthly','acct_fixture','test','free')).id AS id`, [t.order.user_id, plan]);
  await assert.rejects(purchase(), /PAY_COMMON_LEGACY_ORDER_UNRESOLVED/);
  assert.equal((await processOrder({ ...t, apply: true })).outcome, 'closed');
  const newId = (await purchase()).rows[0].id;
  assert.notEqual(newId, t.order.id);
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1', [t.order.user_id])).rows[0].membership_level, 'free');
});
test('existing PAY-COMMON purchase/closure regression SQL still passes', async () => {
  await admin.query(readFileSync(resolve(root, 'packages/db/tests/pay-common/purchase-admission.sql'), 'utf8'));
});
