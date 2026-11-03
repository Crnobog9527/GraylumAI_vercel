/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR verification of the billed-read ledger on kind='review' turns (0463, B8a; the tool-only BILL2 run of 0289 left with batch F):
// the hidden read session, binding a turn, live-attempt recovery, orphaned-run discovery, disconnect and pruning.
// Run: node packages/db/tests/publish-monitor/billed-local.mjs --local-only
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { rpc } from '../erasure-b2a/cases.mjs';
import { fixtureSql, laterRedefinitions } from './fixtures.mjs';

const MIGRATION = 'packages/db/migrations/0289_publish_monitor_billed_reads.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0289', checks: [] };
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
  const m = await member();
  // (V2-12 F: the tool-only BILL2 run of 0289 and its replay went with bill2_prepare; the review-turn ledger below is the monitor's billing.)
  // B8a (0463): the refresh runs as a kind='review' turn in the connection's hidden conversation; the ledger's run id is the
  // turn's request id. Nothing below touches BILL2.
  const beforeReapply = await v(catalogSql);
  for (const path of laterRedefinitions('0462')) await c.query(read(path));
  assert.deepEqual(await v(catalogSql), beforeReapply);
  report.checks.push('0463, 0477 and 0481 re-apply without changing the catalog');
  for (const role of ['anon', 'authenticated']) {
    for (const f of ['publish_monitor_session(uuid,uuid)', 'publish_monitor_billed_run(uuid,uuid,uuid,uuid,jsonb)',
      'publish_monitor_billed_recovery(uuid)', 'publish_monitor_billed_orphans(integer)']) {
      assert.equal(await v("SELECT has_function_privilege($1,'public." + f + "','execute') v", [role]), false, role + ' ' + f);
    }
  }
  const POLICY = { q: 100, uTurnUsd: 0.02, gCredits: 12, minCredits: 6, uModelCredits: 0, historyItems: 0, inputBytes: 0,
    limits: { model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    review: { mode: 'read' } };
  const openTurn = async (member) => {
    const session = await svc('SELECT publish_monitor_session($1,$2) v', [member.a, member.conn]);
    const request = randomUUID();
    const turn = await svc('SELECT turn_open($1,$2,$3,$4,$5) v', [member.a, session, request, 'review', JSON.stringify(POLICY)]);
    return { session, request, turnId: turn.turnId };
  };
  const closeTurn = (member, turn) => svc("SELECT turn_close($1,$2,'completed','[]'::jsonb,false) v", [member.a, turn.turnId]);

  // A read turn settles under the ordinary turn rules: one paid tool row, the user pays only for what returned data.
  const payer = await member(), paid = await openTurn(payer);
  const begun = await svc("SELECT turn_call_begin($1,$2,1,'tool',NULL,'publish_monitor_read',true,$3,'0.02','6') v", [payer.a, paid.turnId, 'a'.repeat(64)]);
  assert.equal(begun.state, 'running');
  await svc("SELECT turn_call_record($1,$2,1,'ok','0.01','0.01','{}'::jsonb,NULL,$3,NULL) v", [payer.a, paid.turnId, 'b'.repeat(64)]);
  const settled = await svc("SELECT turn_close($1,$2,'completed','[]'::jsonb,true) v", [payer.a, paid.turnId]);
  assert.equal(settled.chargedCredits, 6, '0.01 USD x 100 x 6, the held 12 credits released down to what was used');
  assert.equal(await v('SELECT credits::int v FROM profiles WHERE id=$1', [payer.a]), 94);
  report.checks.push('a read turn charges the tool row it used (6 credits) and releases the rest of its freeze');

  // The hidden conversation: one per connection, only for the connection's own account.
  const s1 = await svc('SELECT publish_monitor_session($1,$2) v', [m.a, m.conn]);
  assert.equal(await svc('SELECT publish_monitor_session($1,$2) v', [m.a, m.conn]), s1, 'the same session every time');
  assert.deepEqual((await c.query('SELECT scope FROM runtime_sessions WHERE id=$1', [s1])).rows[0].scope,
    { kind: 'publish_monitor_read', connectionId: m.conn });
  const stranger = await member();
  await assert.rejects(svc('SELECT publish_monitor_session($1,$2) v', [stranger.a, m.conn]), /PUBLISH_MONITOR_INPUT_INVALID/);
  await assert.rejects(svc('SELECT publish_monitor_session($1,$2) v', [m.a, randomUUID()]), /PUBLISH_MONITOR_INPUT_INVALID/);
  report.checks.push('the read session is one hidden conversation per connection and refuses another account or a missing connection');

  // Ledger: one live attempt per request key and refresh; an answered attempt is found again by a re-run.
  const claim = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v')).find(x => x.connectionId === m.conn);
  const keys = [m.conn, claim.lease, claim.refreshId];
  const turn2 = await openTurn(m);
  const bind = id => svc('SELECT publish_monitor_billed_run($1,$2,$3,$4,$5) v', [...keys, id, JSON.stringify([toolPolicy])]);
  await assert.rejects(bind(randomUUID()), /PUBLISH_MONITOR_INPUT_INVALID/, 'a run id must be a review turn of this account');
  const otherTurn = await openTurn(stranger);
  await assert.rejects(bind(otherTurn.request), /PUBLISH_MONITOR_INPUT_INVALID/, 'another account\'s turn cannot be bound');
  const bound = await bind(turn2.request);
  assert.equal(bound.runId, turn2.request);
  assert.equal((await bind(randomUUID())).runId, turn2.request, 'the open run wins');
  const op = randomUUID(), token = randomUUID(), key = 'f'.repeat(64);
  const step = (name, extra = {}) => svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v', [...keys,
    extra.op ?? op, name, extra.key ?? key, ROUTE, extra.token ?? token, extra.call ?? null, extra.state ?? null,
    extra.result ? JSON.stringify(extra.result) : null]);
  assert.deepEqual(await step('open'), { ok: true });
  assert.deepEqual(await step('open', { op: randomUUID() }), { ok: false }, 'one live attempt per key');
  assert.deepEqual(await step('dispatch'), { ok: false }, 'never dispatched before it is linked');
  assert.deepEqual(await step('link', { call: randomUUID() }), { ok: true });
  assert.deepEqual(await step('dispatch', { token: randomUUID() }), { ok: false }, 'the token must match');
  assert.deepEqual(await step('dispatch'), { ok: true });
  // A second key sent but never answered (a killed process), and an attempt opened but never linked.
  const op2 = randomUUID(), op3 = randomUUID();
  await step('open', { op: op2, key: 'e'.repeat(64) }); await step('link', { op: op2, call: randomUUID() }); await step('dispatch', { op: op2 });
  await step('open', { op: op3, key: 'd'.repeat(64) });
  const recovery = await svc('SELECT publish_monitor_billed_recovery($1) v', [turn2.request]);
  assert.deepEqual(recovery.map(x => x.operationId).sort(), [op, op2, op3].sort(), 'every live attempt, nothing else');
  assert.ok(recovery.every(x => Object.keys(x).sort().join() === 'live,operationId' && x.live === true), 'no receipt is replayed: the turn recovery settles the turn');
  // Abandoning is bound to the run, needs no live claim, and frees the key.
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [randomUUID(), op3]), false, 'another run cannot touch it');
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [turn2.request, op3]), true);
  assert.equal(await svc('SELECT publish_monitor_billed_abandon($1,$2) v', [turn2.request, op3]), false, 'idempotent');
  assert.equal((await svc('SELECT publish_monitor_billed_lookup($1,$2,$3,$4) v', [...keys, 'd'.repeat(64)])).found, false);
  report.checks.push('recovery lists the live attempts only (no BILL2 call or receipt); abandon is run-bound and frees the key');
  assert.deepEqual(await step('finish', { state: 'succeeded', result: { items: [{ id: 'n1' }] } }), { ok: true });
  const found = await svc('SELECT publish_monitor_billed_lookup($1,$2,$3,$4) v', [...keys, key]);
  assert.deepEqual([found.found, found.state, found.result], [true, 'answered', { items: [{ id: 'n1' }] }]);
  assert.deepEqual((await svc('SELECT publish_monitor_billed_recovery($1) v', [turn2.request])).map(x => x.operationId), [op2],
    'an answered attempt needs no recovery');
  report.checks.push('ledger: one live attempt per key, link before dispatch, token-bound, answers kept for re-runs');

  // A stale claim cannot open new attempts; a dead refresh's run is listed for closing once its turn is closed.
  await svc('SELECT publish_monitor_refresh_finish($1,$2,$3,$4,$5) v', [...keys, 'done', null]);
  assert.deepEqual(await step('open', { op: randomUUID() }), { ok: false });
  assert.ok(!(await svc('SELECT publish_monitor_billed_orphans(50) v')).some(o => o.runId === turn2.request), 'turn still running: not listed');
  await closeTurn(m, turn2);
  assert.ok((await svc('SELECT publish_monitor_billed_orphans(50) v')).some(o => o.runId === turn2.request), 'turn closed: listed');
  await svc('SELECT publish_monitor_billed_closed($1) v', [turn2.request]);
  assert.ok(!(await svc('SELECT publish_monitor_billed_orphans(50) v')).some(o => o.runId === turn2.request));
  report.checks.push('a settled refresh opens nothing new; its still-open run is listed for closing once the turn is closed, until marked closed');

  // Nothing of BILL2 is left in the monitor (0481): the guard triggers are gone and no monitor function names an old object.
  assert.equal(await v("SELECT count(*)::int v FROM pg_trigger WHERE tgname IN ('publish_monitor_review_admit_guard','publish_monitor_review_result_guard','publish_monitor_review_call_guard')"), 0,
    'the three guard triggers are gone');
  assert.equal(await v("SELECT count(*)::int v FROM pg_proc p WHERE p.proname LIKE 'publish_monitor\\_%' AND (pg_get_functiondef(p.oid) ~ 'runtime_executions|bill2_runs|bill2_calls|runtime_tool_calls|runtime_cancel|runtime_workspace_' AND p.proname<>'publish_monitor_tool_only_run')"), 0,
    'no publish-monitor function reads the old Runtime or BILL2 objects');
  report.checks.push('0481: the guard triggers are gone and no monitor function names an old object (the old run leftovers were closed by the migration while they existed)');

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

  // Disconnecting while a billed call is unsettled must keep the ledger rows (ids and states) and wipe the saved answer.
  const dm = await member();
  const dkeys = await (async () => {
    const claimed = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v')).find(x => x.connectionId === dm.conn);
    return [dm.conn, claimed.lease, claimed.refreshId];
  })();
  const dturn = await openTurn(dm);
  await svc('SELECT publish_monitor_billed_run($1,$2,$3,$4,$5) v', [...dkeys, dturn.request, JSON.stringify([toolPolicy])]);
  const dop = randomUUID(), dstep = (name, extra = {}) => svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v',
    [...dkeys, extra.op ?? dop, name, 'a'.repeat(64), ROUTE, token, extra.call ?? null, extra.state ?? null,
      extra.result ? JSON.stringify(extra.result) : null]);
  const dcall = randomUUID();
  await dstep('open'); await dstep('link', { call: dcall }); await dstep('dispatch');
  await dstep('finish', { state: 'succeeded', result: { items: [{ id: 'secret-post' }], billing: { receipt: { toolOutcome: 'delivered' } } } });
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [dm.a, dm.conn]);
  const kept = (await c.query('SELECT state,result,call_id FROM social_billed_reads WHERE run_id=$1', [dturn.request])).rows;
  assert.deepEqual([kept.length, kept[0].result, kept[0].call_id], [1, { billing: { receipt: { toolOutcome: 'delivered' } } }, dcall],
    'the ledger row survives; the answer is wiped and only the receipt stays');
  // A request still in flight when the connection is deleted: its late finish stores the receipt only, never the answer.
  const lm = await member();
  const lclaim = (await svc('SELECT publish_monitor_tikhub_claim(10,120) v')).find(x => x.connectionId === lm.conn);
  const lkeys = [lm.conn, lclaim.lease, lclaim.refreshId];
  const lturn = await openTurn(lm);
  await svc('SELECT publish_monitor_billed_run($1,$2,$3,$4,$5) v', [...lkeys, lturn.request, JSON.stringify([toolPolicy])]);
  const lop = randomUUID(), lstep = (name, extra = {}) => svc('SELECT publish_monitor_billed_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v',
    [...lkeys, lop, name, 'b'.repeat(64), ROUTE, token, extra.call ?? null, extra.state ?? null, extra.result ? JSON.stringify(extra.result) : null]);
  await lstep('open'); await lstep('link', { call: randomUUID() }); await lstep('dispatch');
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [lm.a, lm.conn]);
  assert.deepEqual(await lstep('finish', { state: 'succeeded', result: { items: [{ id: 'late-secret' }], billing: { receipt: { toolOutcome: 'delivered' } } } }), { ok: true });
  const late = (await c.query('SELECT state,result FROM social_billed_reads WHERE id=$1', [lop])).rows[0];
  assert.deepEqual([late.state, late.result], ['answered', { billing: { receipt: { toolOutcome: 'delivered' } } }]);
  report.checks.push('disconnecting keeps the ledger row of an unsettled call (answer wiped) so its turn can still be settled');

  // Pruning leaves evidence of open runs alone, whatever its age.
  await c.query("UPDATE social_billed_reads SET created_at=now()-interval '9 days' WHERE run_id=$1", [dturn.request]);
  assert.equal(await svc('SELECT publish_monitor_billed_prune(1000) v'), 0, 'open run: nothing pruned');
  await svc('SELECT publish_monitor_billed_closed($1) v', [dturn.request]);
  await c.query("UPDATE social_billed_runs SET closed_at=now()-interval '9 days' WHERE run_id=$1", [dturn.request]);
  assert.ok(await svc('SELECT publish_monitor_billed_prune(1000) v') >= 1);
  assert.equal(await v('SELECT count(*)::int v FROM social_billed_runs WHERE run_id=$1', [dturn.request]), 0);
  report.checks.push('pruning waits for the billed run to be closed and a week to pass');

  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
