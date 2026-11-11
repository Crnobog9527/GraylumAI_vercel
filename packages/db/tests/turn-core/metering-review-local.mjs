/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 metering block (deep review 2026-11-11, finding 10; migration turn_metering_block_review). A model receipt whose cost
// went above its frozen bound blocks that model for every user (turn_call_record / turn_call_begin); before this migration nothing
// could end the block. admin_metering_blocks lists the blocked models; admin_metering_review lets one through again, once, with an
// audit row, and changes no cost, charge or settlement. A non-admin, a repeat and a race change nothing twice.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,root} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const policy={q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:100,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}};
async function account(credits=1000){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session};
}
const adminAccount=async(over={})=>{const id=randomUUID();
 await c.query("insert into profiles(id,credits,role) values($1,0,'admin')",[id]);
 if(over.status)await c.query('update profiles set status=$2 where id=$1',[id,over.status]);
 return id;};
const open=a=>one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify(policy),null]);
const begin=(a,turn,seq,model,upper=0.02)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'model',model,null,null,hash('r'+turn+seq),upper,6]);
// nominal and actual on their own: a receipt is over its bound when either is above upper_usd (0422 / 0510).
const record=(a,turn,seq,{nominal=0.01,actual=0.01}={})=>one("select turn_call_record($1,$2,$3,'ok',$4,$5,'{}',null,$6,$7) v",
 [a.actor,turn,seq,nominal,actual,hash('p'+turn+seq),'[{"choices":[]}]']);
const close=(a,turn)=>one("select turn_close($1,$2,'completed','[]',false,false,null) v",[a.actor,turn]);
const blocks=(client=c)=>one('select admin_metering_blocks() v',[],client);
const review=(model,admin,{request=randomUUID(),client=c}={})=>one('select admin_metering_review($1,$2,$3) v',[model,admin,request],client);
const audits=model=>one("select count(*)::int v from user_activity_logs where action='admin_metering_review' and details->>'modelId'=$1",[model]);
/** One finished turn of a new account with one model call; `over` is its receipt (a cost above the 0.02 bound blocks the model). */
const call=async(model,over={})=>{const a=await account(),o=await open(a);
 await begin(a,o.turnId,1,model);await record(a,o.turnId,1,over);const closed=await close(a,o.turnId);return {a,id:o.turnId,closed};};
/** A new account's first call to the model: 'ok', or the refusal's text. Its turn is closed either way. */
const tryCall=async model=>{const a=await account(),o=await open(a);let out='ok';
 try{await begin(a,o.turnId,1,model);await record(a,o.turnId,1);}catch(e){out=e.message;}
 await one("select turn_close($1,$2,'failed','[]',false,true,'test') v",[a.actor,o.turnId]);return out;};
try{
 const admin=await adminAccount();
 // 1. Normal: a receipt over its bound blocks the model for everyone and is listed; the review lets it through, once, audited.
 {
  const model=randomUUID(),other=randomUUID();
  await c.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
   values($1,'Blocked model','test/blocked','openrouter','true',8192,100000,'{}','https://openrouter.ai/api/v1/chat/completions')`,[model]);
  assert.deepEqual(await blocks(),[]);
  const inside=await call(model,{nominal:0.02,actual:0.02});
  assert.deepEqual(await blocks(),[],'a cost at the bound is not a conflict');
  assert.equal(await tryCall(model),'ok');
  const over=await call(model,{nominal:0.01,actual:0.05});
  // The user of that call is charged by the nominal cost as always: ceil(100 x 0.01 x 6) = 6 credits.
  assert.equal(over.closed.chargedCredits,6);
  assert.match(await tryCall(model),/TURN_MODEL_METERING_BLOCKED/,'another user is refused the blocked model');
  assert.equal(await tryCall(other),'ok','another model is not touched');
  const listed=await blocks();
  assert.equal(listed.length,1);
  assert.deepEqual({...listed[0],firstAt:null,lastAt:null},{modelId:model,model:'Blocked model',calls:1,firstAt:null,lastAt:null,
   turnId:over.id,upperUsd:'0.020000000000',nominalUsd:'0.010000000000',actualUsd:'0.050000000000'});
  assert.ok(listed[0].firstAt&&listed[0].firstAt===listed[0].lastAt);
  const request=randomUUID(),done=await review(model,admin,{request});
  assert.deepEqual(done,{modelId:model,reviewed:1});
  assert.deepEqual(await blocks(),[]);
  assert.equal(await tryCall(model),'ok','the reviewed model is let through again');
  const log=await c.query('select user_id,admin_id,action,action_type,details from user_activity_logs where id=$1',[request]);
  assert.equal(log.rows.length,1);
  assert.deepEqual([log.rows[0].user_id,log.rows[0].admin_id,log.rows[0].action,log.rows[0].action_type,log.rows[0].details.modelId,log.rows[0].details.calls],
   [null,admin,'admin_metering_review','admin',model,1]);
  // Nothing else changed: the receipt keeps its costs and its mark, both turns keep their settlement.
  const kept=await c.query('select budget_conflict,nominal_usd::text n,actual_usd::text a,conflict_reviewed_at is not null reviewed from turn_calls where turn_id=$1',[over.id]);
  assert.deepEqual(kept.rows,[{budget_conflict:true,n:'0.010000000000',a:'0.050000000000',reviewed:true}]);
  assert.equal(await one('select charged_credits v from turns where id=$1',[over.id]),6);
  assert.equal(await one('select charged_credits v from turns where id=$1',[inside.id]),inside.closed.chargedCredits);
  // A later receipt over the bound blocks the model again, and only that receipt is waiting.
  const againOver=await call(model,{nominal:0.03,actual:0.01});
  assert.match(await tryCall(model),/TURN_MODEL_METERING_BLOCKED/);
  const second=await blocks();
  assert.deepEqual([second.length,second[0].calls,second[0].turnId,second[0].nominalUsd],[1,1,againOver.id,'0.030000000000']);
  assert.deepEqual(await review(model,admin),{modelId:model,reviewed:1});
  report.checks.push('an over-bound receipt blocks its model for every user and is listed; the review lets it through once, audited, and changes no cost or charge; a later one blocks it again');
 }
 // 2. Several receipts and several models: one entry per model, the furthest over its bound shown; reviewing one leaves the other.
 {
  const m1=randomUUID(),m2=randomUUID();
  const small=await call(m1,{nominal:0.01,actual:0.03});
  const a=await account(),o=await open(a);
  // The model is already blocked for new calls: a second over-bound receipt can only come from a call that was in flight.
  await c.query('update turn_calls set conflict_reviewed_at=now() where turn_id=$1',[small.id]);
  await begin(a,o.turnId,1,m1);
  await c.query('update turn_calls set conflict_reviewed_at=null where turn_id=$1',[small.id]);
  await record(a,o.turnId,1,{nominal:0.09,actual:0.02});await close(a,o.turnId);
  await call(m2,{nominal:0.01,actual:0.021});
  const listed=await blocks();
  assert.equal(listed.length,2);
  const first=listed.find(b=>b.modelId===m1),second=listed.find(b=>b.modelId===m2);
  assert.deepEqual([first.calls,first.turnId,first.nominalUsd,first.actualUsd,first.model],[2,o.turnId,'0.090000000000','0.020000000000',null]);
  assert.deepEqual([second.calls,second.actualUsd],[1,'0.021000000000']);
  assert.deepEqual(await review(m1,admin),{modelId:m1,reviewed:2});
  assert.deepEqual((await blocks()).map(b=>b.modelId),[m2]);
  assert.match(await tryCall(m2),/TURN_MODEL_METERING_BLOCKED/);assert.equal(await tryCall(m1),'ok');
  assert.deepEqual(await review(m2,admin),{modelId:m2,reviewed:1});
  report.checks.push('one entry per blocked model with its worst receipt; a review covers every waiting receipt of that model and no other model');
 }
 // 3. Repeated: the same request again, or another one, finds nothing waiting and writes nothing.
 {
  const model=randomUUID();await call(model,{actual:0.05});
  const request=randomUUID(),first=await review(model,admin,{request}),same=await review(model,admin,{request}),other=await review(model,admin);
  assert.deepEqual([first.reviewed,same.reviewed,other.reviewed],[1,0,0]);
  assert.equal(await audits(model),1);
  const never=randomUUID();
  assert.deepEqual(await review(never,admin),{modelId:never,reviewed:0});
  assert.equal(await audits(never),0);
  report.checks.push('a repeat or a model that is not blocked changes nothing and adds no audit row');
 }
 // 4. Concurrent: two admins at once; the receipts are reviewed once, one audit row.
 {
  const model=randomUUID();await call(model,{actual:0.05});
  const p1=await peer(),p2=await peer();
  try{
   const results=await Promise.all([review(model,admin,{client:p1}),review(model,admin,{client:p2})]);
   assert.deepEqual(results.map(r=>r.reviewed).sort(),[0,1]);
  }finally{await p1.end();await p2.end();}
  assert.equal(await audits(model),1);assert.deepEqual(await blocks(),[]);
  report.checks.push('two reviews at once: one marks the receipts, the other finds none; one audit row');
 }
 // 5. Refused: a plain user, an inactive admin, an unknown or missing admin, a missing request or model. Nothing is written.
 {
  const model=randomUUID();await call(model,{actual:0.05});
  const user=(await account()).actor,inactive=await adminAccount({status:'inactive'});
  for(const who of [user,inactive,randomUUID(),null])assert.match(await refusal(review(model,who)),/TURN_ADMIN_DENIED/);
  assert.match(await refusal(review(model,admin,{request:null})),/TURN_ADMIN_DENIED/);
  assert.match(await refusal(review(null,admin)),/TURN_METERING_REVIEW_INVALID/);
  assert.equal((await blocks()).length,1);assert.equal(await audits(model),0);
  assert.match(await tryCall(model),/TURN_MODEL_METERING_BLOCKED/,'a refused review leaves the model blocked');
  assert.deepEqual(await review(model,admin),{modelId:model,reviewed:1});
  report.checks.push('a plain user, an inactive, unknown or missing admin, and a missing request or model are refused with nothing written');
 }
 // 6. Service role only.
 {
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]]){
   assert.equal(await one("select has_function_privilege($1,'public.admin_metering_blocks()','EXECUTE') v",[role]),want,role);
   assert.equal(await one("select has_function_privilege($1,'public.admin_metering_review(uuid,uuid,uuid)','EXECUTE') v",[role]),want,role);
  }
  report.checks.push('service role only');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
