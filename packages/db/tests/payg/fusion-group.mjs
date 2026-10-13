/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-1 (0234): billing group over per-model runs; each run settles on its own (Owner 2026-10-14).
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {conserved} from './core.mjs';

const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const calls = async (db,runs) => (await db.query('SELECT * FROM bill2_calls WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',[runs])).rows;
const charged = async (db,runs) => Number((await db.query('SELECT coalesce(sum(charged),0) v FROM bill2_runs WHERE id=ANY($1::uuid[])',[runs])).rows[0].v);

async function group(db,createFixture,{n=3,credits=100,phase='fusion_review'}={}) {
  const first = await createFixture(db,{credits,phase});
  const members = [first];
  for (let i=1;i<n;i++) members.push(await createFixture(db,{actor:first.actor,phase}));
  const id = await rpc(db,'fusion_group_create',first.actor,randomUUID(),'review');
  for (const f of members) await rpc(db,'fusion_group_attach',first.actor,id,f.run);
  const items = members.map(f=>({runId:f.run,sequence:1,payload:f.claimPayload}));
  return {actor:first.actor,id,members,items,runs:members.map(f=>f.run)};
}
const claimGroup = (db,g,step='review:1',attempt=1) => rpc(db,'fusion_group_claim',g.actor,g.id,step,attempt,JSON.stringify(g.items));
async function dispatchAll(db,g,claimed) {
  for (const c of claimed.calls) assert.equal((await rpc(db,'bill2_dispatch',g.actor,c.runId,c.id,c.dispatchToken)).dispatch,true);
}
const usage = cost => ({inputTokens:Math.round(Number(cost)*1e6),outputTokens:0});
const record = (db,g,f,c,cost) => rpc(db,'bill2_record',g.actor,f.run,c.id,{provider:f.claimPayload.provider,account:'sandbox',
  model:f.claimPayload.model,protocol:f.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
  observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost,currency:'USD',usage:usage(cost)});

export async function fusionGroupCases({db,Client,connectionString,report,createFixture,claim}) {
  // 1. Atomic full hold: each member upper bound is 9 credits (8292 tokens at 1 USD/M, q=1000).
  const short = await group(db,createFixture,{credits:26});
  assert.equal((await claimGroup(db,short)).state,'waiting_credits');
  assert.equal((await calls(db,short.runs)).length,0,'no call is created when the batch upper bound exceeds the balance');
  assert.equal(await wallet(db,short.actor),26);
  const exact = await group(db,createFixture,{credits:27});
  const claimed = await claimGroup(db,exact);
  assert.equal(claimed.state,'claimed');
  assert.deepEqual((await calls(db,exact.runs)).map(c=>c.reserved_credits),[9,9,9],'every member holds its full upper bound');
  assert.equal(await wallet(db,exact.actor),0);
  const replay = await claimGroup(db,exact);
  assert.deepEqual(replay.calls.map(c=>c.id).sort(),claimed.calls.map(c=>c.id).sort(),'replay returns the same calls');
  assert.equal(await wallet(db,exact.actor),0,'replay takes no new hold');
  await assert.rejects(rpc(db,'fusion_group_claim',exact.actor,exact.id,'review:1',1,
    JSON.stringify(exact.items.map((x,i)=>i?x:{...x,payload:{...x.payload,requestHash:'d'.repeat(64)}}))),/FUSION_GROUP_CONFLICT/);
  await assert.rejects(claimGroup(db,exact,'review:2',1),/FUSION_GROUP_CONFLICT/);
  await assert.rejects(claimGroup(db,exact,'review:1',2),/FUSION_GROUP_CONFLICT/);
  report.checks.push('fusion group claim: balance below batch upper bound creates nothing; exact balance holds every member in full; replay is idempotent; changed payload conflicts; runs of an earlier step cannot be reused by a new step or attempt');

  // 4. Ordinary claims refuse Fusion purposes and grouped runs.
  const loose = await createFixture(db,{phase:'fusion_review'});
  await assert.rejects(claim(db,loose,1,false),/FUSION_GROUP_CLAIM_REQUIRED/);
  await assert.rejects(rpc(db,'bill2_claim',short.actor,short.runs[0],1,short.items[0].payload),/FUSION_GROUP_CLAIM_REQUIRED/);
  const plain = await createFixture(db);
  await assert.rejects(rpc(db,'fusion_group_claim',plain.actor,short.id,'review:1',1,JSON.stringify([{runId:plain.run,sequence:1,payload:plain.claimPayload}])),/FUSION_GROUP_DENIED/);
  report.checks.push('ordinary claim refuses a Fusion purpose and any grouped run; group claim refuses a run outside the group');

  // 2 + 5. Verdict before settlement; group rounds once; concurrent finalize neither doubles nor drops.
  await dispatchAll(db,exact,claimed);
  for (const [i,f] of exact.members.entries()) await record(db,exact,f,claimed.calls.find(c=>c.runId===f.run),'0.0004');
  await rpc(db,'bill2_finalize',exact.actor,exact.runs[0]);
  assert.equal((await calls(db,[exact.runs[0]]))[0].settled_at,null,'a Fusion call without a host verdict keeps its hold');
  for (const c of claimed.calls) await rpc(db,'fusion_call_verdict',exact.actor,c.id,'usable');
  await assert.rejects(rpc(db,'fusion_call_verdict',exact.actor,claimed.calls[0].id,'format_invalid'),/FUSION_VERDICT_IMMUTABLE/);
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(c=>c.connect()));
  try {
    await Promise.all(clients.map((c,i)=>c.query('SELECT bill2_finalize($1,$2)',[exact.actor,exact.runs[i]])));
  } finally { await Promise.all(clients.map(c=>c.end())); }
  assert.equal(await charged(db,exact.runs.slice(0,2)),2,'each member rounds on its own (Owner 2026-10-14): ceil(0.4)+ceil(0.4)=2');
  // 3. The third member is still unsettled and does not block the others; its late settlement keeps one rounding.
  assert.equal((await calls(db,[exact.runs[2]]))[0].settled_at,null);
  await rpc(db,'bill2_finalize',exact.actor,exact.runs[2]);
  assert.equal(await charged(db,exact.runs),3,'three members, each ceil(0.4)=1');
  assert.equal(await wallet(db,exact.actor),24);
  for (const f of exact.members) await conserved(db,f);
  report.checks.push('verdict required before settlement and immutable; concurrent member finalize; unsettled member does not block; each member settles and rounds on its own');

  // Claim of a later batch vs another transaction holding a shared model lock and then the group
  // row: the claim takes model locks before the group, so neither side waits on the other in a cycle.
  const later = await group(db,createFixture,{n:2,credits:18});
  const modelKey = (await db.query("SELECT hashtextextended('bill2-payg:'||$1,0) k",[later.members[0].claimPayload.model])).rows[0].k;
  const [holder,claimer] = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all([holder.connect(),claimer.connect()]);
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)',[modelKey]);
    const pending = claimer.query('SELECT fusion_group_claim($1,$2,$3,$4,$5) v',[later.actor,later.id,'review:1',1,JSON.stringify(later.items)]);
    await new Promise(r=>setTimeout(r,300));
    await holder.query("SET LOCAL lock_timeout='5s'");
    await holder.query('SELECT 1 FROM fusion_billing_groups WHERE id=$1 FOR UPDATE',[later.id]);
    await holder.query('COMMIT');
    assert.equal((await pending).rows[0].v.state,'claimed');
  } finally { await holder.end(); await claimer.end(); }
  report.checks.push('group claim waits for model locks before the group row: settlement-order holder takes the group without deadlock');

  // Settlement order does not change the bill: an over-hold call is capped at its own hold (9)
  // and the other rounds alone (1), so 10 in either order.
  for (const order of [[0,1],[1,0]]) {
    const over = await group(db,createFixture,{n:2,credits:18});
    const oc = await claimGroup(db,over);
    await dispatchAll(db,over,oc);
    const costs = ['0.01','0.0004'];
    for (const [i,f] of over.members.entries()) await record(db,over,f,oc.calls.find(c=>c.runId===f.run),costs[i]);
    for (const c of oc.calls) await rpc(db,'fusion_call_verdict',over.actor,c.id,'usable');
    for (const i of order) await rpc(db,'bill2_finalize',over.actor,over.runs[i]);
    assert.equal(await charged(db,over.runs),10,'order '+order.join(','));
    for (const f of over.members) await conserved(db,f);
  }
  await assert.rejects(rpc(db,'fusion_group_claim',short.actor,short.id,'review:9',1,
    JSON.stringify(short.items.map(x=>({...x,sequence:2})))),/FUSION_GROUP_INVALID/);
  report.checks.push('per-member settlement: over-hold call capped at its own hold; same total in both orders; one call per Fusion run');

  // 5. Zero-charge verdicts refund in full.
  const bad = await group(db,createFixture,{n:2,credits:18});
  const bc = await claimGroup(db,bad);
  await dispatchAll(db,bad,bc);
  for (const f of bad.members) await record(db,bad,f,bc.calls.find(c=>c.runId===f.run),'0.0004');
  await rpc(db,'fusion_call_verdict',bad.actor,bc.calls[0].id,'format_invalid');
  await rpc(db,'fusion_call_verdict',bad.actor,bc.calls[1].id,'usable');
  for (const r of bad.runs) await rpc(db,'bill2_finalize',bad.actor,r);
  const runs = Object.fromEntries((await db.query('SELECT id,charged FROM bill2_runs WHERE id=ANY($1::uuid[])',[bad.runs])).rows.map(r=>[r.id,Number(r.charged??0)]));
  assert.equal(runs[bc.calls[0].runId],0,'format_invalid is not charged');
  assert.equal(await charged(db,bad.runs),1);
  assert.equal(await wallet(db,bad.actor),17);
  report.checks.push('format_invalid verdict charges zero and releases the full hold; the usable member is charged on its own');

  // Content deletion (not account closure) before the verdict keeps the hold and settles nothing.
  const deleted = await group(db,createFixture,{n:1,credits:9});
  const dc = await claimGroup(db,deleted);
  await dispatchAll(db,deleted,dc);
  await record(db,deleted,deleted.members[0],dc.calls[0],'0.0004');
  await db.query('UPDATE bill2_runs SET content_deleted_at=now() WHERE id=$1',[deleted.runs[0]]);
  await rpc(db,'bill2_finalize',deleted.actor,deleted.runs[0]);
  const kept = (await calls(db,deleted.runs))[0];
  assert.equal(kept.fusion_verdict,null,'content deletion does not synthesize a zero-charge verdict');
  assert.equal(kept.settled_at,null);
  assert.equal(await wallet(db,deleted.actor),0,'the hold stays until a host verdict');
  report.checks.push('content deletion before the verdict keeps the hold; only account closure ends an unjudged call at zero charge');

  // 6. Erasure before the verdict ends in a zero-charge verdict for every member.
  const erased = await group(db,createFixture,{n:2,credits:18});
  const ec = await claimGroup(db,erased);
  await dispatchAll(db,erased,ec);
  for (const f of erased.members) await record(db,erased,f,ec.calls.find(c=>c.runId===f.run),'0.0004');
  await closeAccount(db,{actor:erased.actor});
  for (const r of erased.runs) await rpc(db,'bill2_finalize',erased.actor,r);
  for (const c of await calls(db,erased.runs)) {
    assert.notEqual(c.settled_at,null,'erasure settles the member');
    assert.ok(c.fusion_verdict===null||c.fusion_verdict==='erased_before_verdict');
  }
  assert.equal(await charged(db,erased.runs),0);
  assert.equal(await wallet(db,erased.actor),18,'every held credit is released');
  report.checks.push('account closure before the verdict settles every group member at zero charge; no hold stays frozen');

  // Verdict input hardening: NULL is rejected; after account closure a late usable verdict is refused;
  // a call cancelled before dispatch records no_delivery and settles at zero.
  const late = await group(db,createFixture,{n:2,credits:18});
  const lc = await claimGroup(db,late);
  await dispatchAll(db,late,{calls:lc.calls.slice(0,1)});
  await assert.rejects(rpc(db,'fusion_call_verdict',late.actor,lc.calls[0].id,null),/FUSION_VERDICT_INVALID/);
  await rpc(db,'bill2_cancel',late.actor,lc.calls[1].runId);
  await rpc(db,'bill2_finalize',late.actor,lc.calls[1].runId);
  const cancelled = (await db.query('SELECT fusion_verdict,settled_at,charged_delta FROM bill2_calls WHERE id=$1',[lc.calls[1].id])).rows[0];
  assert.equal(cancelled.fusion_verdict,'no_delivery');
  assert.notEqual(cancelled.settled_at,null);
  await record(db,late,late.members.find(f=>f.run===lc.calls[0].runId),lc.calls[0],'0.0004');
  await closeAccount(db,{actor:late.actor});
  await assert.rejects(rpc(db,'fusion_call_verdict',late.actor,lc.calls[0].id,'usable'),/FUSION_VERDICT_DENIED/);
  await rpc(db,'bill2_finalize',late.actor,lc.calls[0].runId);
  assert.equal(await charged(db,late.runs),0,'closed account: late usable verdict refused, call settles at zero');
  assert.equal(await wallet(db,late.actor),18);
  report.checks.push('NULL verdict rejected; cancelled-before-dispatch call records no_delivery; late usable verdict after account closure refused');

  // Concurrent account closure vs a delayed verdict: closure holds the profile row; the verdict waits
  // for it and then sees the account closed.
  const race = await group(db,createFixture,{n:1,credits:9});
  const rc = await claimGroup(db,race);
  await dispatchAll(db,race,rc);
  await record(db,race,race.members[0],rc.calls[0],'0.0004');
  const [closer,judge] = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all([closer.connect(),judge.connect()]);
  try {
    await closer.query('BEGIN');
    await closer.query('SELECT account_erasure_confirm_with_digests($1,$2,$3)',[race.actor,randomUUID(),
      JSON.stringify([{kind:'email',key_version:'b2a_local_v1',digest:createHash('sha256').update(race.actor).digest('hex')}])]);
    const verdict = judge.query('SELECT fusion_call_verdict($1,$2,$3)',[race.actor,rc.calls[0].id,'usable']).then(()=>'written',e=>e.message);
    await new Promise(r=>setTimeout(r,300));
    await closer.query('COMMIT');
    assert.match(await verdict,/FUSION_VERDICT_DENIED/);
  } finally { await closer.end(); await judge.end(); }
  await rpc(db,'bill2_finalize',race.actor,race.runs[0]);
  assert.equal(await charged(db,race.runs),0);
  report.checks.push('verdict racing with account closure waits on the profile row and is refused once closure commits');

  // Membership is immutable once a call exists.
  const other = await rpc(db,'fusion_group_create',exact.actor,randomUUID(),'review');
  await assert.rejects(rpc(db,'fusion_group_attach',exact.actor,other,exact.runs[0]),/FUSION_GROUP_DENIED/);
  await assert.rejects(db.query('UPDATE bill2_runs SET fusion_group_id=NULL WHERE id=$1',[exact.runs[0]]),/FUSION_GROUP_IMMUTABLE/);
  report.checks.push('group membership cannot be changed after attach');
}
