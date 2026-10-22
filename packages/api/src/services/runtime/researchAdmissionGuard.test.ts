/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {guardResearchAdmission,requiresBenchmarkResearch} from './researchAdmissionGuard';
import {stagingProcedureError} from './stagingErrors';
import type {ResearchAdmissionRejection} from './researchAdmissionDiagnostics';
import {RESEARCH_TOOLS_CONTEXT_CAPACITY_MESSAGE,RESEARCH_TOOLS_UNAVAILABLE_MESSAGE} from '../../shared/runtimeAdmissionMessages';
const state=vi.hoisted(()=>({rejection:{reason:'CONFIG_DISABLED'} as ResearchAdmissionRejection,attached:false}));
const warn=vi.hoisted(()=>vi.fn());
vi.mock('../../lib/logger',()=>({logger:{warn,info:vi.fn(),error:vi.fn()}}));
vi.mock('./researchAdmission',()=>({attachResearchTurn:async(input:{onRejected:(value:ResearchAdmissionRejection)=>void})=>{
 if(!state.attached)input.onRejected(state.rejection);return state.attached;
}}));
const id='10000000-0000-4000-8000-000000000001';
const secret='PRIVATE_USER_TEXT_AND_CREDENTIAL';
function fixture(outcome:'ok'|'error'|'throw'='ok'){
 const insert=vi.fn(()=>({abortSignal:vi.fn(async()=>{
  if(outcome==='throw')throw new Error(secret);
  return {error:outcome==='error'?{message:secret}:null};
 })}));
 const field={id:'benchmark_findings',value:secret};
 const host={stepId:'any-step-id',checklist:[{id:'any-step-id',fields:[field]}]};
 const input={admin:{from:()=>({insert})},actorId:id,sessionId:id,requestId:id,
  context:{input:secret,instructions:secret,hostTurnContext:host},billing:{contractVersion:'bill2.v2'}};
 return {input:input as unknown as Parameters<typeof guardResearchAdmission>[0],insert};
}
beforeEach(()=>{state.attached=false;state.rejection={reason:'CONFIG_DISABLED'};vi.clearAllMocks();});
it.each(['ok','error','throw'] as const)('records only safe diagnostic metadata and still refuses without a paid fallback (log %s)',async outcome=>{
 const f=fixture(outcome);
 await expect(guardResearchAdmission(f.input)).rejects.toThrow('RESEARCH_TOOLS_UNAVAILABLE');
 expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({level:'warn',category:'api',message:'research_admission_rejected',
  user_id:id,request_id:id,context:expect.objectContaining({reason:'CONFIG_DISABLED',required:true})}));
 expect(warn).toHaveBeenCalledWith('api','research_admission_rejected',expect.objectContaining({persisted:outcome==='ok'}));
 expect(JSON.stringify([f.insert.mock.calls,warn.mock.calls])).not.toContain(secret);
});
it.each([['CONTEXT_CAPACITY','RESEARCH_TOOLS_CONTEXT_CAPACITY',RESEARCH_TOOLS_CONTEXT_CAPACITY_MESSAGE],
 ['CONFIG_DISABLED','RESEARCH_TOOLS_UNAVAILABLE',RESEARCH_TOOLS_UNAVAILABLE_MESSAGE]] as const)(
 'maps %s into an explicit recoverable UI refusal with no charge',async(reason,code,message)=>{
 state.rejection={reason};const f=fixture();
 const refusal=await guardResearchAdmission(f.input).catch(error=>error);
 expect(refusal.message).toBe(code);
 expect(stagingProcedureError(refusal,'opc.mentorTurnStream')).toMatchObject({code:'PRECONDITION_FAILED',message});
});
it('a non-PAYG research step is safely diagnosed and refused too',async()=>{
 const f=fixture();Object.assign(f.input.billing,{contractVersion:'bill2.v1'});
 await expect(guardResearchAdmission(f.input)).rejects.toThrow('RESEARCH_TOOLS_UNAVAILABLE');
 expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({context:expect.objectContaining({reason:'BILLING_PROFILE_UNAVAILABLE'})}));
});
it('does not log or refuse successful tools; non-benchmark steps keep their ordinary discussion',async()=>{
 const f=fixture();state.attached=true;
 await expect(guardResearchAdmission(f.input)).resolves.toBe(true);expect(f.insert).not.toHaveBeenCalled();
 state.attached=false;f.input.context.hostTurnContext!.stepId='ordinary';
 expect(requiresBenchmarkResearch(f.input.context.hostTurnContext)).toBe(false);
 await expect(guardResearchAdmission(f.input)).resolves.toBe(false);
});
