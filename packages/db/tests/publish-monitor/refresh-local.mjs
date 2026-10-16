/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-3a verification: daily refresh claims, page writes, empty-list rules, observation
// schedule, the 30/90-day window, manual refresh, post linking, retention and erasure interplay.
// Run: node packages/db/tests/publish-monitor/refresh-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql, REFRESH_MIGRATION } from './fixtures.mjs';

const rpcs = ['publish_monitor_refresh_claim(integer,integer)', 'publish_monitor_refresh_request(uuid,uuid,integer)',
  'publish_monitor_refresh_page(uuid,uuid,uuid,jsonb,text,boolean)',
  'publish_monitor_refresh_due(uuid,uuid,uuid,integer,integer)',
  'publish_monitor_refresh_finish(uuid,uuid,uuid,text,text)', 'publish_monitor_data(uuid,integer,uuid)',
  'publish_monitor_post_history(uuid,uuid,integer)', 'publish_monitor_link_post(uuid,uuid,uuid)',
  'publish_monitor_snapshot_prune(integer)', 'publish_monitor_manual_import(uuid,uuid,text,jsonb)'];
const internal = ['publish_monitor_actor_open(uuid)', 'publish_monitor_refresh_item(social_connections)',
  'publish_monitor_refresh_current(uuid,uuid,uuid)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: REFRESH_MIGRATION, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const REF = 'a'.repeat(32);
let refs = 0;
const member = async (plat = 'youtube') => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  const account = await v('SELECT pm_test.member($1,$2) v', [a, plat]);
  const ref = (++refs).toString(16).padStart(32, '0');
  await c.query('INSERT INTO social_monitor_settings(actor_id,provider_ref) VALUES($1,$2)', [a, ref]);
  return { a, account, ref, business: await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [account]) };
};
const connection = (m, over = {}) => v(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,
  platform,provider_account_id,status,consent_read,consent_auto_track) VALUES($1,$2,$3,'own','postforme',$4,$5,$6,$7,$8)
  RETURNING id v`, [m.a, m.business, m.account, over.platform ?? 'youtube', over.pid ?? `spc_${randomUUID().slice(0, 8)}`,
  over.status ?? 'connected', over.read ?? true, over.track ?? true]);
const row = id => c.query('SELECT * FROM social_connections WHERE id=$1', [id]).then(r => r.rows[0]);
const claimAll = () => svc('SELECT publish_monitor_refresh_claim(200,120) v');
const claimOf = async id => (await claimAll()).find(x => x.connectionId === id);
const post = (id, posted, extra = {}) => ({ platformPostId: id, url: null, postedAt: posted, postedAtSource: posted ? 'provider' : null,
  titleExcerpt: `t ${id}`, metrics: { views: 5 }, breakdowns: {}, missingFields: ['likes'], ...extra });
const page = (k, posts, cursor = null, save = true) => svc('SELECT publish_monitor_refresh_page($1,$2,$3,$4,$5,$6) v',
  [k.connectionId, k.lease, k.refreshId, j(posts), cursor, save]);
const finish = (k, outcome, err = null) => svc('SELECT publish_monitor_refresh_finish($1,$2,$3,$4,$5) v',
  [k.connectionId, k.lease, k.refreshId, outcome, err]);
const ago = days => new Date(Date.now() - days * 86_400_000).toISOString();
// Moves a connection to "yesterday" so the next claim sees a new UTC day.
const nextDay = id => c.query(`UPDATE social_connections SET refresh_day=refresh_day-1,empty_day=empty_day-1,
  pages_day=pages_day-1,fail_day=fail_day-1 WHERE id=$1`, [id]);

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(`packages/db/migrations/${REFRESH_MIGRATION}`));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('reapplication preserves the complete catalog');

  for (const f of [...rpcs, ...internal]) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), rpcs.includes(f), f);
    assert.match(await v('SELECT array_to_string(proconfig,\',\') v FROM pg_proc WHERE oid=$1::regprocedure', [f]),
      /search_path=public, ?pg_temp/);
  }
  report.checks.push('ten RPCs for service_role only, three internal helpers; fixed search_path; clients have no access');

  // Claim: only connected own connections with read and automatic-tracking consent; once per UTC day; leased once.
  const u = await member(), w = await member(), q = await member();
  const cu = await connection(u), cNoTrack = await connection(w, { track: false });
  const cReauth = await connection(q, { status: 'reauth_required' });
  const first = await claimAll();
  const ids = first.map(x => x.connectionId);
  assert.ok(ids.includes(cu) && !ids.includes(cNoTrack) && !ids.includes(cReauth));
  const k = first.find(x => x.connectionId === cu);
  assert.deepEqual([k.ownerRef, k.pagesUsed, k.knownPosts, k.cursor], [u.ref, 0, 0, null]);
  assert.equal((await claimAll()).some(x => x.connectionId === cu), false, 'a leased connection is not claimed twice');
  report.checks.push('daily claim: connected, read and auto-track consent, leased once (plan §9 item 12)');

  // Page writes are idempotent: re-reading the same page adds no post and no second snapshot for the day.
  const p1 = [post('v1', ago(1)), post('v2', null)];
  assert.deepEqual(await page(k, p1, 'c2'), { stale: false, inserted: 2, existing: 0 });
  assert.equal((await row(cu)).refresh_cursor, 'c2');
  assert.deepEqual(await page(k, p1, 'c2'), { stale: false, inserted: 0, existing: 2 });
  assert.equal(await v('SELECT count(*)::int v FROM social_posts WHERE connection_id=$1', [cu]), 2);
  assert.equal(await v('SELECT count(*)::int v FROM social_metric_snapshots WHERE connection_id=$1', [cu]), 2);
  assert.equal((await row(cu)).refresh_cursor, null, 'discovery ends at a known post: tomorrow starts from the newest page');
  await page(k, [post('v3', ago(2))], 'c2');
  const r1 = await row(cu);
  assert.deepEqual([r1.refresh_cursor, r1.pages_used], ['c2', 3]);
  assert.deepEqual(await v(`SELECT missing_fields v FROM social_metric_snapshots s JOIN social_posts p ON p.id=s.post_id
    WHERE p.platform_post_id='v1'`), ['likes'], 'missing fields are listed, not written as zero');
  report.checks.push('page writes upsert posts and one snapshot per post per day; the cursor is saved with the page');

  // A stale worker (wrong lease or refresh number) writes nothing and cannot settle.
  assert.deepEqual(await page({ ...k, lease: randomUUID() }, [post('v9', ago(1))]), { stale: true });
  assert.equal(await finish({ ...k, refreshId: randomUUID() }, 'done'), false);
  report.checks.push('a stale lease or refresh number changes nothing (plan §9 item 11)');

  // Partial keeps the refresh number and cursor for tomorrow; the next day's claim resumes from them.
  assert.equal(await finish(k, 'partial', 'PAGE_CAP'), true);
  let r2 = await row(cu);
  assert.deepEqual([r2.refresh_state, r2.refresh_cursor, r2.refresh_id, r2.lease_owner], ['partial', 'c2', k.refreshId, null]);
  assert.equal(await claimOf(cu), undefined, 'settled for today');
  await nextDay(cu);
  const k2 = await claimOf(cu);
  assert.deepEqual([k2.refreshId, k2.cursor, k2.knownPosts, k2.pagesUsed], [k.refreshId, 'c2', 3, 0]);
  await finish(k2, 'done');
  r2 = await row(cu);
  assert.deepEqual([r2.refresh_state, r2.refresh_cursor, r2.refresh_id, r2.refresh_attempts], ['ok', null, null, 0]);
  report.checks.push('an interrupted refresh resumes from its cursor the next day; done clears it');

  // Empty-list rules (plan §4.1, §9 item 3).
  await nextDay(cu);
  let k3 = await claimOf(cu);
  await finish(k3, 'empty');
  r2 = await row(cu);
  assert.deepEqual([r2.status, r2.refresh_state, r2.empty_streak], ['connected', 'not_fetched', 1]);
  assert.equal(await v('SELECT count(*)::int v FROM social_posts WHERE connection_id=$1', [cu]), 3, 'old data kept');
  await nextDay(cu);
  k3 = await claimOf(cu);
  await finish(k3, 'empty');
  r2 = await row(cu);
  assert.deepEqual([r2.status, r2.empty_streak], ['reauth_required', 2],
    'a connection that showed posts and reads empty two days running needs re-authorisation');
  const fresh = await member(), cf = await connection(fresh);
  for (let d = 1; d <= 7; d++) {
    const kk = await claimOf(cf);
    await finish(kk, 'empty');
    if (d === 3) {
      // A same-day manual refresh does not count a second day.
      const again = await svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [fresh.a, cf]);
      await finish(again, 'empty');
      assert.equal((await row(cf)).empty_streak, 3);
    }
    const st = await row(cf);
    assert.deepEqual([st.status, st.refresh_state], ['connected', d >= 7 ? 'reauth_suggested' : 'no_posts_yet'], `day ${d}`);
    await nextDay(cf);
    await c.query('UPDATE social_connections SET manual_refresh_at=NULL WHERE id=$1', [cf]);
  }
  report.checks.push('empty reads: with earlier posts two days -> re-authorise; never any posts -> prompt after 7 days');

  // Failures keep old data and the cursor; three in a row show "failed". Provider refusal asks to re-authorise.
  const fm = await member(), cfail = await connection(fm);
  for (let d = 1; d <= 3; d++) {
    const kk = await claimOf(cfail);
    await page(kk, [post(`f${d}`, ago(1))], 'cx');
    await finish(kk, 'failed', 'PROVIDER_FAILED_500');
    if (d === 2) {
      // A second failure the same day (the user's manual refresh) is not a second failed day.
      await finish(await svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [fm.a, cfail]), 'failed', 'PROVIDER_FAILED_500');
      await c.query('UPDATE social_connections SET manual_refresh_at=NULL WHERE id=$1', [cfail]);
    }
    assert.equal((await row(cfail)).refresh_attempts, d);
    assert.equal((await row(cfail)).refresh_state, d >= 3 ? 'failed' : 'not_fetched');
    await nextDay(cfail);
  }
  assert.equal((await row(cfail)).refresh_cursor, 'cx');
  const kr = await claimOf(cfail);
  await finish(kr, 'rejected', 'PROVIDER_REJECTED_401');
  assert.equal((await row(cfail)).status, 'reauth_required');
  // An empty day in between breaks the run of failed days.
  const gm = await member(), cg = await connection(gm);
  await finish(await claimOf(cg), 'failed', 'PROVIDER_FAILED_500');
  await nextDay(cg);
  await finish(await claimOf(cg), 'empty');
  await nextDay(cg);
  await finish(await claimOf(cg), 'failed', 'PROVIDER_FAILED_500');
  assert.deepEqual([(await row(cg)).refresh_attempts, (await row(cg)).refresh_state], [1, 'not_fetched']);
  report.checks.push('failures count once per day, consecutive days only; "failed" after three; a 401 asks to re-authorise');

  // Takeover proven by the read check: quarantined with the provider disconnect queued (same as 0265).
  const tm = await member(), ct = await connection(tm);
  await finish(await claimOf(ct), 'taken_over');
  const tr = await row(ct);
  assert.deepEqual([tr.status, tr.provider_disconnect_pending, tr.deletion_attempts], ['quarantined', true, 0]);
  assert.ok((await svc('SELECT publish_monitor_provider_work_claim(50,120) v')).some(x => x.connectionId === ct));
  report.checks.push('a takeover found before reading quarantines and queues the provider disconnect');

  // A webhook disconnect or the user's disconnect during a refresh invalidates the claim.
  const dm = await member(), cd = await connection(dm, { pid: 'spc_dis' });
  const kd = await claimOf(cd);
  await svc('SELECT publish_monitor_provider_account_disconnected($1) v', ['spc_dis']);
  assert.deepEqual(await page(kd, [post('d1', ago(1))]), { stale: true });
  report.checks.push('a provider disconnect during a refresh makes the running claim stale');

  // Observation schedule: daily to day 7, weekly to day 30, fortnightly to day 90 (only with a 90-day window).
  const sm = await member(), cs = await connection(sm);
  const ks = await claimOf(cs);
  const schedule = [['d3', 3, 1], ['d3today', 3, 0], ['d20w', 20, 7], ['d20early', 20, 3], ['d60', 60, 14],
    ['d60early', 60, 10], ['d120', 120, 30], ['never', null, null]];
  for (const [id, age, last] of schedule) {
    await c.query(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id,posted_at,snapshot_day)
      VALUES($1,$2,'postforme',$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE (now() AT TIME ZONE 'UTC')::date-$5::int END)`,
    [sm.a, cs, id, age === null ? null : ago(age), last]);
  }
  const due = async days => (await svc('SELECT publish_monitor_refresh_due($1,$2,$3,$4,100) v',
    [cs, ks.lease, ks.refreshId, days])).sort();
  assert.deepEqual(await due(30), ['d20w', 'd3', 'never'].sort());
  assert.deepEqual(await due(90), ['d20w', 'd3', 'd60', 'never'].sort());
  report.checks.push('observation schedule: daily to 7 days, weekly to 30, fortnightly to 90 for a 90-day window');

  // The data window (plan §9 item 4): a 40-day-old post is outside 30 days and inside 90; others' data never shows.
  const wm = await member(), cw = await connection(wm);
  const kw = await claimOf(cw);
  await page(kw, [post('w5', ago(5)), post('w40', ago(40)), post('wu', null)]);
  await finish(kw, 'done');
  const data = async days => svc('SELECT publish_monitor_data($1,$2,NULL) v', [wm.a, days]);
  const d30 = await data(30), d90 = await data(90);
  assert.deepEqual(d30.posts.map(x => x.titleExcerpt).sort(), ['t w5', 't wu']);
  assert.deepEqual(d90.posts.map(x => x.titleExcerpt).sort(), ['t w40', 't w5', 't wu']);
  assert.deepEqual(d30.posts.find(x => x.titleExcerpt === 't w5').latest.missingFields, ['likes']);
  assert.equal(d30.connections.length, 1);
  assert.equal((await svc('SELECT publish_monitor_data($1,90,NULL) v', [u.a])).posts.every(x => x.connectionId === cu), true);
  const w40 = d90.posts.find(x => x.titleExcerpt === 't w40').id;
  await code(svc('SELECT publish_monitor_post_history($1,$2,30) v', [wm.a, w40]), 'P0002');
  assert.equal((await svc('SELECT publish_monitor_post_history($1,$2,90) v', [wm.a, w40])).snapshots.length, 1);
  await code(svc('SELECT publish_monitor_post_history($1,$2,90) v', [u.a, w40]), 'P0002');
  report.checks.push('30/90-day windows return only posts inside them; another user\'s post is not found');

  // Manual refresh: own connected connection with read consent, once an hour, not while a refresh runs.
  const mm = await member(), cm = await connection(mm, { track: false });
  await code(svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [u.a, cm]), 'P0002');
  const km = await svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [mm.a, cm]);
  assert.equal(km.connectionId, cm);
  await code(svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [mm.a, cm]), 'PT429');
  await finish(km, 'done');
  await c.query("UPDATE social_connections SET manual_refresh_at=now()-interval '61 minutes' WHERE id=$1", [cm]);
  await c.query("UPDATE social_connections SET lease_owner=gen_random_uuid(),lease_expires_at=now()+interval '1 minute' WHERE id=$1", [cm]);
  await code(svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [mm.a, cm]), 'PT409');
  await c.query('UPDATE social_connections SET lease_owner=NULL,lease_expires_at=NULL,consent_read=false WHERE id=$1', [cm]);
  await code(svc('SELECT publish_monitor_refresh_request($1,$2,60) v', [mm.a, cm]), '42501');
  report.checks.push('manual refresh: owner only, read consent required, once an hour, not doubled while running');

  // Linking a post to a content item (plan §9 item 20): only the same user's item on the connection's brand account.
  const linkPost = d30.posts.find(x => x.titleExcerpt === 't w5').id;
  const item = async (owner, accountProjectId) => {
    const id = randomUUID();
    await c.query("SET session_replication_role='replica'");
    try {
      await c.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
        SELECT $1::uuid,$2,module_id,skill_id,'item-'||$1::text,'item',0 FROM artifact_projects WHERE id=$3`,
      [id, owner, accountProjectId]);
      await c.query(`INSERT INTO opc_items(work_item_id,plan_id,item_key,account_project_id,source_version_id,brief,day)
        VALUES($1,gen_random_uuid(),gen_random_uuid(),$2,gen_random_uuid(),'brief',current_date)`, [id, accountProjectId]);
    } finally { await c.query("SET session_replication_role='origin'"); }
    return id;
  };
  const mine = await item(wm.a, wm.account), others = await item(u.a, u.account);
  await code(svc('SELECT publish_monitor_link_post($1,$2,$3) v', [wm.a, linkPost, others]), '42501');
  assert.deepEqual(await svc('SELECT publish_monitor_link_post($1,$2,$3) v', [wm.a, linkPost, mine]),
    { postId: linkPost, workItemId: mine });
  await code(svc('SELECT publish_monitor_link_post($1,$2,$3) v', [u.a, linkPost, null]), 'P0002');
  report.checks.push('a post links only to the same user\'s item on the same brand account');

  // Retention: snapshots older than 100 days go; newer ones stay.
  await c.query("UPDATE social_metric_snapshots SET captured_on=current_date-101 WHERE connection_id=$1", [cw]);
  assert.ok(await svc('SELECT publish_monitor_snapshot_prune(1000) v') >= 3);
  assert.equal(await v('SELECT count(*)::int v FROM social_metric_snapshots WHERE connection_id=$1', [cw]), 0);
  assert.ok(await v('SELECT count(*)::int v FROM social_metric_snapshots WHERE connection_id=$1', [cu]) > 0);
  report.checks.push('snapshots older than 100 days are pruned (plan §7)');

  // Manual import (plan §4.3): confirmed rows attach to the account's connection as source 'manual'; numbers are
  // validated, blanks stay absent, one manual snapshot per post per day; never another user's account.
  const im = await member('xiaohongshu');
  const rows = [{ postKey: 'https://example.com/p/1', url: 'https://example.com/p/1', postedAt: ago(2), titleExcerpt: 'm1',
    metrics: { likes: 12, views: 300 } }, { postKey: 'note-2', url: null, postedAt: null, titleExcerpt: 'm2', metrics: { likes: 3 } }];
  const imported = await svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [im.a, im.account, 'table', j(rows)]);
  assert.deepEqual([imported.inserted, imported.updated], [2, 0]);
  const again = await svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [im.a, im.account, 'screenshot', j(rows)]);
  assert.deepEqual([again.connectionId, again.inserted, again.updated], [imported.connectionId, 0, 2]);
  assert.equal(await v('SELECT count(*)::int v FROM social_metric_snapshots WHERE connection_id=$1', [imported.connectionId]), 2);
  const manual = await svc('SELECT publish_monitor_data($1,30,NULL) v', [im.a]);
  assert.deepEqual(manual.posts.map(x => [x.source, x.postedAtSource]).sort(), [['manual', null], ['manual', 'user']]);
  assert.deepEqual(manual.posts.find(x => x.titleExcerpt === 'm2').latest.metrics, { likes: 3 });
  await code(svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [im.a, im.account, 'table',
    j([{ ...rows[0], metrics: { likes: -1 } }])]), '22023');
  await code(svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [im.a, im.account, 'table',
    j([{ ...rows[0], metrics: { likes: '12' } }])]), '22023');
  await code(svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [u.a, im.account, 'table', j(rows)]), 'P0002');
  // Manual rows on an account already read automatically stay separate posts (never merged into one number).
  const auto = await svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [wm.a, wm.account, 'link',
    j([{ postKey: 'w5', url: null, postedAt: null, titleExcerpt: null, metrics: { likes: 1 } }])]);
  assert.equal(auto.connectionId, cw);
  assert.equal(await v("SELECT count(*)::int v FROM social_posts WHERE connection_id=$1 AND platform_post_id='w5'", [cw]), 2);
  report.checks.push('manual import: validated, separate from automatic data, one snapshot a day, own accounts only');

  // Connecting Post for Me later upgrades the manual connection in place; its manual posts stay.
  const up = await member('youtube');
  const upm = await svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [up.a, up.account, 'link', j([rows[1]])]);
  const st = await svc('SELECT publish_monitor_connect_start($1,$2,$3) v', [up.a, up.account, ['feeds']]);
  await svc('SELECT publish_monitor_connect_callback($1,$2,$3) v', [up.a, st.requestId,
    j([{ providerAccountId: 'spc_up', platform: 'youtube', externalId: st.externalId }])]);
  const conf = await svc('SELECT publish_monitor_connect_confirm($1,$2,$3,$4,$5) v', [up.a, st.requestId, 'spc_up', true,
    j({ providerAccountId: 'spc_up', platform: 'youtube', externalId: st.externalId, status: 'connected' })]);
  assert.equal(conf.connectionId, upm.connectionId);
  const upr = await row(upm.connectionId);
  assert.deepEqual([upr.source, upr.provider_account_id, upr.consent_auto_track], ['postforme', 'spc_up', true]);
  assert.equal(await v("SELECT count(*)::int v FROM social_posts WHERE connection_id=$1 AND source='manual'", [upm.connectionId]), 1);
  report.checks.push('connecting Post for Me upgrades a manual-only connection in place and keeps its manual posts');

  // Erasure: a closed account is never claimed, its data calls are refused, and erasure still finishes.
  const em = await member(), ce = await connection(em);
  const ke = await claimOf(ce);
  await page(ke, [post('e1', ago(1))]);
  await finish(ke, 'done');
  await nextDay(ce);
  await closeAccount(c, { actor: em.a });
  assert.equal(await claimOf(ce), undefined);
  await code(svc('SELECT publish_monitor_data($1,30,NULL) v', [em.a]), '42501');
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [em.a]);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [em.a])), 0);
  report.checks.push('a closed account is not refreshed or readable; erasure still completes');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
