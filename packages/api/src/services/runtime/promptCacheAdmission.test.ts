/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './execute';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {pricingConfig} from '../__tests__/fixtures/runtimePricing';
import {agentTurnInstructions,AGENT_TURN_STABLE_PREFIX,AGENT_TURN_STABLE_PREFIX_CHARS} from '../opc/agentTurnPrompt';
import {PROMPT_CACHE_OVERHEAD_BYTES} from './promptCache';
const skill='Pinned skill 正文';
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[{revisionId:'10000000-0000-4000-8000-000000000003'}]})}));
vi.mock('../skills/loader',()=>({identityOf:(value:unknown)=>value,activateSkill:async()=>({forModel:()=>skill})}));
vi.mock('./billingUnitAdmission',async original=>({
 ...(await original<typeof import('./billingUnitAdmission')>()),freezeWindowBillingUnit:async()=>undefined,
}));
const actor='10000000-0000-4000-8000-000000000001',modelId='10000000-0000-4000-8000-000000000002';
const revisionId='10000000-0000-4000-8000-000000000003',moduleId='10000000-0000-4000-8000-000000000004';
const requestId='10000000-0000-4000-8000-000000000005';
const host=()=>agentTurnInstructions({step:{id:'private-step',title:'Private title',schema:[]},question:null,
 questionLabel:null,workflowContext:{private:'user data'},opening:false});
function fixture(model='anthropic/test',write:string|undefined='2.5',real=true,inputBytes=32000){
 const providerLimits={providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',
  requestUsd:'0',...(write===undefined?{}:{cacheWriteUsdPerMillion:write})};
 const quote={modelId,provider:'openrouter',account:'synthetic',model,protocol:'openrouter-chat-v1' as const,providerLimits,
  upperUsd:openRouterBound(providerLimits,100).upperUsd,inputLimit:32000,outputLimit:100,
  automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 const row={id:modelId,model_id:model,is_active:'true',provider:real?'openrouter':'fixture',max_tokens:1000,input_limit:32000,
  config:pricingConfig(model,'synthetic/fp8','2','0')};
 const configReads=vi.fn();let saved:unknown=null;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:actor}},error:null};
  if(name==='runtime_admission_replay')return {data:saved,error:null};
  if(name==='runtime_admit'){
   saved={context:args.p_payload,billing:args.p_billing};return {data:saved,error:null};
  }
  throw new Error(name);
 });
 const admin={rpc,from:(table:string)=>{
  configReads(table);
  const query={select:()=>query,eq:()=>query,
   single:async()=>({data:table==='modules'?{id:moduleId,active:true,skill_id:moduleId,model_id:modelId}:row,error:null}),
   in:async()=>({data:[row],error:null})};return query;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={...(real?{real:{id:actor,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01',callPolicies:[quote]}}:{}),
  account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes,historyItems:0,
  additionalInstructions:host(),stableAdditionalInstructions:AGENT_TURN_STABLE_PREFIX};
 const input={sessionId:actor,requestId,input:'user facts',network:'deny',selection:{kind:'skill',moduleId,revisionId}};
 return {service:runtimeAdmissionService(user,admin,policy),input,rpc,configReads,row,user,admin,policy};
}
it('freezes actual Skill + host prefix, excludes mutable content, and replays before current configuration',async()=>{
 const f=fixture(),result=await f.service.prepare(f.input);
 const context=runtimeContext.parse(result.context);
 const prefix=skill+'\n'+host().slice(0,AGENT_TURN_STABLE_PREFIX_CHARS);
 expect(AGENT_TURN_STABLE_PREFIX_CHARS).toBeGreaterThan(0);
 expect(prefix.endsWith('\n\n')).toBe(true);expect(prefix).not.toContain('private-step');
 expect(context.promptCache).toEqual({version:'prompt-cache-v1',systemPrefixChars:prefix.length,
  systemPrefixSha256:createHash('sha256').update(prefix).digest('hex')});
 expect(result.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(result.context)).digest('hex'));
 const reads=f.configReads.mock.calls.length;
 f.row.is_active='false';f.row.config.pricing.fetchedAt='2000-01-01';
 expect(await f.service.prepare(f.input)).toEqual(result);expect(f.configReads.mock.calls).toHaveLength(reads);
});
it.each([
 {model:'anthropic/test',write:undefined,real:true},{model:'google/test',write:'2.5',real:true},
 {model:'openai/test',write:'2.5',real:true},{model:'anthropic/test',write:'2.5',real:false},
])('leaves context unmarked when ineligible: %j',async ({model,write,real})=>{
 const f=fixture(model,write,real);
 // Passing undefined as a default parameter would opt in; explicitly remove
 // the optional quote field for the old-window case.
 if(write===undefined){
  const policy={...f.policy,real:{...f.policy.real!,callPolicies:f.policy.real!.callPolicies.map(q=>{
   const providerLimits={...q.providerLimits,cacheWriteUsdPerMillion:undefined};
   return {...q,providerLimits,upperUsd:openRouterBound(providerLimits,100).upperUsd};
  })}};
  expect((await runtimeAdmissionService(f.user,f.admin,policy).prepare(f.input)).context).not.toHaveProperty('promptCache');
 }else expect((await f.service.prepare(f.input)).context).not.toHaveProperty('promptCache');
});
it('ordinary role is never marked even on Anthropic with a write price',async()=>{
 const f=fixture();const result=await f.service.prepare({...f.input,selection:{kind:'ordinary',modelId}});
 expect(result.context).not.toHaveProperty('promptCache');
});
it('reserves marker bytes during admission at the input capacity boundary',async()=>{
 const instructions=skill+'\n'+host();
 const oldLimit=Buffer.byteLength(JSON.stringify({instructions,messages:[{role:'user',content:'user facts'}]}))+1024;
 const f=fixture('anthropic/test','2.5',true,oldLimit);
 await expect(f.service.prepare(f.input)).rejects.toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
 const enough=fixture('anthropic/test','2.5',true,oldLimit+PROMPT_CACHE_OVERHEAD_BYTES);
 expect((await enough.service.prepare(enough.input)).context.promptCache).toBeDefined();
});

it('mentor v5 freezes the host prefix before the question contract',async()=>{
 const f=fixture();
 const reasoning=configuredReasoning(f.row.model_id).reasoning;
 f.row.config.reasoning={...reasoning,catalog:reasoning.catalog!,route:reasoning.route!};
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,opcTurnToken:requestId,mentorStream:true});
 const result=await service.prepare(f.input);
 expect(result.context.providerRequestFormat).toBe('agent-turn-v5-stream');
 expect(result.context.promptCache.systemPrefixChars).toBe(skill.length+1+AGENT_TURN_STABLE_PREFIX_CHARS);
 expect(result.context.instructions.slice(0,result.context.promptCache.systemPrefixChars))
  .toBe(skill+'\n'+host().slice(0,AGENT_TURN_STABLE_PREFIX_CHARS));
 expect(result.context.instructions).toContain('complete public prose in message');
});
it.each(['prepend','same-length-change','truncated'] as const)('admits without a marker when host text mismatches (%s)',async mode=>{
 const f=fixture();
 const additionalInstructions=mode==='prepend'?'Private business name\n'+host():
  mode==='same-length-change'?'X'+host().slice(1):AGENT_TURN_STABLE_PREFIX.slice(0,-1);
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,additionalInstructions});
 const result=await service.prepare(f.input);
 expect(result.context).not.toHaveProperty('promptCache');
 expect(result.context.instructions).toBe(skill+'\n'+additionalInstructions);
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
 expect(result.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(result.context)).digest('hex'));
});
it('keeps ordinary Skill caching without host rules and derives current prefix length from text',async()=>{
 const f=fixture();
 const result=await runtimeAdmissionService(f.user,f.admin,{...f.policy,additionalInstructions:'Dynamic text',
  stableAdditionalInstructions:undefined}).prepare(f.input);
 expect(result.context.promptCache.systemPrefixChars).toBe(skill.length);
 expect(AGENT_TURN_STABLE_PREFIX_CHARS).toBe(AGENT_TURN_STABLE_PREFIX.length);
 expect(AGENT_TURN_STABLE_PREFIX).toBe(host().slice(0,AGENT_TURN_STABLE_PREFIX_CHARS));
});

vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
