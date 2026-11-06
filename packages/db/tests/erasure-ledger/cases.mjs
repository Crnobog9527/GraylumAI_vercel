/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc,closeAccount} from '../erasure-b2a/cases.mjs';

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
/** The value with every modelId / providerModel replaced by its alias (public.model_usage_alias), as token_stats stores it. */
async function aliased(db,value){
 if(Array.isArray(value))return Promise.all(value.map(item=>aliased(db,item)));
 if(value===null||typeof value!=='object')return value;
 const out={};
 for(const [key,item] of Object.entries(value))
  out[key]=(key==='modelId'||key==='providerModel')&&typeof item==='string'
   ?(await db.query('SELECT public.model_usage_alias($1) a',[item])).rows[0].a:await aliased(db,item);
 return out;
}
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
 // The shared fixture no longer opens a billing run (V2-12 F), so it has no pre-deduction row: the suite writes its own billing_history row.
 const pre=(await db.query(`INSERT INTO billing_history(user_id,operation_type,amount,reason,metadata)
  VALUES($1,'pre_deduct',-1,$2,$3::jsonb) RETURNING id`,[f.actor,CANARY,dirty])).rows[0].id;
 const conv=randomUUID(),token=randomUUID();
 await db.query("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'synthetic')",[conv,f.actor]);
 await db.query(`INSERT INTO token_stats(id,user_id,conversation_id,model_used,input_tokens,output_tokens,
 total_cost_usd,total_credits,metadata) VALUES($1,$2,$3,'synthetic',3,4,0.000123,1,$4)`,[token,f.actor,conv,dirty]);
 const usage=await insertUsage(db,f.actor,undefined,dirty),foreign=await insertUsage(db,other.actor,undefined,dirty);
 const untouched=await row(db,'ai_usage_logs',foreign);
 const specs=[['credit_transactions',credit,['description','metadata','content_erased_at']],
  ['billing_history',pre,['reason','metadata','content_erased_at']],
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
  // token_stats alone carries model names in its metadata, and 0217's trigger stores them as aliases (model_usage_alias): the same projection
  // with the names replaced, nothing else changed. The other three tables keep the original names.
  const expected=table==='token_stats'?await aliased(db,safe):safe;
  for(const [key,value] of Object.entries(expected))assert.deepEqual(after.metadata[key],value,key);
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
 // Not run any more (CORE-PATH-V2 V2-12 F, 0505): the actual BILL2 refund recovery after closure (bill2_cancel / bill2_finalize). No core-path
 // equivalent exists in this suite; the late updates and inserts above are what stays checked.
 report.checks.push('late updates/inserts stay scrubbed');

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
 // Not run any more (0505): the real v1 late receipt after closure and the PAYG settlement/compensation evidence (bill2_*), which used the dropped
 // BILL2 functions and tables; no core-path equivalent exists in this suite.
}
