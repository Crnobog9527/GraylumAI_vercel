/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0171_runtime_native_stop.sql');
const report={checks:[],failed:null};
try{
 await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 async function setup(extra={},operation='question',fixtureOptions={}){
  const f=await createFixture(db,fixtureOptions);
  const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'input',instructions:'Answer',
   model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:1,historyItems:0,
   tools:[],network:'deny',nativeOutput:'native-output-v1',providerRequestFormat:'agent-turn-v5-stream',...extra};
  const admission=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,{...f.payload,operation,input:context});
  const begin=await rpc(db,'runtime_execution',f.actor,admission.executionId,'begin',null);
  return {...f,run:admission.runId,execution:admission.executionId,session:session.sessionId,epoch:begin.epoch};
 }
 const action=(f,name,value,client=db)=>rpc(client,'runtime_execution',f.actor,f.execution,name,value);
 const complete=(f,result,client=db)=>action(f,'complete',{epoch:f.epoch,value:result},client);
 const result=(body,extra={})=>({kind:'usable_result',body:body.startsWith('{')?body:JSON.stringify({message:body}),
  stopped:true,completeness:'stopped',
  evidenceRef:'synthetic-stop',evidenceHash:'a'.repeat(64),...extra});
 const stopped=f=>action(f,'stop',{stopAt:2,source:'assistant'});
 const facts=async f=>(await db.query(`SELECT to_jsonb(b) b,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM credit_transactions t WHERE t.bill2_run_id=b.id) ledger,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.revision) FROM runtime_session_history h WHERE h.execution_id=$2) history
  FROM bill2_runs b WHERE b.id=$1`,[f.run,f.execution])).rows[0];
 const f=await setup();
 const c=await claim(db,f);
 assert.equal((await stopped(f)).state,'stopping');
 assert.equal((await action(f,'read',null)).stopCalls[0].responsePending,true);
 await db.query("UPDATE bill2_calls SET dispatched_at=clock_timestamp()-interval '301 seconds' WHERE id=$1",[c.id]);
 assert.equal((await action(f,'read',null)).stopCalls[0].responsePending,false);
 const held=await db.query('SELECT state,reserved_credits,settled_at FROM bill2_calls WHERE id=$1',[c.id]);
 assert.equal(held.rows[0].state,'dispatched');assert.equal(held.rows[0].settled_at,null);
 assert.ok(held.rows[0].reserved_credits>0);
 assert.equal((await action(f,'read',null)).cancelRequested,false);
 await assert.rejects(claim(db,f,2,false),/RUNTIME_RESUME_CONFLICT|RUNTIME_STOP_REQUESTED/);
 await assert.rejects(action(f,'payg_resume',{epoch:1,cursor:1}),/RUNTIME_STOP_REQUESTED/);
 await assert.rejects(action(f,'checkpoint_primary',{epoch:1,value:{body:'wrong',lastSequence:1}}),/RUNTIME_STOP_REQUESTED/);
 await receipt(db,f,c);await rpc(db,'bill2_finalize',f.actor,f.run);
 await assert.rejects(complete(f,result('abc')),/RUNTIME_STOP_POSITION_EXCEEDED/);
 await assert.rejects(complete(f,result('中😀',{stopped:false})),/RUNTIME_STOP_RESULT_REQUIRED/);
 await assert.rejects(complete(f,result('中😀',{completeness:'invalid'})),/RUNTIME_STOP_RESULT_DENIED/);
 const other=new pg.Client(db.connectionParameters);await other.connect();
 try{
  const outcomes=await Promise.all([complete(f,result('中😀')),complete(f,result('中😀'),other)]);
  assert.ok(outcomes.every(o=>o.state==='completed'));
 }finally{await other.end();}
 const once=await facts(f);await complete(f,result('中😀'));assert.deepEqual(await facts(f),once);
 await assert.rejects(complete(f,result('别字')),/RUNTIME_RESULT_CONFLICT/);
 assert.deepEqual((await action(f,'stop',{stopAt:0})).state,'completed');
 assert.deepEqual(await facts(f),once);
 report.checks.push('inflight hold retained; claim/resume/checkpoint denied; R1/R2/R4; concurrent complete once; repeat is read-only');
 const pending=await setup();const unstarted=await claim(db,pending,1,false);
 assert.equal((await stopped(pending)).state,'stopped_pending_result');
 const unused=(await db.query('SELECT state,charged_delta,settled_at FROM bill2_calls WHERE id=$1',[unstarted.id])).rows[0];
 assert.equal(unused.state,'cancelled');assert.equal(unused.charged_delta,0);assert.ok(unused.settled_at);
 assert.equal((await action(pending,'read',null)).billing.contractVersion,'bill2.v2');
 assert.equal((await db.query('SELECT closed,cancel_requested FROM bill2_runs WHERE id=$1',[pending.run])).rows[0].closed,false);
 await action(pending,'stop',{stopAt:0,source:'final'});
 assert.deepEqual((await action(pending,'read',null)).stop,{stopAt:2,source:'assistant'});
 assert.equal((await complete(pending,null)).state,'cancelled');
 const emptyOnce=await facts(pending);await complete(pending,null);assert.deepEqual(await facts(pending),emptyOnce);
 report.checks.push('stop does not close run; prepared cancellation releases once; repeated stop keeps first intent; empty cancellation idempotent');
 for(const format of ['agent-turn-v5-stream','serial-tools-v4-stream']){
  const a=await setup({providerRequestFormat:format,
   ...(format==='serial-tools-v4-stream'?{envelopeOrder:'message-first-v1'}:{}),
   attachedOrganizer:{modelId:randomUUID(),model:'organizer',maxOutputTokens:100}});
  const call=await claim(db,a);await receipt(db,a,call);await rpc(db,'bill2_finalize',a.actor,a.run);
  await rpc(db,'runtime_session_items',a.actor,a.session,a.execution,'append',JSON.stringify([{role:'assistant',content:'original'}]),null,0);
  const primary=JSON.stringify({message:'中😀后',private:'kept'});
  await action(a,'checkpoint_primary',{epoch:1,value:{body:primary,lastSequence:1}});
  await assert.rejects(complete(a,result(JSON.stringify({message:'中😀'}),{summary:''})),/RUNTIME_CHECKPOINT_CONFLICT/);
  await stopped(a);
  for(const fields of [{summary:'',organized:true},{summary:'x',organized:false},{summary:''},{summary:null,organized:false}])
   await assert.rejects(complete(a,result(JSON.stringify({message:'中😀'}),fields)),/RUNTIME_ORGANIZER_PENDING/);
  await assert.rejects(complete(a,result(JSON.stringify({message:'别字'}),{summary:'',organized:false})),/RUNTIME_CHECKPOINT_CONFLICT/);
  const out=await complete(a,result(JSON.stringify({message:'中😀'}),{summary:'',organized:false}));assert.equal(out.state,'completed');
  const visible=(await db.query(
   'SELECT item FROM runtime_session_history WHERE execution_id=$1 AND NOT internal_control ORDER BY revision',[a.execution])).rows;
  assert.equal(visible.length,2);assert.equal(visible[1].item.content,format==='agent-turn-v5-stream'?'中😀':JSON.stringify({message:'中😀'}));
  assert.equal((await rpc(db,'runtime_view',a.actor,a.session)).executions.find(e=>e.executionId===a.execution).stopped,true);
  const nextContext={...(await action(a,'read',null)).context,input:'next turn',historyItems:100};
  const next=await rpc(db,'runtime_admit',a.actor,a.session,randomUUID(),nextContext,{...a.payload,input:nextContext});
  await rpc(db,'runtime_execution',a.actor,next.executionId,'begin',null);
  const history=await rpc(db,'runtime_session_items',a.actor,a.session,next.executionId,'read',null,100,null);
  assert.deepEqual(history.map(entry=>entry.item),visible.map(entry=>entry.item));
  await rpc(db,'runtime_session_items',a.actor,a.session,next.executionId,'freeze',
   JSON.stringify(history.map(entry=>entry.revision)),null,null);
  assert.deepEqual(await rpc(db,'runtime_session_items',a.actor,a.session,next.executionId,'read',null,100,null),history);
 }
 report.checks.push('envelope codepoints and primary prefix only under user_stop; R3 rejects all mismatches; '+
  'stopped Session matches result and next admission/frozen history; view metadata');
 const noPrimary=await setup({attachedOrganizer:{modelId:randomUUID(),model:'organizer',maxOutputTokens:100}});
 const primaryCall=await claim(db,noPrimary);await receipt(db,noPrimary,primaryCall);await rpc(db,'bill2_finalize',noPrimary.actor,noPrimary.run);
 await stopped(noPrimary);assert.equal((await complete(noPrimary,result('ok',{summary:'',organized:false}))).state,'completed');
 report.checks.push('stopped primary without checkpoint may complete unorganized');
 const denied=await setup();
 await assert.rejects(rpc(db,'runtime_execution',randomUUID(),denied.execution,'stop',{stopAt:2}),/BILL2_ACTOR_DENIED/);
 for(const role of ['anon','authenticated']){await db.query('SET ROLE '+role);
  await assert.rejects(stopped(denied),/permission denied/);await db.query('RESET ROLE');}
 await db.query('SET ROLE service_role');assert.equal((await stopped(denied)).state,'stopped_pending_result');await db.query('RESET ROLE');
 report.checks.push('service actor allowed; other actor and anon/authenticated denied');
 const stranger=await createFixture(db);
 await assert.rejects(rpc(db,'runtime_execution',stranger.actor,denied.execution,'stop',{stopAt:2}),/RUNTIME_EXECUTION_DENIED/);
 const zero=await setup();const zeroCall=await claim(db,zero);
 assert.equal((await action(zero,'stop',{stopAt:0,source:'assistant'})).state,'stopping');
 await assert.rejects(complete(zero,result('x')),/RUNTIME_STOP_POSITION_EXCEEDED/);
 await receipt(db,zero,zeroCall);await rpc(db,'bill2_finalize',zero.actor,zero.run);
 assert.equal((await complete(zero,null)).state,'cancelled');
 assert.equal((await action(zero,'read',null)).result,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM runtime_session_history WHERE execution_id=$1',[zero.execution])).rows[0].n,0);
 const zeroOnce=await facts(zero);await complete(zero,null);assert.deepEqual(await facts(zero),zeroOnce);
 report.checks.push('first stopAt zero rejects text, settles dispatched call once and cancels without history; valid foreign actor denied');
 const raceClient=new pg.Client(db.connectionParameters);await raceClient.connect();
 try{
  const parallel=await setup();const prepared=await claim(db,parallel,1,false);
  const intents=[{stopAt:1,source:'assistant'},{stopAt:2,source:'final'}];
  const stops=await Promise.all(intents.map((intent,i)=>action(parallel,'stop',intent,i?raceClient:db)));
  assert.ok(stops.every(value=>value.state==='stopped_pending_result'));
  const chosen=(await action(parallel,'read',null)).stop;
  assert.ok(intents.some(intent=>intent.stopAt===chosen.stopAt&&intent.source===chosen.source));
  const parallelOnce=await facts(parallel);await stopped(parallel);assert.deepEqual(await facts(parallel),parallelOnce);
  assert.equal((await db.query('SELECT charged_delta FROM bill2_calls WHERE id=$1',[prepared.id])).rows[0].charged_delta,0);
  for(const order of ['stop-first','dispatch-first']){
   const racing=await setup();const call=await claim(db,racing,1,false);
   // Hold the run lock until both clients have submitted, exercising both lock winners deterministically.
   await db.query('BEGIN');
   await db.query('SELECT id FROM bill2_runs WHERE id=$1 FOR UPDATE',[racing.run]);
   let stoppedValue,dispatchedValue;
   if(order==='stop-first'){
    stoppedValue=await stopped(racing);
    const dispatch=rpc(raceClient,'bill2_dispatch',racing.actor,racing.run,call.id,call.dispatchToken);
    await db.query('COMMIT');dispatchedValue=await dispatch;
   }else{
    dispatchedValue=await rpc(db,'bill2_dispatch',racing.actor,racing.run,call.id,call.dispatchToken);
    const stop=action(racing,'stop',{stopAt:2,source:'assistant'},raceClient);
    await db.query('COMMIT');stoppedValue=await stop;
   }
   assert.equal(dispatchedValue.dispatch,order==='dispatch-first');
   assert.equal(stoppedValue.state,order==='dispatch-first'?'stopping':'stopped_pending_result');
   const row=(await db.query('SELECT state,dispatched_at,settled_at,charged_delta FROM bill2_calls WHERE id=$1',[call.id])).rows[0];
   if(order==='dispatch-first'){assert.ok(row.dispatched_at);assert.equal(row.settled_at,null);}
   else{assert.equal(row.state,'cancelled');assert.equal(row.dispatched_at,null);assert.ok(row.settled_at);assert.equal(row.charged_delta,0);}
  }
  for(const order of ['stop-first','resume-first']){
   const racing=await setup();
   const wait=await action(racing,'payg_wait',{epoch:racing.epoch,state:'waiting_resume',sequence:1,
    requestHash:racing.claimPayload.requestHash,phase:'question'});
   const resumeArgs={epoch:wait.epoch,cursor:wait.cursor};
   await db.query('BEGIN');
   await db.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[racing.session]);
   if(order==='stop-first'){
    await stopped(racing);
    const resume=action(racing,'payg_resume',resumeArgs,raceClient);
    const rejected=assert.rejects(resume,/RUNTIME_STOP_REQUESTED/);
    await db.query('COMMIT');await rejected;
   }else{
    assert.equal((await action(racing,'payg_resume',resumeArgs)).state,'running');
    const stop=action(racing,'stop',{stopAt:2,source:'assistant'},raceClient);
    await db.query('COMMIT');assert.equal((await stop).state,'stopped_pending_result');
   }
   const observed=await action(racing,'read',null);assert.equal(observed.pausedReason,'user_stop');
   assert.equal(observed.state,'interrupted');
   await assert.rejects(claim(db,racing),/RUNTIME_RESUME_CONFLICT|RUNTIME_STOP_REQUESTED/);
  }
 }finally{await db.query('ROLLBACK');await raceClient.end();}
 report.checks.push('concurrent stops keep one immutable intent; stop/dispatch and stop/resume both lock orders preserve stopped authority');
 for(const [extra,operation] of [[{nativeOutput:undefined},'question'],[{providerRequestFormat:'serial-tools-v2'},'plan'],
  [{providerRequestFormat:'serial-tools-v2'},'question']]){
  const legacy=await setup(extra,operation);await claim(db,legacy,1,false);
  assert.equal((await stopped(legacy)).state,'cancelled');
  const legacyRun=(await db.query('SELECT paused_reason,cancel_requested,closed FROM bill2_runs WHERE id=$1',[legacy.run])).rows[0];
  assert.notEqual(legacyRun.paused_reason,'user_stop');assert.equal(legacyRun.cancel_requested,true);assert.equal(legacyRun.closed,true);
 }
 report.checks.push('old execution without native marker and T3 plan preserve legacy cancellation');
 const financial=await setup();const financialCall=await claim(db,financial);
 await receipt(db,financial,financialCall);await rpc(db,'bill2_finalize',financial.actor,financial.run);
 assert.equal((await stopped(financial)).state,'stopped_pending_result');
 const settledStopCall=(await action(financial,'read',null)).stopCalls[0];
 assert.equal(settledStopCall.settled,true);assert.equal(settledStopCall.responsePending,true);
 const beforeRecovery=await facts(financial);
 for(const finish of [false,true]){
  assert.equal((await rpc(db,'runtime_financial_recovery',financial.actor,financial.execution,finish)).state,'cost_pending');
  assert.deepEqual(await facts(financial),beforeRecovery);
 }
 const batch=await rpc(db,'runtime_pending_financial_batch',financial.actor,20);
 assert.equal(batch.find(item=>item.executionId===financial.execution).userStop,true);
 assert.equal((await complete(financial,null)).state,'cancelled');
 report.checks.push('settled receipt without raw prose requests host completion; financial recovery preserves unsaved stop; batch exposes userStop');
 const cancelledStop=await setup({},'question',{lookupSupported:true});const cancelledCall=await claim(db,cancelledStop);
 assert.equal((await stopped(cancelledStop)).state,'stopping');
 assert.equal((await rpc(db,'runtime_cancel',cancelledStop.actor,cancelledStop.execution)).state,'cost_pending');
 const cancelledInventory=()=>rpc(db,'runtime_pending_financial_batch',cancelledStop.actor,20);
 // Ordinary cancellation removes the stopped-host override; no receipt and no lookup means no batch candidate yet.
 assert.equal((await cancelledInventory()).find(item=>item.executionId===cancelledStop.execution),undefined);
 await rpc(db,'bill2_record',cancelledStop.actor,cancelledStop.run,cancelledCall.id,{
  provider:cancelledStop.claimPayload.provider,account:'sandbox',model:cancelledStop.claimPayload.model,
  protocol:cancelledStop.claimPayload.protocol,providerId:'generation-'+cancelledCall.id,source:'response',
  sourceHash:'e'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:false,cost:null,currency:'USD'});
 const cancelledEntry=(await cancelledInventory()).find(item=>item.executionId===cancelledStop.execution);
 assert.equal(cancelledEntry.userStop,false);assert.equal(cancelledEntry.finishAllowed,true);
 await receipt(db,cancelledStop,cancelledCall);
 assert.equal((await facts(cancelledStop)).b.state,'settled');
 const settledCancelledEntry=(await cancelledInventory()).find(item=>item.executionId===cancelledStop.execution);
 assert.equal(settledCancelledEntry.userStop,false);assert.equal(settledCancelledEntry.finishAllowed,true);
 assert.equal((await rpc(db,'runtime_financial_recovery',cancelledStop.actor,cancelledStop.execution,true)).state,'cancelled');
 assert.equal((await action(cancelledStop,'read',null)).result,null);
 const cancelledRun=(await facts(cancelledStop)).b;
 assert.equal(cancelledRun.cancel_requested,true);assert.equal(cancelledRun.state,'settled');assert.equal(cancelledRun.charged,1);
 assert.equal((await db.query('SELECT active_execution FROM runtime_sessions WHERE id=$1',[cancelledStop.session])).rows[0].active_execution,null);
 const cancelledOnce=await facts(cancelledStop);
 assert.equal((await rpc(db,'runtime_financial_recovery',cancelledStop.actor,cancelledStop.execution,true)).state,'cancelled');
 assert.deepEqual((await facts(cancelledStop)).ledger,cancelledOnce.ledger);
 assert.deepEqual((await facts(cancelledStop)).history,cancelledOnce.history);
 assert.equal((await cancelledInventory()).find(item=>item.executionId===cancelledStop.execution),undefined);
 report.checks.push('stop then ordinary cancellation: no stopped override; late receipt reaches terminal cancelled and charges once');
 const organized=await setup({attachedOrganizer:{modelId:randomUUID(),model:'organizer',maxOutputTokens:100}});
 const mainCall=await claim(db,organized);await receipt(db,organized,mainCall);await rpc(db,'bill2_finalize',organized.actor,organized.run);
 await rpc(db,'runtime_session_items',organized.actor,organized.session,organized.execution,'append',
  JSON.stringify([{role:'assistant',content:'ok'}]),null,0);
 await action(organized,'checkpoint_primary',{epoch:organized.epoch,value:{body:JSON.stringify({message:'ok'}),lastSequence:1}});
 await assert.rejects(complete(organized,result('ok')),/RUNTIME_ORGANIZER_PENDING/);
 const summaryCall=await claim(db,organized,2);
 assert.equal((await stopped(organized)).state,'stopping');
 await receipt(db,organized,summaryCall);await rpc(db,'bill2_finalize',organized.actor,organized.run);
 assert.equal((await complete(organized,result('ok',{summary:'summary',organized:true,completeness:'complete'}))).state,'completed');
 const organizedOnce=await facts(organized);
 await complete(organized,result('ok',{summary:'summary',organized:true,completeness:'complete'}));
 assert.deepEqual(await facts(organized),organizedOnce);
 report.checks.push('non-stop missing summary denied; in-flight organizer can finish with nonempty summary and organized true, once');
 const sig='public.runtime_execution(uuid,uuid,text,jsonb)';
 const def=(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;
 await db.query(migration);await db.query(migration);
 assert.equal((await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d,def);
 await db.query(def.replace('BEGIN','BEGIN\n -- synthetic source drift'));
 await assert.rejects(db.query(migration),/NATIVE_STOP_SOURCE_MISMATCH/);await db.query('ROLLBACK');
 await db.query(def);
 report.checks.push('migration twice unchanged; changed source rejected transactionally');
}catch(error){report.failed=String(error)+"\n"+error.stack;process.exitCode=1;}
finally{await database.close();console.log(JSON.stringify(report,null,2));}
