/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,call,evidence,closeAccount} from '../erasure-b2a/cases.mjs';
const bind=async(db,f)=>(await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
export async function batchCases(db,report){
 const first=await fixture(db);const same=[first];
 for(let i=0;i<2;i++){
  const draft=await rpc(db,'bill2_create_draft',first.actor);
  const payload={...first.payload,scope:{kind:'positioning_draft',draftId:draft}};
  const r=await rpc(db,'bill2_prepare',first.actor,randomUUID(),payload);
  same.push({...first,run:r.id,pre:r.preDeductId,payload,draft});
 }
 const ids=[];
 for(const f of same){await bind(db,f);await call(db,f);ids.push(f.run);}
 await closeAccount(db,first);
 let after=null;const found=[];
 do{
  const page=await rpc(db,'account_erasure_financial_batch',1,first.actor,after);
  found.push(...page.items.map(x=>x.runId));after=page.nextRunId;
 }while(after);
 assert.deepEqual(found,ids.sort(),'stable run pagination visits all candidates exactly once');
 const statuses=[
  ['BILLING_NO_PROVIDER_ID',{}],
  ['BILLING_EXPIRED',{expired:true}],
  ['BILLING_ATTEMPTS_EXHAUSTED',{attempts:3}],
  ['BILLING_CONFLICT',{conflict:true}],
  ['BILLING_LOOKUP_UNSUPPORTED',{unsupported:true}],
 ];
 for(const [reason,options]of statuses){
  const f=await fixture(db);const e=await bind(db,f);const c=await call(db,f);await closeAccount(db,f);
  if(reason!=='BILLING_NO_PROVIDER_ID')await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c,null));
  if(options.expired)await db.query("UPDATE bill2_runs SET deadline=clock_timestamp()-interval '25 hours' WHERE id=$1",[f.run]);
  if(options.attempts)for(let i=0;i<3;i++)assert.ok(await rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id));
  if(options.conflict)await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c,null,{providerId:'conflicting-id'}));
  if(options.unsupported)await db.query("UPDATE bill2_calls SET payload=jsonb_set(payload,'{lookupSupported}','false') WHERE id=$1",[c.id]);
  await rpc(db,'runtime_financial_recovery',f.actor,e,true);
  const page=await rpc(db,'account_erasure_financial_batch',20,f.actor,null);
  assert.equal(page.items.length,0,reason+' cannot starve actionable work');
  assert.equal(page.totalPending,1);assert.equal(page.reasons[reason],1);
  assert.equal(await rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id),null);
 }
 const recoverable=await fixture(db);const execution=await bind(db,recoverable);const c=await call(db,recoverable);
 await closeAccount(db,recoverable);await rpc(db,'bill2_record',recoverable.actor,recoverable.run,c.id,evidence(c,null));
 await rpc(db,'runtime_financial_recovery',recoverable.actor,execution,true);
 const page=await rpc(db,'account_erasure_financial_batch',20,recoverable.actor,null);
 assert.equal(page.items.length,1,'closed cost_pending with reliable ID stays discoverable');
 assert.equal(page.items[0].closed,true);assert.equal(page.items[0].executionState,'cost_pending');
 assert.deepEqual(page.items[0].recoveryPolicy.callPolicies[0],{
  modelId:recoverable.payload.callPolicy[0].modelId,provider:'fixture',account:'sandbox',model:'b2a-fixture',
  protocol:'fixture-cost-v1',upperUsd:'0.02',inputLimit:1000,outputLimit:1000,
  automaticRetry:false,hiddenTools:false,lookupSupported:true,
 });
 const before=(await db.query('SELECT recovery_attempts FROM bill2_calls WHERE id=$1',[c.id])).rows[0].recovery_attempts;
 await rpc(db,'account_erasure_financial_batch',20,recoverable.actor,null);
 assert.equal((await db.query('SELECT recovery_attempts FROM bill2_calls WHERE id=$1',[c.id])).rows[0].recovery_attempts,before,'enumeration never claims queries');
 report.checks.push('stable pagination; closed eligible lookup included; unavailable/exhausted/conflict/expired reported without starvation; discovery read-only');
 // The next account rotates by the existing request timestamp, never a new cursor table.
 const global=await rpc(db,'account_erasure_financial_batch',1,null,null);
 assert.ok(global.selectedActorId);await rpc(db,'account_erasure_note_error',global.selectedActorId,'BILLING_PENDING');
 const rotated=await rpc(db,'account_erasure_financial_batch',1,null,null);
 assert.notEqual(rotated.selectedActorId,global.selectedActorId);
 report.checks.push('existing erasure stage_updated_at rotates eligible accounts');
}

export async function inflightConcurrency({client,Client,connectionString,report}){
 const f=await fixture(client);const e=await bind(client,f);const c=await call(client,f);await closeAccount(client,f);
 const writers=[new Client({connectionString}),new Client({connectionString}),new Client({connectionString})];
 await Promise.all(writers.map(w=>w.connect()));
 try{
  await Promise.all(writers.map(w=>w.query("SET statement_timeout='10s'")));
  await Promise.all([
   rpc(writers[0],'runtime_financial_recovery',f.actor,e,true),
   rpc(writers[1],'bill2_record',f.actor,f.run,c.id,evidence(c,'0.001')),
   rpc(writers[2],'runtime_financial_recovery',f.actor,e,true),
  ]);
  await rpc(client,'runtime_financial_recovery',f.actor,e,true);
  assert.equal((await rpc(client,'bill2_read',f.actor,f.run)).state,'settled');
  const rows=(await client.query('SELECT reason_code,count(*) n FROM credit_transactions WHERE bill2_run_id=$1 GROUP BY reason_code',[f.run])).rows;
  assert.ok(rows.length>0);for(const r of rows)assert.equal(Number(r.n),1);
  report.checks.push('three-backend concurrent receipt/duplicate recovery: no deadlock, finalizes exactly once');
 }finally{await Promise.all(writers.map(w=>w.end()));}
}
