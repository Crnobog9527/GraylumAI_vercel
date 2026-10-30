/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {seedActor,seedMethod,start,rpc} from './fixtures.mjs';
import {createFixture,receipt} from '../payg/fixture.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const archived=/^error: OPC_BUSINESS_ARCHIVED$/;
const wallet=async(db,actor)=>Number((await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits);
export async function fusionArchiveCases({admin:db,connect,report}) {
 const method=await seedMethod(db);
 const seed=async()=>{
  const actor=await seedActor(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[actor]);
  await db.query("UPDATE membership_plans SET allow_fusion_compare=true WHERE level='gold'");
  const source=await start(db,actor,method);
  const members=[await createFixture(db,{actor,phase:'fusion_compare'})];
  members.push(await createFixture(db,{actor,phase:'fusion_compare'}));
  const models=members.map(f=>f.payload.modelId);
  await db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
   [{version:1,review:{enabled:false},compare:{enabled:true,allowedModelIds:models,defaultModelIds:models,minModels:2,maxBudgetUsd:'1'}}]);
  const request=randomUUID(),question='Archive concurrency regression';
  const config={models,skill:null};
  const begun=await rpc(db,'fusion_compare_begin',actor,request,source.sessionId,
   {question,questionHash:sha(question),requestHash:sha(request),snapshotHash:sha('snapshot'),historyRevision:'0',config,
    workspaceDependencies:[]});
  const runs=members.map((f,index)=>{
   const body='Synthetic compare '+index;
   const call={...f.claimPayload,requestHash:sha(body)};
   const fusion={index,phase:'fusion_compare',body,call};
   return {requestId:randomUUID(),payload:{...f.payload,input:{...f.payload.input,fusion},
    sourceHash:sha(JSON.stringify(fusion)),limits:{...f.payload.limits,maxCalls:1}}};
  });
  return {actor,source,members,request,runs,compareId:begun.compareId};
 };
 const gate=f=>rpc(db,'fusion_compare_gate',f.actor,f.compareId,'clear',false);
 const admit=f=>rpc(db,'fusion_group_admit',f.actor,f.request,'compare',f.source.sessionId,JSON.stringify(f.runs));
 const archive=(f,client=db)=>rpc(client,'opc_business_archive',f.actor,f.source.businessId);
 const snapshot=async f=>(await db.query(`SELECT jsonb_build_object('compare',(SELECT to_jsonb(c) FROM fusion_compares c WHERE id=$1),
  'groups',(SELECT count(*) FROM fusion_billing_groups WHERE actor_id=$2),'runs',(SELECT count(*) FROM bill2_runs WHERE actor_id=$2),
  'calls',(SELECT count(*) FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE r.actor_id=$2),
  'credits',(SELECT credits FROM profiles WHERE id=$2)) v`,[f.compareId,f.actor])).rows[0].v;

 // A real begin commits; another transaction archives while the host's positioning check is in flight.
 const first=await seed(),archiver=await connect(),later=await connect();
 await archiver.query('BEGIN');await archive(first,archiver);
 const pid=(await later.query('SELECT pg_backend_pid() id')).rows[0].id;
 const attempt=rpc(later,'fusion_compare_gate',first.actor,first.compareId,'clear',false).then(()=>null,error=>error);
 let blocked=false;
 for(let i=0;i<100&&!blocked;i++) {
  blocked=(await db.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;
  if(!blocked)await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(blocked,'later gate waits for the concurrent archive business lock');
 await archiver.query('COMMIT');assert.match(String(await attempt),archived);
 const frozen=await snapshot(first);
 await assert.rejects(admit(first),archived);
 assert.deepEqual(await snapshot(first),frozen,'no gate write, group, run, hold or fee after archive');
 report.checks.push('Fusion begin -> concurrent archive -> gate and group admission denied, no writes or charge');
 assert.equal(await rpc(db,'fusion_compare_stop_archived',first.actor,first.request),true);
 assert.equal(await rpc(db,'fusion_compare_active',first.actor),false,'post-refusal production cleanup also ends group-less requests');

 const second=await seed();await gate(second);await archive(second);
 const afterGate=await snapshot(second);
 await assert.rejects(admit(second),archived);
 assert.deepEqual(await snapshot(second),afterGate,'archiving between gate and admission writes nothing');
 assert.equal(await rpc(db,'fusion_compare_stop_archived',second.actor,second.request),true);
 assert.equal(await rpc(db,'fusion_compare_active',second.actor),false);
 report.checks.push('Fusion gate -> archive -> group admission denied');

 const third=await seed();await gate(third);const group=await admit(third);
 const open=await snapshot(third);
 assert.equal(await rpc(db,'fusion_compare_stop_archived',third.actor,third.request),false);
 assert.deepEqual(await snapshot(third),open,'cleanup cannot stop an unarchived request');
 const items=group.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}));
 assert.notEqual(third.runs[0].payload.scope.draftId,third.source.draftId,'column billing really uses a temporary draft');
 await archive(third);const beforeClaim=await snapshot(third);
 await assert.rejects(rpc(db,'fusion_compare_claim',third.actor,third.compareId,JSON.stringify(items)),archived);
 await assert.rejects(rpc(db,'fusion_group_claim',third.actor,group.groupId,'compare:1',1,JSON.stringify(items)),archived);
 await assert.rejects(rpc(db,'bill2_claim',third.actor,items[0].runId,1,items[0].payload),archived);
 await assert.rejects(rpc(db,'bill2_payg_claim',third.actor,items[0].runId,1,items[0].payload),archived);
 assert.deepEqual(await snapshot(third),beforeClaim,'existing temporary-draft group cannot reserve after archive');
 const stranger=await seedActor(db);
 assert.equal(await rpc(db,'fusion_compare_stop_archived',stranger,third.request),false);
 assert.deepEqual(await snapshot(third),beforeClaim,'another actor cannot clean up this request');
 const authorized=await connect();await authorized.query('SET ROLE service_role');
 await authorized.query("SELECT set_config('request.jwt.claims',$1,false)",[
  JSON.stringify({sub:third.actor,role:'service_role'})]);
 assert.equal(await rpc(authorized,'fusion_compare_stop_archived',third.actor,third.request),true,
  'same privileged RPC invoked by startCompare after a refusal; no manual stop');
 assert.equal(await rpc(db,'fusion_compare_active',third.actor),false);
 const ended=await rpc(db,'fusion_compare_read',third.actor,third.compareId);
 assert.ok(ended.columns.every(c=>c.billing.closed),'runs with no bill2_calls close, without receipt recovery');
 const cleaned=await snapshot(third);
 assert.equal(await rpc(db,'fusion_compare_stop_archived',third.actor,third.request),true);
 assert.deepEqual(await snapshot(third),cleaned,'cleanup replay is idempotent');
 const denied=await connect();await denied.query('SET ROLE authenticated');
 await assert.rejects(rpc(denied,'fusion_compare_stop_archived',third.actor,third.request),/permission denied for function/);
 await denied.query('RESET ROLE');
 const acl=(await db.query(`SELECT has_function_privilege('anon','fusion_compare_stop_archived(uuid,uuid)','execute') anon,
  has_function_privilege('authenticated','fusion_compare_stop_archived(uuid,uuid)','execute') authenticated,
  has_function_privilege('service_role','fusion_compare_stop_archived(uuid,uuid)','execute') service`)).rows[0];
 assert.deepEqual(acl,{anon:false,authenticated:false,service:true});
 report.checks.push('post-claim-refusal production cleanup closes call-less runs, frees active slot, retries safely; foreign/unarchived/privilege refusals');

 // One column delivered/charged; the other only has a hold. Archive must identify
 // the source of the temporary run, wait for dispatched obligations, then stop any new dispatch.
 const fourth=await seed();await gate(fourth);const paidGroup=await admit(fourth);
 const paidItems=paidGroup.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}));
 const initial=await wallet(db,fourth.actor);
 const claimed=await rpc(db,'fusion_compare_claim',fourth.actor,fourth.compareId,JSON.stringify(paidItems));
 const calls=paidGroup.runs.map(r=>claimed.calls.find(c=>c.runId===r.runId));
 const [delivered,pending]=calls;
 assert.equal((await rpc(db,'bill2_dispatch',fourth.actor,delivered.runId,delivered.id,delivered.dispatchToken)).dispatch,true);
 await assert.rejects(archive(fourth),/^error: OPC_BUSINESS_BUSY$/,'a dispatched temporary Fusion run blocks archive');
 await receipt(db,{...fourth.members[0],run:delivered.runId},delivered,'0.0004',{inputTokens:400,outputTokens:0});
 await rpc(db,'fusion_call_output_save',fourth.actor,delivered.id,'Saved answer before archive');
 await rpc(db,'fusion_call_verdict',fourth.actor,delivered.id,'usable');
 await rpc(db,'bill2_finalize',fourth.actor,delivered.runId);
 await rpc(db,'bill2_cancel',fourth.actor,delivered.runId);await rpc(db,'bill2_finalize',fourth.actor,delivered.runId);
 await archive(fourth);
 assert.deepEqual(await rpc(db,'bill2_dispatch',fourth.actor,pending.runId,pending.id,pending.dispatchToken),
  {dispatch:false,archived:true},'dispatch refusal commits whole-compare cleanup without a manual stop');
 const view=await rpc(db,'fusion_compare_read',fourth.actor,fourth.compareId);
 assert.equal(view.chargedCredits,1,'delivered column charged once');
 assert.equal(view.columns[0].body,'Saved answer before archive');
 assert.equal(view.columns[1].billing.chargedCredits,0,'undispatched column is free');
 assert.equal(await wallet(db,fourth.actor),initial-1,'all unspent holds released, delivered fee retained');
 await rpc(db,'bill2_finalize',fourth.actor,pending.runId);
 assert.equal(await wallet(db,fourth.actor),initial-1,'repeat cleanup never double-refunds');
 assert.equal(await rpc(db,'fusion_compare_active',fourth.actor),false,'no lingering active compare slot');
 report.checks.push('temporary Fusion in-flight call blocks archive; archived dispatch automatically releases holds, preserves delivered fee/result and frees active slot');

 const fifth=await seed();await gate(fifth);const waiting=await admit(fifth),balance=await wallet(db,fifth.actor);
 const reserved=await rpc(db,'fusion_compare_claim',fifth.actor,fifth.compareId,JSON.stringify(
  waiting.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}))));
 await archive(fifth);
 const [a,b]=await Promise.all([connect(),connect()]);
 const [one,two]=reserved.calls;
 const refusals=await Promise.all([
  rpc(a,'bill2_dispatch',fifth.actor,one.runId,one.id,one.dispatchToken),
  rpc(b,'bill2_dispatch',fifth.actor,two.runId,two.id,null,true,waiting.runs.find(r=>r.runId===two.runId).fusion.call),
 ]);
 assert.deepEqual(refusals,[{dispatch:false,archived:true},{dispatch:false,archived:true}]);
 assert.equal(await wallet(db,fifth.actor),balance,'concurrent dispatch/rotation refunds every undispatched column once');
 assert.equal(await rpc(db,'fusion_compare_active',fifth.actor),false);
 const finished=await rpc(db,'fusion_compare_read',fifth.actor,fifth.compareId);
 assert.ok(finished.columns.every(c=>c.billing.closed),'all runs close without a manual stop or recovery job');
 report.checks.push('concurrent archived dispatch/rotation automatically closes every prepared column and refunds once, no active compare slot');

 // CORE-PATH-V2 V2-7b (#1522 review): a compare on the turn path is refused in an archived business before anything is created
 // (by the read before the open, fusion_compare_turn_admit; a jury start likewise by fusion_review_turn_source).
 const sixth=await seed();await archive(sixth);
 const before=await wallet(db,sixth.actor);
 await assert.rejects(rpc(db,'fusion_compare_turn_admit',sixth.actor,sixth.source.sessionId,10,[]),/OPC_BUSINESS_ARCHIVED/);
 assert.equal((await db.query('SELECT count(*)::int n FROM turns WHERE actor_id=$1',[sixth.actor])).rows[0].n,0);
 assert.equal(await wallet(db,sixth.actor),before,'nothing frozen');
 report.checks.push('turn path: a compare in an archived business is refused with no turn, record or freeze');
}
