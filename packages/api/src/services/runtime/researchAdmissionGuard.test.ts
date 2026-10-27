/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {guardResearchAdmission,requiresBenchmarkResearch,researchInputHost} from './researchAdmissionGuard';
import {stagingProcedureError} from './stagingErrors';
import type {ResearchAdmissionRejection} from './researchAdmissionDiagnostics';
import {RESEARCH_TOOLS_CONTEXT_CAPACITY_MESSAGE,RESEARCH_TOOLS_UNAVAILABLE_MESSAGE} from '../../shared/runtimeAdmissionMessages';
const state=vi.hoisted(()=>({rejection:{reason:'CONFIG_DISABLED'} as ResearchAdmissionRejection,attached:false,required:undefined as unknown}));
const warn=vi.hoisted(()=>vi.fn());
vi.mock('../../lib/logger',()=>({logger:{warn,info:vi.fn(),error:vi.fn()}}));
vi.mock('./researchAdmission',()=>({attachResearchTurn:async(input:{requiredTools?:unknown;onRejected:(value:ResearchAdmissionRejection)=>void})=>{
 state.required=input.requiredTools;
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
beforeEach(()=>{state.required=undefined;state.attached=false;state.rejection={reason:'CONFIG_DISABLED'};vi.clearAllMocks();});
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

it('new projection preserves the existing host ceiling and leaves openings, summaries and disabled turns unchanged',async()=>{
 const {hostTurnContextSchema,HOST_TURN_MAX_BYTES}=await import('./hostTurn');
 const host=hostTurnContextSchema.parse({stepId:'s',opening:false,checklist:[{id:'s',title:'Research',fields:[{
  id:'benchmark_findings',title:'Findings',required:true,role:'agent_proposal',status:'draft',protected:false,value:'x'}]}]});
 expect(researchInputHost(host,true)?.materialProjection).toBe('checklist-dedup-v1');
 expect(researchInputHost(host,false)).toBe(host);
 expect(researchInputHost({...host,opening:true},true)?.materialProjection).toBeUndefined();
 const value=host.checklist[0]!.fields[0]!;
 value.value='x'.repeat(HOST_TURN_MAX_BYTES-Buffer.byteLength(JSON.stringify(host))+1);
 expect(Buffer.byteLength(JSON.stringify(host))).toBe(HOST_TURN_MAX_BYTES);
 expect(hostTurnContextSchema.safeParse(host).success).toBe(true);
 expect(researchInputHost(host,true)).toBe(host);
 expect(host).not.toHaveProperty('materialProjection');
});

// A pasted profile link asks for that account to be checked on any step: it needs benchmark_fetch as a benchmark step does.
const link='https://www.tiktok.com/@solidstarts';
const asStep=(f:ReturnType<typeof fixture>,step:'step-1'|'step-2'|'step-3',text?:string)=>{
 const fields={'step-1':['goal','benchmarks'],'step-2':['feasibility','benchmark_findings'],'step-3':['positioning']}[step];
 const host={stepId:step,checklist:[{id:step,fields:fields.map(id=>({id,value:''}))}]};
 Object.assign(f.input.context,{hostTurnContext:host});Object.assign(f.input,{userText:text});
};
it.each(['step-1','step-2','step-3'] as const)('%s: a turn with a profile link that cannot fit the tools is refused with no charge',async step=>{
 state.rejection={reason:'CONTEXT_CAPACITY'};const f=fixture();asStep(f,step,`帮我看看这个账号 ${link}`);
 const refusal=await guardResearchAdmission(f.input).catch(error=>error);
 expect(refusal.message).toBe('RESEARCH_TOOLS_CONTEXT_CAPACITY');
 expect(stagingProcedureError(refusal,'opc.mentorTurnStream')).toMatchObject({message:RESEARCH_TOOLS_CONTEXT_CAPACITY_MESSAGE});
 expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({context:expect.objectContaining({required:true,reason:'CONTEXT_CAPACITY'})}));
});
it('a link turn that fits is attached and asks only for the fetch tool outside a benchmark step',async()=>{
 state.attached=true;const f=fixture();asStep(f,'step-1',link);
 await expect(guardResearchAdmission(f.input)).resolves.toBe(true);
 expect(state.required).toEqual(['benchmark_fetch']);
 asStep(f,'step-2',link);await guardResearchAdmission(f.input);
 expect(state.required).toEqual(['propose_keywords','benchmark_discover','propose_more_candidates','benchmark_fetch']);
});
it.each([undefined,'继续找对标','@solidstarts 帮我看看','https://www.tiktok.com/@solidstarts/video/123','https://example.com/@a'])(
 'without a profile link (%s) a non-benchmark step behaves as before: no refusal',async text=>{
 state.rejection={reason:'CONTEXT_CAPACITY'};const f=fixture();asStep(f,'step-1',text);
 await expect(guardResearchAdmission(f.input)).resolves.toBe(false);expect(state.required).toBeUndefined();
 expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({context:expect.objectContaining({required:false})}));
});
