/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only VOICE-2 verification (0547): 「从我的账号导入」's "读取最新帖子" claims an own TikHub connection for one manual run of
// 数据复盘's billed read. Checks grants, who and what may be claimed, the hourly limit and a running read, that the claim is the
// one the billed-read ledger and settle functions accept, the hour given back (undo) only for the current claim, and that the
// migration applies again unchanged.
// Run: node packages/db/tests/voice-import/read-latest-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const file = readdirSync(new URL('../../migrations/', import.meta.url)).find(f => /^\d{4}_voice2_import_read_latest\.sql$/.test(f));
assert.ok(file, 'the read-latest migration exists');
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: file, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const profile = async (deleted = false) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,status,is_deleted) VALUES($1,0,$2,$3)', [id, 'active', deleted]);
  return id;
};
// Fixture rows without their business chain (the claim only reads the connection): FK checks off for the inserts only.
const raw = async (sql, args) => { await c.query("SET session_replication_role='replica'"); try { await c.query(sql, args); } finally { await c.query("SET session_replication_role='origin'"); } };
const connection = async (a, { role = 'own', source = 'tikhub', status = 'connected', consentRead = true } = {}) => {
  const id = randomUUID();
  // A Post for Me connection is an overseas account with its provider id; a TikHub one has a profile link.
  const pfm = source === 'postforme';
  await raw(`INSERT INTO social_connections(id,actor_id,business_id,account_project_id,role,source,platform,provider_account_id,profile_ref,
    status,consent_read) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, a, randomUUID(), role === 'benchmark' ? null : randomUUID(), role,
    source, pfm ? 'youtube' : 'douyin', pfm ? 'acct-' + id : null, pfm ? null : 'ref', status, consentRead]);
  return id;
};
const svc = async (sql, args) => { await c.query('BEGIN'); try { await c.query('SET LOCAL ROLE service_role'); const r = await v(sql, args); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } };
const request = (a, cid) => svc('SELECT publish_monitor_tikhub_request($1,$2,300) v', [a, cid]);
const undo = (a, claim) => svc('SELECT publish_monitor_tikhub_request_undo($1,$2,$3,$4) v', [a, claim.connectionId, claim.lease, claim.refreshId]);
const refusal = async promise => { try { await promise; } catch (e) { return e.message; } assert.fail('accepted'); };
const col = (cid, name) => v(`SELECT ${name} v FROM social_connections WHERE id=$1`, [cid]);

try {
  for (const role of ['anon', 'authenticated']) for (const f of ['publish_monitor_tikhub_request(uuid,uuid,integer)', 'publish_monitor_tikhub_request_undo(uuid,uuid,uuid,uuid)'])
    assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
  report.checks.push('service role only');

  const a = await profile(), b = await profile();
  const cid = await connection(a);
  const claim = await request(a, cid);
  assert.equal(claim.connectionId, cid);
  assert.equal(claim.actorId, a);
  assert.equal(claim.role, 'own');
  assert.ok(claim.lease && claim.refreshId);
  assert.ok(await col(cid, 'manual_refresh_at'), 'the hour starts');
  assert.ok(await col(cid, "lease_expires_at>now()+interval '200 seconds'"), 'leased for the read');
  // The claim is the one the billed-read ledger accepts (the daily job's read runs on it unchanged).
  const run = await svc('SELECT publish_monitor_billed_run($1,$2,$3,NULL,NULL) v', [cid, claim.lease, claim.refreshId]);
  assert.ok(run !== null, 'the billed read accepts the manual claim as current');
  report.checks.push('an own connected TikHub connection with read consent is claimed in the daily job\'s shape; the billed read accepts it');

  assert.match(await refusal(request(a, cid)), /PUBLISH_MONITOR_REFRESH_TOO_SOON/, 'once an hour');
  await c.query('UPDATE social_connections SET manual_refresh_at=NULL WHERE id=$1', [cid]);
  assert.match(await refusal(request(a, cid)), /PUBLISH_MONITOR_REFRESH_RUNNING/, 'never while a read is running');
  report.checks.push('once an hour per connection; a running read is not doubled');

  // The hour given back: only for the current claim of the user's own connection.
  await c.query("UPDATE social_connections SET manual_refresh_at=now() WHERE id=$1", [cid]);
  assert.equal(await undo(b, claim), false, 'another account');
  assert.equal(await undo(a, { ...claim, lease: randomUUID() }), false, 'a lease that is not current');
  assert.ok(await col(cid, 'manual_refresh_at'));
  assert.equal(await undo(a, claim), true);
  assert.equal(await col(cid, 'manual_refresh_at'), null, 'the hour is given back');
  assert.equal(await svc("SELECT publish_monitor_refresh_finish($1,$2,$3,'release',NULL) v", [cid, claim.lease, claim.refreshId]), true,
    'the daily job\'s settle releases it');
  const again = await request(a, cid);
  assert.equal(again.refreshId, claim.refreshId, 'a read that did not finish keeps its refresh id, so stored answers are re-used, not charged again');
  await svc("SELECT publish_monitor_refresh_finish($1,$2,$3,'release',NULL) v", [cid, again.lease, again.refreshId]);
  assert.equal(await undo(a, again), false, 'nothing to give back once released');
  report.checks.push('undo gives the hour back only for the current claim of the own connection; settle and refresh id as the daily job');

  const postforme = await connection(a, { source: 'postforme' }), noConsent = await connection(a, { consentRead: false });
  const gone = await connection(a, { status: 'disconnected' }), benchmark = await connection(a, { role: 'benchmark' });
  for (const id of [postforme, noConsent, gone]) assert.match(await refusal(request(a, id)), /PUBLISH_MONITOR_REFRESH_UNAVAILABLE/);
  assert.match(await refusal(request(a, benchmark)), /PUBLISH_MONITOR_CONNECTION_NOT_FOUND/, 'a benchmark account is not the user\'s own');
  assert.match(await refusal(request(b, cid)), /PUBLISH_MONITOR_CONNECTION_NOT_FOUND/, 'another account');
  const closed = await profile(true);
  assert.match(await refusal(request(closed, await connection(closed))), /PUBLISH_MONITOR_ACCOUNT_CLOSED/);
  for (const id of [postforme, noConsent, gone, benchmark]) assert.equal(await col(id, 'manual_refresh_at'), null, 'a refusal starts no hour');
  report.checks.push('refused: Post for Me, no read consent, disconnected, a benchmark, another account, a closed account');

  await c.query(read(`packages/db/migrations/${file}`));
  assert.equal(await v("SELECT has_function_privilege('authenticated','publish_monitor_tikhub_request(uuid,uuid,integer)','execute') v"), false);
  report.checks.push('the migration applies again unchanged');
  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
