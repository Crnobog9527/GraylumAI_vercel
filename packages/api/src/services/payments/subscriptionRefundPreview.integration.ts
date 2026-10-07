/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Complete repository schema, real PostgREST SELECTs, synthetic Stripe only.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewSubscriptionRefund } from './subscriptionRefundPreview';
import { actorId, subjectId, request, itemId, fixture, type Row } from './__tests__/subscriptionRefundPreviewFixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = { encoding: 'utf8' as const, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
let local: { endpoint: string; name: string; steps: number };
const suffix = randomUUID().slice(0, 8), network = `refund-preview-${suffix}`, rest = `${network}-rest`;
let port: string;
const secret = randomUUID() + randomUUID(); // Disposable generated local-only credential, never read from environment.
const docker = (...args: string[]) => execFileSync('docker', ['--host', local.endpoint, ...args], options).trim();
const sql = (text: string) => docker('exec', '-i', local.name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'paycommon',
  '-v', 'ON_ERROR_STOP=1', '-c', text);
const quote = (value: unknown) => value === null ? 'NULL' : `'${String(typeof value === 'object'
  ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
function insert(table: string, rows: Row[]) {
  for (const row of rows) sql(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(quote).join(',')})`);
}
function client(role: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const jwt = `${header}.${payload}.${signature}`;
  return createClient(`http://127.0.0.1:${port}`, jwt, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== `http://127.0.0.1:${port}` || !['GET', 'HEAD'].includes(init?.method ?? 'GET')) {
        throw new Error('LOCAL_READ_ONLY_TRANSPORT');
      }
      url.pathname = url.pathname.replace(/^\/rest\/v1\//, '/');
      return fetch(url, init);
    } } });
}
beforeAll(async () => {
  local = JSON.parse(execFileSync('node', [resolve(root, 'packages/db/tests/pay-common/decline-local-db.mjs'), '--local-only'],
    { ...options, timeout: 240000 }));
  expect(local.endpoint.startsWith('unix:///')).toBe(true);
  expect(local.steps).toBeGreaterThan(180);
  const f = fixture();
  // These are fixture INSERTs as postgres; the service transport below can only GET.
  for (const [table, rows] of Object.entries(f.tables)) {
    const idMap: Record<string, string> = { grant_1: '77777777-7777-4777-8777-777777777777',
      tx_grant: '88888888-8888-4888-8888-888888888888', map_1: '99999999-9999-4999-8999-999999999991',
      map_2: '99999999-9999-4999-8999-999999999992', map_3: '99999999-9999-4999-8999-999999999993' };
    f.tables[table] = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'string' && ['id', 'credit_transaction_id'].includes(key) ? idMap[value] ?? value : value])));
  }
  insert('profiles', f.tables.profiles);
  insert('membership_plans', [{ id: itemId, name: 'Synthetic preview plan', allow_fusion_review: 'false',
    allow_fusion_compare: 'false', library_storage_bytes: 0 }]);
  insert('user_subscriptions', f.tables.user_subscriptions.map(row => ({ ...row, stripe_subscription_id: 'sub_fixture',
    membership_plan_id: itemId, billing_cycle: 'monthly' })));
  insert('payment_orders', f.tables.payment_orders.map(row => ({ ...row, mode: 'subscription',
    purchase_request_id: randomUUID(), purchase_payload_hash: 'a'.repeat(64) })));
  insert('credit_transactions', f.tables.credit_transactions);
  insert('subscription_credit_grants', f.tables.subscription_credit_grants.map(row => ({ ...row,
    membership_plan_id: itemId, stripe_subscription_id: 'sub_fixture', billing_cycle: 'monthly', grant_type: 'monthly_invoice',
    grant_period_key: 'preview-fixture', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z',
    idempotency_key: 'preview-fixture' })));
  insert('tickets', f.tables.tickets.map(row => ({ ...row, title: 'Synthetic preview' })));
  insert('payment_provider_refs', f.tables.payment_provider_refs.filter(row => row.object_type !== 'payment'));
  sql('ALTER ROLE service_role SET default_transaction_read_only=on');
  docker('network', 'create', network);
  docker('network', 'connect', network, local.name);
  const image = execFileSync('node', ['--input-type=module', '-e',
    `import { POSTGREST_IMAGE } from './packages/db/tests/v3/images.mjs'; process.stdout.write(POSTGREST_IMAGE)`],
  { ...options, cwd: root }).trim();
  docker('run', '-d', '--pull=never', '--name', rest, '--network', network, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${local.name}:5432/paycommon`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, image);
  port = docker('port', rest, '3000').split(':').at(-1)!;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* local startup */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('LOCAL_POSTGREST_NOT_READY');
}, 240000);
afterAll(() => {
  if (!local) return;
  for (const name of [rest, local.name]) {
    try { docker('rm', '-f', '-v', name); } catch { /* only names allocated above */ }
  }
  try { docker('network', 'rm', network); } catch { /* startup may have failed before network */ }
});
function state() {
  return sql("SELECT md5(string_agg(v,'|' ORDER BY v)) FROM ("
    + ['payment_orders', 'user_subscriptions', 'subscription_credit_grants', 'credit_transactions', 'tickets', 'payment_provider_refs']
      .map(table => `SELECT row_to_json(t)::text v FROM ${table} t`).join(' UNION ALL ') + ') all_rows');
}
describe('subscription preview local PostgreSQL and PostgREST', () => {
  it('uses real selected columns/count/ranges, returns advisory quote and preserves all rows', async () => {
    const f = fixture(), before = state();
    const result = await previewSubscriptionRefund(client('service_role'), f.provider, actorId, request);
    expect(result).toMatchObject({ status: 'eligible', executable: false, quote: { netMinor: 6486 } });
    expect(state()).toBe(before);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rejects service calls with a non-admin actor before provider lookup', async () => {
    const f = fixture();
    expect(await previewSubscriptionRefund(client('service_role'), f.provider, subjectId, request))
      .toMatchObject({ status: 'review_required', executable: false });
    expect(f.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });
  it.each(['anon', 'authenticated'])('does not obtain privileged evidence as %s', async role => {
    const f = fixture();
    expect(await previewSubscriptionRefund(client(role), f.provider, actorId, request))
      .toMatchObject({ status: 'review_required', quote: null, executable: false });
    expect(f.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });
  it('detects a real persisted hold started before payment', async () => {
    sql(`INSERT INTO billing_history(id,user_id,operation_type,amount,created_at) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',${quote(subjectId)},'pre_deduct',1,'2026-09-01T00:00:00Z')`);
    const f = fixture();
    expect(await previewSubscriptionRefund(client('service_role'), f.provider, actorId, request))
      .toMatchObject({ status: 'review_required', quote: null, executable: false });
  });
});
