/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {scrub,insertUsage,row} from '../erasure-ledger/cases.mjs';
import {recordLibraryProof} from './library-proof.mjs';

const cleanup=(db,f)=>rpc(db,'account_erasure_local_cleanup',f.actor,true);
const count=async(db,table,column,id)=>(await db.query(
 `SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`,[id])).rows[0].n;
const money=async(db,f)=>(await db.query(`SELECT
 (SELECT credits FROM profiles WHERE id=$1) credits,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_transactions t WHERE user_id=$1) ledger,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_history t WHERE user_id=$1) history`,[f.actor])).rows[0];
const scrubMoney=async(db,f)=>{
 for(const table of ['credit_transactions','billing_history','token_stats','ai_usage_logs'])await scrub(db,f.actor,table);
};
const conversation=async db=>{
 const f={actor:randomUUID(),conversation:randomUUID()};
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,73)',[f.actor]);
 await db.query("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'PRIVATE')",[f.conversation,f.actor]);
 return f;
};
const scrubRuntime=(db,f)=>rpc(db,'account_erasure_scrub_runtime',f.actor);

export async function runLeaves(db,report){
 const open=await conversation(db);
 await assert.rejects(rpc(db,'account_erasure_prune_business',open.actor,100),/ACCOUNT_ERASURE_NOT_CLOSED/);
 for(const role of ['anon','authenticated','service_role']){
  await db.query('SET ROLE '+role);
  try{await assert.rejects(rpc(db,'account_erasure_prune_business',open.actor,100),/permission denied/);}
  finally{await db.query('RESET ROLE');}
 }
 await closeAccount(db,open);
 assert.ok((await cleanup(db,open)).remaining>0);
 assert.equal(await count(db,'conversations','id',open.conversation),1,'unmarked body cannot be pruned');
 assert.equal((await row(db,'conversations',open.conversation)).title,'PRIVATE');
 for(const limit of [null,0,101])await assert.rejects(
  rpc(db,'account_erasure_prune_business',open.actor,limit),/ERASURE_BATCH_LIMIT_INVALID/);
 report.checks.push('business prune is internal, closed-subject-only, bounded; unmarked body retained');

 // (V2-12 F: the detach / cleanup of an old run's runtime rows and the removal of runtime history and batches went with those tables;
 // the turn path's equivalents are turn-erasure's 14 blocks.)

 const chat=await conversation(db),message=randomUUID(),token=randomUUID();
 await db.query("INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'assistant','PRIVATE')",[message,chat.conversation]);
 await db.query(`INSERT INTO token_stats(id,user_id,conversation_id,message_id,model_used,input_tokens,output_tokens,
  total_cost_usd,total_credits,metadata) VALUES($1,$2,$3,$4,'synthetic',3,4,0.000123,1,'{"body":"PRIVATE"}')`,
 [token,chat.actor,chat.conversation,message]);
 const snapshot=randomUUID();
 await db.query(`INSERT INTO conversation_context_snapshots(id,conversation_id,snapshot_type,content,
  source_message_start_id,source_message_end_id) VALUES($1,$2,'rolling_summary','PRIVATE',$3,$3)`,
  [snapshot,chat.conversation,message]);
 const usage=await insertUsage(db,chat.actor);
 await db.query('UPDATE ai_usage_logs SET conversation_id=$2 WHERE id=$1',[usage,chat.conversation]);
 await closeAccount(db,chat);await scrubRuntime(db,chat);await scrubMoney(db,chat);
 await assert.rejects(db.query('DELETE FROM messages WHERE id=$1',[message]),/ERASED|ERASURE|immutable/i,
  'erased snapshot SET NULL must refuse the wrong deletion order');
 const tokenBefore=await row(db,'token_stats',token),usageBefore=await row(db,'ai_usage_logs',usage);
 const chatBalance=(await row(db,'profiles',chat.actor)).credits;
 assert.ok(tokenBefore.content_erased_at);assert.ok(usageBefore.content_erased_at);
 await recordLibraryProof(db,chat);
 assert.deepEqual(await cleanup(db,chat),{remaining:0,manualReview:0,errors:[]});
 assert.equal(await count(db,'conversations','id',chat.conversation),0);
 assert.equal(await count(db,'messages','id',message),0);
 assert.equal(await count(db,'conversation_context_snapshots','id',snapshot),0,'snapshot removed before message');
 assert.deepEqual(await row(db,'token_stats',token),{...tokenBefore,conversation_id:null,message_id:null,erased_conversation_id:chat.conversation,erased_message_id:message});
 await assert.rejects(db.query('UPDATE token_stats SET erased_conversation_id=$2 WHERE id=$1',[token,randomUUID()]),/ERASURE_USAGE_IDENTITY_DENIED/);
 await assert.rejects(db.query('UPDATE token_stats SET conversation_id=$2 WHERE id=$1',[token,chat.conversation]),/ERASURE_USAGE_IDENTITY_DENIED/);
 assert.deepEqual(await row(db,'ai_usage_logs',usage),{...usageBefore,conversation_id:null});
 assert.equal((await row(db,'profiles',chat.actor)).credits,chatBalance);
 const lateLog=await db.query(`INSERT INTO application_logs(level,category,message,user_id)
  VALUES('info','auth','PRIVATE',$1)`,[chat.actor]);
 assert.equal(lateLog.rowCount,0,'late diagnostic body cannot refill a closed subject');
 report.checks.push('chat pruning severs only nullable usage links; token/usage rows and all monetary fields survive conversation/message deletion');

 // LEGACY-CLOSE 0271 dropped three legacy chat tables, the ordinary chat settlement function and the conversations
 // delete guard; cleanup must not depend on any of them.
 const legacy=(await db.query(`SELECT
  to_regclass('public.ordinary_chat_requests') IS NULL
  AND to_regclass('public.agent_confirmed_preferences') IS NULL AND to_regclass('public.agent_preference_requests') IS NULL
  AND to_regprocedure('public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb)') IS NULL
  AND to_regprocedure('public.ordinary_chat_delete_guard()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='ordinary_chat_delete') AS gone`)).rows[0].gone;
 assert.equal(legacy,true,'0271 legacy chat tables, settlement function and delete guard are gone');
 report.checks.push('0271: legacy chat tables, ordinary_chat_transition and the conversations delete guard are gone');

 const batch=await conversation(db);
 await db.query(`INSERT INTO messages(conversation_id,role,content)
  SELECT $1,'user','PRIVATE' FROM generate_series(1,101)`,[batch.conversation]);
 await closeAccount(db,batch);await scrubRuntime(db,batch);
 assert.ok((await cleanup(db,batch)).remaining>0);
 assert.equal(await count(db,'messages','conversation_id',batch.conversation),1,'one invocation deletes at most 100 business leaves');
 assert.equal(await count(db,'conversations','id',batch.conversation),1);
 await recordLibraryProof(db,batch);
 assert.deepEqual(await cleanup(db,batch),{remaining:0,manualReview:0,errors:[]});
 assert.equal(await count(db,'conversations','id',batch.conversation),0);
 assert.deepEqual(await cleanup(db,batch),{remaining:0,manualReview:0,errors:[]});
 report.checks.push('101 message leaves: first bounded batch remains pending, repeated cleanup reaches zero and is idempotent');
}
