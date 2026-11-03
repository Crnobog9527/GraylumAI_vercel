/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closeAccount} from '../erasure-b2a/cases.mjs';
import {recordLibraryProof} from './library-proof.mjs';
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
 await recordLibraryProof(db,minimal);
 assert.deepEqual(await processAccountErasure({profileId:minimal.actor,...adapters}),
  {stage:'completed',retry:false,remaining:0,manualReview:0,errorCodes:[]});
 assert.equal(removes,1);assert.equal(storageCalls,1);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[minimal.actor])).rows[0].credits,37);
 // (V2-12 F: the settled-Runtime and unknown-finance cases built old runs; a turn with an unknown cost is erased in turn-erasure.)
 const uncertain={actor:randomUUID()};
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,19)',[uncertain.actor]);await closeAccount(db,uncertain);
 await recordLibraryProof(db,uncertain);
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
 report.checks.push('actual TypeScript processor with real service-role RPCs: a minimal account completes; Auth uncertainty is persisted; money preserved');
}
