/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
export const rpc=async(db,name,...args)=>(await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
export const fixture=async db=>(await db.query('SELECT b2a_test.fixture() v')).rows[0].v;
export const closeAccount=(db,f)=>rpc(db,'account_erasure_confirm_with_digests',f.actor,randomUUID(),
 JSON.stringify([{kind:'email',key_version:'b2a_local_v1',digest:createHash('sha256').update(f.actor).digest('hex')}]));
export const call=async(db,f,n=1,dispatch=true)=>{
 const c=await rpc(db,'bill2_claim',f.actor,f.run,n,{provider:'fixture',account:'sandbox',model:'b2a-fixture',
  protocol:'fixture-cost-v1',phase:'reply',requestHash:'b'.repeat(64),upperUsd:'0.005',inputLimit:1000,outputLimit:1000,
  automaticRetry:false,hiddenTools:false,lookupSupported:true});
 if(dispatch)assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
 return c;
};
export const evidence=(c,cost='0.0001',extra={})=>({provider:'fixture',account:'sandbox',model:'b2a-fixture',
 protocol:'fixture-cost-v1',providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
 observedAt:'2026-09-30T00:00:00.000Z',coverage:'request_total',final:cost!==null,cost,currency:'USD',
 rawBody:'B2A_PRIVATE_CANARY',rawBodyBase64:'QjJBX1BSSVZBVEVfQ0FOQVJZ',
 transport:{rawBody:'B2A_PRIVATE_CANARY',rawBodyEncoding:'gzip-base64'},
 usage:{inputTokens:10,sdkResponse:{choices:[{message:{content:'B2A_PRIVATE_CANARY'}}]}},...extra});
export const outcome={kind:'usable_result',evidenceRef:'B2A_PRIVATE_CANARY',evidenceHash:'d'.repeat(64),
 body:'B2A_PRIVATE_CANARY',metadata:{nested:'B2A_PRIVATE_CANARY'}};
export async function cases(db,report){
 // Actual fresh roles, not metadata-only assertions. Private helpers cannot be invoked by service.
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(rpc(db,'bill2_read',randomUUID(),randomUUID()),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 await assert.rejects(rpc(db,'bill2_financial_projection',{}),/permission denied/);await db.query('RESET ROLE');
 report.checks.push('anon/authenticated RPC denied; service private-helper denied');
 const f=await fixture(db);const c=await call(db,f);const c2=await call(db,f,2);
 const e=evidence(c);await closeAccount(db,f);
 await db.query('SET ROLE service_role');
 const view=await rpc(db,'bill2_read',f.actor,f.run);assert.equal(view.accountClosed,true);assert.equal(view.scope,undefined);
 await assert.rejects(rpc(db,'bill2_read',randomUUID(),f.run),/RUN_DENIED/);
 await assert.rejects(rpc(db,'bill2_private_input',f.actor,f.run),/ACTOR_DENIED/);
 await assert.rejects(rpc(db,'bill2_prepare',f.actor,randomUUID(),f.payload),/ACTOR_DENIED/);
 await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,3,{}),/ACTOR_DENIED/);
 await assert.rejects(rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken),/ACTOR_DENIED/);
 await rpc(db,'bill2_record',f.actor,f.run,c.id,e);await rpc(db,'bill2_record',f.actor,f.run,c.id,e);
 await rpc(db,'bill2_record',f.actor,f.run,c2.id,evidence(c2));await db.query('RESET ROLE');
 const receipt=(await db.query('SELECT * FROM bill2_receipts WHERE call_id=$1',[c.id])).rows;
 assert.equal(receipt.length,1);assert.doesNotMatch(JSON.stringify(receipt),/B2A_PRIVATE_CANARY|QjJBX1BSSVZBVEVfQ0FOQVJZ|sdkResponse|rawBody|transport/);
 assert.equal(receipt[0].financial_projection_version,1);
 assert.equal((await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[e])).rows[0].h,receipt[0].payload_hash);
 assert.notEqual(receipt[0].financial_projection_hash,receipt[0].payload_hash);
 assert.deepEqual(receipt[0].payload.usage,{inputTokens:10});
 await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
 await rpc(db,'bill2_close',f.actor,f.run,'delivered',{...outcome,body:'different removed body'});
 await assert.rejects(rpc(db,'bill2_close',f.actor,f.run,'delivered',{...outcome,evidenceHash:'e'.repeat(64)}),/CLOSE_CONFLICT/);
 const run=(await db.query('SELECT result,result_financial_projection_hash FROM bill2_runs WHERE id=$1',[f.run])).rows[0];
 assert.doesNotMatch(JSON.stringify(run),/B2A_PRIVATE_CANARY/);assert.ok(run.result_financial_projection_hash);
 assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).chargedCredits,1,'aggregate two micro costs then round once');
 const ledger=JSON.stringify((await db.query('SELECT * FROM credit_transactions WHERE bill2_run_id=$1 ORDER BY id',[f.run])).rows);
 await rpc(db,'bill2_finalize',f.actor,f.run);assert.equal(JSON.stringify((await db.query('SELECT * FROM credit_transactions WHERE bill2_run_id=$1 ORDER BY id',[f.run])).rows),ledger);
 report.checks.push('closed original identity; admission denied; recursive projection/original hash/replay; exact aggregate once');
 // Original winning delivery closes execution even when result is absent; repeated recovery is harmless.
 const terminal=await fixture(db);const execution=(await db.query('SELECT b2a_test.bind($1) v',[terminal])).rows[0].v;
 const tc=await call(db,terminal);
 await rpc(db,'bill2_record',terminal.actor,terminal.run,tc.id,evidence(tc));
 await rpc(db,'bill2_close',terminal.actor,terminal.run,'delivered',outcome);
 await rpc(db,'bill2_finalize',terminal.actor,terminal.run);await closeAccount(db,terminal);
 for(let i=0;i<2;i++)assert.equal((await rpc(db,'runtime_financial_recovery',terminal.actor,execution,true)).state,'completed');
 assert.equal((await db.query('SELECT active_execution FROM runtime_sessions WHERE id=(SELECT session_id FROM runtime_executions WHERE id=$1)',[execution])).rows[0].active_execution,null);
 assert.equal((await db.query('SELECT result FROM runtime_executions WHERE id=$1',[execution])).rows[0].result,null);
 // The original scrub barrier is used in a separate transaction after financial completion.
 const scrub=await rpc(db,'account_erasure_scrub_runtime',terminal.actor);assert.notEqual(scrub.retry,true);
 assert.ok((await db.query('SELECT erased_at FROM runtime_executions WHERE id=$1',[execution])).rows[0].erased_at);
 assert.equal((await rpc(db,'runtime_financial_recovery',terminal.actor,execution,true)).state,'completed');
 report.checks.push('winning delivered outcome with missing result; execution terminal; B1b scrub and immutable replay');
 const unknown=await fixture(db);const uc=await call(db,unknown);await closeAccount(db,unknown);
 await rpc(db,'bill2_record',unknown.actor,unknown.run,uc.id,evidence(uc,null,{providerId:null}));
 await rpc(db,'bill2_cancel',unknown.actor,unknown.run);
 assert.equal((await rpc(db,'bill2_finalize',unknown.actor,unknown.run)).chargedCredits,null);
 assert.equal(await rpc(db,'bill2_recovery_claim',unknown.actor,unknown.run,uc.id),null);
 const ustate=(await db.query("SELECT p.credits,(SELECT count(*)::int FROM billing_history t WHERE t.metadata->>'preDeductId'=b.id::text) terminals FROM profiles p JOIN billing_history b ON b.user_id=p.id WHERE b.id=$1",[unknown.pre])).rows[0];
 assert.equal(ustate.credits,70);assert.equal(ustate.terminals,0);
 const pending=await fixture(db);const pc=await call(db,pending);await closeAccount(db,pending);
 await rpc(db,'bill2_record',pending.actor,pending.run,pc.id,evidence(pc,null));
 for(let n=0;n<3;n++) {
  assert.ok(await rpc(db,'bill2_recovery_claim',pending.actor,pending.run,pc.id));
  assert.equal(await rpc(db,'bill2_recovery_claim',pending.actor,pending.run,pc.id),null,'active recovery lease excludes overlap');
  await db.query("UPDATE bill2_calls SET rejection_recovery_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[pc.id]);
 }
 await db.query("UPDATE bill2_runs SET deadline=clock_timestamp()-interval '25 hours' WHERE id=$1",[pending.run]);
 assert.equal(await rpc(db,'bill2_recovery_claim',pending.actor,pending.run,pc.id),null);
 report.checks.push('unknown no ID retains reservation; reliable lookup lease excludes overlap and recovery deadline rejects expiry');
 const failure=await fixture(db);const fc=await call(db,failure);await closeAccount(db,failure);
 await rpc(db,'bill2_close',failure.actor,failure.run,'confirmed_failure',{...outcome,kind:'confirmed_delivery_failure'});
 assert.equal((await rpc(db,'bill2_finalize',failure.actor,failure.run)).state,'refunded');
 await rpc(db,'bill2_record',failure.actor,failure.run,fc.id,evidence(fc,'0.002'));
 assert.equal((await rpc(db,'bill2_finalize',failure.actor,failure.run)).chargedCredits,0);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[failure.actor])).rows[0].credits,100);
 const conflict=await fixture(db);const cc=await call(db,conflict);await closeAccount(db,conflict);
 await rpc(db,'bill2_record',conflict.actor,conflict.run,cc.id,evidence(cc));
 assert.equal((await rpc(db,'bill2_record',conflict.actor,conflict.run,cc.id,evidence(cc,'0.0002'))).conflict,true);
 await rpc(db,'bill2_close',conflict.actor,conflict.run,'delivered',outcome);
 assert.equal((await rpc(db,'bill2_finalize',conflict.actor,conflict.run)).chargedCredits,null);
 await assert.rejects(db.query('UPDATE bill2_receipts SET payload=payload WHERE call_id=$1',[cc.id]),/IMMUTABLE/);
 await assert.rejects(db.query('DELETE FROM bill2_receipts WHERE call_id=$1',[cc.id]),/IMMUTABLE/);
 report.checks.push('confirmed failure refunds once; late cost no re-debit; conflicting costs latch; immutable receipt unchanged');
 const unstarted=await fixture(db);const unstartedCall=await call(db,unstarted);
 // SQL-only fixture: permission was granted, no transport is invoked by this runner.
 await db.query("UPDATE bill2_calls SET provider='openrouter',payload=jsonb_set(payload,'{protocol}','\"openrouter-chat-v1\"') WHERE id=$1",
  [unstartedCall.id]);
 await closeAccount(db,unstarted);await rpc(db,'bill2_revoke_draft',unstarted.actor,unstarted.draft);
 const revoke=(actor=unstarted.actor,token=unstartedCall.dispatchToken,hash='b'.repeat(64))=>
  rpc(db,'bill2_revoke_unstarted_dispatch',actor,unstarted.run,unstartedCall.id,token,hash,false);
 await assert.rejects(revoke(randomUUID()),/RUN_DENIED/);
 await assert.rejects(revoke(unstarted.actor,randomUUID()),/UNSTARTED_DISPATCH_DENIED/);
 await assert.rejects(revoke(unstarted.actor,unstartedCall.dispatchToken,'a'.repeat(64)),/UNSTARTED_DISPATCH_DENIED/);
 assert.equal((await revoke()).revoked,true);assert.equal((await revoke()).revoked,true);
 assert.equal((await rpc(db,'bill2_read',unstarted.actor,unstarted.run)).state,'refunded');
 await assert.rejects(rpc(db,'bill2_record',unstarted.actor,unstarted.run,unstartedCall.id,evidence(unstartedCall)),/NOT_DISPATCHED/);
 report.checks.push('closed one-shot unstarted proof: exact actor/token/hash, revoked scope, once-only refund, no late record');
 const malformed=await fixture(db);const mc=await call(db,malformed);await closeAccount(db,malformed);
 for(const extra of [{currency:{private:'B2A_PRIVATE_CANARY'}},{currency:'B2A_PRIVATE_CANARY'},
  {evidenceKind:'B2A_PRIVATE_CANARY'},{usage:{inputTokens:{private:'B2A_PRIVATE_CANARY'}}}]){
  if(typeof extra.usage==='object'){
   await rpc(db,'bill2_record',malformed.actor,malformed.run,mc.id,evidence(mc,null,extra));
  }else await assert.rejects(rpc(db,'bill2_record',malformed.actor,malformed.run,mc.id,evidence(mc,null,extra)),/INVALID_FINANCIAL_PROJECTION/);
 }
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[mc.id])).rows),/B2A_PRIVATE_CANARY/);
 report.checks.push('typed nested financial whitelist rejects disguised content and drops malformed usage');
 const banned=await fixture(db);await db.query("UPDATE profiles SET status='suspended' WHERE id=$1",[banned.actor]);
 await assert.rejects(rpc(db,'bill2_read',banned.actor,banned.run),/ACTOR_DENIED/);
 assert.equal((await rpc(db,'bill2_close',banned.actor,banned.run,'delivered',outcome)).accountClosed,undefined);
 await assert.rejects(rpc(db,'bill2_revoke_unstarted_dispatch',banned.actor,banned.run,randomUUID(),randomUUID(),'b'.repeat(64),true),/ACTOR_DENIED/);
 report.checks.push('ordinary suspension without erasure cannot use the new exception');
}
