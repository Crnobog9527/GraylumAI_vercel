/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {OPENING_INPUT} from '../../shared/opcQuestions';
import {PURPOSE_OUTPUT_CAP} from './purposeBudgets';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {testPrimaryModel} from '../__tests__/fixtures/runtimeGates';
import {packageHash,sha256,type SkillSource} from '../skills/loader';
import {runtimeContext} from './runtimeContext';
import {sourceToolBytes} from './sourceRuntimeTool';
import {openRouterRequestBody,STREAMING_FORMATS} from './providerRequest';
import {frozenReasoningFields} from './reasoningPolicy';
import {openRouterBound} from '../bill2/openRouterPolicy';
const admittedSkill = vi.hoisted(() => ({ source: undefined as SkillSource | undefined }));
vi.mock('../skills/databaseSource', () => ({ databaseSkillSource: () => admittedSkill.source }));
// CONTENT-CONVERSATION-DRIVEN: a test may hand admission a ready catalog; otherwise the real (here empty) discovery runs.
const catalogState = vi.hoisted(() => ({ value: undefined as unknown, probe: undefined as undefined | ((fits: (text: string, extra: number) => boolean) => void) }));
vi.mock('./skillCatalogAdmission', async (original) => {
  const real = await original<typeof import('./skillCatalogAdmission')>();
  return { ...real, admitSkillCatalog: async (...args: Parameters<typeof real.admitSkillCatalog>) =>
    catalogState.probe ? (catalogState.probe((text, extra) => args[2].fitsWith(extra, text)), undefined) : catalogState.value && args[2].eligible && args[2].fitsWith(100, 'x'.repeat(200)) ? catalogState.value : real.admitSkillCatalog(...args) };
});
// The window/configuration consistency of BILL-UNIT is covered in billingUnitAdmission.test.ts.
vi.mock('./billingUnitAdmission', async (original) => ({
  ...(await original<typeof import('./billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', models: {}, providers: {}, hash: 'f'.repeat(64) }),
}));
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const first='10000000-0000-4000-8000-000000000003',second='10000000-0000-4000-8000-000000000004',organizer='10000000-0000-4000-8000-000000000005';
const requestId='10000000-0000-4000-8000-000000000006',nextId='10000000-0000-4000-8000-000000000007';
const moduleId='10000000-0000-4000-8000-000000000008',skillId='10000000-0000-4000-8000-000000000009';
const revisionId='10000000-0000-4000-8000-000000000010';
function fixture(budgetConfig?:unknown){
 testPrimaryModel.id=first;
 const models=[{id:first,model_id:'synthetic/first'}, {id:second,model_id:'synthetic/second'}, {id:organizer,model_id:'synthetic/organizer'}].map(m=>({...m,provider:'openrouter',is_active:'true',max_tokens:8192,input_limit:32000,config:configuredReasoning(m.model_id)}));
 models[1]!.config=configuredReasoning(models[1]!.model_id,{mode:'budget',maxTokens:2048});
 const settings:{key:string;value:unknown}[]=[{key:'v3_summary_model_id',value:organizer},{key:'v3_summary_max_tokens',value:'4096'}];
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
   single:async()=>{reads++;return {data:table==='modules'
    ?{id,active:true,skill_id:skillId,model_id:first}:models.find(m=>m.id===id),error:null};},
   in:async()=>({data:table==='ai_models'?models:[...settings,
    ...(budgetConfig?[{key:'runtime_purpose_budgets',value:JSON.stringify(budgetConfig)}]:[])],error:null})};return q;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const quotes=models.map(m=>({modelId:m.id,provider:'openrouter',account:'synthetic',model:m.model_id,protocol:'openrouter-chat-v1' as const,providerLimits:{providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'},upperUsd:'0.004',inputLimit:32000,outputLimit:8192,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true}));
 const policy={real:{id:sessionId,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01',callPolicies:quotes},account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:8192,inputBytes:32000,historyItems:10,opcTurnToken:requestId,mentorStream:true};
 const service=runtimeAdmissionService(user,admin,policy);
 const input={sessionId,requestId,input:'Synthetic facts',selection:{kind:'ordinary' as const,modelId:first},network:'deny',organizeAfter:true};
 return {models,settings,service,input,frozen,reads:()=>reads,selectedColumns,rpc,policy,user,admin};
}
it('new model selection reads that model setting; replay bypasses changed config and preserves hash',async()=>{
 const f=fixture();
 const old=await f.service.prepare(f.input),original=structuredClone(old);
 expect(old.context.reasoning).toEqual({effort:'none'});
 // UI-MODEL: free chat follows the administrator's primary model; the request's modelId is ignored.
 testPrimaryModel.id=second;
 const next=await f.service.prepare({...f.input,requestId:nextId,selection:{kind:'ordinary',modelId:first}});
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
 expect(result.context.providerRequestFormat).toBe(standalone?'serial-tools-v6-reasoning':'agent-turn-v5-stream');
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

it.each([false,true])('new openings attach an organizer, preserving caller request (real=%s)',async real=>{
 const f=fixture();
 if(!real)for(const model of f.models)model.provider='fixture';
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,real:real?f.policy.real:undefined,organizeOpening:true});
 const input={...f.input,input:OPENING_INPUT,organizeAfter:false};
 const result=await service.prepare(input);
 expect(result.context.request).toEqual({...input,sources:[]});
 expect(result.context).toMatchObject({providerRequestFormat:'agent-turn-v5-stream',
  tools:[],network:'deny',sources:[],maxToolCalls:0,maxTurns:1,
  reasoning:real?{effort:'none'}:{parameter:'none'},
  attachedOrganizer:{modelId:organizer,...(real?{reasoning:{parameter:'none'}}:{})},
 });
 expect(result.context).not.toHaveProperty('matching');expect(result.context).not.toHaveProperty('workspaceContext');
 expect(result.billing.limits).toMatchObject({maxCalls:2,credits:real?8:40,maxPreDeduct:real?8:40});
 expect(result.billing.callPolicy).toHaveLength(2);
 const reads=f.reads();f.models[0]!.config.reasoning.purposes={};f.models[2]!.is_active='false';
 expect(await service.prepare(input)).toEqual(result);expect(f.reads()).toBe(reads);
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admission_replay')
  .every(([,args])=>args.p_request.organizeAfter===false)).toBe(true);
});
it('an answer without organizer remains one call and contains no fabricated extraction',async()=>{
 const f=fixture(),service=runtimeAdmissionService(f.user,f.admin,{...f.policy,maxCalls:1});
 const result=await service.prepare({...f.input,organizeAfter:false});
 expect(result.context.providerRequestFormat).toBe('agent-turn-v5-stream');
 expect(result.context).toMatchObject({tools:['ask_question'],maxToolCalls:1});
 expect(result.context).not.toHaveProperty('attachedOrganizer');
 expect(result.context).not.toHaveProperty('informationPatch');expect(result.billing.limits.maxCalls).toBe(1);
});
it('old v4 opening replay bypasses new organizer and current reasoning reads with byte-identical payload',async()=>{
 const f=fixture(),input={...f.input,input:OPENING_INPUT,organizeAfter:false};
 const context={providerRequestFormat:'serial-tools-v4-stream',request:{...input,sources:[]},
  tools:[],reasoning:{effort:'none'},instructions:'Frozen legacy JSON instructions',maxTurns:1};
 const old={executionId:requestId,context,billing:{limits:{maxCalls:1},
  sourceHash:createHash('sha256').update(JSON.stringify(context)).digest('hex')}};
 const bytes=JSON.stringify(old);f.frozen.set(requestId,old);
 f.models[0]!.config.reasoning.purposes={};f.models[2]!.is_active='false';
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,organizeOpening:true});
 expect(JSON.stringify(await service.prepare(input))).toBe(bytes);expect(f.reads()).toBe(0);
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});
it.each(['auto','workspace','sources'] as const)('v5 refuses %s before reserving any money',async kind=>{
 const f=fixture(),service=runtimeAdmissionService(f.user,f.admin,
  {...f.policy,...(kind==='workspace'?{workspaceContext:true}:{})});
 const input={...f.input,...(kind==='auto'?{selection:{kind:'auto',modelId:first}}:{}),
  ...(kind==='sources'?{sources:[{projectId:first,roundId:second,sourceVersionId:organizer,hash:'a'.repeat(64)}]}:{})};
 await expect(service.prepare(input)).rejects.toThrow('RUNTIME_CONTEXT_INVALID');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});


it.each([
 ['missing-summary', 'RUNTIME_STAGING_MODEL_DENIED'],
 ['invalid-summary-output', 'RUNTIME_STAGING_MODEL_DENIED'],
 ['same-record', 'RUNTIME_STAGING_MODEL_DENIED'],
 ['same-provider-model', 'RUNTIME_STAGING_MODEL_DENIED'],
 ['unapproved-organizer', 'RUNTIME_STAGING_MODEL_NOT_APPROVED'],
 ['inactive-organizer', 'RUNTIME_STAGING_MODEL_DENIED'],
 ['organizer-reasoning-route', 'RUNTIME_REASONING_ROUTE_MISMATCH'],
 ['one-call-budget', 'RUNTIME_ORGANIZER_BUDGET'],
] as const)('new opening rejects %s before creating an execution or reserving credits',async(kind,error)=>{
 const f=fixture();
 if(kind==='missing-summary')f.settings.splice(0);
 if(kind==='invalid-summary-output')f.settings[1]!.value='not-a-token-limit';
 if(kind==='same-record')f.settings[0]!.value=first;
 if(kind==='same-provider-model')f.models[2]!.model_id=' SYNTHETIC/FIRST ';
 if(kind==='unapproved-organizer')f.policy.real.callPolicies=f.policy.real.callPolicies.filter(q=>q.modelId!==organizer);
 if(kind==='inactive-organizer')f.models[2]!.is_active='false';
 if(kind==='organizer-reasoning-route'){
  f.models[2]!.config=configuredReasoning('synthetic/organizer',{mode:'off',wire:'reasoning'},'organize');
  f.models[2]!.config.reasoning.route='synthetic/fp16';
 }
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,organizeOpening:true,
  maxCalls:kind==='one-call-budget'?1:2});
 await expect(service.prepare({...f.input,input:OPENING_INPUT,organizeAfter:false})).rejects.toThrow(error);
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
 expect(f.frozen.size).toBe(0);
});

it('configured budgets freeze separately from unchanged quotes and reservation arithmetic',async()=>{
 const config={version:1,interactive:{inputBytes:24000,maxOutputTokens:2000,historyItems:7},
  organize:{inputBytes:16000,historyItems:3},report:{inputBytes:64000,maxOutputTokens:1000,historyItems:100}};
 const f=fixture(config);
 for(const m of f.models){m.max_tokens=64000;m.input_limit=128000;}
 for(const q of f.policy.real.callPolicies){q.outputLimit=40000;q.providerLimits.contextTokens=128000;q.inputLimit=90000;}
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,purposeBudgets:true});
 const original=await service.prepare(f.input);
 expect(original.context.maxOutputTokens).toBe(PURPOSE_OUTPUT_CAP);
 expect(original.context.purposeBudget).toEqual({purpose:'interactive',inputBytes:24000,historyItems:7});
 expect(original.context.attachedOrganizer).toMatchObject({maxOutputTokens:4096,inputBytes:16000,historyItems:0});
 expect(original.billing.callPolicy).toEqual(f.policy.real.callPolicies.filter(q=>q.modelId!==second));
 expect(original.billing.limits).toMatchObject({costUsd:'0.008000000000',credits:8,maxPreDeduct:8,maxCalls:2});
 config.interactive.maxOutputTokens=PURPOSE_OUTPUT_CAP;config.interactive.historyItems=2;
 const next=await service.prepare({...f.input,requestId:nextId});
 expect(next.context.maxOutputTokens).toBe(PURPOSE_OUTPUT_CAP); // New configuration ceiling; quote arithmetic is unchanged.
 expect(next.context.historyItems).toBe(2);
 expect(next.billing.limits).toEqual({...original.billing.limits,deadline:expect.any(String)});
 expect(await service.prepare(f.input)).toEqual(original);
});

it('new admission uses unified ceiling and replay ignores newly invalid configuration',async()=>{
 const config={version:1,interactive:{inputBytes:24000,maxOutputTokens:2000,historyItems:7},
  organize:{inputBytes:16000,historyItems:3},report:{inputBytes:64000,maxOutputTokens:1000,historyItems:100}};
 const f=fixture(config),service=runtimeAdmissionService(f.user,f.admin,{...f.policy,purposeBudgets:true});
 const admitted=await service.prepare(f.input);
 config.interactive.maxOutputTokens=128000;
 expect(await service.prepare(f.input)).toEqual(admitted);
 await expect(service.prepare({...f.input,requestId:nextId})).rejects.toThrow('RUNTIME_BUDGET_CONFIG_INVALID');
 const legacy=fixture();
 for(const m of legacy.models)m.max_tokens=64000;
 for(const q of legacy.policy.real.callPolicies)q.outputLimit=40000;
 const legacyService=runtimeAdmissionService(legacy.user,legacy.admin,legacy.policy);
 expect((await legacyService.prepare(legacy.input)).context.maxOutputTokens).toBe(PURPOSE_OUTPUT_CAP);
});

it.each([false,true])('zero history applies only to newly admitted positioning attachment (standalone=%s)',async standalone=>{
 const config={version:1,interactive:{inputBytes:24000,maxOutputTokens:2000,historyItems:7},
  organize:{inputBytes:16000,historyItems:3},report:{inputBytes:64000,maxOutputTokens:1000,historyItems:100}};
 const f=fixture(config);
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,purposeBudgets:true,
  ...(standalone?{mentorStream:false,opcTurnToken:undefined}:{})});
 const result=await service.prepare({...f.input,...(standalone?{selection:{kind:'organizer'},organizeAfter:false}:{})});
 expect(standalone?result.context.historyItems:result.context.attachedOrganizer.historyItems).toBe(standalone?3:0);
 config.organize.historyItems=9;
 expect(await service.prepare({...f.input,...(standalone?{selection:{kind:'organizer'},organizeAfter:false}:{})})).toEqual(result);
});

vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

it('new model ceiling below quote remains admissible without changing v1 financial policy or replay', async () => {
 const f=fixture();
 f.models[0]!.max_tokens=4096;
 const originalQuotes=structuredClone(f.policy.real.callPolicies);
 const admitted=await f.service.prepare(f.input);
 expect(admitted.context.maxOutputTokens).toBe(4096);
 expect(admitted.billing.contractVersion).toBe('bill2.v1');
 expect(admitted.billing.callPolicy).toEqual(originalQuotes.filter(q=>q.modelId!==second));
 f.models[0]!.max_tokens=1024;
 expect(await f.service.prepare(f.input)).toEqual(admitted);
});


function activateSyntheticStepSkill() {
 const entry='---\nname: native-step-test\ndescription: Synthetic native step admission\n---\nFollow the step resources.';
 const files={'SKILL.md':entry,'references/step.md':'Use the public message envelope.','references/plan.md':'Return a complete JSON plan array.'};
 const descriptor={packageId:skillId,revisionId,directoryName:'native-step-test',
  files:Object.entries(files).map(([path,content])=>({path,bytes:Buffer.byteLength(content),
   sha256:sha256(content),mediaType:'text/markdown' as const,requires:[]})),
  tasks:{},requiredCapabilities:[],packageHash:''};
 descriptor.packageHash=packageHash(descriptor);
 admittedSkill.source={list:async()=>[descriptor],state:async()=> 'enabled',
  read:async({path})=>Buffer.from(files[path as keyof typeof files])};
}
it.each([false,true])('real Skill admission freezes step streaming and leaves plan buffered (step=%s)',async step=>{
 activateSyntheticStepSkill();
 const f=fixture();
 f.models[0]!.config=configuredReasoning('synthetic/first',{mode:'budget',maxTokens:2048});
 f.models[2]!.config=configuredReasoning('synthetic/organizer',{mode:'off',wire:'reasoning'},'organize');
 for(const quote of f.policy.real.callPolicies)quote.upperUsd=openRouterBound(quote.providerLimits,quote.outputLimit).upperUsd;
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,mentorStream:false,stepStream:step,
  skillResources:[step?'references/step.md':'references/plan.md']});
 const input={...f.input,selection:{kind:'skill' as const,moduleId,revisionId}};
 const admitted=await service.prepare(input);
 const context=runtimeContext.parse(admitted.context);
 expect(context).toMatchObject({role:'skill',moduleId,skillId,revisionId,nativeOutput:'native-output-v1',
  providerRequestFormat:step?'serial-tools-v4-stream':'serial-tools-v6-reasoning',
  reasoning:{parameter:'reasoning',value:{max_tokens:2048}},
  attachedOrganizer:{modelId:organizer,reasoning:{parameter:'reasoning',value:{enabled:false}}},
 });
 expect(STREAMING_FORMATS.has(context.providerRequestFormat!)).toBe(step);
 expect(context.envelopeOrder).toBe(step?'message-first-v1':undefined);
 expect(context.instructions).toContain(step?'public message envelope':'complete JSON plan array');
 const primaryPolicy=f.policy.real.callPolicies.find(quote=>quote.modelId===first)!;
 const organizerPolicy=f.policy.real.callPolicies.find(quote=>quote.modelId===organizer)!;
 const request=(model:string,reasoning:Parameters<typeof frozenReasoningFields>[0],stream:boolean)=>JSON.stringify({
  model,messages:[{role:'user',content:'Synthetic authorized input'}],stream,...frozenReasoningFields(reasoning),
 });
 const primary=JSON.parse(openRouterRequestBody(request(context.model,context.reasoning,step),{
  context,policy:primaryPolicy,phase:'primary',primaryDialogue:true}));
 const attached=JSON.parse(openRouterRequestBody(request(context.attachedOrganizer!.model,context.attachedOrganizer!.reasoning,false),{
  context,policy:organizerPolicy,phase:'attached_organizer',primaryDialogue:false}));
 expect(primary.stream).toBe(step);
 expect(attached.stream).toBe(false);
 expect(attached.reasoning).toEqual({enabled:false});
 expect(primary.reasoning).toEqual({max_tokens:2048});
 expect(admitted.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(admitted.context)).digest('hex'));
 const bytes=JSON.stringify(admitted);
 f.models[0]!.config.reasoning.purposes={};
 expect(JSON.stringify(await service.prepare(input))).toBe(bytes);
});

it.each([8192,32768,32769])('v1 native O is capped at 32768 for model/quote boundary %i with unchanged frozen charges', async limit => {
 const f=fixture();
 f.models[0]!.max_tokens=limit;
 f.policy.real.callPolicies[0]!.outputLimit=limit;
 const before=structuredClone(f.policy.real.callPolicies);
 const result=await runtimeAdmissionService(f.user,f.admin,f.policy).prepare({...f.input,organizeAfter:false});
 expect(result.context.nativeOutput).toBe('native-output-v1');
 expect(result.context.maxOutputTokens).toBe(Math.min(limit,32768));
 expect(result.billing.contractVersion).toBe('bill2.v1');
 expect(result.billing.callPolicy).toEqual([before[0]]);
 expect(result.billing.limits).toMatchObject({costUsd:'0.008000000000',credits:8,maxPreDeduct:8});
});

it('new cap freezes the new quote while an old execution and organizer retain their original limits', async () => {
 const f=fixture();
 const old=await f.service.prepare(f.input),oldBytes=JSON.stringify(old);
 const quote=f.policy.real.callPolicies[0]!;
 quote.providerLimits.contextTokens=100000;
 quote.outputLimit=32768;
 quote.upperUsd=openRouterBound(quote.providerLimits,32768).upperUsd;
 f.models[0]!.max_tokens=32768;f.models[0]!.input_limit=100000;
 const next=runtimeAdmissionService(f.user,f.admin,f.policy);
 const admitted=await next.prepare({...f.input,requestId:nextId});
 expect(admitted.context.maxOutputTokens).toBe(32768);
 expect(admitted.context.attachedOrganizer.maxOutputTokens).toBe(4096);
 expect(admitted.billing.callPolicy[0].upperUsd).toBe('0.013276800000');
 expect(admitted.billing.limits).toMatchObject({costUsd:'0.026553600000',credits:27,maxPreDeduct:27});
 expect(JSON.stringify(await next.prepare(f.input))).toBe(oldBytes);
 expect(old.context.maxOutputTokens).toBe(8192);
});

it('CHAT-NATIVE-OUTPUT: a chosen Skill without an organizer freezes the evidenced v6 format, the interactive reasoning, and streams',async()=>{
 activateSyntheticStepSkill();
 const f=fixture();
 for(const quote of f.policy.real.callPolicies)quote.upperUsd=openRouterBound(quote.providerLimits,quote.outputLimit).upperUsd;
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,mentorStream:false,stepStream:false});
 const admitted=await service.prepare({...f.input,organizeAfter:false,selection:{kind:'skill' as const,moduleId,revisionId}});
 const context=runtimeContext.parse(admitted.context);
 expect(context).toMatchObject({role:'skill',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'none'},
  textStream:'plain-text-v1'});
 expect(context).not.toHaveProperty('attachedOrganizer');
 // Same as free chat: the request carries exactly the administrator's interactive reasoning field.
 const policy=f.policy.real.callPolicies.find(quote=>quote.modelId===context.modelId)!;
 const sdk=(fields:object)=>JSON.stringify({model:context.model,messages:[{role:'user',content:'x'}],stream:false,...fields});
 const request={context:{...context,textStream:undefined},policy,phase:'skill',primaryDialogue:true};
 expect(JSON.parse(openRouterRequestBody(sdk(frozenReasoningFields(context.reasoning)),request)).reasoning_effort).toBe('none');
 expect(()=>openRouterRequestBody(sdk({}),request)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
});

// CHAT-AUTO-CONTEXT A2: real free chat may search the user's library when both server switches are on.
it('real free chat freezes library retrieval, read_source and extra calls only with both switches on',async()=>{
 const freeChat=(f:ReturnType<typeof fixture>)=>{
  // Free chat is an ordinary selection without an OPC turn token (the fixture default is a mentor turn).
  const free:Record<string,unknown>={...f.policy};
  delete free.opcTurnToken;delete free.mentorStream;
  return runtimeAdmissionService(f.user,f.admin,free as typeof f.policy);
 };
 for(const rows of [[],[{key:'library_agent_read_enabled',value:true}],[{key:'chat_library_retrieval_enabled',value:true}]]){
  const f=fixture();f.settings.push(...rows);
  const admitted=await freeChat(f).prepare({...f.input,organizeAfter:false});
  expect(runtimeContext.parse(admitted.context)).not.toHaveProperty('libraryRetrieval');
  expect(admitted.context.tools).toEqual([]);expect(admitted.context.maxTurns).toBe(2);
  expect(admitted.context).not.toHaveProperty('sourceCalls');
 }
 const on=fixture();
 on.settings.push({key:'library_agent_read_enabled',value:true},{key:'chat_library_retrieval_enabled',value:'true'});
 const admitted=await freeChat(on).prepare({...on.input,organizeAfter:false});
 const context=runtimeContext.parse(admitted.context);
 expect(context).toMatchObject({libraryRetrieval:true,tools:['read_source'],providerRequestFormat:'serial-tools-v6-reasoning'});
 // New executions that offer read_source freeze the first-call-only marker; executions admitted before it have none.
 expect(context.sourceCalls).toBe('first-call-v1');
 // Six model calls; this fixture's 32 KB input limit leaves room for one 16 KB read result, so one tool call (the slot
 // arithmetic itself is covered in libraryAdmission.test.ts).
 expect(context.maxTurns).toBe(6);expect(context.maxToolCalls).toBe(1);
 // The tool description the model sees carries the search usage.
 expect(sourceToolBytes(['read_source'],false,false,true)).toBeGreaterThan(sourceToolBytes(['read_source'],false));
 // A mentor turn (the fixture default) never freezes it, whatever the switches say.
 const mentor=fixture();mentor.settings.push({key:'library_agent_read_enabled',value:true},{key:'chat_library_retrieval_enabled',value:true});
 expect(runtimeContext.parse((await mentor.service.prepare({...mentor.input,organizeAfter:false})).context)).not.toHaveProperty('libraryRetrieval');
});

// UI-MODEL: the request's modelId is never a fallback for the administrator's primary model.
it.each([
 ['unset',undefined,'RUNTIME_STAGING_MODEL_DENIED'],
 ['outside the window','10000000-0000-4000-8000-000000000099','RUNTIME_STAGING_MODEL_DENIED'],
] as const)('real free chat with the primary model %s is refused before any reservation',async(_name,primary,code)=>{
 const f=fixture();testPrimaryModel.id=primary;
 // The request names an approved model; it must not be used as a fallback.
 await expect(f.service.prepare({...f.input,organizeAfter:false,selection:{kind:'ordinary',modelId:first}})).rejects.toThrow(code);
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

// CONTENT-CONVERSATION-DRIVEN (Owner 2026-10-23: the dialogue model loads Skills itself, at most 2 per reply):
// a free-chat turn freezes the catalog, its instruction text, the load_skill tool and two more calls and tool calls,
// all on the same primary model; no matching call, no candidate models in billing.
it('free chat freezes a Skill catalog with load_skill on the primary model; mentor turns never do',async()=>{
 const entry={name:'script-writer',description:'写口播稿时使用。',moduleId,skillId,packageId:skillId,revisionId,
  packageHash:'a'.repeat(64),resultBytes:600};
 const freeChat=(f:ReturnType<typeof fixture>)=>{
  const free:Record<string,unknown>={...f.policy};
  delete free.opcTurnToken;delete free.mentorStream;
  return runtimeAdmissionService(f.user,f.admin,free as typeof f.policy);
 };
 const base=fixture();
 const plain=runtimeContext.parse((await freeChat(base).prepare({...base.input,organizeAfter:false})).context);
 expect(plain).not.toHaveProperty('skillCatalog');
 catalogState.value={text:'\n\nAvailable Skills: script-writer',reserveBytes:1200,
  frozen:{skillCatalog:[entry],maxSkillLoads:2,skillCatalogMaxBytes:8000}};
 try{
  const f=fixture();
  const admitted=await freeChat(f).prepare({...f.input,organizeAfter:false});
  const context=runtimeContext.parse(admitted.context);
  expect(context).toMatchObject({role:'ordinary',tools:['load_skill'],skillCatalog:[entry],maxSkillLoads:2,
   skillCatalogMaxBytes:8000,maxToolCalls:plain.maxToolCalls+2,maxTurns:plain.maxTurns+2});
  expect(context.instructions).toContain('Available Skills: script-writer');
  expect(context).not.toHaveProperty('matching');
  expect(admitted.billing.limits.maxCalls).toBe(plain.maxTurns+2);
  expect(admitted.billing.modelId).toBe(first);
  // A mentor turn (the fixture default) never gets the catalog.
  const mentor=fixture();
  const mentorContext=runtimeContext.parse((await mentor.service.prepare({...mentor.input,organizeAfter:false})).context);
  expect(mentorContext).not.toHaveProperty('skillCatalog');expect(mentorContext.tools).not.toContain('load_skill');
 }finally{catalogState.value=undefined;}
});

// The optional catalog is measured where it is serialized: text that fits as raw bytes but not escaped is dropped
// (the reply is then ordinary chat), never accepted and then refused as an over-long request.
it('measures the Skill catalog inside the serialized instructions, so escaped text is dropped rather than refused later',async()=>{
 const f=(()=>{const x=fixture();return x;})();
 const free:Record<string,unknown>={...f.policy};delete free.opcTurnToken;delete free.mentorStream;
 let largestPlain=0,quoted=true;
 catalogState.probe=fits=>{
  let low=0,high=2_000_000;
  while(low<high){const mid=Math.ceil((low+high)/2);if(fits('x'.repeat(mid),0))low=mid;else high=mid-1;}
  largestPlain=low;quoted=fits('"'.repeat(low),0);
 };
 try{await runtimeAdmissionService(f.user,f.admin,free as typeof f.policy).prepare({...f.input,organizeAfter:false});}
 finally{catalogState.probe=undefined;}
 expect(largestPlain).toBeGreaterThan(1000);
 expect(quoted).toBe(false);
});
