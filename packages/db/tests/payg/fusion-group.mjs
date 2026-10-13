/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-1 (0234): billing group over per-model runs.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {conserved} from './core.mjs';

const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const calls = async (db,runs) => (await db.query('SELECT * FROM bill2_calls WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',[runs])).rows;
const charged = async (db,runs) => Number((await db.query('SELECT coalesce(sum(charged),0) v FROM bill2_runs WHERE id=ANY($1::uuid[])',[runs])).rows[0].v);

async function group(db,createFixture,{n=3,credits=100,phase='fusion_review'}={}) {
  const first = await createFixture(db,{credits,phase});
  const members = [first];
  for (let i=1;i<n;i++) members.push(await createFixture(db,{actor:first.actor,phase}));
  const id = await rpc(db,'fusion_group_create',first.actor,randomUUID(),'review',first.payload.rules.creditsPerUsd);
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
  report.checks.push('fusion group claim: balance below batch upper bound creates nothing; exact balance holds every member in full; replay is idempotent; changed payload conflicts');

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
  assert.equal(await charged(db,exact.runs.slice(0,2)),1,'two 0.4-credit calls: ceil(0.8)=1');
  // 3. The third member is still unsettled and does not block the others; its late settlement keeps one rounding.
  assert.equal((await calls(db,[exact.runs[2]]))[0].settled_at,null);
  await rpc(db,'bill2_finalize',exact.actor,exact.runs[2]);
  assert.equal(await charged(db,exact.runs),2,'group total is ceil(1.2)=2, rounded once');
  assert.equal(await wallet(db,exact.actor),25);
  for (const f of exact.members) await conserved(db,f);
  assert.equal(Number((await db.query('SELECT weighted_nominal_usd v FROM fusion_billing_groups WHERE id=$1',[exact.id])).rows[0].v),0.0012);
  report.checks.push('verdict required before settlement and immutable; concurrent member finalize; unsettled member does not block; group charged ceil(total*q) once');

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
  report.checks.push('format_invalid verdict charges zero and releases the full hold; the usable member still rounds once');

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

  // Membership is immutable once a call exists.
  const other = await rpc(db,'fusion_group_create',exact.actor,randomUUID(),'review',exact.members[0].payload.rules.creditsPerUsd);
  await assert.rejects(rpc(db,'fusion_group_attach',exact.actor,other,exact.runs[0]),/FUSION_GROUP_DENIED/);
  await assert.rejects(db.query('UPDATE bill2_runs SET fusion_group_id=NULL WHERE id=$1',[exact.runs[0]]),/FUSION_GROUP_IMMUTABLE/);
  report.checks.push('group membership cannot be changed after attach');
}
