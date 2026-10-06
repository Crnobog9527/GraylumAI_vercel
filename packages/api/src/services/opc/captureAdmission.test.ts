/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {opcService} from './service';
import {OPENING_INPUT,openingRequestId} from './questions';
import type {LocalRuntimePolicy} from '../runtime/admission';
const id='10000000-0000-4000-8000-000000000001';
const requestId='10000000-0000-4000-8000-000000000002';
const sourceId='10000000-0000-4000-8000-000000000003';
const schema=[{id:'goal',title:'Goal',required:true},{id:'audience',title:'Audience',required:true}];
const captured=vi.hoisted(()=>({policy:undefined as LocalRuntimePolicy|undefined,request:undefined as unknown}));
vi.mock('../runtime/admission',()=>({runtimeAdmissionService:(_u:unknown,_a:unknown,p:LocalRuntimePolicy)=>{
 captured.policy=p;return {prepare:async(request:unknown)=>{captured.request=request;return {executionId:id};}};
}}));
vi.mock('../artifacts/workbench',()=>({workbenchService:()=>({read:async()=>({state:'draft',revisionId:id,
 workflow:{steps:[{id:'first',title:'First',information:schema}]},steps:{first:{valid:false}}})})}));
function fixture(saved:unknown=null,replay:unknown=null) {
 const reads:string[]=[];
 const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:saved,error:null})};
 const rpc=vi.fn((name:string,_args:Record<string,unknown>)=>{
  reads.push(name);void _args;
  const map:Record<string,unknown>={opc_query:{projectId:id,roundId:id,sessionId:id,information:{first:{schema,
   values:{goal:{value:'Already known',status:'provisional'}}}}},
   artifact_query:{moduleId:id,workflow:{steps:[{id:'first',resources:[]}]}},runtime_admission_replay:replay,
   runtime_session_context:{waitingOrganizer:null,scopeMaterial:{revision:1,content:{work:{roundId:id,steps:{first:{information:{goal:{value:'Already known',status:'provisional'}}}}}}}},opc_capture_apply:{processed:[],remaining:0,hasMore:false},
   opc_step_material:{revision:1,turnToken:id},runtime_execution:{sessionId:id,context:saved},runtime_view:{executions:[{executionId:sourceId,state:'completed',
    request:{draftId:id,stepId:'first',purpose:'mentor',questionId:'goal'},
    body:JSON.stringify({format:'agent-turn.v1',message:'Choose',card:{question:'Platform?',options:['A','B'],recommended:null}})}]}};
  if(!(name in map))throw new Error(name);
  const conflict = name==='runtime_admission_replay' && saved && reads.filter(n=>n===name).length===1 &&
    (saved as {inputSelection?:string}).inputSelection==='scope-projection-v2';
  if(name==='runtime_view' && saved) map[name]={executions:[{executionId:sourceId,request:{requestId}}]};
  const promise=Promise.resolve({data:map[name],error:conflict?{message:'RUNTIME_REQUEST_CONFLICT'}:null});return Object.assign(promise,{abortSignal:()=>promise});
 });
 const admin={rpc,from:()=>query} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 return {service:opcService(user,admin),rpc,reads};
}
const request={draftId:id,requestId,stepId:'first',purpose:'mentor',input:'A new statement',organizeAfter:true,questionId:'goal'};
beforeEach(()=>{captured.policy=undefined;captured.request=undefined;});
it('new mentor uses a server focus even for valid old client question ids',async()=>{
 await fixture().service.prepareStep(request);
 expect(captured.request).toMatchObject({selection:{task:'opc-question:audience'}});
 expect(captured.policy!.hostTurnContext).toMatchObject({stepId:'first',opening:false});
 expect(JSON.parse(captured.policy!.organizerInput!)).toHaveProperty('captureFormat','v2');
 expect({request:captured.request,policy:captured.policy}).toMatchSnapshot();
});
it('answers inherit the source task rather than a changed form focus',async()=>{
 await fixture().service.prepareStep({...request,questionId:'audience',answerSource:{executionId:sourceId,optionIndex:1}});
 expect(captured.request).toMatchObject({selection:{task:'opc-question:goal'}});
 expect(captured.policy!.resolvedInput).toBe('B');
 expect(JSON.parse(captured.policy!.organizerInput!).answeredCard.selectedOption).toBe('B');
 expect({request:captured.request,policy:captured.policy}).toMatchSnapshot();
});
it('openings normalize to the first field identity for the step and round',async()=>{
 await fixture().service.prepareStep({...request,questionId:'audience',input:OPENING_INPUT,organizeAfter:false});
 expect(captured.request).toMatchObject({requestId:openingRequestId(id,id,'first','goal'),selection:{task:'opc-opening:goal'}});
 expect(captured.policy!.hostTurnContext!.opening).toBe(true);
 expect({request:captured.request,policy:captured.policy}).toMatchSnapshot();
});
it('B2 replay restores its frozen task before capture, while SQL checks the full identity',async()=>{
 const f=fixture({inputSelection:'scope-projection-v2',request:{selection:{task:'opc-question:audience'}}},{executionId:sourceId});
 expect(await f.service.prepareStep(request)).toEqual({executionId:sourceId});
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admission_replay').at(-1)![1].p_request)
  .toMatchObject({selection:{task:'opc-question:audience'},input:request.input});
 expect(f.reads).not.toContain('opc_capture_apply');expect(captured.policy).toBeUndefined();
});
it('legacy replay retains the original client task before new schema/focus checks',async()=>{
 const f=fixture({inputSelection:'scope-projection-v1'},{executionId:sourceId});
 await f.service.prepareStep({...request,questionId:'old-field'});
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admission_replay').at(-1)![1].p_request)
  .toMatchObject({selection:{task:'opc-question:old-field'}});
});
it('rejects an unknown new field before material, billing or model admission',async()=>{
 const f=fixture();await expect(f.service.prepareStep({...request,questionId:'unknown'})).rejects.toThrow('OPC_QUESTION_NOT_REACHED');
 expect(f.reads).not.toContain('opc_step_material');expect(captured.policy).toBeUndefined();
});
