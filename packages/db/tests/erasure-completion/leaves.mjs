/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ready,detach} from '../erasure-binding/cases.mjs';
import {rpc,fixture,call,evidence,closeAccount,outcome} from '../erasure-b2a/cases.mjs';
import {scrub,insertUsage,row} from '../erasure-ledger/cases.mjs';

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

 const f=await ready(db,{version:'v1'});
 await scrubMoney(db,f);
 assert.deepEqual(await detach(db,f),{processed:1,remaining:0});
 const before=await money(db,f);
 const runBefore=await row(db,'bill2_runs',f.run),callBefore=await row(db,'bill2_calls',f.call.id);
 const receiptsBefore=(await db.query('SELECT * FROM bill2_receipts WHERE call_id=$1 ORDER BY id',[f.call.id])).rows;
 await cleanup(db,f);
 assert.equal(await count(db,'runtime_executions','id',f.execution),0);
 assert.equal(await count(db,'runtime_sessions','id',f.session),0);
 assert.equal(await rpc(db,'runtime_receipt_saved',f.actor,f.execution,f.run,f.call.id,f.evidence),true);
 assert.equal((await rpc(db,'runtime_financial_recovery',f.actor,f.execution,true)).state,f.terminal);
 await rpc(db,'bill2_record',f.actor,f.run,f.call.id,f.evidence);
 assert.equal(await rpc(db,'runtime_receipt_saved',f.actor,f.execution,f.run,f.call.id,{...f.evidence,cost:'0.5'}),false);
 await assert.rejects(rpc(db,'runtime_receipt_saved',f.actor,randomUUID(),f.run,f.call.id,f.evidence),/BINDING_DENIED/);
 assert.deepEqual(await money(db,f),before);
 assert.deepEqual(await row(db,'bill2_runs',f.run),runBefore);
 assert.deepEqual(await row(db,'bill2_calls',f.call.id),callBefore);
 assert.deepEqual((await db.query('SELECT * FROM bill2_receipts WHERE call_id=$1 ORDER BY id',[f.call.id])).rows,receiptsBefore);
 report.checks.push('0187 detach then 0192 cleanup deletes runtime; original receipt/recovery/replay accepted; money and run/call/receipt identities unchanged');

 // ready() returns a closed subject. Seed history through its same real fixture/bind
 // before closing, so the test never bypasses a closed-account content admission guard.
 const history=await fixture(db);
 history.execution=(await db.query('SELECT b2a_test.bind($1) v',[history])).rows[0].v;
 history.session=(await row(db,'runtime_executions',history.execution)).session_id;
 await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
  VALUES($1,1,$2,'{"body":"PRIVATE"}')`,[history.session,history.execution]);
 await db.query(`INSERT INTO runtime_session_batches(session_id,execution_id,batch,items,start_revision,end_revision)
  VALUES($1,$2,0,'[{"body":"PRIVATE"}]',0,1)`,[history.session,history.execution]);
 history.call=await call(db,history);history.evidence=evidence(history.call,'0.0001');
 await closeAccount(db,history);
 await rpc(db,'bill2_record',history.actor,history.run,history.call.id,history.evidence);
 await rpc(db,'bill2_close',history.actor,history.run,'delivered',outcome);
 await rpc(db,'runtime_financial_recovery',history.actor,history.execution,true);
 await scrubRuntime(db,history);
 await rpc(db,'account_erasure_scrub_run',history.actor,history.run);
 await rpc(db,'account_erasure_scrub_calls',history.actor,history.run);
 await rpc(db,'account_erasure_scrub_receipts',history.actor,history.run,100);
 await scrubMoney(db,history);
 assert.deepEqual(await detach(db,history),{processed:1,remaining:0});
 const historyMoney=await money(db,history);
 await cleanup(db,history);
 for(const table of ['runtime_session_history','runtime_session_batches'])
  assert.equal(await count(db,table,'session_id',history.session),0);
 assert.equal(await count(db,'runtime_sessions','id',history.session),0);
 assert.equal(await rpc(db,'runtime_receipt_saved',history.actor,history.execution,history.run,history.call.id,history.evidence),true);
 assert.deepEqual(await money(db,history),historyMoney);

 const unknown=await ready(db,{settle:false,version:'v1'});
 const unknownRun=await row(db,'bill2_runs',unknown.run),unknownSession=await row(db,'runtime_sessions',unknown.session);
 const unknownExecution=await row(db,'runtime_executions',unknown.execution),unknownMoney=await money(db,unknown);
 assert.equal((await detach(db,unknown)).reason,'billing_pending');
 assert.ok((await cleanup(db,unknown)).remaining>0);
 assert.deepEqual(await row(db,'bill2_runs',unknown.run),unknownRun);
 assert.deepEqual(await row(db,'runtime_sessions',unknown.session),unknownSession);
 assert.deepEqual(await row(db,'runtime_executions',unknown.execution),unknownExecution);
 assert.deepEqual(await money(db,unknown),unknownMoney);
 report.checks.push('runtime history/batches physically removed after scrub/detach; unknown-finance run/session/execution and money retained');

 const chat=await conversation(db),message=randomUUID(),token=randomUUID();
 await db.query("INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'assistant','PRIVATE')",[message,chat.conversation]);
 await db.query(`INSERT INTO token_stats(id,user_id,conversation_id,message_id,model_used,input_tokens,output_tokens,
  total_cost_usd,total_credits,metadata) VALUES($1,$2,$3,$4,'synthetic',3,4,0.000123,1,'{"body":"PRIVATE"}')`,
 [token,chat.actor,chat.conversation,message]);
 const usage=await insertUsage(db,chat.actor);
 await db.query('UPDATE ai_usage_logs SET conversation_id=$2 WHERE id=$1',[usage,chat.conversation]);
 await closeAccount(db,chat);await scrubRuntime(db,chat);await scrubMoney(db,chat);
 const tokenBefore=await row(db,'token_stats',token),usageBefore=await row(db,'ai_usage_logs',usage);
 const chatBalance=(await row(db,'profiles',chat.actor)).credits;
 assert.ok(tokenBefore.content_erased_at);assert.ok(usageBefore.content_erased_at);
 assert.deepEqual(await cleanup(db,chat),{remaining:0,manualReview:0,errors:[]});
 assert.equal(await count(db,'conversations','id',chat.conversation),0);
 assert.equal(await count(db,'messages','id',message),0);
 assert.deepEqual(await row(db,'token_stats',token),{...tokenBefore,conversation_id:null,message_id:null,erased_conversation_id:chat.conversation,erased_message_id:message});
 await assert.rejects(db.query('UPDATE token_stats SET erased_conversation_id=$2 WHERE id=$1',[token,randomUUID()]),/ERASURE_USAGE_IDENTITY_DENIED/);
 await assert.rejects(db.query('UPDATE token_stats SET conversation_id=$2 WHERE id=$1',[token,chat.conversation]),/ERASURE_USAGE_IDENTITY_DENIED/);
 assert.deepEqual(await row(db,'ai_usage_logs',usage),{...usageBefore,conversation_id:null});
 assert.equal((await row(db,'profiles',chat.actor)).credits,chatBalance);
 const lateLog=await db.query(`INSERT INTO application_logs(level,category,message,user_id)
  VALUES('info','auth','PRIVATE',$1)`,[chat.actor]);
 assert.equal(lateLog.rowCount,0,'late diagnostic body cannot refill a closed subject');
 report.checks.push('chat pruning severs only nullable usage links; token/usage rows and all monetary fields survive conversation/message deletion');

 const pending=await conversation(db),requestId=randomUUID(),writer=randomUUID();
 await db.query(`INSERT INTO ordinary_chat_requests(request_id,user_id,conversation_id,writer_token,input,state)
  VALUES($1,$2,$3,$4,'{"message":"PRIVATE"}','running')`,[requestId,pending.actor,pending.conversation,writer]);
 await closeAccount(db,pending);await scrubRuntime(db,pending);
 const pendingBefore=(await db.query('SELECT * FROM ordinary_chat_requests WHERE request_id=$1',[requestId])).rows[0];
 assert.equal(pendingBefore.erased_at,null);
 assert.equal((await db.query('DELETE FROM conversations WHERE id=$1',[pending.conversation])).rowCount,0,
  'existing ordinary request delete guard still refuses parent deletion');
 assert.ok((await cleanup(db,pending)).remaining>0);
 assert.equal(await count(db,'conversations','id',pending.conversation),1);
 assert.deepEqual((await db.query('SELECT * FROM ordinary_chat_requests WHERE request_id=$1',[requestId])).rows[0],pendingBefore);
 report.checks.push('pending ordinary request and recovery context retained; original parent-delete guard not bypassed');

 const batch=await conversation(db);
 await db.query(`INSERT INTO messages(conversation_id,role,content)
  SELECT $1,'user','PRIVATE' FROM generate_series(1,101)`,[batch.conversation]);
 await closeAccount(db,batch);await scrubRuntime(db,batch);
 assert.ok((await cleanup(db,batch)).remaining>0);
 assert.equal(await count(db,'messages','conversation_id',batch.conversation),1,'one invocation deletes at most 100 business leaves');
 assert.equal(await count(db,'conversations','id',batch.conversation),1);
 assert.deepEqual(await cleanup(db,batch),{remaining:0,manualReview:0,errors:[]});
 assert.equal(await count(db,'conversations','id',batch.conversation),0);
 assert.deepEqual(await cleanup(db,batch),{remaining:0,manualReview:0,errors:[]});
 report.checks.push('101 message leaves: first bounded batch remains pending, repeated cleanup reaches zero and is idempotent');
}
