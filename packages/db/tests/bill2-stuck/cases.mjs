/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {claim,createFixture} from '../payg/fixture.mjs';
import {fixture,proof,balance} from '../payg/provider-rejection.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record=(db,f,c,e)=>rpc(db,'bill2_record',f.actor,f.run,c.id,e);
const call=async(db,c)=>(await db.query('SELECT * FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
const run=async(db,f)=>(await db.query('SELECT * FROM bill2_runs WHERE id=$1',[f.run])).rows[0];
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code));};

// A complete OpenRouter pre-generation refusal with a generation id (pending until a lookup confirms).
function refusal(f,c,status,body={}){
 const providerId='gen-synthetic-'+c.id,e=proof(f);
 const rawBody=JSON.stringify({error:{code:status,message:'Synthetic refusal',
  metadata:{provider_name:null,flagged_input:'PRIVATE_USER_TEXT'}},...body});
 return {...e,evidenceKind:'provider_rejection_pending',providerId,rawBody,sourceHash:hash(rawBody),
  transport:{httpStatus:status,complete:true,transportIssue:null,sourceHash:hash(rawBody),generationId:providerId}};
}
function lookup(f,identity,outcome){
 const now=new Date().toISOString();
 return {provider:'openrouter',account:'sandbox',model:f.claimPayload.model,protocol:'openrouter-chat-v1',
  expectedProviderId:identity.providerId,providerId:null,cost:null,final:false,currency:'USD',
  source:'lookup',coverage:'request_total',observedAt:now,sourceHash:'d'.repeat(64),
  rejectionRecovery:{...identity.rejectionRecovery,queryCount:1,queryTimes:[now],queryOutcomes:[outcome==='timeout'?'other':'not_found']},
  ...(outcome==='timeout'?{evidenceKind:'transport_observation',transport:{httpStatus:null,complete:false,transportIssue:'timeout'}}
   :{lookupOutcome:'not_found',evidenceKind:'provider_rejection_lookup',transport:{httpStatus:404,complete:true,transportIssue:null}})};
}

export async function runCases({db,Client,connectionString,report}) {
 // (A) 400/401/403/422/429 settle at zero only after a later not_found lookup; never immediately.
 for(const version of ['v1','v2'])for(const status of [400,401,403,422,429]){
  // Every fixture opens with 100 credits (v1 holds at prepare, v2 at claim).
  const f=await fixture(db,version),before=100,c=await claim(db,f),held=await balance(db,f);
  assert.ok(held<before);
  await record(db,f,c,refusal(f,c,status));
  assert.equal(await balance(db,f),held,`${version} ${status} pending alone keeps the hold`);
  const stored=JSON.stringify((await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[c.id])).rows);
  assert.ok(!stored.includes('PRIVATE_USER_TEXT')&&!stored.includes('Synthetic refusal'),'private refusal body is not stored');
  assert.ok(stored.includes(`"rejectionStatus": ${status}`)||stored.includes(`"rejectionStatus":${status}`));
  const identity=await rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id);
  await record(db,f,c,lookup(f,identity,'not_found'));
  const settled=await call(db,c);
  assert.equal(settled.provider_rejected,true);assert.equal(Number(settled.selected_cost_usd),0);
  assert.equal(await balance(db,f),before,`${version} ${status} confirmed refusal restores the hold`);
 }
 report.checks.push('400/401/403/422/429 with a generation id are pending refusals; a later not_found lookup settles them at zero (v1 and v2); the private body is not stored');

 const f=await fixture(db,'v2'),c=await claim(db,f),held=await balance(db,f);
 const base=refusal(f,c,403);
 const variants=[
  ['no generation id',{evidenceKind:'provider_rejection',providerId:null,transport:{...base.transport,generationId:undefined}}],
  ['5xx status',{transport:{...base.transport,httpStatus:503}}],
  ['404 status',{transport:{...base.transport,httpStatus:404}}],
  ['code differs from status',(()=>{const raw=JSON.stringify({error:{code:402,message:'x'}});
   return {rawBody:raw,sourceHash:hash(raw),transport:{...base.transport,sourceHash:hash(raw)}};})()],
  ['extra top-level key',(()=>{const raw=JSON.stringify({error:{code:403,message:'x'},choices:[]});
   return {rawBody:raw,sourceHash:hash(raw),transport:{...base.transport,sourceHash:hash(raw)}};})()],
  ['metadata not an object',(()=>{const raw=JSON.stringify({error:{code:403,message:'x',metadata:'text'}});
   return {rawBody:raw,sourceHash:hash(raw),transport:{...base.transport,sourceHash:hash(raw)}};})()],
  ['incomplete transport',{transport:{...base.transport,complete:false}}],
  ['usage present',{usage:{inputTokens:1,outputTokens:0}}],
 ];
 for(const [name,patch] of variants)await denied(record(db,f,c,{...base,...patch}),'BILL2_REJECTION_PROOF_DENIED').catch(error=>{
  throw new Error(name+': '+error.message);});
 assert.equal(await balance(db,f),held);
 report.checks.push('refused proofs: no generation id, 5xx/404, code mismatch, extra keys, non-object metadata, incomplete transport, usage');

 await record(db,f,c,base);
 const identity=await rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id);
 await record(db,f,c,lookup(f,identity,'timeout'));
 assert.equal((await call(db,c)).provider_rejected,false);assert.equal(await balance(db,f),held);
 report.checks.push('a lookup timeout is not "not found": the 403 refusal keeps its hold');

 // (B) A dispatched call whose cost never became known, after automatic recovery ended.
 const admin=randomUUID();
 await db.query("INSERT INTO profiles(id,credits,role) VALUES($1,0,'admin')",[admin]);
 async function stuck(){
  const s=await fixture(db,'v2'),before=100,sc=await claim(db,s),hold=await balance(db,s);
  await record(db,s,sc,{provider:'openrouter',account:'sandbox',model:s.claimPayload.model,protocol:'openrouter-chat-v1',
   evidenceKind:'transport_observation',providerId:'gen-stuck-'+sc.id,cost:null,final:false,currency:'USD',source:'response',
   coverage:'request_total',observedAt:new Date().toISOString(),sourceHash:'e'.repeat(64),rejectedReason:'incomplete_stream'});
  await rpc(db,'bill2_cancel',s.actor,s.run);await rpc(db,'bill2_finalize',s.actor,s.run);
  return {s,sc,before,hold};
 }
 const z=await stuck();
 assert.equal((await run(db,z.s)).state,'cost_pending');
 const settle=(id,cost,reason='供应商后台确认没有生成记录',request=randomUUID(),who=admin)=>
  rpc(db,'bill2_payg_admin_settle_call',who,request,id,cost,reason);
 await denied(settle(z.sc.id,'0'),'BILL2_ADMIN_SETTLE_NOT_READY');
 const listed=async()=> (await rpc(db,'bill2_payg_stuck_calls',100)).calls.map(x=>x.callId);
 assert.ok(!(await listed()).includes(z.sc.id),'not listed while automatic recovery may still run');
 // Three attempts alone do not end recovery (the third lookup may still be running); the deadline does.
 await db.query('UPDATE bill2_calls SET recovery_attempts=3 WHERE id=$1',[z.sc.id]);
 assert.ok(!(await listed()).includes(z.sc.id));await denied(settle(z.sc.id,'0'),'BILL2_ADMIN_SETTLE_NOT_READY');
 await db.query("UPDATE bill2_calls SET recovery_deadline=clock_timestamp()-interval '5 minutes' WHERE id=$1",[z.sc.id]);
 assert.ok(!(await listed()).includes(z.sc.id),'a lookup started just before the deadline gets ten minutes to finish');
 await db.query("UPDATE bill2_calls SET recovery_attempts=3,recovery_deadline=clock_timestamp()-interval '11 minutes' WHERE id=$1",[z.sc.id]);
 assert.equal(await rpc(db,'bill2_recovery_claim',z.s.actor,z.s.run,z.sc.id),null,'after the deadline no lookup can start');
 const entry=(await rpc(db,'bill2_payg_stuck_calls',100)).calls.find(x=>x.callId===z.sc.id);
 assert.ok(entry);assert.ok(!JSON.stringify(entry).includes('rawBody'));
 report.checks.push('a dispatched call with unknown cost stays cost_pending; three attempts or a fresh deadline are not enough; listed only ten minutes after the recovery deadline');

 await denied(settle(z.sc.id,'0','供应商确认',randomUUID(),z.s.actor),'BILL2_ADMIN_SETTLE_DENIED');
 await denied(settle(z.sc.id,'0','   '),'BILL2_ADMIN_SETTLE_DENIED');
 await denied(settle(z.sc.id,'-1'),'BILL2_ADMIN_SETTLE_DENIED');
 const request=randomUUID();
 const result=await settle(z.sc.id,'0','供应商后台确认没有生成记录',request);
 assert.equal(result.creditsBefore,z.hold);assert.equal(result.creditsAfter,z.before);assert.equal(await balance(db,z.s),z.before);
 const closed=await run(db,z.s);
 assert.ok(['settled','refunded'].includes(closed.state));assert.equal(Number(closed.charged),0);
 assert.deepEqual(await settle(z.sc.id,'0','供应商后台确认没有生成记录',request),result);
 await denied(settle(z.sc.id,'0.001','供应商后台确认没有生成记录',request),'BILL2_ADMIN_SETTLE_CONFLICT');
 await denied(settle(z.sc.id,'0'),'BILL2_ADMIN_SETTLE_NOT_READY');
 const audit=(await db.query('SELECT admin_id,action,details FROM user_activity_logs WHERE id=$1',[request])).rows[0];
 assert.equal(audit.admin_id,admin);assert.equal(audit.action,'bill2_admin_settle_call');
 assert.equal(audit.details.reason,'供应商后台确认没有生成记录');assert.equal(audit.details.before.credits,z.hold);
 assert.ok(!(await listed()).includes(z.sc.id));
 report.checks.push('admin settles a verified cost of 0 once: hold released to the exact pre-call balance, audit written with reason and balances, repeat returns the same result, a changed repeat conflicts, a settled call is no longer listed');

 const n=await stuck();
 await db.query("UPDATE bill2_calls SET recovery_attempts=3,recovery_deadline=clock_timestamp()-interval '11 minutes' WHERE id=$1",[n.sc.id]);
 const charged=await settle(n.sc.id,'0.001');
 assert.ok(charged.chargedDelta>0);assert.ok(await balance(db,n.s)<n.before);assert.ok(await balance(db,n.s)>=n.hold);
 assert.equal((await call(db,n.sc)).metering_missing,true);
 report.checks.push('a verified non-zero cost settles through the unchanged min(c,U) fallback and is flagged metering_missing');

 // The staging instance: Fusion review calls in cancelled runs (verdict user_stopped, no cost).
 const fz=await fixture(db,'v2'),fc=await claim(db,fz),fhold=await balance(db,fz);
 await db.query("UPDATE bill2_calls SET payload=jsonb_set(payload,'{phase}','\"fusion_review\"') WHERE id=$1",[fc.id]);
 await record(db,fz,fc,{provider:'openrouter',account:'sandbox',model:fz.claimPayload.model,protocol:'openrouter-chat-v1',
  evidenceKind:'transport_observation',providerId:'gen-fusion-'+fc.id,cost:null,final:false,currency:'USD',source:'response',
  coverage:'request_total',observedAt:new Date().toISOString(),sourceHash:'e'.repeat(64),rejectedReason:'incomplete_stream'});
 await rpc(db,'bill2_cancel',fz.actor,fz.run);await rpc(db,'bill2_finalize',fz.actor,fz.run);
 await db.query("UPDATE bill2_calls SET recovery_attempts=3,recovery_deadline=clock_timestamp()-interval '11 minutes' WHERE id=$1",[fc.id]);
 assert.equal((await run(db,fz)).state,'cost_pending');assert.equal(await balance(db,fz),fhold);
 const fusion=await settle(fc.id,'0');
 assert.equal(fusion.creditsAfter,100);assert.equal(await balance(db,fz),100);
 assert.equal((await call(db,fc)).fusion_verdict,'user_stopped');
 report.checks.push('the staging shape (Fusion review call, cancelled run, verdict user_stopped, cost unknown) settles at 0 and restores the balance');

 // Two settlements by one admin of that admin's own two stuck calls overlap without deadlocking
 // (the staging repair shape: account A is itself the administrator).
 const pa=await stuck(),owner=pa.s.actor;
 const sb=await createFixture(db,{actor:owner,empirical:true,bytes:2000,lookupSupported:true}),cb=await claim(db,sb);
 await record(db,sb,cb,{provider:'openrouter',account:'sandbox',model:sb.claimPayload.model,protocol:'openrouter-chat-v1',
  evidenceKind:'transport_observation',providerId:'gen-stuck-'+cb.id,cost:null,final:false,currency:'USD',source:'response',
  coverage:'request_total',observedAt:new Date().toISOString(),sourceHash:'e'.repeat(64),rejectedReason:'incomplete_stream'});
 await rpc(db,'bill2_cancel',owner,sb.run);await rpc(db,'bill2_finalize',owner,sb.run);
 await db.query("UPDATE bill2_calls SET recovery_attempts=3,recovery_deadline=clock_timestamp()-interval '11 minutes' WHERE id IN ($1,$2)",[pa.sc.id,cb.id]);
 await db.query("UPDATE profiles SET role='admin' WHERE id=$1",[owner]);
 const ownerHeld=await balance(db,pa.s);
 const one=new Client({connectionString}),two=new Client({connectionString});
 await one.connect();await two.connect();
 try {
  for(const c of [one,two]){await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='20s'");}
  // Each commits as soon as its own settlement returns; whichever locks first lets the other proceed.
  const settleIn=(c,id)=>rpc(c,'bill2_payg_admin_settle_call',owner,randomUUID(),id,'0','并发释放').then(()=>c.query('COMMIT'));
  await Promise.all([settleIn(one,pa.sc.id),settleIn(two,cb.id)]);
 } finally {await one.query('ROLLBACK').catch(()=>null);await two.query('ROLLBACK').catch(()=>null);await one.end();await two.end();}
 assert.ok(await balance(db,pa.s)>ownerHeld);
 assert.equal((await call(db,pa.sc)).settled_at!==null&&(await call(db,cb)).settled_at!==null,true);
 report.checks.push('one admin settling two of their own stuck calls in overlapping transactions: both complete (no lock-upgrade deadlock)');

 const grants=await db.query(`SELECT f,r,has_function_privilege(r,f,'EXECUTE') ok FROM unnest(ARRAY[
  'public.bill2_payg_stuck_calls(integer)','public.bill2_payg_admin_settle_call(uuid,uuid,uuid,numeric,text)']) f,
  unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY f,r`);
 assert.deepEqual(grants.rows.map(x=>x.ok),[false,false,true,false,false,true]);
 report.checks.push('both new functions execute for service_role only');
}
