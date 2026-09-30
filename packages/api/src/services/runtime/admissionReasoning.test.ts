/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const first='10000000-0000-4000-8000-000000000003',second='10000000-0000-4000-8000-000000000004',organizer='10000000-0000-4000-8000-000000000005';
const requestId='10000000-0000-4000-8000-000000000006',nextId='10000000-0000-4000-8000-000000000007';
function fixture(budgetConfig?:unknown){
 const models=[{id:first,model_id:'synthetic/first'}, {id:second,model_id:'synthetic/second'}, {id:organizer,model_id:'synthetic/organizer'}].map(m=>({...m,provider:'openrouter',is_active:'true',max_tokens:8192,input_limit:32000,config:configuredReasoning(m.model_id)}));
 models[1]!.config=configuredReasoning(models[1]!.model_id,{mode:'budget',maxTokens:2048});
 const frozen=new Map<string,any>();let reads=0;
 const rpc=vi.fn(async(name:string,args:any)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId},dialogueModelId:first,dialogueModel:models[0]!.model_id},error:null};
  if(name==='runtime_admission_replay')return {data:frozen.get(args.p_request_id)??null,error:null};
  if(name==='runtime_admit'){
   const result={executionId:args.p_request_id,context:structuredClone(args.p_payload),billing:structuredClone(args.p_billing)};
   frozen.set(args.p_request_id,result);return {data:result,error:null};
  }
  throw new Error(name);
 });
 const selectedColumns:string[]=[];
 const admin={rpc,from:(table:string)=>{
  let id='';const q={select:(columns:string)=>{if(table==='ai_models')selectedColumns.push(columns);return q;},eq:(_key:string,value:string)=>{id=value;return q;},
   maybeSingle:async()=>({data:budgetConfig?{value:JSON.stringify(budgetConfig)}:null,error:null}),
   single:async()=>{reads++;return {data:models.find(m=>m.id===id),error:null};},
   in:async()=>({data:[{key:'v3_summary_model_id',value:organizer},{key:'v3_summary_max_tokens',value:'4096'}],error:null})};return q;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const quotes=models.map(m=>({modelId:m.id,provider:'openrouter',account:'synthetic',model:m.model_id,protocol:'openrouter-chat-v1' as const,providerLimits:{providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'},upperUsd:'0.004',inputLimit:32000,outputLimit:8192,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true}));
 const policy={real:{id:sessionId,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01',callPolicies:quotes},account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:8192,inputBytes:32000,historyItems:10,opcTurnToken:requestId,mentorStream:true};
 const service=runtimeAdmissionService(user,admin,policy);
 const input={sessionId,requestId,input:'Synthetic facts',selection:{kind:'ordinary' as const,modelId:first},network:'deny',organizeAfter:true};
 return {models,service,input,reads:()=>reads,selectedColumns,rpc,policy,user,admin};
}
it('new model selection reads that model setting; replay bypasses changed config and preserves hash',async()=>{
 const f=fixture();
 const old=await f.service.prepare(f.input),original=structuredClone(old);
 expect(old.context.reasoning).toEqual({effort:'none'});
 const next=await f.service.prepare({...f.input,requestId:nextId,selection:{kind:'ordinary',modelId:second}});
 expect(next.context.model).toBe('synthetic/second');
 expect(next.context.reasoning).toEqual({parameter:'reasoning',value:{max_tokens:2048}});
 expect(next.billing.sourceHash).not.toBe(old.billing.sourceHash);
 for(const result of [old,next])expect(result.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(result.context)).digest('hex'));
 f.models[0]!.config.reasoning.purposes={};f.models[0]!.is_active='false';
 const reads=f.reads();expect(await f.service.prepare(f.input)).toEqual(original);expect(f.reads()).toBe(reads);
 expect(f.selectedColumns.every(columns=>columns.split(',').includes('config'))).toBe(true);
});
it('changing settings on the same model affects only the next admission',async()=>{
 const f=fixture(),old=await f.service.prepare(f.input);
 f.models[0]!.config=configuredReasoning('synthetic/first',{mode:'off',wire:'reasoning'});
 const next=await f.service.prepare({...f.input,requestId:nextId});
 expect(next.context.reasoning).toEqual({parameter:'reasoning',value:{enabled:false}});
 expect(await f.service.prepare(f.input)).toEqual(old);
});
it.each([false,true])('freezes independent organizer settings (standalone=%s)',async standalone=>{
 const f=fixture();f.models[2]!.config=configuredReasoning('synthetic/organizer',{mode:'effort',wire:'reasoning',effort:'max'},'organize');
 const service=standalone?runtimeAdmissionService(f.user,f.admin,{...f.policy,mentorStream:false,opcTurnToken:undefined}):f.service;
 const result=await service.prepare({...f.input,...(standalone?{selection:{kind:'organizer'},organizeAfter:false}:{})});
 const context=standalone?result.context:result.context.attachedOrganizer;
 expect(context.reasoning).toEqual({parameter:'reasoning',value:{effort:'max'}});
 expect(result.context.providerRequestFormat).toBe(standalone?'serial-tools-v6-reasoning':'serial-tools-v4-stream');
 if(!standalone)expect(result.context.reasoning).toEqual({effort:'none'});
});
it.each(['missing','route','organizer-route'] as const)('denies %s before admission/BILL2 reservation',async kind=>{
 const f=fixture();
 if(kind==='missing')f.models[0]!.config.reasoning.purposes={};
 if(kind==='route')f.models[0]!.config.reasoning.route='synthetic';
 if(kind==='organizer-route'){
  f.models[2]!.config=configuredReasoning('synthetic/organizer',{mode:'off',wire:'reasoning'},'organize');
  f.models[2]!.config.reasoning.route='synthetic/fp16';
 }
 await expect(f.service.prepare(f.input)).rejects.toThrow(kind==='missing'?'RUNTIME_REASONING_NOT_CONFIGURED':'RUNTIME_REASONING_ROUTE_MISMATCH');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('reasoning alone changes sourceHash, including independent organizer defaults',async()=>{
 const original=fixture(),changed=fixture();
 changed.models[2]!.config=configuredReasoning('synthetic/organizer',{mode:'off',wire:'reasoning'},'organize');
 const before=await original.service.prepare(original.input),after=await changed.service.prepare(changed.input);
 expect(after.context).toEqual({...before.context,attachedOrganizer:{...before.context.attachedOrganizer,reasoning:{parameter:'reasoning',value:{enabled:false}}}});
 expect(after.billing.sourceHash).not.toBe(before.billing.sourceHash);
});

it('configured budgets freeze separately from unchanged quotes and reservation arithmetic',async()=>{
 const config={version:1,interactive:{inputBytes:24000,maxOutputTokens:30000,historyItems:7},
  organize:{inputBytes:16000,historyItems:3},report:{inputBytes:64000,maxOutputTokens:1000,historyItems:100}};
 const f=fixture(config);
 for(const m of f.models){m.max_tokens=64000;m.input_limit=128000;}
 for(const q of f.policy.real.callPolicies){q.outputLimit=40000;q.providerLimits.contextTokens=128000;q.inputLimit=90000;}
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,purposeBudgets:true});
 const original=await service.prepare(f.input);
 expect(original.context.maxOutputTokens).toBe(30000); // No hidden 20000 ceiling.
 expect(original.context.purposeBudget).toEqual({purpose:'interactive',inputBytes:24000,historyItems:7});
 expect(original.context.attachedOrganizer).toMatchObject({maxOutputTokens:4096,inputBytes:16000,historyItems:3});
 expect(original.billing.callPolicy).toEqual(f.policy.real.callPolicies.filter(q=>q.modelId!==second));
 expect(original.billing.limits).toMatchObject({costUsd:'0.008000000000',credits:8,maxPreDeduct:8,maxCalls:2});
 config.interactive.maxOutputTokens=60000;config.interactive.historyItems=2;
 const next=await service.prepare({...f.input,requestId:nextId});
 expect(next.context.maxOutputTokens).toBe(40000); // Approved quote is still authoritative.
 expect(next.context.historyItems).toBe(2);
 expect(next.billing.limits).toEqual({...original.billing.limits,deadline:expect.any(String)});
 expect(await service.prepare(f.input)).toEqual(original);
});
