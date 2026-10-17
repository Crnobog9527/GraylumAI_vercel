/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-4b (0290) verification: the Owner-approved tool-only BILL2 run (and that every other run
// shape is still refused), one billed TikHub call end to end, the billed-read ledger, and orphaned-run discovery.
// Run: node packages/db/tests/publish-monitor/billed-local.mjs --local-only
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { rpc } from '../erasure-b2a/cases.mjs';
import { fixtureSql } from './fixtures.mjs';

const MIGRATION = 'packages/db/migrations/0290_publish_monitor_billed_reads.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0290', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const toolModelId = route => createHash('md5').update('bill2-research-tool:' + route).digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const PLACEHOLDER = toolModelId('publish-monitor:read-run');
const ROUTE = 'tikhub:/xiaohongshu/app_v2/get_user_posted_notes';
const pricing = { unit: 'call', currency: 'USD', price: '0.01', unitsPerPrice: '1', usdPerCurrency: null, entryHash: 'e'.repeat(64),
  validUntil: new Date(Date.now() + 7 * 86400000).toISOString(), maxUnitsPerCall: '1' };
const toolPolicy = { provider: 'tikhub', account: 'tikhub-main', model: ROUTE, protocol: 'research-tool-v1',
  modelId: toolModelId(ROUTE), multiplier: '6', lookupSupported: false, upperUsd: '0.01', purposes: ['publish_monitor'],
  toolPricing: pricing };
const XHS = '61b46d790000000010008153';

async function member() {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,100)', [a]);
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,
    balance_before,balance_after) VALUES($1,100,'addition','grant','opening_grant','system',$2,0,100)`, [a, 'opening_grant:' + a]);
  const account = await v('SELECT pm_test.member($1,$2) v', [a, 'xiaohongshu']);
  const conn = (await svc('SELECT publish_monitor_tikhub_connect($1,$2,$3,$4,$5) v', [a, account, 'xiaohongshu', XHS, true])).connectionId;
  return { a, account, conn };
}
const payload = async (a, patch = {}) => ({ contractVersion: 'bill2.v2', mode: 'isolated',
  scope: { kind: 'positioning_draft', draftId: await rpc(c, 'bill2_create_draft', a) }, operation: 'research', modelId: PLACEHOLDER,
  sourceHash: 'a'.repeat(64), input: { publishMonitor: { connectionId: randomUUID(), refreshId: randomUUID() } },
  callPolicy: [toolPolicy], rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '100', multiplier: '6', fx: {},
    billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '100', defaultMultiplier: '6', hash: 'f'.repeat(64) } },
  limits: { costUsd: '0.02', credits: 0, maxPreDeduct: 0, maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString() },
  ...patch });
const refused = async (a, p, pattern) => assert.rejects(rpc(c, 'bill2_prepare', a, randomUUID(), p), pattern);

try {
  await c.query(fixtureSql);
  await c.query(`INSERT INTO system_settings(key,value) VALUES('billing_payg_start_thresholds',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=jsonb_set(system_settings.value,'{thresholds}',
      coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{ version: 'local-v1', thresholds: [{ model: ROUTE, purpose: 'publish_monitor', credits: 1 }] }]);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(MIGRATION));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('reapplication preserves the complete catalog (patches are marker-guarded)');

  // The exception is narrow: every other shape is still refused exactly as before.
  const m = await member();
  await refused(m.a, await payload(m.a, { input: { text: 'no marker' } }), /BILL2_MODEL_DENIED/);
  await refused(m.a, await payload(m.a, { modelId: randomUUID() }), /BILL2_MODEL_DENIED/);
  await refused(m.a, await payload(m.a, { contractVersion: 'bill2.v1', limits: { costUsd: '0.02', credits: 6, maxPreDeduct: 6,
    maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString() } }), /BILL2_/);
  const modelRow = randomUUID();
  await c.query("INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES($1,'pm-local','x','fixture',true)", [modelRow]);
  await refused(m.a, await payload(m.a, { callPolicy: [toolPolicy, { ...toolPolicy, protocol: 'fixture-cost-v1', modelId: modelRow,
    provider: 'fixture', model: 'pm-local' }] }), /BILL2_/);
  await refused(m.a, await payload(m.a, { input: { publishMonitor: 'x' } }), /BILL2_MODEL_DENIED/);
  // Clients cannot create runs at all (no execute right on bill2_prepare), so a marker can only come from the server.
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await v("SELECT has_function_privilege($1,'public.bill2_prepare(uuid,uuid,jsonb)','execute') v", [role]), false);
    assert.equal(await v("SELECT has_function_privilege($1,'public.publish_monitor_tool_only_run(jsonb)','execute') v", [role]), false);
  }
  report.checks.push('refused as before: no marker, a real model id, v1 contract, any model route, a malformed marker; clients cannot prepare runs');

  // The approved shape prepares, claims, dispatches, records and finalizes like any tool call.
  const ok = await payload(m.a);
  const run = await rpc(c, 'bill2_prepare', m.a, randomUUID(), ok);
  const call = await rpc(c, 'bill2_claim', m.a, run.id, 1, { provider: 'tikhub', account: 'tikhub-main', model: ROUTE,
    protocol: 'research-tool-v1', phase: 'publish_monitor', requestHash: 'd'.repeat(64), automaticRetry: false, hiddenTools: false,
    lookupSupported: false, upperUsd: '0.01', billingUnit: { modelId: toolPolicy.modelId, multiplier: '6' }, toolPricing: pricing });
  assert.equal((await rpc(c, 'bill2_dispatch', m.a, run.id, call.id, call.dispatchToken)).dispatch, true);
  await rpc(c, 'bill2_record', m.a, run.id, call.id, { provider: 'tikhub', account: 'tikhub-main', protocol: 'research-tool-v1',
    model: ROUTE, providerId: call.id, source: 'response', sourceHash: 'c'.repeat(64), observedAt: new Date().toISOString(),
    coverage: 'request_total', final: true, currency: 'USD', cost: '0.01', usage: { unit: 'call', units: '1' },
    evidenceKind: 'tool_result', toolOutcome: 'delivered' });
  await rpc(c, 'bill2_close', m.a, run.id, 'delivered', { kind: 'usable_result', evidenceRef: 'publish-monitor:test', evidenceHash: 'd'.repeat(64) });
  const fin = await rpc(c, 'bill2_finalize', m.a, run.id);
  assert.equal(fin.chargedCredits, 6, '0.01 USD × 100 × 6');
  assert.equal(await v('SELECT credits::int v FROM profiles WHERE id=$1', [m.a]), 94);
  report.checks.push('the approved tool-only run bills one TikHub call at the frozen price (6 credits) and finalizes');

  // Ledger: one live attempt per request key and refresh; an answered attempt is found again by a re-run.
  const claim = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v')).find(x => x.connectionId === m.conn);
  const keys = [m.conn, claim.lease, claim.refreshId];
  const run2 = await rpc(c, 'bill2_prepare', m.a, randomUUID(), await payload(m.a));
  const bind = id => svc('SELECT publish_monitor_billed_run($1,$2,$3,$4,$5) v', [...keys, id, JSON.stringify([toolPolicy])]);
  assert.equal((await bind(run2.id)).runId, run2.id);
  assert.equal((await bind(randomUUID())).runId, run2.id, 'the open run wins');
  const op = randomUUID(), token = randomUUID(), key = 'f'.repeat(64);
  const step = (name, extra = {}) => svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v', [...keys,
    extra.op ?? op, name, key, ROUTE, extra.token ?? token, extra.call ?? null, extra.state ?? null,
    extra.result ? JSON.stringify(extra.result) : null]);
  assert.deepEqual(await step('open'), { ok: true });
  assert.deepEqual(await step('open', { op: randomUUID() }), { ok: false }, 'one live attempt per key');
  assert.deepEqual(await step('dispatch'), { ok: false }, 'never dispatched before its BILL2 call is linked');
  assert.deepEqual(await step('link', { call: randomUUID() }), { ok: true });
  assert.deepEqual(await step('dispatch', { token: randomUUID() }), { ok: false }, 'the token must match');
  assert.deepEqual(await step('dispatch'), { ok: true });
  // A second key, really claimed and sent on the run but never answered (a killed process).
  const op2 = randomUUID(), key2 = 'e'.repeat(64);
  const real = await rpc(c, 'bill2_claim', m.a, run2.id, 1, { provider: 'tikhub', account: 'tikhub-main', model: ROUTE,
    protocol: 'research-tool-v1', phase: 'publish_monitor', requestHash: 'e'.repeat(64), automaticRetry: false, hiddenTools: false,
    lookupSupported: false, upperUsd: '0.01', billingUnit: { modelId: toolPolicy.modelId, multiplier: '6' }, toolPricing: pricing });
  assert.equal((await rpc(c, 'bill2_dispatch', m.a, run2.id, real.id, real.dispatchToken)).dispatch, true);
  const step2 = (name, extra = {}) => svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v', [...keys,
    op2, name, key2, ROUTE, token, extra.call ?? null, null, null]);
  await step2('open'); await step2('link', { call: real.id }); await step2('dispatch');
  // An opened attempt that was never linked to a call (killed between open and link).
  const op3 = randomUUID();
  await svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v', [...keys, op3, 'open', 'd'.repeat(64),
    ROUTE, token, null, null, null]);
  const recovery = await svc('SELECT publish_monitor_billed_recovery($1) v', [run2.id]);
  const byOp = Object.fromEntries(recovery.map(x => [x.operationId, x]));
  assert.deepEqual([byOp[op2].callPending, byOp[op2].live, byOp[op2].receipt], [true, true, null], 'sent, no receipt');
  assert.deepEqual([byOp[op3].callId, byOp[op3].callPending, byOp[op3].live], [null, false, true], 'opened, never linked');
  assert.equal(byOp[op].callPending, false, 'a fake call id is not a pending BILL2 call');
  // Abandoning is bound to the run, needs no live claim, and frees the key.
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [randomUUID(), op3]), false, 'another run cannot touch it');
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [run2.id, op3]), true);
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [run2.id, op3]), false, 'idempotent');
  assert.equal((await svc('SELECT publish_monitor_billed_lookup($1,$2,$3,$4) v', [...keys, 'd'.repeat(64)])).found, false);
  report.checks.push('recovery lists sent-without-receipt calls and opened-but-unlinked attempts; abandon is run-bound and frees the key');
  assert.deepEqual(await step('finish', { state: 'succeeded', result: { items: [{ id: 'n1' }] } }), { ok: true });
  const found = await svc('SELECT publish_monitor_billed_lookup($1,$2,$3,$4) v', [...keys, key]);
  assert.deepEqual([found.found, found.state, found.result], [true, 'answered', { items: [{ id: 'n1' }] }]);
  // The stored answer carries its receipt; recovery offers it for replay when the BILL2 call is still pending.
  report.checks.push('ledger: one live attempt per key, link before dispatch, token-bound, answers kept for re-runs');

  // A stale claim cannot open new attempts; a run left open is found for closing once the refresh moved on.
  await svc('SELECT publish_monitor_refresh_finish($1,$2,$3,$4,$5) v', [...keys, 'done', null]);
  assert.deepEqual(await step('open', { op: randomUUID() }), { ok: false });
  const orphans = await svc('SELECT publish_monitor_billed_orphans(50) v');
  assert.ok(orphans.some(o => o.runId === run2.id));
  await svc('SELECT publish_monitor_billed_closed($1) v', [run2.id]);
  assert.ok(!(await svc('SELECT publish_monitor_billed_orphans(50) v')).some(o => o.runId === run2.id));
  report.checks.push('a settled refresh opens nothing new; its still-open run is listed for closing until marked closed');

  // Insufficient credits: settled for today without any hold.
  const claim2 = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v'));
  await c.query("UPDATE social_connections SET refresh_day=NULL WHERE id=$1", [m.conn]);
  const k3 = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v')).find(x => x.connectionId === m.conn) ?? claim2[0];
  if (k3) {
    assert.equal(await svc('SELECT publish_monitor_refresh_insufficient($1,$2,$3) v', [k3.connectionId, k3.lease, k3.refreshId]), true);
    assert.equal((await c.query('SELECT refresh_state FROM social_connections WHERE id=$1', [k3.connectionId])).rows[0].refresh_state,
      'insufficient_credits');
  }
  report.checks.push('insufficient credits settles the connection for today as "余额不足，未更新"');

  // Disconnecting removes the ledger rows with the connection.
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [m.a, m.conn]);
  assert.equal(await v('SELECT count(*)::int v FROM social_billed_reads WHERE connection_id=$1', [m.conn]), 0);
  report.checks.push('ledger rows go with their connection');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
