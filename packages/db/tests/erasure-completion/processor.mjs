/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closeAccount,fixture,call} from '../erasure-b2a/cases.mjs';
import {ready} from '../erasure-binding/cases.mjs';
export async function runProcessor(db,processAccountErasure,report){
 const database={async rpc(name,args){
  assert.match(name,/^[a-z_0-9]+$/);
  for(const key of Object.keys(args))assert.match(key,/^p_[a-z_0-9]+$/);
  await db.query('SET ROLE service_role');
  try{
   const values=Object.values(args);
   const params=Object.keys(args).map((key,i)=>`${key}=>$${i+1}`).join(',');
   const result=await db.query(`SELECT public.${name}(${params}) value`,values);
   return {data:result.rows[0].value,error:null};
  }catch(error){return {data:null,error:{code:error.code}};}
  finally{await db.query('RESET ROLE');}
 }};
 let removes=0,storageCalls=0;
 const absent=new Set();
 const adapters={database,storageAdapter:{async cleanSubject(){storageCalls++;return {complete:true,remaining:0,manualReview:0};}},
  authAdapter:{async getState(id){return absent.has(id)?'absent':'present';},async remove(id){removes++;absent.add(id);}},
  budget:{deadline:Date.now()+120000,operationTimeoutMs:5000}};
 const minimal={actor:randomUUID()};
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,37)',[minimal.actor]);await closeAccount(db,minimal);
 assert.deepEqual(await processAccountErasure({profileId:minimal.actor,...adapters}),
  {stage:'completed',retry:false,remaining:0,manualReview:0,errorCodes:[]});
 assert.equal(removes,1);assert.equal(storageCalls,1);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[minimal.actor])).rows[0].credits,37);
 const normal=await ready(db,{scrub:false});
 const balance=(await db.query('SELECT credits FROM profiles WHERE id=$1',[normal.actor])).rows[0].credits;
 const completed=await processAccountErasure({profileId:normal.actor,...adapters});
 assert.equal(completed.stage,'completed',JSON.stringify(completed));assert.equal(completed.retry,false);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[normal.actor])).rows[0].credits,balance);
 assert.equal((await db.query('SELECT count(*)::int n FROM runtime_sessions WHERE actor_id=$1',[normal.actor])).rows[0].n,0);
 assert.equal((await db.query('SELECT session_ref,erased_execution_id FROM bill2_runs WHERE id=$1',[normal.run])).rows[0].erased_execution_id,normal.execution);
 assert.equal(removes,2);
 const unknown=await fixture(db);const unknownCall=await call(db,unknown);await closeAccount(db,unknown);
 const originalBalance=(await db.query('SELECT credits FROM profiles WHERE id=$1',[unknown.actor])).rows[0].credits;
 const pending=await processAccountErasure({profileId:unknown.actor,...adapters});
 assert.equal(pending.retry,true);assert.notEqual(pending.stage,'completed');assert.ok(pending.remaining>0||pending.manualReview>0);
 assert.equal(removes,2,'unknown finance cannot reach Auth removal');
 const review=(await db.query('SELECT stage,review_codes,next_review_at FROM account_erasure_requests WHERE profile_id=$1',
  [unknown.actor])).rows[0];
 assert.equal(review.stage,'billing_pending');
 assert.ok(review.review_codes.includes('ERASURE_FINANCIAL_PENDING_REVIEW'),JSON.stringify(review));
 assert.ok(review.next_review_at,'missing provider/cost receives a durable review date');
 const callState=(await db.query('SELECT provider_id,selected_cost_usd FROM bill2_calls WHERE id=$1',[unknownCall.id])).rows[0];
 assert.equal(callState.provider_id,null);assert.equal(callState.selected_cost_usd,null);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[unknown.actor])).rows[0].credits,originalBalance);
 await processAccountErasure({profileId:unknown.actor,...adapters});
 const retryReview=(await db.query('SELECT next_review_at FROM account_erasure_requests WHERE profile_id=$1',[unknown.actor])).rows[0];
 assert.equal(retryReview.next_review_at.getTime(),review.next_review_at.getTime(),'daily retries cannot postpone review');
 report.checks.push('missing provider/cost: original money/identity retained, durable review and fixed due date, no Auth deletion');
 const uncertain={actor:randomUUID()};
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,19)',[uncertain.actor]);await closeAccount(db,uncertain);
 let uncertainRemoves=0,state='present';
 const authAdapter={async getState(){return state;},async remove(){
  uncertainRemoves++;
  const saved=(await db.query('SELECT review_codes,next_review_at FROM account_erasure_requests WHERE profile_id=$1',
   [uncertain.actor])).rows[0];
  assert.deepEqual(saved.review_codes,['ERASURE_AUTH_PENDING']);assert.ok(saved.next_review_at);
  state='unknown';throw new Error('synthetic transport uncertainty');
 }};
 const first=await processAccountErasure({profileId:uncertain.actor,...adapters,authAdapter});
 assert.ok(first.errorCodes.includes('ERASURE_AUTH_PENDING'));assert.equal(uncertainRemoves,1);
 state='present';
 const resumed=await processAccountErasure({profileId:uncertain.actor,...adapters,authAdapter});
 assert.ok(resumed.errorCodes.includes('ERASURE_AUTH_PENDING'));assert.equal(uncertainRemoves,1,'no second external deletion');
 state='absent';
 const recovered=await processAccountErasure({profileId:uncertain.actor,...adapters,authAdapter});
 assert.equal(recovered.stage,'completed',JSON.stringify(recovered));assert.equal(uncertainRemoves,1);
 const final=(await db.query('SELECT review_codes,next_review_at,progress_expires_at FROM account_erasure_requests WHERE profile_id=$1',
  [uncertain.actor])).rows[0];
 assert.deepEqual(final.review_codes,[]);assert.equal(final.next_review_at,null);assert.ok(final.progress_expires_at);
 report.checks.push('Auth uncertainty is persisted before dispatch; resumed intent reads only and clears review after absence proof');
 report.checks.push('actual TypeScript processor with real service-role RPCs: minimal and settled Runtime complete; unknown finance blocks Auth; money preserved');
}
