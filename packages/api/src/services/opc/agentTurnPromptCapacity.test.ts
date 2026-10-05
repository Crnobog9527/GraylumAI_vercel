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
import {captureWorkflowSteps as steps} from '../__tests__/fixtures/captureWorkflow';
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
    artifact_query:{moduleId:id,workflow:{steps}},runtime_admission_replay:null,runtime_session_context:{waitingOrganizer:null,scopeMaterial:{revision:1,content:{work:{roundId:id,steps:Object.fromEntries(steps.map((step,index)=>[step.id,{information:information[step.id]!.values,valid:index<5}]))}}}},
    opc_capture_apply:{processed:[],remaining:0,hasMore:false},opc_step_material:{revision:1,turnToken:id},
   };
   if(!(name in data))throw new Error('Unexpected local fixture RPC: '+name);
   const response=Promise.resolve({data:data[name],error:null});
   return Object.assign(response,{abortSignal:()=>response});
  })} as unknown as SupabaseClient;
  const user={auth:{getUser:async()=>({data:{user:{id,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
  await opcService(user,admin).prepareStep({draftId:id,requestId:id,purpose:'mentor',stepId:'step-6',
   questionId:'offer',input:opening?OPENING_INPUT:'我不确定，帮我分析',organizeAfter:!opening});
  const direct=agentTurnInstructions();
  const complete=captured.policy!.additionalInstructions!;
  expect(complete).toBe(direct);
  expect(captured.policy!.hostTurnContext!.checklist).toHaveLength(6);
  expect(captured.policy!.hostTurnContext!.opening).toBe(opening);
  expect(complete).not.toContain('Current workflow step:');
  expect(Buffer.byteLength(JSON.stringify(captured.policy!.hostTurnContext))).toBeLessThanOrEqual(16000);
  expect(complete.length).toBeLessThanOrEqual(8000);
  // Keep room for later host rules; raise it only with a capacity plan.
  expect(8000-complete.length).toBeGreaterThanOrEqual(200);
  expect(z.string().max(8000).safeParse(complete).success).toBe(true);
  console.info('Synthetic final-step prompt capacity',JSON.stringify({opening,status,
   builderCharacters:direct.length,additionalCharacters:complete.length,utf8Bytes:Buffer.byteLength(complete)}));
 });

vi.mock('../runtime/newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('../runtime/newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
