/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {createTRPCContext} from '../../trpc';
import type {makeWorkflow} from '../__tests__/fixtures/artifacts';
import {pricingConfig} from '../__tests__/fixtures/runtimePricing';
import {runtimeRouter} from '../../routers/runtime';
import {opcRouter} from '../../routers/opc';
import {opcService} from '../opc/service';
import {workbenchService} from '../artifacts/workbench';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {frozenReasoningFields} from './reasoningPolicy';
import {runtimePaygCall} from './paygRuntime';
import {openRouterRequestBody} from './providerRequest';
import {runtimeContext} from './runtimeContext';
import type {FrozenPaygRun} from '../bill2/service';
import {OPENING_INPUT} from '../../shared/opcQuestions';
type Fixture={actor:string;user:SupabaseClient;admin:SupabaseClient;registration:string;mentorModel:string;organizerModel:string;
 flow:ReturnType<typeof makeWorkflow>;context:()=>ReturnType<typeof createTRPCContext>;draft:()=>Promise<{draftId:string}>};

/** Real router -> real admission/pricing -> loopback PostgREST -> real PostgreSQL.
 * No policy/pricing/RPC mocks and no provider network request. */
export function registerPaygHostTests(db:pg.Client,fixture:()=>Promise<Fixture>){
 it.each(['ordinary','ordinary-cap','work','mentor','step','plan','topic','mentor-final-profile'] as const)('RUNTIME: PAYG host SQL %s admission and claim',async entry=>{
  const outputLimit=entry==='ordinary-cap'?32768:8192;
  const f=await fixture(),ctx=await f.context(),opc=opcRouter.createCaller(ctx),runtime=runtimeRouter.createCaller(ctx);
  const service=opcService(f.user,f.admin),artifacts=workbenchService(f.user,f.admin);
  const d=entry==='topic'||entry==='plan'||entry==='step'
   ?await service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'}):await f.draft();
  const detail=await service.read(d.draftId);
  if(['topic','plan','step'].includes(entry)){
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
   if(entry!=='step'){
    const snapshot=await artifacts.read(detail.projectId,detail.roundId);
    await artifacts.execute({action:'publish',projectId:detail.projectId,roundId:detail.roundId,requestId:randomUUID(),
     expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([key,value])=>
      [key,{version:value.version,reviewVersion:value.reviewVersion}]))});
    await service.topicBind({draftId:d.draftId,requestId:randomUUID(),sourceVersionId:(await service.read(d.draftId)).report.id});
   }
  }
  const windowId=randomUUID(),expiresAt=new Date(Date.now()+7200000).toISOString();
  const pairs=[[f.mentorModel,'anthropic/claude-sonnet-5.5','anthropic'],[f.organizerModel,'openai/gpt-6-luna','openai']];
  const policies=pairs.map(([modelId,model,providerSlug])=>{
   const providerLimits={providerSlug,contextTokens:250000,promptUsdPerMillion:'1',completionUsdPerMillion:'1',requestUsd:'0'};
   return {modelId,model,provider:'openrouter',account:'synthetic',protocol:'openrouter-chat-v1',providerLimits,
    upperUsd:openRouterBound(providerLimits,outputLimit).upperUsd,inputLimit:196608,outputLimit,multiplier:'3',
    automaticRetry:false,hiddenTools:false,lookupSupported:true};
  });
  for(const [id,model,tag] of pairs){
   const config=pricingConfig(model,tag,'1','1');
   config.reasoning.catalog.endpoints[0].supportedParameters=['tools','reasoning_effort'];
   const catalog={...config.reasoning.catalog,reasoning:{mandatory:false,defaultEnabled:false,
    supportedEfforts:['low'],defaultEffort:null,supportsMaxTokens:false}};
   const reasoning={...config.reasoning,catalog,purposes:{interactive:{mode:'effort',effort:'low',wire:'reasoning_effort'},organize:{mode:'provider_default'}}};
   await db.query("update ai_models set model_id=$2,provider='openrouter',input_limit=250000,max_tokens=$4,config=$3 where id=$1",
    [id,model,{...config,reasoning},outputLimit]);
  }
  const profiles=pairs.map(([,model,endpointTag])=>({model,endpointTag,protocol:'openrouter-chat-v1',
   profileVersion:'synthetic-only',evidenceVersion:'synthetic-only',admissionPath:'empirical',
   templateTokens:4096,marginTokens:4096,maxBytes:196608,maxMessages:128,maxTools:2,maxSchemaBytes:16384,
   purposes:['ordinary','skill','organizer','skill_matching','attached_organizer'],
   requestFormats:['serial-tools-v2','serial-tools-v4-stream','serial-tools-v6-reasoning','agent-turn-v5-stream'],
   reasoningVariants:[{parameter:'none'},{effort:'low'}].map(reasoning=>({reasoning,outputLimit,testedOutputLimit:512,evidenceReference:'synthetic-only',
    manifestHash:'b'.repeat(64),outputStressSamples:2,includesReasoning:true})),outputLimit,expiresAt,
   evidence:{reference:'synthetic-only',manifestHash:'a'.repeat(64),distinctSamples:60,messageStressSamples:12,maxVerifiedMessages:128,completeCells:15,variantsPerCell:4,
    maxPromptToBytes:0.5,maxPromptToUpper:0.4,outputLimit,testedOutputLimit:512,outputSemantics:'max-tokens-includes-reasoning',includesReasoning:true,cacheCovered:true,costBoundPassed:true}}));
  // Use the delivered profile unchanged except local expiry/window lifetimes.
  // This is a disposable regression fixture, never a production configuration.
  const finalProfiles=entry==='mentor-final-profile'
   ?JSON.parse(readFileSync(new URL('../../../../../docs/launch/evidence/payg-profile-final.json',import.meta.url),'utf8'))
     .profiles.map((p:Record<string,unknown>)=>({...p,expiresAt})):profiles;
  const values={runtime_payg_staging:{version:1,enabled:true,windowId,profiles:finalProfiles},billing_credits_per_usd:'100',
   billing_token_price_multiplier:'3',
   ...(entry==='mentor-final-profile'?{runtime_purpose_budgets:{version:2,
    interactive:{inputBytes:90000,historyItems:100},organize:{inputBytes:64000,historyItems:100},
    report:{inputBytes:196608,historyItems:0}}}:{}),
   billing_payg_start_thresholds:{version:'synthetic-only',
    thresholds:pairs.flatMap(([,model])=>['ordinary','skill','skill_matching','organizer','attached_organizer'].map(purpose=>({model,purpose,typicalUsd:'0.04415'})))}};
  const saved=(await db.query('select key,value from system_settings where key=any($1)',[Object.keys(values)])).rows;
  const env={VERCEL:'1',VERCEL_PROJECT_PRODUCTION_URL:'auth-staging.graylum.com',VERCEL_GIT_COMMIT_REF:'staging',
   VERCEL_GIT_REPO_OWNER:'Crnobog9527',VERCEL_GIT_REPO_SLUG:'GraylumAI_vercel',VERCEL_PROJECT_ID:'synthetic',
   V3_RUNTIME_STAGING_PROJECT_ID:'synthetic',V3_RUNTIME_STAGING_DATABASE_HOST:'synthetic.supabase.co',
   NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.supabase.co',V3_RUNTIME_STAGING_WINDOW_ID:windowId,V3_RUNTIME_STAGING_ENABLED:'true'};
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  try{
   for(const [key,value] of Object.entries(values))await db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',[key,JSON.stringify(value)]);
   if(entry==='mentor-final-profile')await db.query("delete from system_settings where key='billing_payg_start_thresholds'");
   await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,
    max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,100,3,10,100,$4)`,[windowId,[f.actor],JSON.stringify(policies),expiresAt]);
   Object.assign(process.env,env);
   let admitted:{executionId:string};
   if(entry==='ordinary'||entry==='ordinary-cap'||entry==='work'){
    let scope:{kind:string;projectId?:string;workItemId?:string}={kind:'positioning_draft'};
    if(entry==='work'){
     const parent=randomUUID(),work=randomUUID();
     await db.query(`insert into artifact_projects(id,actor_id,module_id,skill_id)
      select $1,actor_id,module_id,skill_id from artifact_projects where id=$2`,[parent,detail.projectId]);
     await db.query(`insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id)
      select $1,actor_id,module_id,skill_id,'script',id from artifact_projects where id=$2`,[work,parent]);
     scope={kind:'work_item',projectId:parent,workItemId:work};
    }
    const s=await runtime.start({requestId:randomUUID(),scope});
    admitted=await runtime.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Synthetic host input',
     selection:{kind:'ordinary',modelId:f.mentorModel},network:'deny'});
   }else if(entry==='topic')admitted=await opc.topicTurn({draftId:d.draftId,requestId:randomUUID(),input:'Synthetic topic'});
   else admitted=await opc.prepareStep({draftId:d.draftId,stepId:'step-0',purpose:entry==='mentor-final-profile'?'mentor':entry,requestId:randomUUID(),
    input:(entry==='mentor'||entry==='mentor-final-profile')?OPENING_INPUT:'Synthetic host input',...((entry==='mentor'||entry==='mentor-final-profile')?{questionId:'goal'}:{})});
   const rpc=async(name:string,args:Record<string,unknown>)=>{
    const result=await f.admin.rpc(name,{p_actor_id:f.actor,...args});if(result.error)throw new Error(result.error.message);return result.data;
   };
   const e=await rpc('runtime_execution',{p_execution_id:admitted.executionId,p_action:'begin'});
   const billing=e.billing as FrozenPaygRun,c=runtimeContext.parse(e.context);
   expect(billing.contractVersion).toBe('bill2.v2');expect(c.historyItems).toBe(100);
   if(entry==='mentor-final-profile'){
    expect(c.maxOutputTokens).toBe(8192);expect(c.purposeBudget?.inputBytes).toBe(90000);
    expect(c.reasoning).toMatchObject({effort:'low'});
    expect(c.attachedOrganizer).toMatchObject({model:'openai/gpt-6-luna',maxOutputTokens:2048,inputBytes:64000});
   }
   const policy=billing.callPolicy.find(p=>p.modelId===c.modelId)!;
   const request=openRouterRequestBody(JSON.stringify({model:policy.model,messages:[{role:'system',content:'Synthetic instructions'},
     ...Array.from({length:126},(_,i)=>({role:i%2?'assistant':'user',content:'Synthetic history'})),
     {role:'user',content:'Synthetic claim'}],
    max_tokens:c.maxOutputTokens,...frozenReasoningFields(c.reasoning)}),{context:c,policy,phase:c.role,primaryDialogue:true});
   const {call}=runtimePaygCall(request,c.role,policy,billing.rules,e.epoch,true);
   expect(call.payg?.messages).toBe(128);
   expect(c.maxOutputTokens).toBe(outputLimit);
   const excessive=JSON.parse(request);excessive.messages.push({role:'user',content:'One too many'});
   expect(()=>runtimePaygCall(JSON.stringify(excessive),c.role,policy,billing.rules,e.epoch,true))
    .toThrow('BILL2_INPUT_PROFILE_INVALID');
   if(entry==='mentor-final-profile'){
    await expect(rpc('bill2_claim',{p_run_id:e.runId,p_sequence:1,p_payload:call})).rejects.toThrow('BILL2_START_THRESHOLD_UNCONFIGURED');
    expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[e.runId])).rows[0].n).toBe(0);
    expect((await db.query('select credits from profiles where id=$1',[f.actor])).rows[0].credits).toBe(1000);
    await db.query('insert into system_settings(key,value) values($1,$2)',
     ['billing_payg_start_thresholds',JSON.stringify(values.billing_payg_start_thresholds)]);
   }
   const claimed=await rpc('bill2_claim',{p_run_id:e.runId,p_sequence:1,p_payload:call});
   expect(claimed.id).toEqual(expect.any(String));
   const stored=(await db.query('select start_threshold,payload from bill2_calls where id=$1',[claimed.id])).rows[0];
   expect(stored.start_threshold).toBe(14); // ceil(typicalUsd 0.04415 * q 100 * m 3)
   expect(stored.payload.outputLimit).toBe(outputLimit);
   expect(stored.payload.upperUsd).toBe(call.upperUsd);
   expect((await rpc('bill2_claim',{p_run_id:e.runId,p_sequence:1,p_payload:call})).id).toBe(claimed.id);
   expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[e.runId])).rows[0].n).toBe(1);
   expect((await db.query('select credits from profiles where id=$1',[f.actor])).rows[0].credits).toBeGreaterThanOrEqual(0);
  }finally{
   for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
   await db.query('delete from system_settings where key=any($1)',[Object.keys(values)]);
   for(const row of saved)await db.query('insert into system_settings(key,value) values($1,$2)',[row.key,JSON.stringify(row.value)]);
  }
 },30000);
}
