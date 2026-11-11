/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-SCHEDULE verification (migration *_publish_monitor_schedule.sql): scheduling on the one-click publish
// job, slots in the billing period of the scheduled time, cancel and reschedule leases, the cron claim and finish steps,
// charging only successful targets and nothing after a cancellation, late and repeated webhooks, concurrency, erasure.
// No provider is involved. Run: node packages/db/tests/publish-monitor/schedule-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql, scheduleMigrationPath } from './fixtures.mjs';

const entry = ['publish_monitor_schedule_prepare(uuid,uuid,timestamp with time zone,text,integer)',
  'publish_monitor_schedule_accepted(uuid,text)',
  'publish_monitor_schedule_list(uuid,timestamp with time zone,timestamp with time zone)',
  'publish_monitor_schedule_begin(uuid,uuid,text,timestamp with time zone,timestamp with time zone,integer)',
  'publish_monitor_schedule_claim(integer,integer)',
  'publish_monitor_schedule_finish(uuid,uuid,text,timestamp with time zone,text)', 'publish_monitor_schedule_holds()'];
const internal = ['publish_monitor_quota_period_at(timestamp with time zone)',
  'publish_monitor_schedule_move_slots(social_publish_jobs,timestamp with time zone,boolean)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: scheduleMigrationPath(), checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => {
  const error = await promise.then(() => null, e => e);
  assert.ok(error?.message?.includes(expected), `expected ${expected}, got ${error?.message}`);
};
const svc = async (sql, args = [], client = c) => {
  await client.query('SET ROLE service_role');
  try { return (await client.query(sql, args)).rows[0]?.v; } finally { await client.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const credits = a => v('SELECT credits v FROM profiles WHERE id=$1', [a]);
const job = id => c.query('SELECT * FROM social_publish_jobs WHERE id=$1', [id]).then(r => r.rows[0]);
const period = start => c.query('SELECT used,reserved FROM social_publish_quota_periods WHERE period_start=$1', [start])
  .then(r => r.rows[0]);
const inMinutes = m => v(`SELECT (clock_timestamp()+make_interval(mins=>$1))::timestamptz v`, [m]);

const extraAccountSql = `CREATE OR REPLACE FUNCTION pm_test.extra_account(a uuid,plat text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE src opc_accounts;ap artifact_projects;nid uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO src FROM opc_accounts WHERE actor_id=a LIMIT 1;
 SELECT * INTO ap FROM artifact_projects p WHERE p.id=src.project_id;
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(nid,a,ap.module_id,ap.skill_id,'account-'||nid,'account title',0);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id)
 VALUES(nid,a,plat,'pm-'||nid,src.source_version_id,src.business_id);
 RETURN nid;
END $$;`;
let seq = 0;
async function member(balance = 100, platforms = ['x', 'youtube']) {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,$2)', [a, balance]);
  const first = await v('SELECT pm_test.member($1,$2) v', [a, platforms[0]]);
  const business = await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [first]);
  await c.query('INSERT INTO social_monitor_settings(actor_id,provider_ref) VALUES($1,$2)', [a, a.replace(/-/g, '')]);
  const connections = [];
  for (const [i, plat] of platforms.entries()) {
    const acct = i === 0 ? first : await v('SELECT pm_test.extra_account($1,$2) v', [a, plat]);
    seq += 1;
    connections.push({ platform: plat, provider: `pfm_sch_${seq}`, id: await v(`INSERT INTO social_connections(actor_id,
      business_id,account_project_id,role,source,platform,provider_account_id,status,consent_read,consent_publish,
      provider_can_publish) VALUES($1,$2,$3,'own','postforme',$4,$5,'connected',true,true,true) RETURNING id v`,
    [a, business, acct, plat, `pfm_sch_${seq}`]) });
  }
  return { a, business, ref: a.replace(/-/g, ''), connections };
}
const fp = ch => ch.repeat(64);
const claim = (m, key, print, ids = m.connections.map(x => x.id)) =>
  svc('SELECT publish_monitor_publish_claim($1,$2,$3,$4,NULL,$5) v', [m.a, key, print, m.business, ids]);
const prepare = (m, id, at, preview = 'Hello schedule preview', media = 1) =>
  svc('SELECT publish_monitor_schedule_prepare($1,$2,$3,$4,$5) v', [m.a, id, at, preview, media]);
const observed = m => Object.fromEntries(m.connections.map(x => [x.provider, { ownerRef: m.ref, connected: true }]));
const dispatch = (m, id) => svc('SELECT publish_monitor_publish_dispatch($1,$2,$3) v', [m.a, id, j(observed(m))]);
const accepted = (id, post) => svc('SELECT publish_monitor_schedule_accepted($1,$2) v', [id, post]);
const begin = (m, id, action, expected, next = null, client = c) =>
  svc('SELECT publish_monitor_schedule_begin($1,$2,$3,$4,$5,60) v', [m.a, id, action, expected, next], client);
const finish = (id, lease, outcome, at = null, codeText = null) =>
  svc('SELECT publish_monitor_schedule_finish($1,$2,$3,$4,$5) v', [id, lease, outcome, at, codeText]);
const claimDue = () => svc('SELECT publish_monitor_schedule_claim(50,60) v');
const hook = (post, provider, ok) => svc('SELECT publish_monitor_publish_webhook_result($1,$2,$3,$4) v',
  [post, provider, ok, ok ? 'https://x.com/i/status/1' : null]);
let posts = 0;
// A scheduled job waiting at Post for Me: claim, prepare, dispatch, accepted.
async function scheduled(m, minutes = 120, key = `key-sch-${randomUUID().slice(0, 8)}`) {
  const at = await inMinutes(minutes);
  const claimed = await claim(m, key, fp(String((posts % 9) + 1)));
  await prepare(m, claimed.id, at);
  assert.equal((await dispatch(m, claimed.id)).dispatch, true);
  posts += 1;
  const view = await accepted(claimed.id, `sp_sch_${posts}`);
  assert.equal(view.state, 'scheduled');
  return { id: claimed.id, at: (await job(claimed.id)).scheduled_at, post: `sp_sch_${posts}`, key };
}

try {
  await c.query(fixtureSql);
  await c.query(extraAccountSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(scheduleMigrationPath()));
  await c.query(read(scheduleMigrationPath()));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('the migration runs twice on the built database with an unchanged catalog');
  for (const f of [...entry, ...internal]) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v('SELECT has_function_privilege($1,$2,$3) v', [role, f, 'EXECUTE']), false, `${role} ${f}`);
    }
    assert.equal(await v('SELECT has_function_privilege($1,$2,$3) v', ['service_role', f, 'EXECUTE']), entry.includes(f), f);
  }
  report.checks.push('only the entry points are callable, by service_role only');

  await c.query(`INSERT INTO system_settings(key,value) VALUES('billing_credits_per_usd','100'::jsonb),
    ('billing_token_price_multiplier','6'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_publish_quota',
    jsonb_build_object('limit',1000,'periodAnchor',to_char((now() AT TIME ZONE 'UTC')-interval '40 days','YYYY-MM-DD"T"HH24:MI:SS"Z"')))
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);

  // Normal: claimed -> prepared -> dispatched -> scheduled; replays; time range.
  const u = await member();
  const s1 = await scheduled(u);
  const row1 = await job(s1.id);
  assert.equal(row1.caption_preview, 'Hello schedule preview');
  assert.equal(row1.media_count, 1);
  assert.equal(row1.provider_post_id, s1.post);
  assert.ok(Math.abs(row1.next_check_at - (row1.scheduled_at - 40 * 60_000)) < 2000, 'first check 40 minutes before');
  assert.equal(await credits(u.a), 88, 'the hold is taken at claim (2 targets x 6)');
  assert.equal((await prepare(u, s1.id, row1.scheduled_at)).state, 'scheduled', 'a replay with the same values answers');
  await code(prepare(u, s1.id, await inMinutes(200)), 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH');
  assert.equal((await claim(u, s1.key, fp('1'))).replayed, true);
  const early = await claim(u, 'key-sch-early', fp('a'));
  await code(prepare(u, early.id, await inMinutes(5)), 'PUBLISH_SCHEDULE_TIME_INVALID');
  await code(prepare(u, early.id, await inMinutes(31 * 24 * 60)), 'PUBLISH_SCHEDULE_TIME_INVALID');
  await svc('SELECT publish_monitor_publish_release($1,$2) v', [early.id, 'PUBLISH_SCHEDULE_TIME_INVALID']);
  assert.equal(await credits(u.a), 88, 'a refused time returns the hold');
  const other = await member();
  await code(prepare(other, s1.id, row1.scheduled_at), 'PUBLISH_MONITOR_JOB_NOT_FOUND');
  const holds = await svc('SELECT publish_monitor_schedule_holds() v');
  assert.deepEqual(holds.filter(h => h.preDeductId === row1.pre_deduct_id).map(h => Date.parse(h.scheduledAt)),
    [row1.scheduled_at.getTime()], 'the billing audit sees the scheduled time of the hold');
  report.checks.push('normal: the job waits as scheduled with the hold taken at claim; replays answer, other values and '
    + 'other users are refused; times under 15 minutes or over 30 days are refused and released');

  // Slots: a time in the next billing period reserves there.
  const current = row1.quota_period_start;
  const periodEnd = await v('SELECT period_end v FROM social_publish_quota_periods WHERE period_start=$1', [current]);
  const nextClaim = await claim(u, 'key-sch-next', fp('b'));
  const reservedBefore = (await period(current)).reserved;
  await prepare(u, nextClaim.id, new Date(periodEnd.getTime() + 3600_000));
  const moved = await job(nextClaim.id);
  assert.equal(moved.quota_period_start.getTime(), periodEnd.getTime());
  assert.equal((await period(current)).reserved, reservedBefore - 2);
  assert.equal((await period(periodEnd)).reserved, 2);
  await svc('SELECT publish_monitor_publish_release($1,$2) v', [nextClaim.id, 'PUBLISH_MONITOR_TEST']);
  assert.equal((await period(periodEnd)).reserved, 0);
  report.checks.push('slots are reserved in the Post for Me billing period of the scheduled time and released there');

  // Cron claim, lease, preflight; results through the webhook, late and twice.
  assert.deepEqual(await claimDue(), [], 'nothing is due before 40 minutes ahead');
  await c.query('UPDATE social_publish_jobs SET next_check_at=clock_timestamp() WHERE id=$1', [s1.id]);
  const [item] = await claimDue();
  assert.equal(item.jobId, s1.id);
  assert.deepEqual([item.cancelReason, item.preflightDone, item.mediaCount], [null, false, 1]);
  assert.deepEqual(await claimDue(), [], 'a leased job is not handed out twice');
  assert.equal((await finish(s1.id, randomUUID(), 'checked', s1.at)).stale, true, 'a stale lease changes nothing');
  await finish(s1.id, item.lease, 'checked', new Date(s1.at.getTime() + 5 * 60_000));
  assert.ok((await job(s1.id)).preflight_at);
  const [x1, y1] = u.connections;
  assert.equal(await hook(s1.post, x1.provider, true), true);
  const partial = await job(s1.id);
  assert.equal(partial.state, 'unknown', 'a sent post is reconciled like a dispatched one');
  assert.ok(partial.dispatched_at <= partial.scheduled_at && Math.abs(partial.dispatched_at - Date.now()) < 60_000,
    'the 24-hour reconciliation window starts when it was sent');
  assert.equal(await hook(s1.post, x1.provider, true), false, 'the same webhook twice changes nothing');
  assert.equal(await hook(s1.post, y1.provider, false), true);
  const done = await job(s1.id);
  assert.deepEqual([done.state, done.charged_credits], ['completed', 6]);
  assert.equal(await credits(u.a), 94, 'only the published platform is charged');
  assert.equal(await hook(s1.post, y1.provider, true), false, 'a late webhook after settlement changes nothing');
  report.checks.push('cron: due jobs are leased once, stale leases are ignored, the pre-send check is recorded; results from '
    + 'the webhook settle once for successful targets only; repeated or late webhooks change nothing');

  // Cancel: expected time, leases, second tab, lock window, release in full.
  const w = await member();
  const s2 = await scheduled(w);
  assert.equal(await credits(w.a), 88);
  await code(begin(w, s2.id, 'cancel', new Date(s2.at.getTime() + 60_000)), 'PUBLISH_SCHEDULE_CHANGED');
  const { Client } = createRequire(`${root}/package.json`)('pg');
  const tabs = await Promise.all([0, 1].map(async () => {
    const x = new Client({ host: c.host, port: c.port, user: c.user, database: c.database });
    await x.connect();
    return x;
  }));
  const raced = await Promise.allSettled([begin(w, s2.id, 'reschedule', s2.at, await inMinutes(300), tabs[0]),
    begin(w, s2.id, 'reschedule', s2.at, await inMinutes(301), tabs[1])]);
  await Promise.all(tabs.map(x => x.end()));
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1, 'two tabs: one change at a time');
  assert.match(String(raced.find(r => r.status === 'rejected').reason.message), /PUBLISH_SCHEDULE_BUSY/);
  const leaseHolder = raced.find(r => r.status === 'fulfilled').value;
  await svc('SELECT publish_monitor_publish_unlease($1,$2) v', [s2.id, leaseHolder.lease]);
  const cancel = await begin(w, s2.id, 'cancel', s2.at);
  assert.ok(cancel.lease);
  assert.equal(cancel.cancelReason, 'PUBLISH_SCHEDULE_CANCELLED');
  assert.equal((await begin(w, s2.id, 'cancel', s2.at)).lease, null, 'a second cancel only answers');
  await code(begin(w, s2.id, 'reschedule', s2.at, await inMinutes(300)), 'PUBLISH_SCHEDULE_CANCELLING');
  const released = await finish(s2.id, cancel.lease, 'cancelled');
  assert.deepEqual([released.state, released.errorCode], ['released', 'PUBLISH_SCHEDULE_CANCELLED']);
  assert.equal(await credits(w.a), 100, 'a cancel returns the hold in full');
  assert.equal((await job(s2.id)).reserved_slots, 0);
  await code(begin(w, s2.id, 'cancel', s2.at), 'PUBLISH_SCHEDULE_NOT_SCHEDULED');
  assert.equal(await hook(s2.post, w.connections[0].provider, true), false, 'a result for a released job is ignored');
  const s3 = await scheduled(w);
  await c.query("UPDATE social_publish_jobs SET scheduled_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [s3.id]);
  await code(begin(w, s3.id, 'cancel', (await job(s3.id)).scheduled_at), 'PUBLISH_SCHEDULE_LOCKED');
  report.checks.push('cancel: the expected time must match, two tabs get one lease, a second cancel only answers, a release '
    + 'returns the hold and slots in full, nothing changes inside the 10-minute lock window');

  // Reschedule: time rules, slots follow the provider's time.
  const s4 = await scheduled(w, 180);
  await code(begin(w, s4.id, 'reschedule', s4.at, s4.at), 'PUBLISH_SCHEDULE_TIME_INVALID');
  await code(begin(w, s4.id, 'reschedule', s4.at, await inMinutes(5)), 'PUBLISH_SCHEDULE_TIME_INVALID');
  const move = await begin(w, s4.id, 'reschedule', s4.at, new Date(periodEnd.getTime() + 7200_000));
  const target = new Date(periodEnd.getTime() + 7200_000);
  await finish(s4.id, move.lease, 'moved', target);
  const after = await job(s4.id);
  assert.equal(after.scheduled_at.getTime(), target.getTime());
  assert.equal(after.quota_period_start.getTime(), periodEnd.getTime());
  assert.equal(after.preflight_at, null);
  assert.equal((await period(periodEnd)).reserved, 2);
  report.checks.push('reschedule: same or too-near times are refused; a move takes its slots to the new billing period');

  // The user's own disconnect inside the lock window cannot stop the post; it is charged like any sent post (otherwise
  // disconnecting before each post would publish for free, again and again: review of #1852).
  const z = await member();
  const s5 = await scheduled(z);
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [z.a, z.connections[1].id]);
  const marked = (await claimDue()).find(i => i.jobId === s5.id);
  assert.equal(marked.cancelReason, 'PUBLISH_SCHEDULE_TARGET_CHANGED');
  await finish(s5.id, marked.lease, 'mark', s5.at, 'PUBLISH_SCHEDULE_TARGET_CHANGED');
  await hook(s5.post, z.connections[0].provider, true);
  await hook(s5.post, z.connections[1].provider, true);
  const charged = await job(s5.id);
  assert.deepEqual([charged.state, charged.charged_credits, charged.error_code], ['completed', 12, null]);
  assert.equal(await credits(z.a), 88, 'a post sent after the user disconnected is charged for its successful targets');
  report.checks.push('a target disconnected before the time is noticed by the cron claim; if the post goes out anyway it '
    + 'is charged for its successful targets (no free post by disconnecting)');

  // A cancellation the user cannot trigger at will (membership ended), decided inside the lock window: sent, not charged.
  const zz = await member();
  const s5b = await scheduled(zz);
  await c.query('UPDATE social_publish_jobs SET next_check_at=clock_timestamp() WHERE id=$1', [s5b.id]);
  const due5b = (await claimDue()).find(i => i.jobId === s5b.id);
  await finish(s5b.id, due5b.lease, 'mark', s5b.at, 'PUBLISH_SCHEDULE_MEMBERSHIP_ENDED');
  await hook(s5b.post, zz.connections[0].provider, true);
  await hook(s5b.post, zz.connections[1].provider, true);
  const free = await job(s5b.id);
  assert.deepEqual([free.state, free.charged_credits, free.error_code], ['completed', null, 'PUBLISH_SCHEDULE_SENT_AFTER_CANCEL']);
  assert.equal(await credits(zz.a), 100, 'a post sent after a cancellation the user could not cause is not charged');
  assert.equal(await v("SELECT count(*)::int v FROM billing_history WHERE user_id=$1 AND operation_type='settle'", [zz.a]), 0);
  report.checks.push('a post sent after a cancellation decided too late (membership ended) is completed without any charge');

  // A hold taken from a subscription period whose credit release then ends (the period is over or the subscription was
  // refunded): cancelling returns nothing of the period's credits, so expired credits never become spendable again.
  const sub = await member(0);
  const grant = randomUUID(), stripeSub = `sub_${randomUUID()}`, invoice = `in_${randomUUID()}`;
  const dayMs = 24 * 3600e3;
  await c.query(`UPDATE profiles SET credits=100 WHERE id=$1`, [sub.a]);
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,
    balance_before,balance_after) VALUES($1,100,'addition','grant','opening_grant','system',$2,0,100)`, [sub.a, `opening_grant:${sub.a}`]);
  await c.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','pro',true,true,500000000) ON CONFLICT(level) DO NOTHING`, [randomUUID()]);
  const plan = await v("SELECT id v FROM membership_plans WHERE level='pro'");
  const subStart = new Date(Date.now() - dayMs).toISOString(), subEnd = new Date(Date.now() + dayMs).toISOString();
  await c.query(`INSERT INTO user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,billing_cycle,current_period_start,
    current_period_end,status) VALUES($1,$2,$3,'monthly',$4,$5,'active')`, [sub.a, stripeSub, plan, subStart, subEnd]);
  await c.query(`INSERT INTO subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,grant_type,
    grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted,consumed_amount,idempotency_key)
    VALUES($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,100,0,$9)`,
  [grant, sub.a, stripeSub, plan, `invoice:${invoice}`, subStart, subEnd, invoice, `grant:${invoice}`]);
  const s9 = await scheduled(sub, 60 * 24 * 3);
  const holdRow = await job(s9.id);
  assert.equal(await v("SELECT metadata->>'chargedGrantId' v FROM billing_history WHERE id=$1", [holdRow.pre_deduct_id]), grant,
    'the hold came from the subscription period');
  assert.equal(await credits(sub.a), 88);
  await c.query('UPDATE user_subscriptions SET credit_release_terminated_at=clock_timestamp() WHERE stripe_subscription_id=$1',
    [stripeSub]);
  const cancelSub = await begin(sub, s9.id, 'cancel', s9.at);
  assert.equal((await finish(s9.id, cancelSub.lease, 'cancelled')).state, 'released');
  assert.equal(await credits(sub.a), 88, 'the period\'s credits held across the end of its release are not returned');
  assert.equal(await v("SELECT (metadata->>'refundInterceptedRestoration')::int v FROM billing_history WHERE user_id=$1 "
    + "AND operation_type='refund' AND metadata->>'preDeductId'=$2", [sub.a, String(holdRow.pre_deduct_id)]), 12);
  report.checks.push('a hold from a subscription period whose release ended before the cancel returns none of that period\'s '
    + 'credits (expired credits never come back spendable)');

  // Failure: sent and failed on every platform -> full refund; the backoff reaches manual review a day after the time.
  const f = await member();
  const s6 = await scheduled(f);
  await c.query('UPDATE social_publish_jobs SET next_check_at=clock_timestamp() WHERE id=$1', [s6.id]);
  const due6 = (await claimDue()).find(i => i.jobId === s6.id);
  await finish(s6.id, due6.lease, 'started');
  assert.equal((await job(s6.id)).state, 'unknown');
  await svc('SELECT publish_monitor_publish_record($1,$2,$3) v', [s6.id, s6.post,
    j({ [f.connections[0].id]: { status: 'failed' }, [f.connections[1].id]: { status: 'failed' } })]);
  assert.deepEqual([(await job(s6.id)).state, await credits(f.a)], ['failed', 100]);
  const s7 = await scheduled(f);
  await c.query(`UPDATE social_publish_jobs SET scheduled_at=clock_timestamp()-interval '25 hours',next_check_at=clock_timestamp()
    WHERE id=$1`, [s7.id]);
  const due7 = (await claimDue()).find(i => i.jobId === s7.id);
  await finish(s7.id, due7.lease, 'later', null, 'PUBLISH_SCHEDULE_NOT_SENT');
  const stuck = await job(s7.id);
  assert.deepEqual([stuck.manual_review, stuck.next_check_at, stuck.state], [true, null, 'scheduled']);
  assert.equal(await credits(f.a), 88, 'a job waiting for a person keeps its hold');
  report.checks.push('failure: a post failed everywhere refunds in full; a post still not sent a day after its time waits '
    + 'for manual review with its hold');

  // The schedule view.
  const listed = await svc('SELECT publish_monitor_schedule_list($1,$2,$3) v', [w.a, await inMinutes(-60), await inMinutes(60 * 24 * 40)]);
  assert.deepEqual(listed.map(x => x.id).sort(), [s2.id, s3.id, s4.id].sort());
  assert.deepEqual(listed.map(x => Date.parse(x.at)), listed.map(x => Date.parse(x.at)).sort((p, q) => p - q));
  assert.ok(listed.every(x => x.captionPreview === 'Hello schedule preview' && 'scheduledAt' in x && 'cancelReason' in x));
  assert.deepEqual(await svc('SELECT publish_monitor_schedule_list($1,$2,$3) v', [z.a, await inMinutes(60 * 24 * 60),
    await inMinutes(60 * 24 * 61)]), []);
  await code(svc('SELECT publish_monitor_schedule_list($1,$2,$3) v', [w.a, await inMinutes(0), await inMinutes(60 * 24 * 44)]),
    'PUBLISH_MONITOR_INPUT_INVALID');
  report.checks.push('the schedule view lists only the user\'s own jobs in the range, in time order, at most 43 days');

  // Erasure: a scheduled job is kept without brand links or preview, cancelled by the cron step, then removed.
  const e = await member();
  const s8 = await scheduled(e);
  await closeAccount(c, { actor: e.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [e.a]);
  const kept = await job(s8.id);
  assert.deepEqual([kept.state, kept.business_id, kept.caption_preview], ['scheduled', null, null]);
  const due8 = (await claimDue()).find(i => i.jobId === s8.id);
  assert.equal(due8.cancelReason, 'PUBLISH_SCHEDULE_ACCOUNT_CLOSED');
  await finish(s8.id, due8.lease, 'cancelled');
  assert.equal(await job(s8.id), undefined, 'the cancelled job of an erased user is removed');
  report.checks.push('erasure keeps a scheduled job without brand links or preview until the cron step cancels it, then '
    + 'removes it');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
