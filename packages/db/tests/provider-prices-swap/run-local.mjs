/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0346 billing_provider_prices_swap (#1294): the admin price page and the daily research price refresh compare the stored
// hash and write in one locked statement. Checks that a save stores exactly what the old upsert stored (same input, same
// row, same hash as saveProviderPrices computes), that a stale hash is refused, that a racing save waits and then loses,
// grants, and that the migration is repeatable. Run: node packages/db/tests/provider-prices-swap/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';

const database = await localDb(), db = database.client;
const migration = read('packages/db/migrations/0346_billing_provider_prices_swap.sql');
const sha = text => createHash('sha256').update(text).digest('hex');
const KEY = 'billing_provider_prices';
const config = price => JSON.stringify({ version: 1, entries: [{ provider: 'tikhub', route: '/tiktok/app/v3/handler_user_profile',
  appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'call', unitsPerPrice: '1', price, usdPerCurrency: null,
  fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null, pricingBasis: '价格 official', sourceUrl: null, evidenceHash: null,
  verifiedAt: null, validUntil: '2026-10-30T00:00:00.000Z', chargeCondition: 'one call', includedInReceipt: false, priceMultiplier: null }] });
const stored = async () => (await db.query('SELECT value FROM system_settings WHERE key=$1', [KEY])).rows[0]?.value ?? null;
const swap = (client, hash, value) => client.query('SELECT public.billing_provider_prices_swap($1,$2) h', [hash, value]).then(r => r.rows[0].h);
const report = { checks: [], failed: null };
let other;
try {
  await db.query('DELETE FROM system_settings WHERE key=$1', [KEY]);

  // Same input, same result as the old manual save (supabase upsert of the JSON text into the jsonb column).
  const first = config('0.001');
  await db.query('INSERT INTO system_settings(key,value) VALUES($1,to_jsonb($2::text))', [KEY, first]);
  const legacyRow = await stored();
  await db.query('DELETE FROM system_settings WHERE key=$1', [KEY]);
  const firstHash = await swap(db, null, first);
  assert.deepEqual(await stored(), legacyRow);
  assert.equal(typeof legacyRow, 'string');
  assert.equal(firstHash, sha(legacyRow));
  report.checks.push('first save (expected hash null) stores the same jsonb string as the old upsert; returned hash = saveProviderPrices hash');

  const second = config('0.002');
  const secondHash = await swap(db, firstHash, second);
  assert.equal(await stored(), second);
  assert.equal(secondHash, sha(second));
  await assert.rejects(swap(db, firstHash, config('0.003')), /BILLING_UNIT_PROVIDER_PRICES_CONFLICT/);
  await assert.rejects(swap(db, null, config('0.003')), /BILLING_UNIT_PROVIDER_PRICES_CONFLICT/);
  await assert.rejects(swap(db, secondHash, '[1]'), /BILLING_UNIT_PROVIDER_PRICES_INVALID/);
  await assert.rejects(swap(db, 'not-a-hash', config('0.003')), /BILLING_UNIT_PROVIDER_PRICES_INVALID/);
  assert.equal(await stored(), second);
  report.checks.push('a matching hash replaces the row; a stale or missing hash and invalid input are refused and write nothing');

  // A racing save waits for the first one's lock, then sees the new row and loses (no silent overwrite).
  const { Client } = createRequire(resolve(root, 'package.json'))('pg');
  other = new Client({ connectionString: `postgres://postgres@${db.host}:${db.port}/${db.database}` });
  await other.connect();
  await db.query('BEGIN');
  const winner = await swap(db, secondHash, config('0.004'));
  const loser = swap(other, secondHash, config('0.005')).then(() => 'won', error => String(error.message));
  let waiting = 0;
  for (let i = 0; i < 50 && waiting === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waiting = Number((await db.query("SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid<>pg_backend_pid()")).rows[0].n);
  }
  assert.equal(waiting, 1, 'the second save must wait for the first one\'s lock');
  await db.query('COMMIT');
  assert.match(await loser, /BILLING_UNIT_PROVIDER_PRICES_CONFLICT/);
  assert.equal(await stored(), config('0.004'));
  assert.equal(winner, sha(config('0.004')));
  report.checks.push('two saves with the same stale-to-be hash: the second waits for the lock, then gets CONFLICT');

  const grants = (await db.query(`SELECT has_function_privilege('anon',f,'EXECUTE') anon, has_function_privilege('authenticated',f,'EXECUTE') auth,
    has_function_privilege('service_role',f,'EXECUTE') service FROM (SELECT 'public.billing_provider_prices_swap(text,text)'::regprocedure f) x`)).rows[0];
  assert.deepEqual(grants, { anon: false, auth: false, service: true });
  report.checks.push('only service_role may execute it');

  const definition = async () => (await db.query("SELECT pg_get_functiondef('public.billing_provider_prices_swap(text,text)'::regprocedure) d")).rows[0].d;
  const before = await definition();
  await db.query(migration); await db.query(migration);
  assert.equal(await definition(), before);
  report.checks.push('migration repeatable without change');
} catch (error) { report.failed = String(error) + '\n' + error.stack; process.exitCode = 1; }
finally { await other?.end().catch(() => {}); await database.close(); console.log(JSON.stringify(report, null, 2)); }
