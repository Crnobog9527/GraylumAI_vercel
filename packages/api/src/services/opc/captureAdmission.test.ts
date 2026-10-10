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
function fixture(saved:unknown=null,replay:unknown=null, frozen?:Record<string, unknown>) {
 const reads:string[]=[];
 const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:saved,error:null})};
 const rpc=vi.fn((name:string,_args:Record<string,unknown>)=>{
  reads.push(name);void _args;
  const map:Record<string,unknown>={opc_query:{projectId:id,roundId:id,sessionId:id,information:{first:{schema,
   values:{goal:{value:'Already known',status:'provisional'}}}}},
   artifact_query:{moduleId:id,workflow:{steps:[{id:'first',resources:[]}]}},runtime_admission_replay:replay,
   runtime_session_context:{waitingOrganizer:null,scopeMaterial:{revision:1,content:{work:{roundId:id,steps:{first:{information:{goal:{value:'Already known',status:'provisional'}},...frozen}}}}}},opc_capture_apply:{processed:[],remaining:0,hasMore:false},
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

it('explicit checklist notification uses ordinary request identity and no organizer user speech',async()=>{
 const {checklistUpdatedInput}=await import('../../shared/opcQuestions');
 const input=checklistUpdatedInput(['goal']);
 await fixture().service.prepareStep({...request,input});
 expect(captured.request).toMatchObject({requestId,input,organizeAfter:true});
 expect(captured.policy).toMatchObject({maxCalls:3,inputBytes:64000,hostTurnContext:{updatedFieldIds:['goal']}});
 const organizer=JSON.parse(captured.policy!.organizerInput!);
 expect(organizer).toMatchObject({userInput:'',hostEvent:{kind:'checklist_updated',fieldIds:['goal']}});
 expect(captured.policy!.additionalInstructions).not.toContain(input);
 const replay=fixture(null,{executionId:sourceId});
 expect(await replay.service.prepareStep({...request,input})).toEqual({executionId:sourceId});
 expect(replay.reads).not.toContain('opc_capture_apply');
});
it('refuses malformed, unknown or mis-scoped host updates before admission',async()=>{
 for(const input of ['HOST_CHECKLIST_UPDATED:[]','HOST_CHECKLIST_UPDATED:bad','HOST_CHECKLIST_UPDATED:["unknown"]']) {
  const f=fixture();
  await expect(f.service.prepareStep({...request,input})).rejects.toThrow('OPC_INFORMATION_INVALID');
  expect(f.reads).not.toContain('opc_step_material');
 }
 await expect(fixture().service.prepareStep({...request,purpose:'step',input:'HOST_CHECKLIST_UPDATED:["goal"]'}))
  .rejects.toThrow('OPC_STEP_DENIED');
});

it.each(['继续','下一步','没问题','好的','确认了，进入下一步','好的，后续我想每周发三次']) (
 'complete unconfirmed steps stay behind the confirmation gate for %s', async input => {
  const f=fixture(null,null,{valid:false,information:{goal:{value:'Recorded goal',status:'provisional'},
   audience:{value:'Pilot first',status:'deferred'}},fieldMeta:{goal:{source:'capture',basis:'user_statement'}}});
  await f.service.prepareStep({...request,input});
  expect(captured.policy!.hostTurnContext!.confirmation).toEqual({requiredComplete:true,stepConfirmed:false,
   stepReady:true,needsLookFieldIds:['goal']});
  expect(captured.policy!.additionalInstructions).toContain('Do not start the next step');
  expect(captured.policy!.additionalInstructions).toContain('any verbal assent are not confirmation');
  expect(JSON.parse(captured.policy!.organizerInput!).userInput).toBe(input);
  expect(captured.policy!.organizerInstructions).toContain('including later steps');
  expect(f.reads).not.toContain('artifact_transition');
  expect(f.reads).not.toContain('opc_information');
 });
it('uses frozen step validity rather than the earlier snapshot and preserves legacy replay',async()=>{
 await fixture(null,null,{valid:true,information:{goal:{value:'A',status:'confirmed'},audience:{value:'B',status:'confirmed'}}})
  .service.prepareStep(request);
 expect(captured.policy!.hostTurnContext!.confirmation).toMatchObject({stepConfirmed:true,stepReady:false});
});
