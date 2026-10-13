/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-3b DB part (0235): group admission in one transaction — switch, membership, model
// allowlist and budget read in the transaction; idempotent by request; replay returns the frozen requests.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const settings = (db,review) => db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review,compare:{enabled:false}})]);
const runCount = async (db,actor) => Number((await db.query('SELECT count(*) v FROM bill2_runs WHERE actor_id=$1',[actor])).rows[0].v);

// One frozen run per model: the run payload of the fixture with a single call and the Fusion request inside.
async function member(db,f,index,phase,body=`review request ${index}`) {
  const draft = await rpc(db,'bill2_create_draft',f.actor);
  const call = {...f.claimPayload,phase,requestHash:sha(body)};
  const fusion = {index,phase,body,call};
  const payload = {...f.payload,scope:{kind:'positioning_draft',draftId:draft},input:{...f.payload.input,fusion},
    sourceHash:sha(JSON.stringify(fusion)),limits:{...f.payload.limits,maxCalls:1}};
  return {requestId:randomUUID(),payload};
}

export async function fusionAdmitCases({db,Client,connectionString,report,createFixture}) {
  const reviewer = await createFixture(db,{credits:18,phase:'fusion_review'});
  const summary = await createFixture(db,{actor:reviewer.actor,phase:'fusion_summary'});
  const actor = reviewer.actor;
  const session = randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [session,actor,reviewer.payload.scope,randomUUID()]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO NOTHING`,[randomUUID()]);
  const enabled = {enabled:true,reviewerModelIds:[reviewer.payload.modelId],summaryModelId:summary.payload.modelId,maxBudgetUsd:'1'};
  const items = async () => [await member(db,reviewer,0,'fusion_review'),await member(db,summary,1,'fusion_summary')];
  // The service role is the only caller in production (membership facts are service-role only).
  const admit = async (runs,request=randomUUID(),client=db) => {
    await client.query('SET ROLE service_role');
    try { return (await client.query('SELECT fusion_group_admit($1,$2,$3,$4,$5) v',
      [actor,request,'review',session,JSON.stringify(runs)])).rows[0].v; }
    finally { await client.query('RESET ROLE'); }
  };
  const before = await runCount(db,actor);

  // Switch and permission are read inside the admission transaction; nothing is created on refusal.
  await settings(db,{...enabled,enabled:false});
  await assert.rejects(admit(await items()),/FUSION_REVIEW_DISABLED/);
  await settings(db,enabled);
  await assert.rejects(admit(await items()),/MEMBERSHIP_REQUIRED/);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[actor]);
  await db.query("UPDATE membership_plans SET allow_fusion_review=false WHERE level='gold'");
  await assert.rejects(admit(await items()),/FUSION_MEMBERSHIP_REQUIRED/);
  await db.query("UPDATE membership_plans SET allow_fusion_review=true WHERE level='gold'");
  assert.equal(await runCount(db,actor),before,'refused admissions create no run');
  report.checks.push('group admission reads the review switch and membership permission in its transaction; refusals create nothing');

  // Allowlist, budget and frozen-request integrity.
  await assert.rejects(admit([await member(db,summary,0,'fusion_review')]),/FUSION_MODEL_DENIED/);
  await assert.rejects(admit([await member(db,reviewer,0,'fusion_summary')]),/FUSION_MODEL_DENIED/);
  await settings(db,{...enabled,maxBudgetUsd:'0.000001'});
  await assert.rejects(admit(await items()),/FUSION_BUDGET_EXCEEDED/);
  await settings(db,{...enabled,maxBudgetUsd:null});
  await assert.rejects(admit(await items()),/FUSION_BUDGET_EXCEEDED/);
  await settings(db,enabled);
  const tampered = await member(db,reviewer,0,'fusion_review');
  tampered.payload.input.fusion.body = 'changed after hashing';
  await assert.rejects(admit([tampered]),/FUSION_GROUP_INVALID/);
  const two = await member(db,reviewer,0,'fusion_review');
  two.payload.limits.maxCalls = 2;
  await assert.rejects(admit([two]),/FUSION_GROUP_INVALID/);
  await assert.rejects(admit([await member(db,reviewer,1,'fusion_review')]),/FUSION_GROUP_INVALID/,'indexes start at 0 in order');
  assert.equal(await runCount(db,actor),before);
  report.checks.push('admission enforces the reviewer/summary allowlist, the configured group budget and the frozen request hash');

  // Success and replay: the first admission wins; a replay returns its frozen requests, not new ones.
  const request = randomUUID();
  const first = await admit(await items(),request);
  assert.equal(first.replayed,false);assert.equal(first.runs.length,2);
  assert.deepEqual(first.runs.map(r=>r.fusion.phase),['fusion_review','fusion_summary']);
  const again = await admit([await member(db,reviewer,0,'fusion_review','a different request')],request);
  assert.equal(again.replayed,true);assert.equal(again.groupId,first.groupId);
  assert.deepEqual(again.runs,first.runs,'replay returns the first frozen requests');
  assert.equal(await runCount(db,actor),before+2);
  const group = (await db.query('SELECT source_session_id FROM fusion_billing_groups WHERE id=$1',[first.groupId])).rows[0];
  assert.equal(group.source_session_id,session);
  // The frozen call claims as a full-hold batch.
  const claimed = await rpc(db,'fusion_group_claim',actor,first.groupId,'review:1',1,
    JSON.stringify(first.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}))));
  assert.equal(claimed.state,'claimed');assert.equal(claimed.calls.length,2);
  // A switch turned off later does not undo the admitted group, and refuses only new admissions.
  await settings(db,{...enabled,enabled:false});
  assert.equal((await admit([],request)).groupId,first.groupId);
  await assert.rejects(admit(await items()),/FUSION_REVIEW_DISABLED/);
  await settings(db,enabled);
  report.checks.push('admission is idempotent by request: replay returns the first frozen runs; the batch claims with full holds');

  // Two concurrent admissions of the same request: one group, one set of runs.
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(c=>c.connect()));
  try {
    const shared = randomUUID();
    const sets = [await items(),await items()];
    const results = await Promise.all(clients.map((c,i)=>admit(sets[i],shared,c)));
    assert.equal(results[0].groupId,results[1].groupId);
    assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);
    assert.equal(await runCount(db,actor),before+4,'only one admission created runs');
  } finally { await Promise.all(clients.map(c=>c.end())); }
  report.checks.push('two concurrent admissions of one request produce one group and one set of runs');

  // A replay after the source conversation was deleted returns nothing private.
  await rpc(db,'content_erasure_mark_session',actor,session);
  await assert.rejects(admit([],request),/FUSION_GROUP_DENIED/);
  report.checks.push('an admission replay after the source conversation was deleted is refused');
}
