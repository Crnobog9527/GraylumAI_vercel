/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc,closeAccount,call as v1Call,evidence as v1Evidence} from '../erasure-b2a/cases.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';

export const CANARY='LEDGER_PRIVATE_CANARY';
export const scrub=(db,actor,table,limit=100,after=null)=>
 rpc(db,'account_erasure_scrub_ledger',actor,table,limit,after);
export const row=async(db,table,id)=>(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
export async function insertUsage(db,actor,id=randomUUID(),metadata={body:CANARY}){
 await db.query(`INSERT INTO ai_usage_logs(id,user_id,model_id,status,error_message,ip_address,user_agent,metadata)
 VALUES($1,$2,'synthetic-model','failed',$3,'127.0.0.1',$3,$4)`,[id,actor,CANARY,metadata]);
 return id;
}
const providerUsage={promptTokens:3,completionTokens:'4',totalTokens:7,toolUsePromptTokens:0,cachedTokens:null,
 cacheWriteTokens:0,reasoningTokens:1,source:'provider_usage',providerResponseId:'synthetic-response',
 openRouterCost:{totalUsd:'0.001',upstreamInferenceUsd:'0.0007',upstreamPromptUsd:null,
 upstreamCompletionUsd:'0.0005',serverToolUsd:'0',searchUsd:'0',isByok:false}};
const pricing={modelId:'model',providerModel:'synthetic-model',inputPer1M:'0.125',reservedCredits:30,
 inputTokens:3,maxTokens:1000,rates:{inputPer1M:'0.125',outputPer1M:1,cacheCreationPer1M:null},
 settings:{creditsPerUsd:1000,tokenPriceMultiplier:'1.5',minPreDeduct:1,maxPreDeduct:30,safetyMargin:'0.1'},
 pricing:{inputPer1M:'0.125',outputPer1M:1,cacheReadPer1M:0}};
const evidence={inputTokens:3,outputTokens:'4',cacheReadTokens:0,cacheCreationTokens:null,
 credits:1,costUsd:'0.001',providerId:'synthetic-provider',outcome:'responded',usageEvidence:providerUsage};
const safe={preDeductId:'synthetic-pre',requestId:'synthetic-request',balance_before:100,balance_after:'70',
 requestedRefundAmount:'30.000',refundAmount:20,requestedDifference:30,difference:'20',actualRestore:20,
 intercepted:10,refundInterceptedRestoration:10,refundInterceptedOverrun:'2',providerCostUsd:null,
 consumedTokens:{inputTokens:3,outputTokens:'4'},
 billingSettingsSnapshot:{creditsPerUsd:1000,tokenPriceMultiplier:'1.5',minPreDeduct:1,maxPreDeduct:30,safetyMargin:'0.1'},
 provider_usage:providerUsage,evidence,
 search_evidence:{requested:true,available:true,executed:true,queryCount:2,providerUnits:'2',
 surchargeUnits:2,surchargeCredits:1,status:'verified',providerUnit:'search-query'},
 generationId:'synthetic-generation',executionId:'synthetic-execution',
 agentKeyCost:{unit:'agentkey-credit',quoted:'2',actual:null,status:'unknown'},
 usage:{inputTokens:3,output_tokens:'4',prompt_tokens_details:{cached_tokens:0},
 agentKeyCost:{unit:'agentkey-credit',quoted:2,actual:'1',status:'reported'},
 pricing,usageEvidence:providerUsage,generationId:'synthetic-generation',executionId:'synthetic-execution'},pricing};
const dirtyProvider={...providerUsage,body:CANARY,openRouterCost:{...providerUsage.openRouterCost,body:CANARY}};
const dirtyPricing={...pricing,body:CANARY,rates:{...pricing.rates,body:CANARY},
 settings:{...pricing.settings,body:CANARY},pricing:{...pricing.pricing,body:CANARY}};
const dirty={...safe,body:CANARY,nested:{body:CANARY},usage:{...safe.usage,sdkResponse:{choices:[{content:CANARY}]},
 prompt_tokens_details:{cached_tokens:0,body:CANARY},pricing:dirtyPricing,usageEvidence:dirtyProvider,
 agentKeyCost:{...safe.usage.agentKeyCost,body:CANARY}},agentKeyCost:{...safe.agentKeyCost,body:CANARY},
 pricing:dirtyPricing,provider_usage:dirtyProvider,evidence:{...evidence,body:CANARY,usageEvidence:dirtyProvider},
 search_evidence:{...safe.search_evidence,queries:[CANARY],sources:[{url:CANARY}],suggestionsHtml:CANARY},
 consumedTokens:{...safe.consumedTokens,body:CANARY},
 billingSettingsSnapshot:{...safe.billingSettingsSnapshot,body:CANARY}};
const financial=(value,cols)=>Object.fromEntries(Object.entries(value).filter(([k])=>!cols.includes(k)));

export async function runCases(db,report){
 const f=await fixture(db),other=await fixture(db);
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  try{
   await assert.rejects(scrub(db,f.actor,'ai_usage_logs'),/permission denied/);
   await assert.rejects(rpc(db,'erasure_ledger_metadata',{}),/permission denied/);
   await assert.rejects(rpc(db,'erasure_ledger_value',{},{}),/permission denied/);
  }
  finally{await db.query('RESET ROLE');}
 }
 await db.query('SET ROLE service_role');
 try{
  assert.deepEqual(await rpc(db,'erasure_ledger_metadata',dirty),safe);
  assert.deepEqual(await rpc(db,'erasure_ledger_value',{amount:'2',body:CANARY},{amount:'number'}),{amount:'2'});
 }
 finally{await db.query('RESET ROLE');}
 await assert.rejects(scrub(db,f.actor,'ai_usage_logs'),/ACCOUNT_ERASURE_NOT_CLOSED/);
 for(const name of [null,'profiles','ai_usage_logs; DROP TABLE profiles;--']){
  await assert.rejects(scrub(db,f.actor,name),/ERASURE_LEDGER_TABLE_DENIED/);
 }
 for(const limit of [null,0,101])await assert.rejects(scrub(db,f.actor,'ai_usage_logs',limit),/ERASURE_BATCH_LIMIT_INVALID/);
 report.checks.push('ledger RPC/helper deny clients; pure projection allows service; open accounts, injection and bounds denied');

 const credit=(await db.query('SELECT id FROM credit_transactions WHERE user_id=$1 ORDER BY id LIMIT 1',[f.actor])).rows[0].id;
 await db.query('UPDATE credit_transactions SET description=$2,metadata=$3 WHERE id=$1',[credit,CANARY,dirty]);
 await db.query('UPDATE billing_history SET reason=$2,metadata=metadata||$3::jsonb WHERE id=$1',[f.pre,CANARY,dirty]);
 const conv=randomUUID(),token=randomUUID();
 await db.query("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'synthetic')",[conv,f.actor]);
 await db.query(`INSERT INTO token_stats(id,user_id,conversation_id,model_used,input_tokens,output_tokens,
 total_cost_usd,total_credits,metadata) VALUES($1,$2,$3,'synthetic',3,4,0.000123,1,$4)`,[token,f.actor,conv,dirty]);
 const usage=await insertUsage(db,f.actor,undefined,dirty),foreign=await insertUsage(db,other.actor,undefined,dirty);
 const untouched=await row(db,'ai_usage_logs',foreign);
 const specs=[['credit_transactions',credit,['description','metadata','content_erased_at']],
  ['billing_history',f.pre,['reason','metadata','content_erased_at']],
  ['token_stats',token,['metadata','content_erased_at']],
  ['ai_usage_logs',usage,['error_message','ip_address','user_agent','metadata','content_erased_at']]];
 const before=await Promise.all(specs.map(([table,id])=>row(db,table,id)));
 await closeAccount(db,f);
 for(let i=0;i<specs.length;i++){
  const [table,id,cols]=specs[i];
  await db.query('SET ROLE service_role');
  let result;try{result=await scrub(db,f.actor,table);}finally{await db.query('RESET ROLE');}
  assert.ok(result.processed>=1);assert.equal(result.manualReview,0);assert.equal(result.remaining,0);
  const after=await row(db,table,id);
  assert.ok(after.content_erased_at);assert.doesNotMatch(JSON.stringify(after),/LEDGER_PRIVATE_CANARY/);
  assert.deepEqual(financial(after,cols),financial(before[i],cols),'amount, classifications, bindings and timestamps unchanged');
  for(const [key,value] of Object.entries(safe))assert.deepEqual(after.metadata[key],value,key);
  const repeated=await scrub(db,f.actor,table);assert.equal(repeated.processed,0);assert.equal(repeated.remaining,0);
  assert.deepEqual(await row(db,table,id),after,'replay does not alter marker or financial fields');
  await assert.rejects(db.query(`UPDATE ${table} SET content_erased_at=NULL WHERE id=$1`,[id]),/ERASURE_LEDGER_IMMUTABLE/);
 }
 assert.deepEqual(await row(db,'ai_usage_logs',foreign),untouched);
 report.checks.push('all four tables recursively scrub private content; original financial fields/types and normalized classification unchanged; replay and actor isolation');

 await db.query('UPDATE ai_usage_logs SET metadata=$2,error_message=$3 WHERE id=$1',[usage,dirty,CANARY]);
 const late=await row(db,'ai_usage_logs',usage);assert.deepEqual(late.metadata,safe);assert.equal(late.error_message,null);
 const lateId=await insertUsage(db,f.actor,undefined,dirty);
 assert.deepEqual((await row(db,'ai_usage_logs',lateId)).metadata,safe);
 assert.ok((await row(db,'ai_usage_logs',lateId)).content_erased_at);
 let serviceLateId;
 // Disposable fixture only: the file-built baseline does not install platform table ACLs.
 // Add only missing privileges needed to exercise the actual invoker trigger, then restore them.
 const grants=[];
 for(const [table,privilege] of [['ai_usage_logs','INSERT'],['profiles','SELECT'],['account_erasure_requests','SELECT']]){
  const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) ok',['service_role',table,privilege])).rows[0].ok;
  if(!allowed){await db.query(`GRANT ${privilege} ON ${table} TO service_role`);grants.push([table,privilege]);}
 }
 try{
  await db.query('SET ROLE service_role');
  try{serviceLateId=await insertUsage(db,f.actor,undefined,dirty);}
  finally{await db.query('RESET ROLE');}
 }finally{for(const [table,privilege] of grants)await db.query(`REVOKE ${privilege} ON ${table} FROM service_role`);}
 const serviceLate=await row(db,'ai_usage_logs',serviceLateId);
 assert.deepEqual(serviceLate.metadata,safe);assert.equal(serviceLate.error_message,null);
 assert.equal(serviceLate.ip_address,null);assert.equal(serviceLate.user_agent,null);assert.ok(serviceLate.content_erased_at);
 const recovery=await fixture(db);await closeAccount(db,recovery);
 await rpc(db,'bill2_cancel',recovery.actor,recovery.run);await rpc(db,'bill2_finalize',recovery.actor,recovery.run);
 const refund=(await db.query("SELECT * FROM billing_history WHERE user_id=$1 AND operation_type='refund'",[recovery.actor])).rows;
 assert.ok(refund.length,'actual original-run refund recovery still writes its financial row');
 assert.ok(refund.every(r=>r.content_erased_at));
 assert.doesNotMatch(JSON.stringify(refund),/LEDGER_PRIVATE_CANARY/);
 report.checks.push('late updates/inserts stay scrubbed and actual BILL2 refund recovery remains operational');

 const invalid=await fixture(db);
 const badId='00000000-0000-4000-8000-000000000001',goodId='00000000-0000-4000-8000-000000000002';
 await insertUsage(db,invalid.actor,badId,{refundAmount:{body:CANARY},body:CANARY});
 await insertUsage(db,invalid.actor,goodId,{providerCostUsd:null,usage:null,body:CANARY});
 await closeAccount(db,invalid);
 const blocked=await scrub(db,invalid.actor,'ai_usage_logs',1);
 assert.deepEqual(blocked,{processed:0,remaining:2,manualReview:1,nextRowId:badId});
 assert.equal((await row(db,'ai_usage_logs',badId)).content_erased_at,null);
 const next=await scrub(db,invalid.actor,'ai_usage_logs',1,blocked.nextRowId);
 assert.equal(next.processed,1);assert.equal(next.remaining,1);assert.equal(next.manualReview,0);
 assert.deepEqual((await row(db,'ai_usage_logs',goodId)).metadata,{providerCostUsd:null,usage:null});
 await assert.rejects(insertUsage(db,invalid.actor,undefined,{refundAmount:'unknown'}),/ERASURE_LEDGER_INVALID_EVIDENCE/);
 assert.deepEqual(await row(db,'ai_usage_logs',foreign),untouched,'unrelated active account keeps original private content');
 report.checks.push('malformed financial evidence preserved for manual review; cursor avoids starvation; null retained and unknown not coerced to zero');
 await paygEvidence(db,report);
 const v1=await fixture(db),vc=await v1Call(db,v1);await closeAccount(db,v1);
 // SQL confirmation closes account access; the host separately seals the original v1 call set.
 await rpc(db,'bill2_cancel',v1.actor,v1.run);
 await rpc(db,'bill2_record',v1.actor,v1.run,vc.id,v1Evidence(vc,'0.001'));
 const terminal=await rpc(db,'bill2_finalize',v1.actor,v1.run);
 assert.equal(terminal.outcome,'cancelled');assert.equal(terminal.chargedCredits,2);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[v1.actor])).rows[0].credits,98);
 const logs=(await db.query('SELECT metadata FROM ai_usage_logs WHERE bill2_run_id=$1',[v1.run])).rows;
 assert.ok(logs.length);assert.ok(logs.some(r=>r.metadata.usage?.outcome==='cancelled'||r.metadata.outcome==='cancelled'));
 const v1Rows=(await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[v1.actor])).rows;
 await rpc(db,'bill2_finalize',v1.actor,v1.run);
 assert.deepEqual((await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[v1.actor])).rows,v1Rows);
 report.checks.push('real v1 late receipt after account closure settles cancelled outcome for exactly 2 credits; replay preserves financial rows');
}

async function paygEvidence(db,report){
 for(const late of [false,true]){
  const f=await createFixture(db),c=await claim(db,f,1,true);
  if(late)await closeAccount(db,f);
  await receipt(db,f,c,'0.003',{inputTokens:3000,outputTokens:0});
  const spend=(await db.query("SELECT metadata FROM credit_transactions WHERE bill2_call_id=$1 AND reason_code='bill2_spend'",[c.id])).rows[0];
  assert.ok(spend,'real PAYG spend exists');
  for(const key of ['nominalCostUsd','nominalSource','theoreticalDelta','chargedDelta','platformCapCredits','platformBoundCredits']){
   assert.ok(Object.hasOwn(spend.metadata,key),`real PAYG metadata retains ${key}`);
  }
  assert.equal(spend.metadata.chargedDelta,3);
  assert.equal(Number(spend.metadata.nominalCostUsd),0.003);
  if(!late)await rpc(db,'bill2_close',f.actor,f.run,'confirmed_failure',{
   kind:'confirmed_delivery_failure',evidenceRef:'synthetic-proof',evidenceHash:'d'.repeat(64),body:CANARY});
  await rpc(db,'bill2_finalize',f.actor,f.run);
  const compensation=(await db.query("SELECT * FROM credit_transactions WHERE bill2_call_id=$1 AND reason_code='bill2_compensation'",[c.id])).rows[0];
  if(late){
   assert.equal(compensation,undefined,'account cancellation never invents confirmed-failure compensation');
   assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).outcome,'cancelled');
  }else{
   assert.ok(compensation);assert.equal(compensation.amount,3);
   for(const key of ['originalPreDeductId','originalSpendId','requestedCompensation','actualRestore','intercepted','reason']){
    assert.ok(Object.hasOwn(compensation.metadata,key),`real compensation retains ${key}`);
   }
   assert.equal(compensation.metadata.requestedCompensation,3);
   assert.equal(compensation.metadata.reason,'confirmed_delivery_failure');
  }
  const before=new Map();
  for(const table of ['credit_transactions','billing_history','token_stats','ai_usage_logs']){
   const rows=(await db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY id`,[f.actor])).rows;
   before.set(table,rows);
   if(!late){
    for(const r of rows)await db.query(`UPDATE ${table} SET metadata=metadata||$2::jsonb WHERE id=$1`,[r.id,{body:CANARY}]);
   }
  }
  if(!late)await closeAccount(db,f);
  for(const [table,rows] of before){
   const result=await scrub(db,f.actor,table);assert.equal(result.manualReview,0);assert.equal(result.remaining,0);
   for(const r of rows){
    const after=await row(db,table,r.id);assert.ok(after.content_erased_at);
    const expected={...r.metadata};
    // Legacy pre-deduction stores response:null. Response is content, never financial evidence.
    if(Object.hasOwn(expected,'response')){assert.equal(expected.response,null);delete expected.response;}
    assert.deepEqual(after.metadata,expected,'only response content omitted; every original financial field stays complete');
    assert.doesNotMatch(JSON.stringify(after),/LEDGER_PRIVATE_CANARY/);
   }
  }
  const balance=(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
  assert.equal(balance,late?97:100);
  await rpc(db,'bill2_finalize',f.actor,f.run);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,balance);
 }
 report.checks.push('real PAYG settlement and compensation preserve complete original metadata before/after closure, including nested usage evidence; replay never recredits');
}
