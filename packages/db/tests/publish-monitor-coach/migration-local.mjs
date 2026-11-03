/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REVIEW-COACH RC-1 (migration 0457): local PostgreSQL built from repository files only. No provider, model or staging.
// Run: node packages/db/tests/publish-monitor-coach/migration-local.mjs --local-only
import assert from 'node:assert/strict';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { fixtureSql, laterRedefinitions } from '../publish-monitor/fixtures.mjs';
import { generateDataset } from '../../../api/src/services/publishMonitor/coach/simulatedDataset.ts';
import { seedSql } from './seed-sql.mjs';

const MIGRATION = 'packages/db/migrations/0457_publish_monitor_review_coach_foundation.sql';
const OLD_KEYS = ['actorId', 'id', 'maxCostUsd', 'modelId', 'requestId', 'sessionId', 'token'];
const db = await localDb(), c = db.client, report = { build: db.build, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const claim = () => svc('SELECT publish_monitor_review_claim(20) v');
const step = (r, action, reason = null) => svc('SELECT publish_monitor_review_step($1,$2,$3,$4) v', [r.id, r.token, action, reason]);
const run = id => c.query('SELECT * FROM social_review_runs WHERE id=$1', [id]).then(x => x.rows[0]);
const finish = (id, ago) => c.query(`UPDATE social_review_runs SET status='completed',lease_expires_at=NULL,
 finished_at=now()-$2::interval WHERE id=$1`, [id, ago]);
const coach = on => c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_coach_enabled',$1)
 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(on)]);
// A brand whose confirmed positioning report carries content pillars (same chain as pm_test.member).
const brandSql = `CREATE OR REPLACE FUNCTION pm_test.brand(a uuid,plat text,report jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE ac uuid:=pm_test.member(a,plat);v uuid:=gen_random_uuid();r uuid:=gen_random_uuid();src artifact_projects;
BEGIN
 SELECT p.* INTO src FROM opc_accounts o JOIN artifact_versions x ON x.id=o.source_version_id
  JOIN artifact_projects p ON p.id=x.project_id WHERE o.project_id=ac;
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 SELECT r,src.id,revision_id,package_hash,workflow,workflow_hash,template_hash,'published','{}' FROM artifact_rounds
  WHERE project_id=src.id LIMIT 1;
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
 VALUES(v,src.id,r,2,report,repeat('f',64),'[]');
 UPDATE opc_businesses SET current_source_version_id=v WHERE id=(SELECT business_id FROM opc_accounts WHERE project_id=ac);
 RETURN (SELECT business_id FROM opc_accounts WHERE project_id=ac);
END $$;`;
const connect = (a, business, platform) => c.query(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,
 platform,status,consent_read) SELECT a,business_id,project_id,'own','manual',platform,'connected',true
 FROM (SELECT $1::uuid a,business_id,project_id,platform FROM opc_accounts WHERE actor_id=$1 AND business_id=$2 AND platform=$3) x`,
[a, business, platform]);

try {
  await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
  await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
  await c.query(fixtureSql);
  await c.query(brandSql);
  await c.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
   own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) VALUES('RC1 Gold','gold',true,true,0,90,true,true)`);
  await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_enabled','true'),
   ('publish_monitor_review_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`);
  await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_max_usd','"1"')
   ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  const gold = await v('SELECT ws_test.actor() v');
  await c.query("UPDATE profiles SET membership_level='gold',credits=100 WHERE id=$1", [gold]);
  const report1 = { generatedReport: { data: { data: { content: { pillars: ['干货教程', '日常记录', ' '] } }, textEdited: [] } } };
  const brandA = await v("SELECT pm_test.brand($1,'xiaohongshu',$2) v", [gold, report1]);
  const brandB = await v("SELECT pm_test.brand($1,'youtube','{}') v", [gold]);
  await connect(gold, brandA, 'xiaohongshu');
  await connect(gold, brandB, 'youtube');
  await svc('SELECT publish_monitor_set_auto_review($1,true) v', [gold]);
  await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1", [gold]);

  // Coach setting absent: the old claim exactly, one per user, the old output shape the deployed app parses strictly.
  const [legacy] = await claim();
  assert.deepEqual(Object.keys(legacy).sort(), OLD_KEYS);
  assert.deepEqual(await claim(), []);
  const legacyRow = await run(legacy.id);
  assert.equal(legacyRow.business_id, null); assert.equal(legacyRow.cadence, 'weekly'); assert.equal(legacyRow.attempt, 1);
  report.checks.push('coach setting off: claim output and behaviour are the old per-user weekly review');

  // Interrupted with no execution (or a closed bill): retried with a new request in the same session, three attempts.
  let current = legacy;
  for (const attempt of [2, 3]) {
    const out = await step(current, 'skip', 'RUNTIME_INTERRUPTED');
    assert.equal(out.state, 'retrying');
    const row = await run(legacy.id);
    assert.equal(row.status, 'claimed'); assert.equal(row.attempt, attempt);
    assert.notEqual(row.runtime_request_id, current.requestId); assert.equal(row.runtime_session_id, legacy.sessionId);
    assert.equal(Number(row.max_cost_usd), 1); assert.deepEqual(row.prior_bill2_run_ids, []);
    const [again] = await claim();
    assert.equal(again.id, legacy.id); assert.equal(again.requestId, row.runtime_request_id);
    assert.equal((await step(again, 'observe')).expired, false);
    current = again;
  }
  await step(current, 'skip', 'RUNTIME_INTERRUPTED');
  const ended = await run(legacy.id);
  assert.equal(ended.status, 'skipped'); assert.equal(ended.skip_reason, 'RUNTIME_INTERRUPTED'); assert.equal(ended.attempt, 3);
  report.checks.push('RUNTIME_INTERRUPTED retries the same period twice with new request ids, then records the skip');

  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);
  const [balance] = await claim();
  await step(balance, 'skip', 'BALANCE_LOW');
  assert.equal((await run(balance.id)).status, 'skipped');
  report.checks.push('other skip reasons still end the period at once');

  // Coach on: one review per brand, one at a time per user; old per-user rows count for every brand.
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);
  await coach(true);
  await c.query(`INSERT INTO social_review_runs(actor_id,period_start,status,runtime_request_id,finished_at,created_at)
   VALUES($1,current_date-2,'completed',gen_random_uuid(),now()-interval '2 days',now()-interval '2 days')`, [gold]);
  assert.deepEqual(await claim(), []);
  report.checks.push('turning the coach on adds no early review after a recent old-style review');
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);
  const [first] = await claim();
  // The same key list the app's scheduler test builds its claims from (reviews.test.ts), so the two sides cannot drift apart.
  assert.deepEqual(Object.keys(first).sort(), JSON.parse(read('packages/db/tests/publish-monitor-coach/claim-keys.json')));
  assert.equal(first.cadence, 'weekly'); assert.equal(first.attempt, 1);
  assert.deepEqual(await claim(), []);
  await finish(first.id, '1 minute');
  const [second] = await claim();
  assert.deepEqual(new Set([first.businessId, second.businessId]), new Set([brandA, brandB]));
  await finish(second.id, '1 minute');
  assert.deepEqual(await claim(), []);
  report.checks.push('coach on: each brand gets its own review, never two in flight for one user');

  const profileA = await v('SELECT to_jsonb(p) v FROM social_coach_profiles p WHERE business_id=$1', [brandA]);
  assert.deepEqual(profileA.pillars.map(p => [p.key, p.name]), [['p1', '干货教程'], ['p2', '日常记录']]);
  assert.equal(profileA.pillars_source, 'extracted');
  const profileB = await v('SELECT to_jsonb(p) v FROM social_coach_profiles p WHERE business_id=$1', [brandB]);
  assert.deepEqual(profileB.pillars, []); assert.equal(profileB.pillars_source, null);
  report.checks.push('first sight of a brand extracts pillars from its confirmed report; none stays empty, not invented');

  // Cadence: monthly after 28 days, quarterly after 91 days or when an account stage changes.
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);
  await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '40 days' WHERE actor_id=$1", [gold]);
  const monthly = await claim();
  assert.equal(monthly[0].cadence, 'monthly');
  await finish(monthly[0].id, '1 minute');
  const [next] = await claim();
  assert.notEqual(next.businessId, monthly[0].businessId); assert.equal(next.cadence, 'monthly');
  await finish(next.id, '1 minute');
  assert.deepEqual(await claim(), []);
  await c.query("UPDATE social_review_runs SET finished_at=now()-interval '8 days' WHERE actor_id=$1", [gold]);
  const [weekly] = await claim();
  assert.equal(weekly.cadence, 'weekly');
  await finish(weekly.id, '8 days');
  await c.query("UPDATE opc_accounts SET stage='growing' WHERE business_id=$1", [weekly.businessId]);
  const [quarterly] = await claim();
  assert.equal(quarterly.cadence, 'quarterly'); assert.equal(quarterly.businessId, weekly.businessId);
  const stagesOf = () => v('SELECT strategy_check_stages v FROM social_coach_profiles WHERE business_id=$1', [weekly.businessId]);
  // A skipped strategy check does not consume the stage change: it is scheduled again.
  await step(quarterly, 'skip', 'BALANCE_LOW');
  assert.ok(!Object.values(await stagesOf()).includes('growing'));
  // A week later (the skip itself starts the next period, so its period key differs from the skipped one).
  await c.query(`UPDATE social_review_runs SET finished_at=finished_at-interval '7 days 1 minute' WHERE actor_id=$1`, [gold]);
  const [again] = await claim();
  assert.equal(again.cadence, 'quarterly'); assert.equal(again.businessId, weekly.businessId);
  // Completed: the stages seen are recorded and the next due review is no longer a strategy check.
  const reviewPolicy = { q: 100, uTurnUsd: 0.04, gCredits: 24, minCredits: 6, uModelCredits: 24, historyItems: 0, inputBytes: 1000,
    limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    review: { mode: 'weekly' } };
  const reviewTurn = await svc('SELECT turn_open($1,$2,$3,$4,$5) v', [gold, again.sessionId, again.requestId, 'review', JSON.stringify(reviewPolicy)]);
  await svc("SELECT turn_close($1,$2,'completed','[]'::jsonb,true,false,NULL) v", [gold, reviewTurn.turnId]);
  assert.equal((await step(again, 'observe')).state, 'completed');
  assert.equal((await run(again.id)).status, 'completed');
  assert.ok(Object.values(await stagesOf()).includes('growing'));
  await c.query("UPDATE social_review_runs SET finished_at=now()-interval '8 days' WHERE actor_id=$1", [gold]);
  assert.notEqual((await claim()).find(x => x.businessId === weekly.businessId)?.cadence, 'quarterly');
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);
  await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '100 days' WHERE actor_id=$1", [gold]);
  assert.equal((await claim())[0].cadence, 'quarterly');
  report.checks.push('cadence: monthly after 28 days, quarterly after 91 days or a stage change that only a completed check consumes');
  await coach(false);
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [gold]);

  // Facts: settle the simulated dataset and compare with its ground truth.
  const today = await v("SELECT (now() AT TIME ZONE 'UTC')::date::text v");
  const dataset = generateDataset({ asOf: today });
  const sim = await v('SELECT ws_test.actor() v');
  await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1", [sim]);
  const businesses = {};
  for (const account of dataset.accounts) {
    const project = await v('SELECT pm_test.member($1,$2) v', [sim, account.connections[0].platform]);
    businesses[account.key] = await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [project]);
  }
  await c.query(seedSql(dataset, sim, businesses));
  let settled = 0, batch;
  while ((batch = await svc('SELECT publish_monitor_settle_facts(5000) v')) > 0) settled += batch;
  assert.equal(await svc('SELECT publish_monitor_settle_facts(5000) v'), 0);
  const facts = new Map((await c.query(`SELECT sp.platform_post_id k,to_jsonb(f) f FROM social_post_facts f
   JOIN social_posts sp ON sp.id=f.post_id WHERE f.actor_id=$1`, [sim])).rows.map(r => [r.k, r.f]));
  const posts = dataset.accounts.flatMap(a => a.posts.map(p => ({ post: p, truth: a.settled.find(s => s.postKey === p.key) })))
    .filter(x => x.post.visibility !== 'not_imported' && Date.parse(x.post.postedAt) <= Date.now() - 7 * 86_400_000);
  assert.equal(facts.size, posts.length); assert.equal(settled, posts.length);
  let day7 = 0, imported = 0;
  for (const { post, truth } of posts) {
    const fact = facts.get(post.platformPostId);
    // A missing exact day falls back to day 8-9 and says so in day7_on; only the exact day must equal the truth.
    const on = (days) => new Date(Date.parse(post.postedAt.slice(0, 10)) + days * 86_400_000).toISOString().slice(0, 10);
    if (fact.day7) {
      day7++;
      if (fact.day7_on === on(7)) assert.deepEqual(fact.day7, truth.day7);
      else assert.ok([on(8), on(9)].includes(fact.day7_on) && fact.day7.views >= truth.day7.views);
    }
    if (fact.import_cumulative && post.visibility === 'cumulative_at_import') {
      imported++; assert.deepEqual(fact.import_cumulative, truth.cumulativeAtImport.metrics);
    }
    if (fact.day30 && fact.day30_on === on(30)) assert.deepEqual(fact.day30, truth.day30);
    assert.equal(fact.business_id, businesses[post.account]);
  }
  assert.ok(day7 > 250 && imported > 20, `${day7} ${imported}`);
  const outage = dataset.accounts.find(a => a.key === 'B').outages[0];
  const lost = posts.filter(x => x.post.platform === 'youtube' && x.post.account === 'B' && x.post.visibility === 'daily')
    .map(x => facts.get(x.post.platformPostId)).filter(f => f.day7 === null);
  assert.ok(lost.length > 0 && lost.every(f => f.missing_fields.includes('day7')), JSON.stringify(outage));
  report.checks.push(`settled ${settled} posts: day-7/30 and import values equal the dataset's ground truth; outage marks day7 missing`);

  // Review pack rows: one round trip, owner and brand scoped, long-run facts not cut to the 90-day window.
  const runId = await v(`INSERT INTO social_review_runs(actor_id,business_id,period_start,status,runtime_request_id,finished_at)
   VALUES($1,$2,current_date,'completed',gen_random_uuid(),now()) RETURNING id v`, [sim, businesses.A]);
  await c.query(`INSERT INTO social_review_experiments(actor_id,business_id,proposed_in,kind,hypothesis,action,metric,target_mult,
   match,evidence,period_start,period_end) VALUES($1,$2,$3,'tactic','h','a','views',1.5,'{"pillar_key":"p1"}','{"post_ids":[]}',
   current_date,current_date+14)`, [sim, businesses.A, runId]);
  const anyPost = await v('SELECT post_id v FROM social_post_facts WHERE business_id=$1 ORDER BY posted_at DESC LIMIT 1', [businesses.A]);
  await c.query(`INSERT INTO social_post_diagnostics(actor_id,business_id,post_id,platform,source,rates,opening_text,captured_on,
   confirmed_at,review_run_id) VALUES($1,$2,$3,'xiaohongshu','manual','{"bounce_2s":0.6}','开头第一句',current_date,now(),$4)`,
  [sim, businesses.A, anyPost, runId]);
  const pack = await svc('SELECT publish_monitor_review_pack_rows($1,$2,30) v', [sim, businesses.A]);
  assert.ok(pack.facts.some(f => Date.parse(f.postedAt) < Date.now() - 100 * 86_400_000));
  assert.equal(pack.experiments.length, 1); assert.equal(pack.diagnostics[0].openingText, '开头第一句');
  assert.equal(pack.diagnostics[0].dropSecond, null);
  const recent = dataset.accounts.find(x => x.key === 'A').posts.filter(p => Date.parse(p.postedAt) > Date.now() - 7 * 86_400_000);
  assert.equal(pack.recent.length, recent.length);
  assert.ok(pack.recent.every(r => Date.parse(r.postedAt) > Date.now() - 14 * 86_400_000) && recent.length > 0);
  assert.equal(pack.facts.every(f => typeof f.title === 'string'), true);
  const xhs = pack.followers.find(f => f.platform === 'xiaohongshu');
  const truth = dataset.accounts.find(a => a.key === 'A').snapshots.filter(x => !x.postKey && x.platform === 'xiaohongshu');
  assert.equal(xhs.points.length, truth.length); assert.equal(xhs.points.at(-1).value, truth.at(-1).metrics.followers);
  assert.equal(pack.strategy, null);
  const strategyPack = await svc('SELECT publish_monitor_review_pack_rows($1,$2,30) v', [gold, brandA]);
  assert.deepEqual(strategyPack.strategy, { content: { pillars: ['干货教程', '日常记录', ' '] } });
  await assert.rejects(svc('SELECT publish_monitor_review_pack_rows($1,$2,30) v', [gold, businesses.A]), /BUSINESS_NOT_FOUND/);
  await assert.rejects(svc('SELECT publish_monitor_review_pack_rows($1,$2,0) v', [sim, businesses.A]), /INPUT_INVALID/);
  report.checks.push('pack rows return facts beyond 100 days, experiments and diagnostics for the owner brand only');

  // RC-3b (migration 0491): a delivered brand review writes its checked output into the ledger and the facts, once, under its lease.
  await c.query(`INSERT INTO social_coach_profiles(actor_id,business_id,pillars,pillars_source) VALUES($1,$2,$3,'user')
   ON CONFLICT(actor_id,business_id) DO UPDATE SET pillars=EXCLUDED.pillars`,
  [sim, businesses.A, JSON.stringify([{ key: 'p1', name: 'a', definition: 'a' }, { key: 'p2', name: 'b', definition: 'b' }])]);
  const experiment = (start, end, extended = false) => v(`INSERT INTO social_review_experiments(actor_id,business_id,proposed_in,kind,status,
   hypothesis,action,metric,target_mult,match,evidence,period_start,period_end,extended_once) VALUES($1,$2,$3,'tactic','running','h','a','views',1.5,
   '{"pillar_key":"p1","platform":"xiaohongshu"}','{"post_ids":[]}',current_date+$4::int,current_date+$5::int,$6) RETURNING id v`,
  [sim, businesses.A, runId, start, end, extended]);
  const [done, retry, outside, spent] = [await experiment(-40, -20), await experiment(-40, -20), await experiment(-40, -20), await experiment(-40, -20, true)];
  const result = (verdict, next) => ({ verdict, reason: null, lean: null, matched_posts: [], samples: 4, median: 10, vs_baseline: 1.6, next_status: next });
  const leaseToken = await v('SELECT gen_random_uuid() v');
  const coachRun = await v(`INSERT INTO social_review_runs(actor_id,business_id,period_start,status,runtime_request_id,lease_token,lease_expires_at,pack)
   VALUES($1,$2,current_date-400,'claimed',gen_random_uuid(),$3,now()+interval '1 hour',$4) RETURNING id v`,
  [sim, businesses.A, leaseToken, JSON.stringify({ review: { ledger: { to_review: [{ id: done, result: result('worked', 'concluded') },
    { id: retry, result: result('inconclusive', 'extended') }, { id: spent, result: result('inconclusive', 'extended') }] } } })]);
  const untagged = (await c.query('SELECT post_id FROM social_post_facts WHERE business_id=$1 AND pillar_key IS NULL LIMIT 2', [businesses.A])).rows.map(r => r.post_id);
  const otherBrand = await v('SELECT post_id v FROM social_post_facts WHERE business_id=$1 AND pillar_key IS NULL LIMIT 1', [businesses.B]);
  assert.equal(untagged.length, 2); assert.ok(otherBrand);
  const newExperiment = { kind: 'tactic', layer: null, hypothesis: 'h2', action: 'a2', metric: 'views', target_mult: 1.5, target_line: null,
    match: { pillar_key: 'p2', platform: 'xiaohongshu' }, baseline: { metric: 'views', median: 9, samples: 5, window_weeks: 8, basis: 'day7' },
    evidence: { post_ids: [], metrics: [] }, period_start: '2030-01-01', period_end: '2030-01-07' };
  const payload = { experiments: [newExperiment], verdict_notes: [{ experiment_id: done, note: '数据够，做法有效' }, { experiment_id: outside, note: 'x' }],
    tags: [{ post_id: untagged[0], pillar_key: 'p2' }, { post_id: untagged[1], pillar_key: 'p9' }, { post_id: otherBrand, pillar_key: 'p1' }] };
  const save = (body, token = leaseToken) => svc('SELECT publish_monitor_review_save_coach($1,$2,$3) v', [coachRun, token, JSON.stringify(body)]);
  const row = id => v('SELECT to_jsonb(e) v FROM social_review_experiments e WHERE id=$1', [id]);
  assert.deepEqual(await save(payload), { saved: true, concluded: 2, proposed: 1, tagged: 1 });
  const [d, r, o, sp] = [await row(done), await row(retry), await row(outside), await row(spent)];
  assert.deepEqual([d.status, d.verdict, d.verdict_in, d.verdict_detail.note], ['concluded', 'worked', coachRun, '数据够，做法有效']);
  assert.deepEqual([r.status, r.extended_once, r.verdict, r.verdict_in], ['extended', true, null, coachRun]);
  assert.equal(r.period_end, await v(`SELECT (current_date-20+21)::text v`), 'extended by its own length');
  assert.deepEqual([o.status, o.verdict_in, o.verdict_detail], ['running', null, null], 'a verdict note alone never concludes anything');
  assert.deepEqual([sp.status, sp.verdict_in], ['running', null], 'a second extension is not given');
  const created = await v('SELECT to_jsonb(e) v FROM social_review_experiments e WHERE proposed_in=$1', [coachRun]);
  assert.deepEqual([created.status, created.hypothesis, created.baseline.median, created.period_start], ['running', 'h2', 9, '2030-01-01']);
  assert.deepEqual((await c.query('SELECT post_id,pillar_key,pillar_source FROM social_post_facts WHERE post_id=ANY($1) OR post_id=$2 ORDER BY pillar_key NULLS LAST',
    [untagged, otherBrand])).rows.map(x => [x.pillar_key, x.pillar_source]), [['p2', 'model'], [null, null], [null, null]]);
  assert.deepEqual(await save(payload), { saved: true, concluded: 0, proposed: 0, tagged: 0 }, 'saving twice changes nothing');
  assert.deepEqual(await save(payload, await v('SELECT gen_random_uuid() v')), { saved: false });
  await assert.rejects(save({ experiments: [newExperiment, newExperiment, newExperiment, newExperiment] }), /INPUT_INVALID/);
  assert.equal((await c.query(`SELECT has_function_privilege('authenticated','publish_monitor_review_save_coach(uuid,uuid,jsonb)','EXECUTE') ok`)).rows[0].ok, false);
  report.checks.push('RC-3b: verdicts come from the saved pack (note added, second extension refused), experiments and tags written once under the lease');

  // Erasure: counted, and removed with their parents.
  const before = await v('SELECT publish_monitor_erasure_remaining($1) v', [sim]);
  const rows = await v(`SELECT (SELECT count(*) FROM social_post_facts WHERE actor_id=$1)+(SELECT count(*) FROM social_post_diagnostics
   WHERE actor_id=$1)+(SELECT count(*) FROM social_review_experiments WHERE actor_id=$1) v`, [sim]);
  assert.ok(Number(rows) > 0);
  await c.query('DELETE FROM social_metric_snapshots WHERE actor_id=$1', [sim]);
  await c.query('DELETE FROM social_posts WHERE actor_id=$1', [sim]);
  await c.query('DELETE FROM social_review_runs WHERE actor_id=$1', [sim]);
  assert.equal(Number(await v(`SELECT (SELECT count(*) FROM social_post_facts WHERE actor_id=$1)+(SELECT count(*)
   FROM social_post_diagnostics WHERE actor_id=$1)+(SELECT count(*) FROM social_review_experiments WHERE actor_id=$1) v`, [sim])), 0);
  assert.ok(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [sim])) < Number(before));
  assert.deepEqual((await c.query(read('packages/db/tests/erasure-coverage-audit.sql'))).rows, []);
  report.checks.push('new rows are counted by erasure_remaining, cascade away with posts and runs, and pass the coverage audit');

  // Reapply and rollback.
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalog = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const built = await v(catalog);
  // 0457, then the publish-monitor migrations after it (0463, 0477 redefine its claim and step): the pair replays to the same catalog.
  for (const path of laterRedefinitions('0457')) await c.query(read(path)); // 0457 itself is not replayable after batch F (its rollback names the old run tables)
  assert.deepEqual(await v(catalog), built);
  const grants = await c.query(`SELECT f,r,has_function_privilege(r,f,'EXECUTE') ok FROM unnest(ARRAY[
   'publish_monitor_review_claim(integer)','publish_monitor_settle_facts(integer)','publish_monitor_review_pack_rows(uuid,uuid,integer)',
   'publish_monitor_erasure_remaining(uuid)']) f,unnest(ARRAY['authenticated','service_role']) r ORDER BY 1,2`);
  assert.deepEqual(grants.rows.map(r => r.ok), [false, false, false, true, false, true, false, true]);
  report.checks.push('reapplying the later migrations changes no schema; functions are service-role only (the 0457 rollback went with the old tables)');
} catch (error) {
  report.failed = String(error.stack ?? error); process.exitCode = 1;
} finally {
  await db.close(); console.log(JSON.stringify(report, null, 1));
}
