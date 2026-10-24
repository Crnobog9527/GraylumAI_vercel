/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-COMPARE PR-1 (0290): compare record, begin (recorded before the paid positioning judgement),
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
    const r = {question,questionHash:sha(question),historyRevision:'0',config,workspaceDependencies:[],snapshotHash:sha('snapshot'),...extra};
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
  await db.query('UPDATE runtime_sessions SET active_execution=$2 WHERE id=$1',[session,randomUUID()]);
  await assert.rejects(begin(request()),/FUSION_COMPARE_STALE/,'a turn still running is refused before the record and the paid judgement');
  await db.query('UPDATE runtime_sessions SET active_execution=NULL WHERE id=$1',[session]);
  await assert.rejects(begin({...request(),config:{models:models.slice(0,2),skill:null,materialRevision:'changed-since-read'}}),/FUSION_COMPARE_STALE/,
    'the work material read with the history must still be current when the compare begins');
  await assert.rejects(begin({...request(),question:'tampered'}),/FUSION_COMPARE_INVALID/,'question hash binds the text');
  await assert.rejects(begin(request(),randomUUID(),randomUUID()),/FUSION_COMPARE_SESSION_GONE/);
  await assert.rejects(begin({...request(),workspaceDependencies:[{sourceVersionId:randomUUID()}]}),/FUSION_COMPARE_SOURCE_REVOKED/,
    'a missing or deleted workspace source is refused before anything is recorded');
  await assert.rejects(begin({...request(),workspaceDependencies:['bare-string']}),/FUSION_COMPARE_INVALID/);
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
  assert.equal((await call(db,'fusion_compare_gate',actor,first.compareId,'clear',false)).gateVerdict,'clear');
  assert.equal((await call(db,'fusion_compare_gate',actor,first.compareId,'clear',false)).gateVerdict,'clear');
  // The work material changed (or was withdrawn) while the judgement ran: the admission refuses before preparing any run.
  await db.query("UPDATE fusion_compares SET config=config||'{\"materialRevision\":\"older:none\"}' WHERE id=$1",[first.compareId]);
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,runs),/FUSION_COMPARE_STALE/);
  await db.query("UPDATE fusion_compares SET config=config-'materialRevision' WHERE id=$1",[first.compareId]);
  // A turn appended after begin (while the judgement ran): the snapshot omits it, so the admission refuses before any run.
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[session]);
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,runs),/FUSION_COMPARE_STALE/);
  await db.query('UPDATE runtime_sessions SET revision=revision-1 WHERE id=$1',[session]);
  // A frozen workspace source that stopped being allowed after begin is refused again at admission.
  await db.query("UPDATE fusion_compares SET workspace_dependencies=jsonb_build_array(jsonb_build_object('sourceVersionId',$2::text)) WHERE id=$1",[first.compareId,randomUUID()]);
  await assert.rejects(call(db,'fusion_group_admit',actor,id1,'compare',session,runs),/FUSION_COMPARE_SOURCE_REVOKED/);
  await db.query("UPDATE fusion_compares SET workspace_dependencies='[]' WHERE id=$1",[first.compareId]);
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'block',false),/FUSION_COMPARE_REQUEST_CONFLICT/);
  // The fallback rule rides with the verdict and is replayed as stored, not rebuilt later.
  assert.equal((await call(db,'fusion_compare_read',actor,first.compareId)).gateFallback,false);
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'clear',true),/FUSION_COMPARE_REQUEST_CONFLICT/,
    'the same verdict with another fallback decision is a conflict');
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'clear',null),/FUSION_COMPARE_INVALID/);
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'block',true),/FUSION_COMPARE_INVALID/,'a blocked turn has no fallback rule');
  await assert.rejects(call(db,'fusion_compare_gate',actor,first.compareId,'maybe',false),/FUSION_COMPARE_INVALID/);
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
  // 0340: exactly one request owns the dispatch of an undispatched column; the claim is a lease that can be taken again.
  const owns = async (who,call) => (await db.query('SELECT fusion_compare_dispatch_claim($1,$2) v',[who,call])).rows[0].v;
  assert.equal(await owns(actor,c1.id),true,'the first request owns the dispatch');
  assert.equal(await owns(actor,c1.id),false,'a second request for the same column does not');
  const outsider = (await createFixture(db,{credits:1,phase:'fusion_compare'})).actor;
  assert.equal(await owns(outsider,c1.id),false,'nobody else can claim another actor\'s column');
  await db.query("UPDATE fusion_compare_dispatch_claims SET claimed_at=now()-interval '3 minutes' WHERE call_id=$1",[c1.id]);
  assert.equal(await owns(actor,c1.id),true,'a claim never followed by a dispatch can be taken again after the lease');
  assert.equal(await owns(actor,randomUUID()),false,'an unknown call cannot be claimed');
  const release = async (who,call) => (await db.query('SELECT fusion_compare_dispatch_release($1,$2) v',[who,call])).rows[0].v;
  assert.equal(await release(outsider,c1.id),false,'nobody else can release another actor\'s claim');
  assert.equal(await release(actor,c1.id),true,'a confirmed no-start gives the claim back');
  assert.equal(await release(actor,c1.id),false,'releasing twice is a no-op');
  assert.equal(await owns(actor,c1.id),true,'and the next request can dispatch at once');
  await db.query('DELETE FROM fusion_compare_dispatch_claims WHERE call_id=$1',[c1.id]);
  report.checks.push('fusion_compare_dispatch_claim: one winner per column, owner-checked, re-claimable after the lease');
  assert.equal((await rpc(db,'bill2_dispatch',actor,c0.runId,c0.id,c0.dispatchToken)).dispatch,true);
  await rpc(db,'bill2_record',actor,c0.runId,c0.id,{provider:a.claimPayload.provider,account:'sandbox',model:a.claimPayload.model,
    protocol:a.claimPayload.protocol,providerId:'generation-'+c0.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',usage:{inputTokens:400,outputTokens:0}});
  const answer = 'Hook A: lead with the result.';
  await rpc(db,'fusion_call_output_save',actor,c0.id,answer);
  // 0340: a saved answer without its verdict (interrupted between the two) is listed for the daily recovery to judge.
  const unjudged = (await db.query('SELECT call_id,compare_id FROM fusion_compare_unjudged(200)')).rows;
  assert.ok(unjudged.some(x=>x.call_id===c0.id&&x.compare_id===first.compareId),'the saved, unjudged compare call is listed');
  await rpc(db,'fusion_call_verdict',actor,c0.id,'usable');
  assert.ok(!(await db.query('SELECT call_id FROM fusion_compare_unjudged(200)')).rows.some(x=>x.call_id===c0.id),'a judged call is not');
  report.checks.push('fusion_compare_unjudged lists a saved compare answer until its verdict is written');
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

  // A real start records the session's work-material revision with the request; adoption fences on it.
  const material = (await db.query('SELECT fusion_compare_material_token($1,$2) v',[actor,session])).rows[0].v;
  await db.query("UPDATE fusion_compares SET config=config||jsonb_build_object('materialRevision',$2::text) WHERE id=$1",[first.compareId,material]);
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
  // The work material changed after the compare started: the answer is stale, nothing is written.
  await db.query("UPDATE fusion_compares SET config=config||'{\"materialRevision\":\"changed-since\"}' WHERE id=$1",[first.compareId]);
  assert.equal((await call(db,'fusion_compare_adopt',actor,first.compareId,0,randomUUID(),billing(0),items2)).state,'stale');
  assert.equal(await count(db,'SELECT revision v FROM runtime_sessions WHERE id=$1',[session]),0,'a stale adoption writes nothing');
  await db.query("UPDATE fusion_compares SET config=config||jsonb_build_object('materialRevision',$2::text) WHERE id=$1",[first.compareId,material]);
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
  await assert.rejects(call(db,'fusion_compare_adopt',actor,first.compareId,1,adoptRequest,billing(1),items2),/FUSION_COMPARE_REQUEST_CONFLICT/,
    'a replay of the adoption request for another column is a conflict, not a success');
  // 0340: the conversation's cards carry the server-written adoption and the frozen workspace dependencies; another actor sees none.
  const cards = await call(db,'fusion_compare_list',actor,session);
  const card = cards.find(x=>x.compareId===first.compareId);
  assert.equal(card.question,question);assert.equal(card.adoption.executionId,adopted.adoption.executionId);
  assert.deepEqual(card.workspaceDependencies,[]);
  assert.ok(cards.every(x=>x.groupId),'a start that never built a group shows no card');
  const stranger = (await createFixture(db,{credits:1,phase:'fusion_compare'})).actor;
  assert.deepEqual(await call(db,'fusion_compare_list',stranger,session),[],'a foreign conversation lists nothing');
  // One exact compare by id (adoption and its replay): not cut by the newest-50 page, and still owner-checked.
  assert.deepEqual((await call(db,'fusion_compare_list',actor,session,first.compareId)).map(x=>x.compareId),[first.compareId]);
  assert.deepEqual(await call(db,'fusion_compare_list',stranger,session,first.compareId),[],'by id still checks the owner');
  assert.deepEqual(await call(db,'fusion_compare_list',actor,session,randomUUID()),[],'an unknown compare id lists nothing');
  report.checks.push('fusion_compare_list returns the conversation cards with adoption and dependencies, nothing for another actor');
  report.checks.push('adoption writes the question and chosen answer through a zero-amount adoption run bound like an ordinary turn; '+
    'the execution ends cancelled, the conversation shows it, the next turn can read it; written once, replayable');

  // The conversation as the next compare would read it: revision and history from the same transaction.
  const context = await call(db,'fusion_compare_context',actor,session,100);
  assert.equal(context.revision,2);assert.equal(context.busy,false);
  assert.deepEqual(context.items.map(x=>x.revision),[1,2]);
  // A turn that used a library document is left out of the compare context (its text is not registered for erasure there).
  const turnExecution = (await db.query('SELECT execution_id FROM runtime_session_history WHERE session_id=$1 AND revision=2',[session])).rows[0].execution_id;
  await db.query("INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal) VALUES($1,$2,$3,1,1)",[turnExecution,actor,randomUUID()]);
  assert.deepEqual((await call(db,'fusion_compare_context',actor,session,100)).items,[],'a turn with library references is omitted');
  await db.query('DELETE FROM runtime_library_references WHERE execution_id=$1',[turnExecution]);
  // ... and so is a turn built on such a turn (its answer is derived from the document), through the dependency lineage.
  const other = (await db.query('SELECT id FROM runtime_executions WHERE id<>$1 AND erased_at IS NULL AND content_deleted_at IS NULL ORDER BY id LIMIT 1',[turnExecution])).rows[0]?.id;
  if (other) {
    await db.query('INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal) SELECT id,actor_id,$2,1,1 FROM runtime_executions WHERE id=$1',[other,randomUUID()]);
    await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[turnExecution,other]);
    assert.deepEqual((await call(db,'fusion_compare_context',actor,session,100)).items,[],'a turn derived from a library turn is omitted');
    await db.query('DELETE FROM runtime_history_dependencies WHERE execution_id=$1 AND dependency_id=$2',[turnExecution,other]);
    await db.query('DELETE FROM runtime_library_references WHERE execution_id=$1',[other]);
    assert.equal((await call(db,'fusion_compare_context',actor,session,100)).items.length,2);
    report.checks.push('the compare context omits turns that used library documents, directly or through the dependency lineage');
  }
  assert.deepEqual(context.items.map(x=>x.item.role),['user','assistant']);
  assert.equal(context.items[0].item.content,question);
  assert.equal(context.items[1].item.content[0].text,answer);
  assert.equal(context.scopeMaterial,null);
  // The material token moves on a revocation too (a revocation keeps the revision but withdraws the content).
  const tokenOf = async () => (await db.query('SELECT fusion_compare_material_token($1,$2) v',[actor,session])).rows[0].v;
  const noMaterial = await tokenOf();
  await db.query("INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash) VALUES($1,1,$2,'{}','{\"brief\":\"x\"}','h1')",[session,randomUUID()]);
  const withMaterial = await tokenOf();
  const guard = () => db.query('SELECT fusion_compare_material_guard($1,$2)',[actor,session]);
  // This brief has no authorized source: an ordinary turn refuses it, so does a compare (begin and adopt), before any record or charge.
  await assert.rejects(guard(),/RUNTIME_MATERIAL_UNAVAILABLE/);
  const beforeRecords = await count(db,'SELECT count(*) v FROM fusion_compares WHERE actor_id=$1',[actor]);
  await assert.rejects(begin({...request(),historyRevision:'2',config:{models:models.slice(0,2),skill:null,materialRevision:withMaterial}}),/RUNTIME_MATERIAL_UNAVAILABLE/);
  assert.equal(await count(db,'SELECT count(*) v FROM fusion_compares WHERE actor_id=$1',[actor]),beforeRecords,'a refused start records nothing');
  await db.query('UPDATE runtime_scope_material SET revoked=true WHERE session_id=$1',[session]);
  const revoked = await tokenOf();
  assert.notEqual(withMaterial,noMaterial);assert.notEqual(revoked,withMaterial,'a revocation changes the token although the revision stays');
  await db.query('DELETE FROM runtime_scope_material WHERE session_id=$1',[session]);
  assert.equal(await tokenOf(),noMaterial);
  assert.deepEqual((await call(db,'fusion_compare_context',actor,session,1)).items.map(x=>x.revision),[2],'the last items only');
  assert.deepEqual((await call(db,'fusion_compare_context',actor,session,0)).items,[]);
  await assert.rejects(call(db,'fusion_compare_context',actor,session,-1),/FUSION_COMPARE_INVALID/);
  await assert.rejects(call(db,'fusion_compare_context',actor,session,1001),/FUSION_COMPARE_INVALID/);
  await assert.rejects(call(db,'fusion_compare_context',actor,randomUUID(),10),/FUSION_COMPARE_SESSION_GONE/);
  await assert.rejects(call(db,'fusion_compare_context',randomUUID(),session,10),/./,'another user cannot read this conversation');
  // An execution the ordinary turn could not read leaves its items out, as in runtime admission.
  await db.query("UPDATE runtime_executions SET unavailable_reason='content_deleted' WHERE id=$1",[adopted.adoption.executionId]);
  assert.deepEqual((await call(db,'fusion_compare_context',actor,session,100)).items,[]);
  await db.query('UPDATE runtime_executions SET unavailable_reason=NULL WHERE id=$1',[adopted.adoption.executionId]);
  // A turn in progress makes the session busy; a stopped turn that only waits for its cost does not (runtime_admit's rule).
  await db.query("UPDATE runtime_sessions SET active_execution=$2 WHERE id=$1",[session,adopted.adoption.executionId]);
  assert.equal((await call(db,'fusion_compare_context',actor,session,100)).busy,true);
  await db.query("UPDATE runtime_sessions SET active_execution=NULL WHERE id=$1",[session]);
  report.checks.push('fusion_compare_context returns the usable history with the session revision and busy flag from one transaction; '+
    'limits, bad limits, a missing or foreign conversation and unavailable executions are handled');

  // A compare whose conversation moved on returns a quote and changes nothing (repeatably).
  const id2 = randomUUID();
  const second = await begin({...request(),historyRevision:'2',requestHash:sha('second')},id2);
  await call(db,'fusion_compare_gate',actor,second.compareId,'allow',false);
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
  // Reading a stopped compare whose runs are all closed keeps it stopped (finishing moves only running records).
  assert.equal((await call(db,'fusion_compare_read',actor,second.compareId)).state,'stopped');
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[session]);
  for (let i=0;i<2;i++) {
    const stale = await call(db,'fusion_compare_adopt',actor,second.compareId,0,randomUUID(),billing(0),items2);
    assert.equal(stale.state,'stale');assert.equal(stale.quote,'second answer');
  }
  // A quote never exceeds what the composer can send: 18000 characters plus the notice, for an answer over 20000.
  await db.query("UPDATE fusion_call_outputs SET body=repeat('x',25000) WHERE call_id=$1",[d0.id]);
  const longQuote = (await call(db,'fusion_compare_adopt',actor,second.compareId,0,randomUUID(),billing(0),items2)).quote;
  assert.equal(longQuote.startsWith('x'.repeat(18000)+'\n'),true);assert.equal(longQuote.includes('已截断'),true);
  assert.equal(longQuote.length<18100,true);
  await db.query("UPDATE fusion_call_outputs SET body='second answer' WHERE call_id=$1",[d0.id]);
  // A frozen workspace source withdrawn after admission also makes the answer stale (the revision is unchanged here).
  await db.query('UPDATE runtime_sessions SET revision=revision-1 WHERE id=$1',[session]);
  await db.query("UPDATE fusion_compares SET workspace_dependencies=jsonb_build_array(jsonb_build_object('sourceVersionId',$2::text)) WHERE id=$1",[second.compareId,randomUUID()]);
  assert.equal((await call(db,'fusion_compare_adopt',actor,second.compareId,0,randomUUID(),billing(0),items2)).state,'stale');
  await db.query("UPDATE fusion_compares SET workspace_dependencies='[]' WHERE id=$1",[second.compareId]);
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[session]);
  assert.equal((await call(db,'fusion_compare_read',actor,second.compareId)).adoption,null,'a quote is not an adoption');
  report.checks.push('when the conversation moved on, adoption returns the answer as a quote, repeatably, and records nothing');

  // The view carries the snapshot hash recorded at begin; end closes a compare that has no group, idempotently.
  const idEnd = randomUUID();
  const toEnd = await begin({...request(),historyRevision:'3',requestHash:sha('end')},idEnd);
  assert.equal(toEnd.snapshotHash,sha('snapshot'));
  await call(db,'fusion_compare_gate',actor,toEnd.compareId,'clear',false);
  assert.equal((await call(db,'fusion_compare_end',actor,toEnd.compareId)).state,'refused');
  assert.equal((await call(db,'fusion_compare_end',actor,toEnd.compareId)).state,'refused','ending twice is the same answer');
  await assert.rejects(call(db,'fusion_group_admit',actor,idEnd,'compare',session,[column(a,0),column(b,1)]),/FUSION_COMPARE_ENDED/);
  await assert.rejects(call(db,'fusion_compare_end',actor,first.compareId),/FUSION_COMPARE_DENIED/,'a compare with a group is stopped, not ended');
  await assert.rejects(call(db,'fusion_compare_end',actor,randomUUID()),/FUSION_COMPARE_DENIED/);
  await assert.rejects(call(db,'fusion_compare_end',randomUUID(),toEnd.compareId),/./);
  report.checks.push('fusion_compare_end closes a compare that has no group and answers the same again; a compare with a group, an unknown '+
    'one or another user is refused; the view returns the recorded snapshot hash');

  // A blocked judgement ends the compare without a group; an expired admitting record is refused.
  const id3 = randomUUID();
  const third = await begin({...request(),historyRevision:'3',requestHash:sha('third')},id3);
  assert.equal((await call(db,'fusion_compare_gate',actor,third.compareId,'block',false)).state,'refused');
  await assert.rejects(call(db,'fusion_group_admit',actor,id3,'compare',session,[column(a,0),column(b,1)]),/FUSION_COMPARE_ENDED/);
  const id4 = randomUUID();
  const fourth = await begin({...request(),historyRevision:'3',requestHash:sha('fourth')},id4);
  await db.query("UPDATE fusion_compares SET created_at=now()-interval '6 minutes' WHERE id=$1",[fourth.compareId]);
  assert.equal((await call(db,'fusion_compare_read',actor,fourth.compareId)).state,'refused');
  await assert.rejects(call(db,'fusion_compare_gate',actor,fourth.compareId,'clear',false),/FUSION_COMPARE_ENDED/);
  report.checks.push('a blocked judgement refuses the compare with no group; an admitting record older than 5 minutes is refused');

  // Recovery closes a running compare's runs (the page was closed before dispatch): the user can start again at
  // once, without reading that compare first; the next read finishes the record.
  await db.query("UPDATE fusion_compares SET state='refused' WHERE id=$1",[fourth.compareId]);
  const id5 = randomUUID();
  const fifth = await begin({...request(),historyRevision:'3',requestHash:sha('fifth')},id5);
  await call(db,'fusion_compare_gate',actor,fifth.compareId,'clear',false);
  const admitted5 = await call(db,'fusion_group_admit',actor,id5,'compare',session,[column(a,0),column(b,1)]);
  await call(db,'fusion_compare_claim',actor,fifth.compareId,admitted5.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call})));
  await assert.rejects(begin({...request(),historyRevision:'3',requestHash:sha('sixth')}),/FUSION_COMPARE_ACTIVE/);
  for (const r of admitted5.runs) { await rpc(db,'bill2_cancel',actor,r.runId); await rpc(db,'bill2_finalize',actor,r.runId); }
  const sixth = await begin({...request(),historyRevision:'3',requestHash:sha('sixth')});
  assert.equal(sixth.state,'admitting','a compare whose runs recovery closed no longer blocks a new one');
  assert.equal((await call(db,'fusion_compare_read',actor,fifth.compareId)).state,'finished');
  report.checks.push('after recovery closes a compare\'s runs the user can start a new compare without reading it; the next read finishes it');

  // First-message compare (0348): a conversation that so far holds only a compare is listed, titled with the question;
  // a refused start leaves nothing to list.
  const fresh = randomUUID();
  const freeDraft = await rpc(db,'bill2_create_draft',actor);
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [fresh,actor,{kind:'positioning_draft',draftId:freeDraft},randomUUID()]);
  const listedFresh = async () => (await rpc(db,'opc_free_conversations',actor)).find(row=>row.sessionId===fresh);
  assert.equal(await listedFresh(),undefined,'an empty new conversation is not listed');
  const firstMessage = 'First message of a new chat';
  const firstReq = {...request(),question:firstMessage,questionHash:sha(firstMessage),requestHash:sha('first-message')};
  await db.query("UPDATE fusion_compares SET state='stopped' WHERE actor_id=$1 AND state IN ('admitting','running')",[actor]);
  const firstCompare = await begin(firstReq,randomUUID(),fresh);
  const shown = await listedFresh();
  assert.ok(shown,'a conversation holding only a compare is listed');
  assert.equal(shown.title,firstMessage,'titled with the compared question');
  await db.query("UPDATE fusion_compares SET created_at=now()-interval '6 minutes' WHERE id=$1",[firstCompare.compareId]);
  assert.equal(await listedFresh(),undefined,'a start stuck admitting past five minutes is not listed');
  await db.query("UPDATE fusion_compares SET state='refused' WHERE id=$1",[firstCompare.compareId]);
  assert.equal(await listedFresh(),undefined,'a refused start is not listed');
  // Before/after equivalence for every account in this database: the ids and order the list returned before 0348
  // (conversations with a plain/Skill turn, newest activity first) are exactly the new list minus compare-only conversations.
  const actors = (await db.query("SELECT DISTINCT actor_id FROM runtime_sessions WHERE scope->>'kind'='positioning_draft'")).rows;
  let compared = 0;
  for (const {actor_id} of actors) {
    let now;
    try { now = (await rpc(db,'opc_free_conversations',actor_id)).map(row=>row.sessionId); }
    catch (error) { if (/BILL2_ACTOR_DENIED/.test(String(error.message))) continue; throw error; }
    const before = (await db.query(`SELECT s.id FROM runtime_sessions s
      CROSS JOIN LATERAL (SELECT e.payload FROM runtime_executions e WHERE e.session_id=s.id AND e.actor_id=$1
        AND e.payload->>'role' IN ('ordinary','skill') ORDER BY e.created_at,e.id LIMIT 1) t
      CROSS JOIN LATERAL (SELECT max(e.created_at) AS la FROM runtime_executions e WHERE e.session_id=s.id AND e.actor_id=$1) act
      WHERE s.erased_at IS NULL AND s.content_deleted_at IS NULL AND s.actor_id=$1 AND s.scope->>'kind'='positioning_draft'
        AND bill2_scope_allowed($1,s.scope) AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces w WHERE w.session_id=s.id)
        AND NOT coalesce(t.payload ? 'weeklyReview',false)
      ORDER BY act.la DESC,s.id LIMIT 100`,[actor_id])).rows.map(row=>row.id);
    const compareOnly = new Set((await db.query(`SELECT s.id FROM runtime_sessions s WHERE s.actor_id=$1 AND NOT EXISTS(SELECT 1 FROM runtime_executions e
      WHERE e.session_id=s.id AND e.actor_id=$1 AND e.payload->>'role' IN ('ordinary','skill'))`,[actor_id])).rows.map(row=>row.id));
    assert.deepEqual(now.filter(id=>!compareOnly.has(id)),before,'the list of pre-existing conversations is unchanged for '+actor_id);
    compared += before.length;
  }
  report.checks.push('0348 before/after: for '+actors.length+' accounts ('+compared+' conversations) every previously listed conversation is still listed in the same order');
  report.checks.push('a conversation that holds only a compare appears in the list with the question as title; a refused one does not');

  // Account erasure removes compare records and counts them while present.
  assert.ok(await count(db,'SELECT account_erasure_body_remaining($1)::bigint v',[actor])>0);
  await closeAccount(db,{actor});
  const scrubbed = (await db.query('SELECT account_erasure_scrub_content($1) v',[actor])).rows[0].v;
  assert.ok(scrubbed.fusion_compares>=4);
  assert.equal(await records(),0);
  report.checks.push('account erasure removes and counts compare records');

  // Privileges: only service_role executes the entry points; clients cannot read the table.
  for (const role of ['anon','authenticated'])
    for (const fn of ['fusion_compare_begin(uuid,uuid,uuid,jsonb)','fusion_compare_adopt(uuid,uuid,integer,uuid,jsonb,jsonb)',
      'fusion_compare_context(uuid,uuid,integer)','fusion_compare_end(uuid,uuid)'])
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'execute\') v',[role,fn])).rows[0].v,false);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','public.fusion_compares','SELECT') v")).rows[0].v,false);
  report.checks.push('compare functions are service-role only; clients cannot read compare records');
  void Client;void connectionString;
}
