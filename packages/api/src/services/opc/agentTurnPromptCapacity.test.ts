/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {beforeEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {LocalRuntimePolicy} from '../runtime/admission';
import {OPENING_INPUT} from '../../shared/opcQuestions';
import {parseWorkflowManifest} from '../skills/workflowManifest';
import {agentTurnInstructions} from './agentTurnPrompt';
import {opcService} from './service';

const captured=vi.hoisted(()=>({policy:undefined as LocalRuntimePolicy|undefined,snapshot:undefined as unknown}));
vi.mock('../runtime/admission',()=>({runtimeAdmissionService:(_user:unknown,_admin:unknown,policy:LocalRuntimePolicy)=>{
 captured.policy=policy;return {prepare:async()=>({executionId:'synthetic'})};
}}));
vi.mock('../artifacts/workbench',()=>({workbenchService:()=>({read:async()=>captured.snapshot})}));

// Public metadata already represented by mergedPositioningFixture. Its six-step,
// nine-field projection was checked against the private workflow with the hash
// in docs/skill-candidates/positioning-mentor-v3/file-hashes.json. No private
// Skill prose, credentials or user material is included in this fixture.
const titles=['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'];
const fields=[
 [['product','产品与服务','user_fact'],['platforms','准备经营的平台','user_fact'],['time','每周可用时间','user_fact']],
 [['reference','参考研究结论','agent_proposal']],
 [['audience','优先服务的用户','agent_proposal'],['difference','价值与依据','user_fact']],
 [['roles','内容表达与平台安排','agent_proposal']],
 [['cadence','可持续的制作安排','agent_proposal']],
 [['offer','内容如何支持业务','agent_proposal']],
] as const;
const steps=titles.map((title,index)=>({id:`step-${index+1}`,title,resources:['SKILL.md'],
 information:fields[index]!.map(([id,title,elicitation])=>({id,title,required:true,profileKey:id,elicitation})),
}));
const id='10000000-0000-4000-8000-000000000001';
const workflowHash='9f53a1be0d21cbade5daaa9c54c1930b1d2e8e336455c92021df61b6a5b0ab02';
const privateRoot=process.env.V3_MENTOR_SKILL_CANDIDATE;
beforeEach(()=>{captured.policy=undefined;captured.snapshot=undefined;});

it.skipIf(!privateRoot)('matches the pinned private workflow through its public step/field projection',()=>{
 const bytes=readFileSync(resolve(privateRoot!,'social-media-commercial-strategist/workflow.yaml'));
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(workflowHash);
 const parsed=parseWorkflowManifest(bytes.toString('utf8'));
 expect(parsed.steps.map(({title,information})=>({title,information})))
  .toEqual(steps.map(({title,information})=>({title,information})));
});

it.each([false,true].flatMap(opening=>['missing','provisional','confirmed','deferred'].map(status=>({opening,status}))))(
 'the real six-step method fits the complete host instruction limit at its last step ($opening, $status)',
 async({opening,status})=>{
  const information=Object.fromEntries(steps.map((step,index)=>[step.id,{schema:step.information,
   values:Object.fromEntries(step.information.flatMap(field=>index===5&&status==='missing'?[]:[[field.id,{
    status:index===5?status:'confirmed',value:'Synthetic confirmed material',nature:'decision',
   }]])),
  }]));
  captured.snapshot={state:'draft',revisionId:id,workflow:{steps},
   steps:Object.fromEntries(steps.map((step,index)=>[step.id,{valid:index<5}]))};
  const admin={rpc:vi.fn((name:string)=>{
   const data:Record<string,unknown>={
    opc_query:{projectId:id,roundId:id,sessionId:id,information},
    artifact_query:{moduleId:id,workflow:{steps}},runtime_admission_replay:null,
    opc_step_material:{revision:1,turnToken:id},
   };
   if(!(name in data))throw new Error('Unexpected local fixture RPC: '+name);
   const response=Promise.resolve({data:data[name],error:null});
   return Object.assign(response,{abortSignal:()=>response});
  })} as unknown as SupabaseClient;
  const user={auth:{getUser:async()=>({data:{user:{id,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
  await opcService(user,admin).prepareStep({draftId:id,requestId:id,purpose:'mentor',stepId:'step-6',
   questionId:'offer',input:opening?OPENING_INPUT:'我不确定，帮我分析',organizeAfter:!opening});
  const expectedWorkflow=steps.map((step,index)=>({id:step.id,title:step.title,confirmed:index<5,
   fields:step.information.map(({id,title})=>({id,title})),
  }));
  const step=steps[5]!;
  const direct=agentTurnInstructions({step:{id:step.id,title:step.title,
   schema:step.information,values:information[step.id]!.values},
   question:step.information[0]!,questionLabel:'6.1',workflowContext:expectedWorkflow,opening});
  const complete=captured.policy!.additionalInstructions!;
  expect(complete).toBe(direct);
  expect(complete).toContain('Current workflow step: step-6');
  expect(complete).toContain('Steps and allowed fields: '+JSON.stringify(expectedWorkflow));
  expect(complete).toContain('A status supplies no value');
  expect(complete).toContain('this overrides every case');
  expect(complete).toContain('it never guesses the user\'s situation');
  expect(complete).toContain('total time across combined activities');
  const statusLengths={missing:7,provisional:11,confirmed:9,deferred:8};
  const expectedLength=(opening?7766:7213)+statusLengths[status as keyof typeof statusLengths];
  expect(complete.length).toBe(expectedLength);
  expect(complete.length).toBeLessThanOrEqual(8000);
  // Keep room for later host rules; raise it only with a capacity plan.
  expect(8000-complete.length).toBeGreaterThanOrEqual(200);
  expect(z.string().max(8000).safeParse(complete).success).toBe(true);
  console.info('Synthetic final-step prompt capacity',JSON.stringify({opening,status,
   builderCharacters:direct.length,additionalCharacters:complete.length,utf8Bytes:Buffer.byteLength(complete)}));
 });
