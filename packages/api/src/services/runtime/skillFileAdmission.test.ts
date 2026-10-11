/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {packageHash,sha256} from '../skills/loader';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './runtimeContext';
import {StagingAccessError,stagingProcedureError} from './stagingErrors';
import {RUNTIME_INPUT_TOO_LONG_MESSAGE} from '../../shared/runtimeInputMessages';
import {OPENING_INPUT} from '../../shared/opcQuestions';
vi.mock('./newWorkGate',async original=>({...await original<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates}));
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[descriptor],state:async()=> 'enabled'})}));
const skill=vi.hoisted(()=>({instructions:'Synthetic Skill',file:'',activations:0,tooLarge:false}));
const matching=vi.hoisted(()=>({candidates:[] as unknown[]}));
vi.mock('./matching',async original=>({...await original<typeof import('./matching')>(),discoverRuntimeCandidates:async()=>matching.candidates}));
vi.mock('../skills/loader',async original=>{const real=await original<typeof import('../skills/loader')>();return {...real,
 readSkillResource:async()=>skill.file,activateSkill:async()=>{skill.activations++;
  if(skill.tooLarge)throw new real.SkillLoadError('CAPACITY_EXCEEDED');return {forModel:()=>skill.instructions};}};});
const actor='10000000-0000-4000-8000-000000000001';
const model='10000000-0000-4000-8000-000000000002';
const revision='10000000-0000-4000-8000-000000000003';
const module='10000000-0000-4000-8000-000000000004';
const base={packageId:module,revisionId:revision,directoryName:'test',files:[{
 path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[],
}],tasks:{},requiredCapabilities:[]};
const descriptor={...base,packageHash:packageHash(base)};
function fixture(){
 skill.instructions='Synthetic Skill';skill.file='';skill.activations=0;skill.tooLarge=false;matching.candidates=[];
 let saved:unknown=null;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:actor}},error:null};
  if(name==='runtime_admission_replay')return {data:saved,error:null};
  if(name==='runtime_admit'){saved={context:args.p_payload,billing:args.p_billing};return {data:saved,error:null};}
  throw new Error(name);
 });
 const admin={rpc,from:(table:string)=>{
  const query={select:()=>query,eq:()=>query,in:async()=>({data:[],error:null}),single:async()=>({error:null,data:
   table==='modules'?{id:module,active:true,skill_id:module,model_id:model}:
    {id:model,model_id:'fixture',provider:'fixture',is_active:'true',max_tokens:1000,input_limit:64000}})};
  return query;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={account:'test',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,
  maxOutputTokens:100,inputBytes:32000,historyItems:0,mentorStream:true,skillFileRead:true,opcTurnToken:actor};
 const input={sessionId:actor,requestId:model,input:'Please explain the reference.',network:'deny',
  selection:{kind:'skill',moduleId:module,revisionId:revision}};
 return {user,admin,policy,input,rpc};
}
it('freezes package identity, one tool read and two model calls; reuses original admission',async()=>{
 const f=fixture(),service=runtimeAdmissionService(f.user,f.admin,f.policy);
 const admitted=await service.prepare(f.input),context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['ask_question','read_skill_file']);
 expect(context.skillFile).toEqual({packageId:module,revisionId:revision,packageHash:descriptor.packageHash});
 expect(context.maxTurns).toBe(2);expect(context.maxToolCalls).toBe(1);
 const replay=await runtimeAdmissionService(f.user,f.admin,{...f.policy,skillFileRead:false}).prepare(f.input);
 expect(replay).toEqual(admitted);
 expect(runtimeContext.safeParse({...context,skillId:actor}).success).toBe(false);
 expect(runtimeContext.safeParse({...context,maxTurns:1}).success).toBe(false);
});
it('host openings offer no file tool',async()=>{
 const f=fixture();
 const admitted=await runtimeAdmissionService(f.user,f.admin,{...f.policy,maxCalls:1})
  .prepare({...f.input,input:OPENING_INPUT});
 expect(admitted.context.tools).toEqual([]);
 expect(admitted.context.skillFile).toBeUndefined();
});

it('admits without the optional file tool when only its continuation reserve does not fit',async()=>{
 // Staging step-2 shape: large step resources plus a near-limit declared file overflow the interactive cap.
 const f=fixture();skill.instructions='S'.repeat(13000);skill.file='y'.repeat(15000);
 const admitted=await runtimeAdmissionService(f.user,f.admin,{...f.policy,inputBytes:32000})
  .prepare({...f.input,input:'这一步先到这里'}),context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['ask_question']);
 expect(context.skillFile).toBeUndefined();expect(context.skillFileReserve).toBeUndefined();
 expect(context.instructions).not.toContain('read_skill_file');expect(context.maxToolCalls).toBe(1);
 // The runner only accepts two committed turns with the file tool; its continuation call is dropped too.
 expect(context.maxTurns).toBe(1);expect(admitted.billing.limits.maxCalls).toBe(1);
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
});

it('refuses user input that does not fit even without the file tool as a typed refusal before admission',async()=>{
 const f=fixture();
 const refused=runtimeAdmissionService(f.user,f.admin,{...f.policy,inputBytes:14000}).prepare({...f.input,input:'中'.repeat(8000)});
 await expect(refused).rejects.toBeInstanceOf(StagingAccessError);
 await expect(refused).rejects.toThrow('RUNTIME_INPUT_TOO_LONG');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

const candidateModel=(n:number)=>`10000000-0000-4000-8000-0000000000${10+n}`;
const autoCandidate=(n:number,inputLimit:number)=>({key:'candidate-'+n,name:'Synthetic '+n,description:'Synthetic skill',moduleId:module,skillId:module,
 packageId:module,revisionId:revision,packageHash:descriptor.packageHash,modelId:candidateModel(n),model:'fixture',inputLimit,outputLimit:100,requiresTask:false});
const autoPolicy={inputBytes:32000,mentorStream:false,skillFileRead:false,opcTurnToken:undefined};
const autoInput={selection:{kind:'auto',modelId:model}};

it('drops an automatic match candidate whose own capacity cannot run the selected Skill before any charge',async()=>{
 const f=fixture();skill.instructions='S'.repeat(9000);
 matching.candidates=[autoCandidate(0,14000),autoCandidate(1,10000)];
 const admitted=await runtimeAdmissionService(f.user,f.admin,{...f.policy,...autoPolicy})
  .prepare({...f.input,...autoInput,input:'x'.repeat(3000)});
 expect(admitted.context.matching.candidates.map((c:{key:string})=>c.key)).toEqual(['candidate-0']);
 expect(admitted.billing.callPolicy.map((p:{modelId:string})=>p.modelId)).not.toContain(candidateModel(1));
 expect(admitted.context.maxTurns).toBe(1);
});

it('skips the paid match and admits an ordinary turn when no candidate can hold the input',async()=>{
 const f=fixture();skill.instructions='S'.repeat(9000);
 matching.candidates=[autoCandidate(0,2000),autoCandidate(1,10000)];
 const admitted=await runtimeAdmissionService(f.user,f.admin,{...f.policy,...autoPolicy})
  .prepare({...f.input,...autoInput,input:'x'.repeat(3000)});
 expect(admitted.context.matching).toBeUndefined();expect(admitted.context.role).toBe('ordinary');
 expect(admitted.context.maxTurns).toBe(2);
 expect(admitted.billing.callPolicy.map((p:{modelId:string})=>p.modelId)).toEqual([model]);
 // The 2000-byte candidate cannot hold the input alone, so only the other one loaded its Skill.
 expect(skill.activations).toBe(1);
});

it('drops a candidate whose Skill is too large for its own model instead of failing the turn',async()=>{
 const f=fixture();skill.tooLarge=true;matching.candidates=[autoCandidate(0,14000)];
 const admitted=await runtimeAdmissionService(f.user,f.admin,{...f.policy,...autoPolicy})
  .prepare({...f.input,...autoInput,input:'x'.repeat(3000)});
 expect(admitted.context.matching).toBeUndefined();expect(admitted.context.role).toBe('ordinary');
 expect(skill.activations).toBe(1);
});

it('refuses before admission when neither a candidate nor the ordinary turn can hold the input',async()=>{
 const f=fixture();matching.candidates=[autoCandidate(0,2000)];
 const refused=runtimeAdmissionService(f.user,f.admin,{...f.policy,...autoPolicy,inputBytes:14000})
  .prepare({...f.input,...autoInput,input:'中'.repeat(8000)});
 await expect(refused).rejects.toThrow('RUNTIME_INPUT_TOO_LONG');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('refuses too-long input during automatic Skill matching with the same typed refusal',async()=>{
 const f=fixture();
 matching.candidates=[{key:'candidate-1',name:'Synthetic',description:'Synthetic skill',moduleId:module,skillId:module,packageId:module,
  revisionId:revision,packageHash:descriptor.packageHash,modelId:model,model:'fixture',inputLimit:14000,outputLimit:100,requiresTask:false}];
 const refused=runtimeAdmissionService(f.user,f.admin,{...f.policy,inputBytes:14000,mentorStream:false,skillFileRead:false,opcTurnToken:undefined})
  .prepare({...f.input,input:'中'.repeat(8000),selection:{kind:'auto',modelId:model}});
 await expect(refused).rejects.toThrow('RUNTIME_INPUT_TOO_LONG');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('maps too-long input to a fixed refusal without a diagnostic identifier',()=>{
 const error=stagingProcedureError(new StagingAccessError('RUNTIME_INPUT_TOO_LONG'),'opc.mentorTurnStream');
 expect(error.code).toBe('PRECONDITION_FAILED');expect(error.message).toBe(RUNTIME_INPUT_TOO_LONG_MESSAGE);
 expect(error.message).not.toContain('诊断编号');
});

it('keeps an overflow that does not depend on user input an untyped server failure',async()=>{
 const f=fixture();skill.instructions='S'.repeat(20000);
 const refused=runtimeAdmissionService(f.user,f.admin,{...f.policy,inputBytes:14000}).prepare(f.input);
 await expect(refused).rejects.toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 await expect(refused).rejects.not.toBeInstanceOf(StagingAccessError);
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('summary freezes only the file tool, refuses contradictory context and replays unchanged',async()=>{
 const f=fixture();
 const host={stepId:'first',opening:false,checklist:[],stepSummary:{kind:'step_summary' as const,missingRequiredFieldIds:['goal']}};
 const service=runtimeAdmissionService(f.user,f.admin,{...f.policy,hostTurnContext:host});
 const input={...f.input,input:'HOST_STEP_SUMMARY:v1'};
 const admitted=await service.prepare(input),context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['read_skill_file']);expect(context.maxToolCalls).toBe(1);
 expect(context.attachedOrganizer).toBeUndefined();
 expect(context.instructions).not.toContain('then answer or show a question card');
 expect(runtimeContext.safeParse({...context,tools:['ask_question','read_skill_file']}).success).toBe(false);
 expect(runtimeContext.safeParse({...context,input:'ordinary speech'}).success).toBe(false);
 expect(await service.prepare(input)).toEqual(admitted);
});
