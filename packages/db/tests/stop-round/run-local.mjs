/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-NATIVE-OUTPUT (0260): runtime_execution 'stop' accepts the round (`call`) next to stopAt/source.
// Local only: node packages/db/tests/stop-round/run-local.mjs --local-only
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0260_runtime_stop_round.sql');
const report={checks:[],failed:null};
try{
 await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 async function setup(){
  const f=await createFixture(db);
  const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'input',instructions:'Answer',
   model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:2,historyItems:0,tools:[],network:'deny',
   nativeOutput:'native-output-v1',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'},textStream:'plain-text-v1'};
  const admission=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,{...f.payload,operation:'question',input:context});
  const begin=await rpc(db,'runtime_execution',f.actor,admission.executionId,'begin',null);
  return {...f,run:admission.runId,execution:admission.executionId,session:session.sessionId,epoch:begin.epoch};
 }
 const action=(f,name,value)=>rpc(db,'runtime_execution',f.actor,f.execution,name,value);
 const complete=(f,result)=>action(f,'complete',{epoch:f.epoch,value:result});

 for(const bad of [{stopAt:2,source:'assistant',call:0},{stopAt:2,source:'assistant',call:'1'},{stopAt:2,source:'assistant',call:1.5},
  {stopAt:2,source:'assistant',call:1,round:1}]){
  const f=await setup();await claim(db,f);
  await assert.rejects(action(f,'stop',bad),/RUNTIME_STOP_DENIED/,JSON.stringify(bad));
  assert.equal((await action(f,'read',null)).stop,null,'a denied stop records nothing');
 }
 report.checks.push('call must be a positive integer; unknown keys still denied; a denied stop records nothing');

 const f=await setup();const c1=await claim(db,f);
 assert.equal((await action(f,'stop',{stopAt:2,source:'assistant',call:1})).state,'stopping');
 await action(f,'stop',{stopAt:9,source:'assistant',call:2});
 assert.deepEqual((await action(f,'read',null)).stop,{stopAt:2,source:'assistant',call:1},'first stop intent, with its round, wins');
 await receipt(db,f,c1);await rpc(db,'bill2_finalize',f.actor,f.run);
 const before=(await db.query('SELECT coalesce(sum(charged_delta),0)::int charged FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0];
 const result={kind:'usable_result',body:'我先',stopped:true,completeness:'stopped',evidenceRef:'synthetic-stop',evidenceHash:'a'.repeat(64)};
 assert.equal((await complete(f,result)).state,'completed');
 const after=(await db.query('SELECT coalesce(sum(charged_delta),0)::int charged FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0];
 assert.deepEqual(after,before,'naming the round changes no charge');
 report.checks.push('stop with call is stored with the immutable first intent; completion settles exactly as before');

 const legacy=await setup();await claim(db,legacy);
 assert.equal((await action(legacy,'stop',{stopAt:2,source:'assistant'})).state,'stopping');
 assert.deepEqual((await action(legacy,'read',null)).stop,{stopAt:2,source:'assistant'});
 report.checks.push('a stop without call is unchanged');

 const sig='public.runtime_execution(uuid,uuid,text,jsonb)';
 const def=(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;
 await db.query(migration);await db.query(migration);
 assert.equal((await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d,def);
 await db.query(def.replace('BEGIN','BEGIN\n -- synthetic source drift'));
 await assert.rejects(db.query(migration),/STOP_ROUND_SOURCE_MISMATCH/);await db.query('ROLLBACK');
 await db.query(def);
 report.checks.push('migration twice unchanged; changed source rejected transactionally');
}catch(error){report.failed=String(error)+"\n"+error.stack;process.exitCode=1;}
finally{await database.close();console.log(JSON.stringify(report,null,2));}
