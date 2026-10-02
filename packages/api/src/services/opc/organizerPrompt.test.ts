/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it,vi,beforeEach} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {LocalRuntimePolicy} from '../runtime/admission';
import {opcService} from './service';
import {ORGANIZER_INSTRUCTIONS,organizerStepMaterial} from './organizerPrompt';
const captured=vi.hoisted(()=>({policy:undefined as LocalRuntimePolicy|undefined}));
vi.mock('../runtime/admission',()=>({runtimeAdmissionService:(_u:unknown,_a:unknown,p:LocalRuntimePolicy)=>{
  captured.policy=p;return {prepare:async()=>({executionId:'synthetic'})};
}}));
const schema=[{id:'goal',title:'目标与变现方式',required:true},
  {id:'audience',title:'服务受众',required:true},{id:'platform',title:'起步平台',required:true}];
const id='10000000-0000-4000-8000-000000000001';
const values={goal:{status:'provisional',nature:'decision',value:'增加工作日下午的到店客流，暂不扩店'},
  audience:{status:'unknown',nature:'unknown',value:''},platform:{status:'deferred',nature:'unknown',value:''}};
vi.mock('../artifacts/workbench',()=>({workbenchService:()=>({read:async()=>({state:'draft',revisionId:id,
  workflow:{steps:[{id:'current',title:'了解你',information:schema}]},steps:{current:{valid:false}}})})}));
beforeEach(()=>{captured.policy=undefined;});
describe('organizer complete-value context',()=>{
  it('projects only pinned current-step fields with values and statuses, including missing fields',()=>{
    expect(organizerStepMaterial('current',schema,{...values,foreign:{value:'not in schema'}})).toEqual({id:'current',fields:[
      {id:'goal',title:'目标与变现方式',required:true,elicit:'user_fact',...values.goal},
      {id:'audience',title:'服务受众',required:true,elicit:'user_fact',...values.audience},
      {id:'platform',title:'起步平台',required:true,elicit:'user_fact',...values.platform},
    ]});
    expect(organizerStepMaterial('current',schema,null)).toEqual(organizerStepMaterial('current',schema));
    expect(organizerStepMaterial('current',schema).fields.every(f=>f.value===''&&f.status==='unknown')).toBe(true);
  });
  it.each([
    ['audience answer', '先服务附近独自阅读的自由职业者，给他们安静的空间'],
    ['platform choice', '小红书'],
  ])('freezes existing goal and off-topic %s separately without widening writable fields',async(_name,input)=>{
    const admin={rpc:vi.fn((name:string)=>{
      const data:Record<string,unknown>={opc_query:{projectId:id,roundId:id,sessionId:id,information:{current:{schema,values}}},
        artifact_query:{moduleId:id,workflow:{steps:[{id:"current",resources:[]}] }},runtime_admission_replay:null,opc_capture_apply:{processed:[],remaining:0,hasMore:false},opc_step_material:{revision:1,turnToken:id}};
      if(!(name in data))throw new Error(name);
      const response=Promise.resolve({data:data[name],error:null});
      return Object.assign(response,{abortSignal:()=>response});
    })} as unknown as SupabaseClient;
    const user={auth:{getUser:async()=>({data:{user:{id,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
    await opcService(user,admin).prepareStep({draftId:id,requestId:id,stepId:'current',questionId:'goal',
      purpose:'mentor',organizeAfter:true,input});
    const frozen=JSON.parse(captured.policy!.organizerInput!);
    expect(frozen.userInput).toBe(input);
    expect(frozen.currentStepMaterial).toEqual(organizerStepMaterial('current',schema,values));
    expect(frozen.currentQuestion.id).toBe('goal');
    expect(frozen.allowedWorkflow[0].fields).toEqual([{id:'goal',title:'目标与变现方式'}]);
    expect(captured.policy!.organizerInstructions).toContain('return an empty informationPatch: do not put an audience answer or a platform choice');
    expect(captured.policy!.additionalInstructions).toContain('If the user answers another topic, respond briefly');
    expect(captured.policy!.additionalInstructions).toContain('never confirm or advance on their behalf');
  });
  it('requires complete updates, unchanged-content empty patches, and provisional status',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('updated COMPLETE value, preserving valid information');
    expect(ORGANIZER_INSTRUCTIONS).toContain('If there is no substantive change, return an empty informationPatch');
    expect(ORGANIZER_INSTRUCTIONS).toContain('only for an explicit correction or contradiction');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Updates remain provisional');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Never return confirmed or deferred');
  });
  it('separates user statements from mentor proposals when merging complete values',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('For user_fact, retain supported user-stated content and add only what the user stated');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Use the mentor reply only to understand context');
    expect(ORGANIZER_INSTRUCTIONS).toContain("never merge the mentor's guesses or recommendations as user facts");
    expect(ORGANIZER_INSTRUCTIONS).toContain('Only an agent_proposal field may adopt a relevant concrete mentor recommendation, with basis agent_proposal');
    expect(ORGANIZER_INSTRUCTIONS).not.toContain('combine its existing supported content with the relevant user answer and the primary mentor reply');
  });
  it('bounds every complete value and preserves qualifications when condensing',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('Each field value must be at most 400 characters');
    expect(ORGANIZER_INSTRUCTIONS).toContain('condense it into concise key points within that limit');
    expect(ORGANIZER_INSTRUCTIONS).toContain('preserving key facts, decisions, negation, constraints and uncertainty');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Do not emit an overlong value that the host would discard');
    expect(ORGANIZER_INSTRUCTIONS).toContain('or drop important qualifications merely to shorten it');
  });

});
