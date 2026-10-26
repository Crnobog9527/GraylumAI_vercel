/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ready,detach} from '../erasure-binding/cases.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';

// 0395 (staging 10-25): account_erasure_prune_business swallowed a foreign-key failure with NULL, so a request stayed
// 'erasing' for 12 hours with empty executor_error_codes. A row that cannot be deleted must leave a fixed code
// (SQLSTATE + table) on the executor round, while the rest of the pass continues and completion is judged as before.
export async function runPruneDiagnostics(db,report) {
 await db.query(`CREATE TABLE IF NOT EXISTS public.prune_diagnostics_block(
  conversation_id uuid NOT NULL REFERENCES public.conversations(id))`);
 // A closed account refuses new rows (ERASURE_INSERT_DENIED); stand in for a scrubbed row left from before closure.
 const conversation=async f=>{await db.query("SET session_replication_role=replica");
  try{return (await db.query(`INSERT INTO conversations(user_id,title,erased_at)
   VALUES($1,NULL,clock_timestamp()) RETURNING id`,[f.actor])).rows[0].id;}
  finally{await db.query("SET session_replication_role=DEFAULT");}};
 const exists=async id=>(await db.query('SELECT count(*)::int n FROM conversations WHERE id=$1',[id])).rows[0].n===1;
 const request=async f=>(await db.query(`SELECT request_id,stage,review_codes,local_cleaned_at,executor_error_codes
  FROM account_erasure_requests WHERE profile_id=$1`,[f.actor])).rows[0];
 // An executor claim resets the round's codes (account_erasure_executor_claim); the test does the same directly.
 const claim=async f=>{const token=randomUUID();
  await db.query(`UPDATE account_erasure_requests SET executor_token=$2,executor_started_at=clock_timestamp(),
   executor_error_codes=ARRAY['ERASURE_EXECUTOR_RUNNING'] WHERE profile_id=$1`,[f.actor,token]);return token;};
 const prune=async f=>{let removed=0;for(let i=0;i<3;i++)removed+=await rpc(db,'account_erasure_prune_business',f.actor,100);return removed;};
 const code='ERASURE_PRUNE_23503_CONVERSATIONS';

 const stuck=await ready(db,{version:'v1'});await detach(db,stuck);
 const blocked=await conversation(stuck),free=await conversation(stuck);
 await db.query('INSERT INTO prune_diagnostics_block VALUES($1)',[blocked]);
 const token=await claim(stuck);const before=await request(stuck);
 assert.ok(await prune(stuck)>0,'the rest of the pass still deletes');
 assert.equal(await exists(blocked),true,'the undeletable row stays (no cascade or bypass)');
 assert.equal(await exists(free),false,'a deletable row of the same table is still deleted');
 const after=await request(stuck);
 assert.ok(after.executor_error_codes.includes(code),'blocked delete leaves its code: '+JSON.stringify(after.executor_error_codes));
 assert.ok(after.executor_error_codes.includes('ERASURE_EXECUTOR_RUNNING'),'existing round codes kept');
 assert.deepEqual({stage:after.stage,review:after.review_codes,cleaned:after.local_cleaned_at},
  {stage:before.stage,review:before.review_codes,cleaned:before.local_cleaned_at},'completion facts unchanged');
 // The executor's finish replaces the round's codes with the processor's; the database-side prune code survives it.
 const finish=await rpc(db,'account_erasure_executor_finish',stuck.actor,after.request_id,token,['ERASURE_LOCAL_PENDING'],true);
 assert.deepEqual(finish,{recorded:true});
 assert.deepEqual((await request(stuck)).executor_error_codes,['ERASURE_LOCAL_PENDING',code],'finish keeps the prune code');
 // A later round that can delete the row no longer reports it.
 await db.query('DELETE FROM prune_diagnostics_block WHERE conversation_id=$1',[blocked]);
 const next=await claim(stuck);await prune(stuck);
 assert.equal(await exists(blocked),false);
 await rpc(db,'account_erasure_executor_finish',stuck.actor,after.request_id,next,[],true);
 assert.deepEqual((await request(stuck)).executor_error_codes,[],'resolved block leaves no code');

 // Without a blocked row nothing is reported.
 const clean=await ready(db,{version:'v1'});await detach(db,clean);await conversation(clean);
 await claim(clean);await prune(clean);
 assert.deepEqual((await request(clean)).executor_error_codes,['ERASURE_EXECUTOR_RUNNING'],'no failure, no prune code');
 await db.query('DROP TABLE prune_diagnostics_block');
 report.checks.push('0395: an undeletable business row leaves ERASURE_PRUNE_<SQLSTATE>_<TABLE> on the executor round; rest of pass and completion unchanged');
}
