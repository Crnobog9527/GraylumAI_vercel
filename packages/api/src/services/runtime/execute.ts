/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authoritativeBilling, type FrozenRun, type FrozenCall, type BillingTransport } from '../bill2/service';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import { localFixtureAdapter } from '../bill2/fixtureAdapter';
import { PostgresSession, type SessionRpc } from './session';
import { runRuntime, type RuntimeTool } from './runner';
import { selectRuntimeHistory, assertRuntimeRequestCapacity, runtimeScopeInput } from './context';
import { matchingPlan, matchingInput, MATCH_INSTRUCTIONS, parseMatch, type MatchCandidate } from './matching';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const runtimeContext=z.object({
 version:z.literal('runtime.v1'),sdkVersion:z.literal('0.18.0'),role:z.enum(['ordinary','skill','organizer']),
 input:z.string().min(1).max(20000),instructions:z.string().max(262144),model:z.string().min(1),
 maxOutputTokens:z.number().int().positive().max(20000),maxTurns:z.number().int().min(1).max(32),
 historyItems:z.number().int().min(0).max(1000),
 tools:z.array(z.enum(['search','read_source'])).default([]),maxToolCalls:z.number().int().min(0).max(16).default(0),
 modelId:z.string().uuid().optional(),network:z.enum(['deny','allow','require_latest']).optional(),
 attachedOrganizer:z.object({modelId:z.string().uuid(),model:z.string().min(1),maxOutputTokens:z.number().int().positive()}).strict().optional(),
 opcTurnToken:z.string().uuid().optional(),matching:matchingPlan.optional(),scopeMaterial:z.unknown().optional(),
 request:z.unknown().optional(),moduleId:z.string().uuid().optional(),skillId:z.string().uuid().optional(),revisionId:z.string().uuid().optional(),sources:z.array(z.unknown()).optional(),
}).strict();
/** Trusted server host only. The public admission layer must construct this context.
 * The default transport is local-only; the Staging host must explicitly supply
 * its allowlisted official adapter and frozen price policy.
 */
export function runtimeExecutor(options:{database:SessionRpc;actor:()=>Promise<string>;endpoint?:string;adapter?:BillingTransport;activateSkill?:(candidate:MatchCandidate)=>Promise<string>}){
 const adapter=options.adapter ?? localFixtureAdapter(options.endpoint??'');
 const billing=authoritativeBilling({admin:options.database,actor:options.actor,adapter});
 async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const result=await options.database.rpc(name,{...args,p_actor_id:z.string().uuid().parse(await options.actor())});
  if(result.error)throw new Error('RUNTIME_DATABASE_UNAVAILABLE');return result.data as T;
 }
 return {
  cancel:(executionId:string)=>rpc<{state:string}>('runtime_cancel',{p_execution_id:z.string().uuid().parse(executionId)}),
  /** Trusted maintenance only: caller supplies a verified original actor; no UI route. */
  async recoverFinancial(executionId:string){
   const args={p_execution_id:z.string().uuid().parse(executionId)};
   const current=await rpc<{runId:string}>('runtime_financial_recovery',args);
   await billing.recoverReceipts(current.runId);
   return rpc<{executionId:string;runId:string;state:string;billing:unknown}>('runtime_financial_recovery',{...args,p_finish:true});
  },
  async execute(executionId:string){
  type Execution={executionId:string;sessionId:string;runId:string;live:boolean;cancelRequested:boolean;state:string;context:unknown;billing:FrozenRun;result:{kind:string;evidenceRef:string;evidenceHash:string;body:string;summary?:string}|null};
  const args={p_execution_id:z.string().uuid().parse(executionId)};
  const execution=await rpc<Execution>('runtime_execution',{...args,p_action:'begin'});
  if(execution.state==='cancelled')return {state:'cancelled' as const};
  if(execution.cancelRequested){
   await billing.recoverReceipts(execution.runId);
   const recovered=await rpc<{state:string}>('runtime_financial_recovery',{...args,p_finish:true});
   return {state:recovered.state as 'completed'|'cancelled'|'cost_pending',...(execution.result?{body:execution.result.body,...(execution.result.summary!==undefined?{summary:execution.result.summary}:{})}:{})};
  }
  if(execution.state==='completed')return {body:execution.result?.body,...(execution.result?.summary!==undefined?{summary:execution.result.summary}:{}),state:'completed' as const};
  if(execution.state==='cost_pending'&&execution.result){
   // Saved SDK output is immutable. Recover only the original billed calls;
   // this branch never starts the SDK or appends Session messages again.
   await billing.recoverRun(execution.runId);
   const recovered=await rpc<{state:'completed'|'cost_pending'}>('runtime_execution',{...args,p_action:'complete',p_result:execution.result});
   return {body:execution.result.body,...(execution.result.summary!==undefined?{summary:execution.result.summary}:{}),state:recovered.state};
  }
  const context=runtimeContext.parse(execution.context);
  const policy=execution.billing.callPolicy.find(p=>p.model===context.model);
  if(!policy)throw new Error('RUNTIME_MODEL_DENIED');
  const session=new PostgresSession(options.database,{actorId:await options.actor(),sessionId:execution.sessionId,executionId});
  try{
   let callSequence=0;
   let primaryPolicy=policy;
   const exchange=async(request:string,phase:string,selectedPolicy=primaryPolicy)=>{
    if(selectedPolicy.protocol==='openrouter-chat-v1') {
     const original=JSON.parse(request);
     if(context.tools.length || context.network!=='deny' || original.tools?.length || original.model!==selectedPolicy.model)
      throw new Error('RUNTIME_REAL_TOOLS_DISABLED');
     if(!selectedPolicy.providerLimits)throw new Error('RUNTIME_REAL_QUOTE_REQUIRED');
     const quoted=openRouterBound(selectedPolicy.providerLimits,selectedPolicy.outputLimit);
     if(decimal(quoted.upperUsd)!==decimal(selectedPolicy.upperUsd))throw new Error('RUNTIME_REAL_QUOTE_CONFLICT');
     request=JSON.stringify({...original,stream:false,provider:quoted.routing});
    }
    assertRuntimeRequestCapacity(request,selectedPolicy.inputLimit);
    const sequence=++callSequence;
     const requestHash=hash(request);
     const existing=await rpc<{callId:string;state:string;rawBody:string|null}|null>('runtime_response',{...args,p_sequence:sequence,p_request_hash:requestHash});
     let raw=existing?.rawBody;
     if(!raw){
      // Recovery is replay-only, even when a later step had not yet been sent.
      if(!execution.live||existing?.state==='dispatched'||existing?.state==='unknown'||existing?.state==='responded')throw new Error('RUNTIME_RESPONSE_PENDING');
      const call:FrozenCall={provider:selectedPolicy.provider,account:selectedPolicy.account,model:selectedPolicy.model,protocol:selectedPolicy.protocol,
       ...(selectedPolicy.providerLimits?{providerLimits:selectedPolicy.providerLimits}:{}),phase,requestHash,upperUsd:selectedPolicy.upperUsd,inputLimit:selectedPolicy.inputLimit,outputLimit:selectedPolicy.outputLimit,
       automaticRetry:false,hiddenTools:false,lookupSupported:selectedPolicy.lookupSupported};
      const claim=await billing.claimCall(execution.runId,sequence,call);
      const dispatch=await billing.dispatchOnce(claim.id,request);
      if(!dispatch.dispatched)throw new Error('RUNTIME_RESPONSE_PENDING');
      if(dispatch.pendingReceipt){
       // Keep the already obtained private observation while inspecting the
       // original call. A lost commit response needs no duplicate write;
       // a confirmed missing response permits bounded idempotent receipt replay.
       const pending=dispatch.pendingReceipt;
       for(let attempt=0;attempt<2;attempt++){
        const savedReceipt=await rpc<boolean>('runtime_receipt_saved',{...args,p_run_id:pending.runId,p_call_id:pending.callId,p_evidence:pending.evidence});
        if(savedReceipt)break;
        try{await billing.recordReceipt(pending.runId,pending.callId,pending.evidence);break;}
        catch{if(attempt===1)throw new Error('RUNTIME_RECEIPT_STORAGE_UNAVAILABLE');}
       }
      }
      const saved=await rpc<{rawBody:string|null}|null>('runtime_response',{...args,p_sequence:sequence,p_request_hash:requestHash});
      raw=saved?.rawBody;
     }
     if(!raw)throw new Error('RUNTIME_RESPONSE_PENDING');
     const decoded=JSON.parse(raw);
     return selectedPolicy.protocol==='openrouter-chat-v1' ? {usage:{sdkResponse:decoded}} : decoded;
   };
   let effective={model:context.model,instructions:context.instructions,maxOutputTokens:context.maxOutputTokens,role:context.role};
   if(context.matching){
    const plan=context.matching;
    const matched=await runRuntime({model:context.model,instructions:MATCH_INSTRUCTIONS,input:matchingInput(context.input,plan.candidates),session,maxOutputTokens:context.maxOutputTokens,maxTurns:1,tools:[],
     selectHistory:async(_history,incoming)=>selectRuntimeHistory([],incoming,{instructions:MATCH_INSTRUCTIONS,inputBytes:policy.inputLimit,historyItems:0,toolBytes:0}),
     exchange:async(_sequence,request)=>{
      const envelope=await exchange(request,'skill_matching',policy),response=envelope.usage?.sdkResponse;
      if(!response||response.model!==context.model||response.choices?.length!==1)throw new Error('RUNTIME_RESPONSE_INVALID');
      return JSON.stringify(response);
     }});
    const selected=parseMatch(matched,plan.candidates);
    await rpc('runtime_execution',{...args,p_action:'checkpoint_match',p_result:selected});
    const candidate=plan.candidates.find(c=>c.key===selected.key);
    if(candidate){
     if(!options.activateSkill)throw new Error('RUNTIME_SKILL_ACTIVATION_UNAVAILABLE');
     const instructions=await options.activateSkill(candidate);
     const selectedPolicy=execution.billing.callPolicy.find(p=>p.modelId===candidate.modelId&&p.model===candidate.model);
     if(!selectedPolicy)throw new Error('RUNTIME_MODEL_DENIED');
     primaryPolicy=selectedPolicy;
     effective={model:candidate.model,instructions,maxOutputTokens:candidate.outputLimit,role:'skill'};
    }
   }
   if(context.network==='require_latest')effective.instructions+='\nThe user requires current information. Use the permitted search tool before answering; tool availability alone is not evidence that a search occurred. Do not claim verified current information without retrieved evidence.';
   const tools:RuntimeTool[]=context.tools.map(name=>({name,description:name==='search'?'Search current sources through the explicitly enabled local search adapter.':'Read the selected source only.',
    execute:async(arguments_,callId)=>{
     const toolArgs={...args,p_call_id:callId,p_name:name,p_arguments:arguments_};
     const saved=await rpc<{execute:boolean;result:unknown}>('runtime_tool',{...toolArgs,p_action:'claim'});
     if(name==='read_source'){
      if(!context.sources?.length||Object.keys(arguments_).length)throw new Error('RUNTIME_SOURCE_ARGUMENT_DENIED');
      const source=await rpc<unknown>('runtime_source',{p_source:context.sources[0]});
      if(saved.result!==null){if(JSON.stringify(saved.result)!==JSON.stringify(source))throw new Error('RUNTIME_SOURCE_CHANGED');return JSON.stringify(source);}
      await rpc('runtime_tool',{...toolArgs,p_action:'complete',p_result:source});
      return JSON.stringify(source);
     }
     // Increment/replay the original billed tool phase even when the result was saved.
     // This keeps following model call identities deterministic after SDK replay.
     const envelope=await exchange(JSON.stringify({tool:name,arguments:arguments_}), 'tool:'+name);
     if(saved.result!==null)return JSON.stringify(saved.result);
     if(!execution.live&&!saved.execute&& !envelope.usage?.toolResult)throw new Error('RUNTIME_TOOL_PENDING');
     const result=z.object({body:z.string().max(20000),sources:z.array(z.object({id:z.string(),version:z.string(),status:z.literal('available')}).strict()).max(32)}).strict().parse(envelope.usage?.toolResult);
     const committed=await rpc<{result:unknown}>('runtime_tool',{...toolArgs,p_action:'complete',p_result:result});
     // Use the persisted JSON representation on first execution as on replay.
     // JSONB reorders object keys; serializing the pre-write object would alter
     // the next SDK request bytes after recovery despite identical tool data.
     return JSON.stringify(committed.result);
    }}));
   const body=await runRuntime({...context,...effective,input:runtimeScopeInput(context.input,context.scopeMaterial),session,tools,selectHistory:async(history,incoming)=>{const selected=selectRuntimeHistory(history,incoming,{instructions:effective.instructions,inputBytes:primaryPolicy.inputLimit,historyItems:context.historyItems,toolBytes:Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description}))))});await session.freezeHistory(selected.length-incoming.length);return selected;},
    exchange:async(_sequence,request)=>{
     const envelope=await exchange(request,effective.role);
     // Local fixture carries the SDK response as private usage evidence. It is
     // not an OpenRouter protocol capability or proof of real supplier costs.
     const response=envelope.usage?.sdkResponse;
     if(!response||response.model!==effective.model||response.choices?.length!==1)throw new Error('RUNTIME_RESPONSE_INVALID');
     return JSON.stringify(response);
    }});
   if(context.network==='require_latest'){
    const latest=await rpc<{state:'cancelled'|'cost_pending';unavailable?:boolean}>('runtime_execution',{...args,p_action:'check_latest'});
    if(latest.unavailable)return {state:latest.state,unavailable:'latest' as const};
   }
   let summary:string|undefined;
   if(context.attachedOrganizer){
    await rpc('runtime_execution',{...args,p_action:'checkpoint_primary',p_result:{body,lastSequence:callSequence}});
    const organizer=context.attachedOrganizer,organizerPolicy=execution.billing.callPolicy.find(p=>p.modelId===organizer.modelId&&p.model===organizer.model);
    if(!organizerPolicy)throw new Error('RUNTIME_ORGANIZER_DENIED');
    const instructions='Organize this operation result. Preserve provenance and uncertainty. Do not add new facts.';
    summary=await runRuntime({model:organizer.model,instructions,input:body,session,maxOutputTokens:organizer.maxOutputTokens,maxTurns:1,tools:[],
     selectHistory:async(_history,incoming)=>selectRuntimeHistory([],incoming,{instructions,inputBytes:organizerPolicy.inputLimit,historyItems:0,toolBytes:0}),
     exchange:async(_sequence,request)=>{
      const envelope=await exchange(request,'attached_organizer',organizerPolicy),response=envelope.usage?.sdkResponse;
      if(!response||response.model!==organizer.model||response.choices?.length!==1)throw new Error('RUNTIME_RESPONSE_INVALID');
      return JSON.stringify(response);
     }});
   }
   const result={kind:'usable_result',evidenceRef:executionId,evidenceHash:hash(JSON.stringify({body,summary})),body,...(summary?{summary}:{})};
   const completed=await rpc<{state:'completed'|'cost_pending'}>('runtime_execution',{...args,p_action:'complete',p_result:result});
   return {body,...(summary!==undefined?{summary}:{}),state:completed.state};
  }catch{
   // A replay has no authority to cancel or interrupt the still-live owner.
   // It may observe an unfinished response, but must leave shared state alone.
   if(!execution.live)return {state:'pending' as const};
   // A lost durable response is inspected by later recovery, never a network retry.
   const failed=await rpc<{state:string}>('runtime_execution',{...args,p_action:'fail_before_dispatch'}).catch(()=>null);
   if(failed?.state==='cancelled')return {state:'cancelled' as const};
   await rpc('runtime_execution',{...args,p_action:'interrupt'}).catch(()=>{});
   return {state:'pending' as const};
  }
 }};
}
