/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0377 research_test_window_sync_prices: the daily research price refresh realigns the staging test window's TikHub
// tool policies with the stored prices. Checks that the price, expiry, entry hash (providerEntryHash) and upperUsd come
// from the price table, that a price written into the window by anyone is put back to the table's, that nothing outside
// that window's TikHub research policies changes, that unpriceable routes are skipped and reported, grants, and that the
// migration is repeatable. Run: node packages/db/tests/research-window-sync/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const database = await localDb(), db = database.client;
const migration = read('packages/db/migrations/0377_research_test_window_sync_prices.sql');
// providerEntryHash (billingProviderPrices.ts): sha256 of JSON.stringify of the entry's [key, value] pairs in key order.
const entryHash = entry => createHash('sha256').update(JSON.stringify(Object.keys(entry).sort().map(key => [key, entry[key]]))).digest('hex');
const DAY = 86400000;
const iso = ms => new Date(Date.now() + ms).toISOString();
const entry = (route, price, over = {}) => ({ provider: 'tikhub', route, appliesToUnlistedRoutes: false, currency: 'USD',
  usageUnit: 'call', unitsPerPrice: '1', price, usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
  // Non-ASCII, quotes and a backslash: the database must hash the same text JSON.stringify produces.
  pricingBasis: 'official endpoint_cost "每日刷新" \\ 2026', sourceUrl: 'https://api.tikhub.io/api/v1/tikhub/user/get_endpoint_info',
  evidenceHash: 'e'.repeat(64), verifiedAt: iso(-DAY), validUntil: iso(7 * DAY), chargeCondition: 'one call',
  includedInReceipt: false, priceMultiplier: null, ...over });
const ROUTES = { fresh: '/tiktok/app/v3/handler_user_profile', pricier: '/douyin/app/v3/handler_user_profile',
  expired: '/tiktok/app/v3/fetch_user_post_videos', multiplied: '/xiaohongshu/app/v2/get_user_info', missing: '/x/web/fetch_user_profile' };
const prices = { version: 1, entries: [entry(ROUTES.fresh, '0.001'), entry(ROUTES.pricier, '0.01'),
  entry(ROUTES.expired, '0.001', { verifiedAt: iso(-9 * DAY), validUntil: iso(-DAY) }),
  entry(ROUTES.multiplied, '0.002', { priceMultiplier: '2' }),
  { ...entry(null, '1'), provider: 'parallel', route: 'parallel:search:fast', usageUnit: 'sku_search' }] };
const policy = (route, pricing = {}) => ({ model: `tikhub:${route}`, account: 'research-staging', modelId: randomUUID(),
  protocol: 'research-tool-v1', provider: 'tikhub', purposes: ['research'], upperUsd: '0.001', multiplier: '3', lookupSupported: false,
  toolPricing: { unit: 'call', price: '0.001', currency: 'USD', entryHash: 'a'.repeat(64), validUntil: iso(2 * DAY), unitsPerPrice: '1',
    usdPerCurrency: null, maxUnitsPerCall: '1', ...pricing } });
const model = { provider: 'openrouter', model: 'openrouter:x', account: 'a', modelId: randomUUID(), multiplier: '3' };
const WINDOW = randomUUID(), OTHER = randomUUID();
const policies = [model, policy(ROUTES.fresh), policy(ROUTES.pricier, { price: '9', maxUnitsPerCall: '2' }), policy(ROUTES.expired),
  policy(ROUTES.multiplied), policy(ROUTES.missing)];
const window = async id => (await db.query('SELECT call_policies FROM runtime_test_windows WHERE id=$1', [id])).rows[0].call_policies;
// Called as the daily job calls it: service_role, which has no grant on runtime_test_windows itself.
const sync = async id => {
  await db.query('BEGIN'); await db.query('SET LOCAL ROLE service_role');
  try { const r = (await db.query('SELECT public.research_test_window_sync_prices($1) r', [id])).rows[0].r; await db.query('COMMIT'); return r; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
};
const report = { checks: [], failed: null };
try {
  await db.query("DELETE FROM system_settings WHERE key='billing_provider_prices'");
  await db.query("INSERT INTO system_settings(key,value) VALUES('billing_provider_prices',to_jsonb($1::text))", [JSON.stringify(prices)]);
  for (const id of [WINDOW, OTHER]) {
    await db.query(`INSERT INTO runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,
      max_calls,expires_at) VALUES($1,true,ARRAY[$2::uuid],$3::jsonb,100,3,5,100,now()+interval '7 days')`, [id, randomUUID(), JSON.stringify(policies)]);
  }

  const result = await sync(WINDOW);
  assert.deepEqual(result, { status: 'updated', synced: 2, skipped: [
    { route: ROUTES.expired, reason: 'PRICE_EXPIRED' }, { route: ROUTES.multiplied, reason: 'PRICE_MULTIPLIER' },
    { route: ROUTES.missing, reason: 'PRICE_UNKNOWN' }] });
  const after = await window(WINDOW);
  const [fresh, pricier] = [prices.entries[0], prices.entries[1]];
  assert.deepEqual(after[1], { ...policies[1], toolPricing: { ...policies[1].toolPricing, price: '0.001',
    validUntil: fresh.validUntil, entryHash: entryHash(fresh) }, upperUsd: '0.001' });
  // As service_role the table itself stays closed.
  await db.query('BEGIN'); await db.query('SET LOCAL ROLE service_role');
  await assert.rejects(db.query('SELECT 1 FROM runtime_test_windows'), /permission denied/); await db.query('ROLLBACK');
  report.checks.push('a priced TikHub route gets the table price, its expiry and the same entry hash as providerEntryHash (non-ASCII, quotes, backslash)');
  // The window said 9 USD: the table's 0.01 is restored, and the bound follows the table price × the policy's own max units.
  assert.deepEqual(after[2], { ...policies[2], toolPricing: { ...policies[2].toolPricing, price: '0.01',
    validUntil: pricier.validUntil, entryHash: entryHash(pricier) }, upperUsd: '0.02' });
  report.checks.push('a price written into the window is put back to the table price; upperUsd = table price × the policy maxUnitsPerCall');
  assert.deepEqual([after[0], after[3], after[4], after[5]], [policies[0], policies[3], policies[4], policies[5]]);
  assert.deepEqual(await window(OTHER), policies);
  report.checks.push('other policies, unpriceable routes (expired, own multiplier, no entry) and other windows are left exactly as they were');

  assert.deepEqual(await sync(WINDOW), { status: 'unchanged', synced: 2, skipped: result.skipped });
  assert.deepEqual(await window(WINDOW), after);
  assert.deepEqual(await sync(randomUUID()), { status: 'not_found', synced: 0, skipped: [] });
  await db.query("UPDATE system_settings SET value='{\"version\":1}'::jsonb WHERE key='billing_provider_prices'");
  assert.deepEqual(await sync(WINDOW), { status: 'invalid', synced: 0, skipped: [] });
  assert.deepEqual(await window(WINDOW), after);
  report.checks.push('a second run changes nothing; an unknown window or an unreadable price table writes nothing');

  const grants = (await db.query(`SELECT has_function_privilege('anon',f,'EXECUTE') anon, has_function_privilege('authenticated',f,'EXECUTE') auth,
    has_function_privilege('service_role',f,'EXECUTE') service, p.prosecdef definer, p.proconfig config
    FROM (SELECT 'public.research_test_window_sync_prices(uuid)'::regprocedure f) x JOIN pg_proc p ON p.oid=x.f`)).rows[0];
  assert.deepEqual(grants, { anon: false, auth: false, service: true, definer: true, config: ['search_path=public, pg_temp'] });
  const tableGrants = Number((await db.query(`SELECT count(*) n FROM information_schema.role_table_grants
    WHERE table_name='runtime_test_windows' AND grantee IN ('anon','authenticated','service_role')`)).rows[0].n);
  assert.equal(tableGrants, 0);
  report.checks.push('SECURITY DEFINER with a fixed search_path, only service_role may execute it; still no table grant');

  const definition = async () => (await db.query("SELECT pg_get_functiondef('public.research_test_window_sync_prices(uuid)'::regprocedure) d")).rows[0].d;
  const before = await definition();
  await db.query(migration); await db.query(migration);
  assert.equal(await definition(), before);
  report.checks.push('migration repeatable without change');
} catch (error) { report.failed = String(error) + '\n' + error.stack; process.exitCode = 1; }
finally { await database.close(); console.log(JSON.stringify(report, null, 2)); }
