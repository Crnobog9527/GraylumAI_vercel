/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {createTRPCContext} from '../../trpc';
import type {makeWorkflow} from '../__tests__/fixtures/artifacts';
import * as gates from './newWorkGate';
import * as redis from '../redisRateLimiter';
import {opcRouter} from '../../routers/opc';
import {runtimeRouter} from '../../routers/runtime';
import {opcService} from '../opc/service';
import {workbenchService} from '../artifacts/workbench';
import {OPENING_INPUT} from '../../shared/opcQuestions';
import {readRuntimeView} from './view';
type Fixture={actor:string;user:SupabaseClient;admin:SupabaseClient;registration:string;
 flow:ReturnType<typeof makeWorkflow>;context:()=>ReturnType<typeof createTRPCContext>;draft:()=>Promise<{draftId:string}>};

export function registerAdmissionGateTests(db:pg.Client,fixture:()=>Promise<Fixture>,modelId:()=>string){
 it.each(['runtime','mentor','stream','topic'] as const)(
  'RUNTIME: %s admission shares the message gate and refused requests can resume without empty visible turns',async entry=>{
   const f=await fixture(),ctx=await f.context(),opc=opcRouter.createCaller(ctx),runtime=runtimeRouter.createCaller(ctx);
   const service=opcService(f.user,f.admin),artifacts=workbenchService(f.user,f.admin);
   const d=entry==='topic'?await service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'}):await f.draft();
   const detail=await service.read(d.draftId);
   if(entry==='topic'){
    for(const step of f.flow.steps){
     await artifacts.execute({action:'save',projectId:detail.projectId,roundId:detail.roundId,
      requestId:randomUUID(),stepId:step.id,body:'Synthetic confirmed decision',evidenceIds:[],expectedVersion:0});
     const before=(await artifacts.read(detail.projectId,detail.roundId)).steps[step.id];
     await service.information({draftId:d.draftId,stepId:step.id,requestId:randomUUID(),expectedVersion:before.version,
      values:{goal:{status:'confirmed',nature:'decision',value:'A concrete synthetic decision'}}});
     const updated=(await artifacts.read(detail.projectId,detail.roundId)).steps[step.id];
     await artifacts.execute({action:'confirm',projectId:detail.projectId,roundId:detail.roundId,requestId:randomUUID(),
      stepId:step.id,expectedVersion:updated.version,expectedReviewVersion:updated.reviewVersion});
    }
    const snapshot=await artifacts.read(detail.projectId,detail.roundId);
    await artifacts.execute({action:'publish',projectId:detail.projectId,roundId:detail.roundId,requestId:randomUUID(),
     expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([key,value])=>
      [key,{version:value.version,reviewVersion:value.reviewVersion}]))});
    await service.topicBind({draftId:d.draftId,requestId:randomUUID(),sourceVersionId:(await service.read(d.draftId)).report.id});
   }
   const session=entry==='runtime'?await runtime.start({requestId:randomUUID(),scope:{kind:'positioning_draft'}}):null;
   const actual=await vi.importActual<typeof gates>('./newWorkGate');
   const factory=vi.spyOn(gates,'newWorkGate').mockImplementation(actual.newWorkGate);
   const settings=vi.spyOn(gates,'readNewWorkSettings').mockImplementation(actual.readNewWorkSettings);
   const limit=vi.spyOn(redis,'checkRuntimeRateLimit');
   const counts=async()=>({
    executions:(await db.query('select count(*)::int n from runtime_executions where actor_id=$1',[f.actor])).rows[0].n,
    runs:(await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[f.actor])).rows[0].n,
    credits:(await db.query('select credits from profiles where id=$1',[f.actor])).rows[0].credits,
   });
   const submit=async(requestId:string,opening=true)=>{
    if(entry==='runtime')return runtime.prepare({sessionId:session!.sessionId,requestId,input:'Synthetic input',
     selection:{kind:'ordinary',modelId:modelId()},network:'deny'});
    if(entry==='topic')return opc.topicTurn({draftId:d.draftId,requestId,input:'Synthetic topic'});
    const input={draftId:d.draftId,stepId:'step-0',purpose:'mentor' as const,questionId:'goal',requestId,input:opening?OPENING_INPUT:'Synthetic user turn'};
    if(entry==='mentor')return opc.prepareStep(input);
    const stream=await opc.mentorTurnStream(input);
    // A refused stream fails while preparing, before any execution event.
    for await(const event of stream)if(event.type==='admitted')return event;
    throw new Error('expected admission');
   };
   try{
    for(const sameRequest of [true,false]){
     const rejected=randomUUID(),before=await counts();
     limit.mockResolvedValue({success:false,reason:'rate_limited',retryAfter:30,window:'minute'});
     await expect(submit(rejected,sameRequest)).rejects.toMatchObject({code:'TOO_MANY_REQUESTS'});
     expect(await counts()).toEqual(before);
     expect(limit).toHaveBeenLastCalledWith(f.actor,'admission',expect.any(Object),'local',1,'bill2.v1');
     if(entry==='runtime'||entry==='stream')break;
     const material=(await db.query('select request_id,material_revision from opc_turns where draft_id=$1 order by request_id',
      [d.draftId])).rows;
     const visible=entry==='topic'?
      (await readRuntimeView(f.admin,f.actor,(await service.topicRead(d.draftId)).sessionId)).executions:
      (await service.read(d.draftId)).turns;
     expect(visible).toHaveLength(sameRequest?0:1);
     limit.mockResolvedValue({success:true});
     const admitted=await submit(sameRequest?rejected:randomUUID(),sameRequest);
     expect((await counts()).executions).toBe(before.executions+1);
     const after=(await db.query('select request_id,material_revision from opc_turns where draft_id=$1 order by request_id',
      [d.draftId])).rows;
     if(sameRequest)expect(after).toEqual(material);
     else expect(after).toHaveLength(material.length+1);
     await runtime.cancel({executionId:admitted.executionId});
    }
   }finally{limit.mockRestore();settings.mockRestore();factory.mockRestore();}
  },30000);
}
