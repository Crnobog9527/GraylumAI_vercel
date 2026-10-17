/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-COMPARE PR-1 (0284): compare record, begin (recorded before the paid positioning judgement),
// compare branch of the group admission, claim, read, stop, adoption write-back and account erasure.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const count = async (db,sql,args) => Number((await db.query(sql,args)).rows[0].v);
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;

async function settings(db,compare,review={enabled:false}) {
  await db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review,compare})]);
}
const asService = async (client,fn) => {
  await client.query('SET ROLE service_role');
  try { return await fn(); } finally { await client.query('RESET ROLE'); }
};
const call = (client,name,...args) => asService(client,async () =>
  (await client.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,
    args.map(a=>a!==null&&typeof a==='object'?JSON.stringify(a):a))).rows[0].v);

// One frozen run per compare column (index i = the i-th chosen model), as the host builds it.
function column(f,index,body=`compare request ${index}`) {
  const callPayload = {...f.claimPayload,phase:'fusion_compare',requestHash:sha(body)};
  const fusion = {index,phase:'fusion_compare',body,call:callPayload};
  const payload = {...f.payload,input:{...f.payload.input,fusion},sourceHash:sha(JSON.stringify(fusion)),
    limits:{...f.payload.limits,maxCalls:1}};
  return {requestId:randomUUID(),payload};
}

export async function fusionCompareCases({db,Client,connectionString,report,createFixture}) {
  const a = await createFixture(db,{credits:40,phase:'fusion_compare'});
  const b = await createFixture(db,{actor:a.actor,phase:'fusion_compare'});
  const c = await createFixture(db,{actor:a.actor,phase:'fusion_compare'});
  const actor = a.actor;
  const models = [a,b,c].map(f=>f.payload.modelId);
  const session = randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [session,actor,a.payload.scope,randomUUID()]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO NOTHING`,[randomUUID()]);
  const enabled = {enabled:true,allowedModelIds:models,defaultModelIds:models.slice(0,2),minModels:2,maxBudgetUsd:'1'};
  const question = 'Which hook works best?';
  const request = (picked=models.slice(0,2),extra={}) => {
    const config = {models:picked,skill:null};
    const r = {question,questionHash:sha(question),historyRevision:'0',config,workspaceDependencies:[],...extra};
    return {...r,requestHash:sha(JSON.stringify([session,question,config,extra]))};
  };
  const begin = (req,id=randomUUID(),sess=session) => call(db,'fusion_compare_begin',actor,id,sess,req);
  const records = () => count(db,'SELECT count(*) v FROM fusion_compares WHERE actor_id=$1',[actor]);

  // Switch, permission, model count and allowlist are read in the transaction; refusals record nothing.
  await settings(db,{...enabled,enabled:false});
  await assert.rejects(begin(request()),/FUSION_COMPARE_DISABLED/);
  await settings(db,enabled);
  await assert.rejects(begin(request()),/MEMBERSHIP_REQUIRED/);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[actor]);
  await db.query("UPDATE membership_plans SET allow_fusion_compare=false WHERE level='gold'");
  await assert.rejects(begin(request()),/FUSION_COMPARE_FORBIDDEN/);
  await db.query("UPDATE membership_plans SET allow_fusion_compare=true WHERE level='gold'");
  await assert.rejects(begin(request(models.slice(0,1))),/FUSION_COMPARE_TOO_FEW/);
  await settings(db,{...enabled,minModels:3});
  await assert.rejects(begin(request()),/FUSION_COMPARE_TOO_FEW/,'the administrator minimum applies');
  await db.query("UPDATE system_settings SET value='2'::jsonb WHERE key='fusion_compare_max_models'");
  await assert.rejects(begin(request()),/FUSION_COMPARE_SETTINGS_INVALID/,'a minimum above D3 is refused');
  await settings(db,enabled);
  await assert.rejects(begin(request(models)),/FUSION_COMPARE_TOO_MANY/,'D3 caps the count');
  await db.query("UPDATE system_settings SET value='4'::jsonb WHERE key='fusion_compare_max_models'");
  await assert.rejects(begin(request([models[0],models[0]])),/FUSION_COMPARE_MODEL_NOT_ALLOWED/);
  await assert.rejects(begin(request([models[0],randomUUID()])),/FUSION_COMPARE_MODEL_NOT_ALLOWED/);
  await assert.rejects(begin({...request(),historyRevision:'7'}),/FUSION_COMPARE_STALE/);
  await assert.rejects(begin({...request(),question:'tampered'}),/FUSION_COMPARE_INVALID/,'question hash binds the text');
  await assert.rejects(begin(request(),randomUUID(),randomUUID()),/FUSION_COMPARE_SESSION_GONE/);
  assert.equal(await records(),0);
  report.checks.push('compare begin reads the switch, membership, [minModels, D3], allowlist and conversation revision; refusals record nothing');

  // Begin is idempotent by request with a request-hash check; the gate verdict is written once.
  const id1 = randomUUID();
  const first = await begin(request(),id1);
  assert.equal(first.state,'admitting');assert.equal(first.created,true);
  const again = await begin(request(),id1);
  assert.equal(again.compareId,first.compareId);assert.equal(again.created,false,'a replay does not ask for a new judgement');
  await assert.rejects(begin(request(models.slice(1,3)),id1),/FUSION_COMPARE_REQUEST_CONFLICT/);
  await assert.rejects(begin(request(),randomUUID()),/FUSION_COMPARE_ACTIVE/,'one compare in progress per user');
  const runs = [column(a,0),column(b,1)];
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,runs),/FUSION_COMPARE_GATE_REQUIRED/);
  assert.equal((await call(db,'fusion_compare_gate',actor,first.compareId,'clear')).gateVerdict,'clear');
  assert.equal((await call(db,'fusion_compare_gate',actor,first.compareId,'clear')).gateVerdict,'clear');
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'block'),/FUSION_COMPARE_REQUEST_CONFLICT/);
  report.checks.push('begin is idempotent with a request-hash conflict check; the positioning verdict is written once; no admission before it');

  // Compare admission: allowlist in the frozen order, no Skill identity on column runs, budget; then success.
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,[column(b,0),column(a,1)]),/FUSION_COMPARE_MODEL_NOT_ALLOWED/);
  const skilled = column(b,1);skilled.payload.revisionId = randomUUID();
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,[column(a,0),skilled]),/FUSION_GROUP_INVALID/);
  const wrongPhase = column(a,0);wrongPhase.payload.input.fusion.phase='fusion_review';wrongPhase.payload.input.fusion.call.phase='fusion_review';
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,[wrongPhase,column(b,1)]),/FUSION_GROUP_INVALID/);
  await settings(db,{...enabled,maxBudgetUsd:'0.000001'});
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,runs),/FUSION_BUDGET_EXCEEDED/);
  await settings(db,enabled);
  const admitted = await call(db,'fusion_group_admit',actor,id1,'compare',session,runs);
  assert.equal(admitted.replayed,false);assert.equal(admitted.runs.length,2);
  const replay = await call(db,'fusion_group_admit',actor,id1,'compare',session,[]);
  assert.equal(replay.groupId,admitted.groupId);assert.equal(replay.replayed,true);
  const record = await call(db,'fusion_compare_read',actor,first.compareId);
  assert.equal(record.state,'running');assert.equal(record.groupId,admitted.groupId);
  // The review branch still refuses a compare-phase run.
  await assert.rejects(call(db,'fusion_group_admit',actor,randomUUID(),'review',session,[column(a,0)]),/FUSION_REVIEW_DISABLED|FUSION_GROUP_INVALID/);
  report.checks.push('compare admission enforces the frozen model order, column runs without Skill identity, the compare phase and budget');

  // The single group claim, under the compare lock: full holds for both columns, then a replay.
  const items = admitted.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}));
  await assert.rejects(call(db,'fusion_compare_stop',actor,first.compareId,admitted.runs[1].runId),/FUSION_COMPARE_NOT_CLAIMED/,
    'a single column cannot stop before the one claim');
  const before = await wallet(db,actor);
  await assert.rejects(call(db,'fusion_compare_claim',actor,first.compareId,items.slice(0,1)),/FUSION_COMPARE_CLAIM_INCOMPLETE/);
  assert.equal(await wallet(db,actor),before,'a truncated batch holds nothing');
  const claimed = await call(db,'fusion_compare_claim',actor,first.compareId,items);
  assert.equal(claimed.state,'claimed');assert.equal(claimed.calls.length,2);
  assert.ok(await wallet(db,actor)<before,'both columns hold their bound');
  assert.equal((await call(db,'fusion_compare_claim',actor,first.compareId,items)).calls.length,2,'replay returns the same batch');
  report.checks.push('one compare claim holds every column in full; a replay returns the same batch');

  // Column 0 answers; column 1 is stopped before dispatch (released free). Read shows each column.
  const [c0,c1] = admitted.runs.map(r=>claimed.calls.find(x=>x.runId===r.runId));
  assert.equal((await rpc(db,'bill2_dispatch',actor,c0.runId,c0.id,c0.dispatchToken)).dispatch,true);
  await rpc(db,'bill2_record',actor,c0.runId,c0.id,{provider:a.claimPayload.provider,account:'sandbox',model:a.claimPayload.model,
    protocol:a.claimPayload.protocol,providerId:'generation-'+c0.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',usage:{inputTokens:400,outputTokens:0}});
  const answer = 'Hook A: lead with the result.';
  await rpc(db,'fusion_call_output_save',actor,c0.id,answer);
  await rpc(db,'fusion_call_verdict',actor,c0.id,'usable');
  // As the executor settles: finalize, then close the run (cancel) and finalize again.
  await rpc(db,'bill2_finalize',actor,c0.runId);await rpc(db,'bill2_cancel',actor,c0.runId);await rpc(db,'bill2_finalize',actor,c0.runId);
  await call(db,'fusion_compare_stop',actor,first.compareId,c1.runId);
  const read = await call(db,'fusion_compare_read',actor,first.compareId);
  assert.equal(read.state,'finished','all runs closed');
  assert.deepEqual(read.columns.map(x=>x.column),[0,1]);
  assert.equal(read.columns[0].body,answer);assert.equal(read.columns[0].call.verdict,'usable');
  assert.equal(read.columns[1].billing.chargedCredits,0,'the stopped column is free');
  assert.equal(read.chargedCredits,read.columns.reduce((t,x)=>t+(x.billing.chargedCredits??0),0));
  await assert.rejects(call(db,'fusion_compare_claim',actor,first.compareId,items),/FUSION_COMPARE_ENDED/);
  report.checks.push('read lists columns in order with saved body, verdict, charged credits and their total; a column stops free before dispatch');

  // Adoption: column 1 has no usable answer; column 0 is written back with a zero-amount adoption run.
  const items2 = [{role:'user',content:question},{role:'assistant',content:[{type:'output_text',text:answer}]}];
  const billing = (columnIndex,patch={}) => ({...a.payload,input:{...a.payload.input,input:question,dependencies:[],
    fusionAdoption:{compareId:first.compareId,column:columnIndex}},...patch});
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,1,randomUUID(),billing(1),
    [items2[0],{...items2[1],content:[{type:'output_text',text:'x'}]}]),/FUSION_COMPARE_NOT_ADOPTABLE/);
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,0,randomUUID(),billing(0),
    [items2[0],{...items2[1],content:[{type:'output_text',text:'not the saved answer'}]}]),/FUSION_COMPARE_INVALID/);
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,0,randomUUID(),billing(0,{scope:{kind:'positioning_draft',draftId:randomUUID()}}),items2),
    /FUSION_COMPARE_INVALID/,'the adoption run is frozen with the conversation scope');
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,0,randomUUID(),
    billing(0,{moduleId:randomUUID(),skillId:randomUUID(),revisionId:randomUUID()}),items2),/FUSION_COMPARE_SKILL_MISMATCH/,
    'a compare without a Skill adopts without one');
  const adoptRequest = randomUUID();
  const funds = await wallet(db,actor);
  const adopted = await call(db,'fusion_compare_adopt',actor,first.compareId,0,adoptRequest,billing(0),items2);
  assert.equal(adopted.state,'adopted');
  assert.equal(await wallet(db,actor),funds,'adoption charges nothing');
  const execution = (await db.query('SELECT e.state,e.result,r.closed,r.charged,r.session_ref FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.id=$1',
    [adopted.adoption.executionId])).rows[0];
  assert.equal(execution.state,'cancelled');assert.equal(execution.result.body,answer);
  assert.equal(execution.closed,true);assert.equal(Number(execution.charged??0),0);assert.equal(execution.session_ref,session);
  assert.equal(await count(db,'SELECT count(*) v FROM bill2_calls WHERE run_id=$1',[adopted.adoption.adoptionRunId]),0);
  assert.equal(await count(db,'SELECT revision v FROM runtime_sessions WHERE id=$1',[session]),2);
  const available = (await db.query('SELECT available FROM runtime_history_availability(ARRAY[$1::uuid])',[adopted.adoption.executionId])).rows[0].available;
  assert.equal(available,true,'the next turn can read the adopted pair');
  const view = await rpc(db,'runtime_view',actor,session);
  assert.equal(view.executions.find(x=>x.executionId===adopted.adoption.executionId)?.body,answer,'the conversation shows the adopted answer');
  assert.equal((await call(db,'fusion_compare_adopt',actor,first.compareId,0,adoptRequest,billing(0),items2)).adoption.executionId,
    adopted.adoption.executionId,'the same request replays the same adoption');
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,1,randomUUID(),billing(1),items2),/FUSION_COMPARE_ADOPTED/);
  report.checks.push('adoption writes the question and chosen answer through a zero-amount adoption run bound like an ordinary turn; '+
    'the execution ends cancelled, the conversation shows it, the next turn can read it; written once, replayable');

  // A compare whose conversation moved on returns a quote and changes nothing (repeatably).
  const id2 = randomUUID();
  const second = await begin({...request(),historyRevision:'2',requestHash:sha('second')},id2);
  await call(db,'fusion_compare_gate',actor,second.compareId,'allow');
  const admitted2 = await call(db,'fusion_group_admit',actor,id2,'compare',session,[column(a,0),column(b,1)]);
  const claimed2 = await call(db,'fusion_compare_claim',actor,second.compareId,
    admitted2.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call})));
  const d0 = claimed2.calls.find(x=>x.runId===admitted2.runs[0].runId);
  assert.equal((await rpc(db,'bill2_dispatch',actor,d0.runId,d0.id,d0.dispatchToken)).dispatch,true);
  await rpc(db,'bill2_record',actor,d0.runId,d0.id,{provider:a.claimPayload.provider,account:'sandbox',model:a.claimPayload.model,
    protocol:a.claimPayload.protocol,providerId:'generation-'+d0.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'fusion_call_output_save',actor,d0.id,'second answer');
  await rpc(db,'fusion_call_verdict',actor,d0.id,'usable');
  // As the executor settles: finalize, then close the run (cancel) and finalize again.
  await rpc(db,'bill2_finalize',actor,d0.runId);await rpc(db,'bill2_cancel',actor,d0.runId);await rpc(db,'bill2_finalize',actor,d0.runId);
  await call(db,'fusion_compare_stop',actor,second.compareId,null);
  assert.equal((await call(db,'fusion_compare_read',actor,second.compareId)).state,'stopped');
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[session]);
  for (let i=0;i<2;i++) {
    const stale = await call(db,'fusion_compare_adopt',actor,second.compareId,0,randomUUID(),billing(0),items2);
    assert.equal(stale.state,'stale');assert.equal(stale.quote,'second answer');
  }
  assert.equal((await call(db,'fusion_compare_read',actor,second.compareId)).adoption,null,'a quote is not an adoption');
  report.checks.push('when the conversation moved on, adoption returns the answer as a quote, repeatably, and records nothing');

  // A blocked judgement ends the compare without a group; an expired admitting record is refused.
  const id3 = randomUUID();
  const third = await begin({...request(),historyRevision:'3',requestHash:sha('third')},id3);
  assert.equal((await call(db,'fusion_compare_gate',actor,third.compareId,'block')).state,'refused');
  await assert.rejects(call(db,'fusion_group_admit',actor,id3,'compare',session,[column(a,0),column(b,1)]),/FUSION_COMPARE_ENDED/);
  const id4 = randomUUID();
  const fourth = await begin({...request(),historyRevision:'3',requestHash:sha('fourth')},id4);
  await db.query("UPDATE fusion_compares SET created_at=now()-interval '6 minutes' WHERE id=$1",[fourth.compareId]);
  assert.equal((await call(db,'fusion_compare_read',actor,fourth.compareId)).state,'refused');
  await assert.rejects(call(db,'fusion_compare_gate',actor,fourth.compareId,'clear'),/FUSION_COMPARE_ENDED/);
  report.checks.push('a blocked judgement refuses the compare with no group; an admitting record older than 5 minutes is refused');

  // Recovery closes a running compare's runs (the page was closed before dispatch): the user can start again at
  // once, without reading that compare first; the next read finishes the record.
  await db.query("UPDATE fusion_compares SET state='refused' WHERE id=$1",[fourth.compareId]);
  const id5 = randomUUID();
  const fifth = await begin({...request(),historyRevision:'3',requestHash:sha('fifth')},id5);
  await call(db,'fusion_compare_gate',actor,fifth.compareId,'clear');
  const admitted5 = await call(db,'fusion_group_admit',actor,id5,'compare',session,[column(a,0),column(b,1)]);
  await call(db,'fusion_compare_claim',actor,fifth.compareId,admitted5.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call})));
  await assert.rejects(begin({...request(),historyRevision:'3',requestHash:sha('sixth')}),/FUSION_COMPARE_ACTIVE/);
  for (const r of admitted5.runs) { await rpc(db,'bill2_cancel',actor,r.runId); await rpc(db,'bill2_finalize',actor,r.runId); }
  const sixth = await begin({...request(),historyRevision:'3',requestHash:sha('sixth')});
  assert.equal(sixth.state,'admitting','a compare whose runs recovery closed no longer blocks a new one');
  assert.equal((await call(db,'fusion_compare_read',actor,fifth.compareId)).state,'finished');
  report.checks.push('after recovery closes a compare\'s runs the user can start a new compare without reading it; the next read finishes it');

  // Account erasure removes compare records and counts them while present.
  assert.ok(await count(db,'SELECT account_erasure_body_remaining($1)::bigint v',[actor])>0);
  await closeAccount(db,{actor});
  const scrubbed = (await db.query('SELECT account_erasure_scrub_content($1) v',[actor])).rows[0].v;
  assert.ok(scrubbed.fusion_compares>=4);
  assert.equal(await records(),0);
  report.checks.push('account erasure removes and counts compare records');

  // Privileges: only service_role executes the entry points; clients cannot read the table.
  for (const role of ['anon','authenticated'])
    for (const fn of ['fusion_compare_begin(uuid,uuid,uuid,jsonb)','fusion_compare_adopt(uuid,uuid,integer,uuid,jsonb,jsonb)'])
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'execute\') v',[role,fn])).rows[0].v,false);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','public.fusion_compares','SELECT') v")).rows[0].v,false);
  report.checks.push('compare functions are service-role only; clients cannot read compare records');
  void Client;void connectionString;
}
