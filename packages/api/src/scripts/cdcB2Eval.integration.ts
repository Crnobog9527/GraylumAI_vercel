/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fixture} from './cdcB2Fixture';
import {runtimeExecutor} from '../services/runtime/execute';
import {openRouterAdapter} from '../services/bill2/openRouterAdapter';
import {allowTestCalls} from '../services/__tests__/fixtures/runtimeGates';
import {historyItems} from './ac0Probe/trial';
import {hash,measure,profiles,type Role} from '../../../../scripts/cdc-b2-eval/policy.ts';
import {assertOutsideRepository} from './ac0Probe/paths';

// Disposable fixture has no remote Redis. External dispatch uses the separate $9 gate.
vi.mock('../services/runtime/newWorkGate',async original=>({
 ...await original<typeof import('../services/runtime/newWorkGate')>(),
 ...(await import('../services/__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

it('CDC_EVAL: freeze or execute exactly the approved roster through local OPC and Runtime',async()=>{
 const path=process.env.V3_REAL_SKILL_INPUT!;assertOutsideRepository(path);
 const plan=JSON.parse(readFileSync(path,'utf8'));assertOutsideRepository(plan.output);
 const f=await fixture(plan.moduleSkill),rows:Array<ReturnType<typeof measure>&{ordinal:number;category:string;role:Role;raw:string}>=[],results:unknown[]=[];
 let active:{organize:boolean;dryPatches:unknown[];category:string;slot:string},currentExecution='',ordinal=0,phase=0;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'LOCAL_BOUNDARY_ONLY',transport:async(url,init)=>{
  if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('CDC_NO_LOOKUP_OR_RETRY');
  const raw=String(init?.body),body=JSON.parse(raw),role:Role=phase++===0?'mentor':'organizer';
  if(phase>2||role==='organizer'&&!active.organize)throw new Error('CDC_UNEXPECTED_CALL');
  const measured=measure(raw,role);rows.push({ordinal:++ordinal,category:active.category,role,...measured,raw});
  if(plan.bridge){
   const response=await fetch(plan.bridge.url,{method:'POST',headers:{'content-type':'application/json',authorization:plan.bridge.secret},
    body:JSON.stringify({role,ordinal,slot:active.slot,raw})});
   if(!response.ok)throw new Error('CDC_LIVE_STOP');return response;
  }
  // Dry-run only: synthetic replies exercise the real persistence/capture path; never quality evidence.
  const content=role==='mentor'?'Synthetic dry-run reply, not model evidence.':JSON.stringify({inputKind:'answer',patches:active.dryPatches??[],notes:[]});
  const response={id:'gen-cdc-'+randomUUID(),object:'chat.completion',created:1,model:body.model,
   choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],
   usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.001}};
  if(!body.stream)return new Response(JSON.stringify(response));
  return new Response('data: '+JSON.stringify({...response,object:'chat.completion.chunk',
   choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
   {headers:{'content-type':'text/event-stream'}});
 }});
 try{
  for(const group of plan.groups){
   const draft=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'mentor'});
   const initial=await f.service.read(draft.draftId);
   // Fixture-only prerequisite state for original scenarios that start at a later step.
   for(const stepId of Object.keys(initial.snapshot.steps).filter(id=>id!==group.stepId))await f.db.query(
    "update artifact_rounds set steps=jsonb_set(steps,ARRAY[$2,'valid'],'true'::jsonb) where id=$1",[initial.roundId,stepId]);
   // Seed only approved synthetic history, no extra provider calls. A completed local fixture owns its provenance.
   if(group.history?.length){
    const prepared=await f.service.prepareStep({draftId:draft.draftId,requestId:randomUUID(),purpose:'mentor',
     stepId:group.stepId,questionId:group.questionId,input:'Synthetic history fixture'});
    await f.admin.rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:prepared.executionId});
    await f.db.query("update runtime_executions set state='completed',unavailable_reason=null,result=$2 where id=$1",
     [prepared.executionId,{body:'Synthetic historical fixture'}]);
    const items=historyItems({...group,input:''}).slice(0,-1);
    for(const [index,item] of items.entries())await f.db.query(
     'insert into runtime_session_history(session_id,revision,execution_id,item) values($1,$2,$3,$4)',
     [initial.sessionId,index+1,prepared.executionId,JSON.stringify(item)]);
    await f.db.query('update runtime_sessions set revision=$2 where id=$1',[initial.sessionId,items.length]);
   }
   if(group.fieldValues)await f.db.query("update artifact_rounds set steps=jsonb_set(steps,ARRAY[$2,'information'],$3) where id=$1",
    [initial.roundId,group.stepId,JSON.stringify(group.fieldValues)]);
   for(const turn of group.turns){
    active=turn;phase=0;
    if(turn.pauseBefore&&plan.bridge){
     const started=Date.now();await new Promise(resolve=>setTimeout(resolve,420000));
     const elapsed=Date.now()-started;if(elapsed<360000||elapsed>480000)throw new Error('CDC_CACHE_INTERVAL');
     results.push({pauseMs:elapsed,beforeSlot:turn.slot});
    }
    if(turn.manual){
     const state=await f.service.read(draft.draftId),step=state.information[turn.manual.stepId];
     await f.service.information({draftId:draft.draftId,requestId:randomUUID(),stepId:turn.manual.stepId,
      expectedVersion:state.snapshot.steps[turn.manual.stepId].version,
      values:{...Object.fromEntries(step.schema.map((field:{id:string})=>[field.id,
       step.values?.[field.id]??{value:'',status:'unknown',nature:'unknown'}])),
       [turn.manual.fieldId]:{value:turn.manual.value,status:'provisional',nature:'fact'}}});
    }
    const prepared=await f.service.prepareStep({draftId:draft.draftId,requestId:randomUUID(),purpose:'mentor',
     stepId:group.stepId,questionId:group.questionId,input:turn.input,organizeAfter:turn.organize});
    currentExecution=prepared.executionId;
    const frozen=(await f.db.query('select payload from runtime_executions where id=$1',[currentExecution])).rows[0].payload;
    if(frozen.providerRequestFormat!==profiles.mentor.format||frozen.reasoning?.effort!=='low'||
     turn.organize&&frozen.attachedOrganizer?.reasoning?.parameter!=='none')throw new Error('CDC_FROZEN_FORMAT');
    const result=await runtimeExecutor({database:f.admin,actor:async()=>f.actor,adapter,callGate:allowTestCalls}).execute(currentExecution);
    if(result.state!=='completed'||phase!==(turn.organize?2:1))throw new Error('CDC_EXECUTION_INCOMPLETE');
    const capture=turn.organize?await f.service.capturePending({draftId:draft.draftId}):null;
    if(!plan.bridge&&capture&&(capture.processed.length!==1||
     !['applied','suggested'].includes(capture.processed[0]?.result)))throw new Error('CDC_DRY_CAPTURE');
    results.push({slot:turn.slot,frozen,result,capture,after:await f.service.read(draft.draftId)});
   }
  }
  if(rows.length!==100)throw new Error('CDC_ROSTER_INCOMPLETE');
  const privateOutput=JSON.stringify({inputHash:hash(readFileSync(path)),rows,results});
  writeFileSync(plan.output+'/frozen-private.json',privateOutput,{mode:0o600,flag:'wx'});
  const measures=rows.map((row)=>{const {raw,...safe}=row;void raw;return safe;});
  writeFileSync(plan.output+'/summary.json',JSON.stringify({mode:plan.bridge?'live':'freeze',dispatches:plan.bridge?100:0,
   privateHash:hash(privateOutput),rows:measures},null,2),{mode:0o600,flag:'wx'});
 }finally{await f.db.end();}
},7_200_000);
