/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {packageHash,sha256} from '../skills/loader';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './runtimeContext';
import {OPENING_INPUT} from '../../shared/opcQuestions';
vi.mock('./newWorkGate',async original=>({...await original<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates}));
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[descriptor]})}));
vi.mock('../skills/loader',async original=>({...await original<typeof import('../skills/loader')>(),
 activateSkill:async()=>({forModel:()=> 'Synthetic Skill'})}));
const actor='10000000-0000-4000-8000-000000000001';
const model='10000000-0000-4000-8000-000000000002';
const revision='10000000-0000-4000-8000-000000000003';
const module='10000000-0000-4000-8000-000000000004';
const base={packageId:module,revisionId:revision,directoryName:'test',files:[{
 path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[],
}],tasks:{},requiredCapabilities:[]};
const descriptor={...base,packageHash:packageHash(base)};
function fixture(){
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
 return {user,admin,policy,input};
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
