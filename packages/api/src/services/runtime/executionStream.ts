/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {contentVisibilityFence} from '../accountErasure/content';
import {withClaimNotice} from './claimNotice';
import {NativeTextTransport,type NativeTextDelta} from './nativeProgress';
import type {ResumeInput} from './paygRuntime';
import {admitPricing} from './pricingAdmission';
import {captureCompleted} from '../opc/capture';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {RuntimeProgress} from './progress';
import type {AgentTurnOutcome} from '../../shared/agentTurn';
import type {RuntimeBudget} from './budget';
import {loadStagingPolicy,loadStagingRecoveryPolicy} from './stagingPolicy';
import {StagingAccessError,stagingProcedureError,stagingRpcFailure} from './stagingErrors';
import {stagingTransport} from './stagingTransport';
import {retainedOutputReason} from './view';
import {runtimeExecutor} from './execute';
import {runtimeActor} from './actor';
import {activateRuntimeCandidate} from './matching';
import {newWorkGate,denyNewCalls} from './newWorkGate';
import {inflightFinancialHost,finishErasedWaiting} from './inflightFinancial';
import {localFixtureAdapter} from '../bill2/fixtureAdapter';
import type {BillingTransport} from '../bill2/service';

/** Loopback tests remain separate from the explicitly enabled Staging host. */
export function runtimeLocalEndpoint(){
 const endpoint=process.env.V3_RUNTIME_LOCAL_ENDPOINT;
 for(const value of [endpoint,process.env.NEXT_PUBLIC_SUPABASE_URL]){
  if(!value)throw new Error('RUNTIME_DISABLED');const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('RUNTIME_DISABLED');
 }
 return endpoint!;
}

/** Already authenticated router context for one original execution. The
 * caller has verified the user and, for maintenance, local or read access. */
export type OriginalExecutionHost={
 admin:SupabaseClient;user:SupabaseClient;actorId:string;budget:RuntimeBudget;
 authorization?:string|null;maintenanceEndpoint?:string;
};

/** Runs or recovers one admitted execution under its original frozen policy.
 * Shared by `runtime.execute`, `runtime.executeStream` and `opc.mentorTurnStream`. */
export async function executeOriginalExecution(host:OriginalExecutionHost,executionId:string,
 onProgress?:(event:RuntimeProgress)=>void,resume?:ResumeInput,replayOnly=false):Promise<AgentTurnOutcome>{
  // Original test-window and recovery policy reads count as policy; the
  // executor enters its own phase when it begins.
  host.budget?.timing?.tagExecution(executionId);host.budget?.timing?.enter('policy');
  const actor=runtimeActor(host.user.auth,host.actorId,host.budget,host.authorization);
  const activateSkill=(candidate:Parameters<typeof activateRuntimeCandidate>[2])=>activateRuntimeCandidate(host.user,host.admin,candidate);
  let erasedWaitingClosed=false;
  const visible=contentVisibilityFence(host.admin,host.actorId,executionId);
  const outcome=async<T extends {state:AgentTurnOutcome['state']}>(result:T)=>{
   if(erasedWaitingClosed)return {state:result.state};
   await visible();
   if(result.state==='completed'&&'summary' in result){
    host.budget?.timing?.finishProvider();
    const leave=host.budget?.timing?.enter('host');
    try{await captureCompleted(host.admin,host.actorId,executionId);}finally{leave?.();}
   }
   if(!['cancelled','cost_pending'].includes(result.state))return withClaimNotice(result);
   const reason=await retainedOutputReason(host.admin,host.actorId,executionId);
   return {...result,...(reason?{unavailable:reason}:{})};
  };
  const financial=inflightFinancialHost({database:host.admin,actorId:host.actorId,executionId,actor,budget:host.budget});
  const base={database:financial.database,budget:host.budget,actor};
  const publicProgress=(event:RuntimeProgress)=>{if(!financial.isAccountClosed())onProgress?.(event);};
  const closeWaiting=async()=>{
   const closed=await finishErasedWaiting({database:host.admin,actorId:host.actorId,executionId,budget:host.budget});
   if(closed)erasedWaitingClosed=true;return closed;
  };
  const run=async(adapter:BillingTransport,execute:()=>Promise<AgentTurnOutcome>)=>{
   let result:AgentTurnOutcome|undefined;
   try{result=await execute();
    if(['waiting_credits','waiting_resume'].includes(result.state))result=await closeWaiting()??result;
   }catch(error){
    if(error instanceof StagingAccessError
     &&['RUNTIME_RESUME_CONFLICT','RUNTIME_STAGING_AUTH_REFRESH_REQUIRED'].includes(error.reason))throw error;
    // Best-effort erased-account maintenance must not replace the original
    // execution failure with a secondary storage/binding failure.
    const closed=await closeWaiting().catch(()=>null);if(closed)return closed;throw error;
   }finally{
    const recovered=result&&['completed','waiting_credits','waiting_resume'].includes(result.state)&&!financial.isAccountClosed()
     ?undefined:await financial.finish(adapter);
    if(financial.isAccountClosed()&&recovered)
     result={state:recovered.state as 'completed'|'cancelled'|'cost_pending'};
   }
   return result!;
  };
  if(host.maintenanceEndpoint)
   return outcome(await run(localFixtureAdapter(host.maintenanceEndpoint),()=>runtimeExecutor({
    ...base,endpoint:host.maintenanceEndpoint,activateSkill,
    callGate:replayOnly?denyNewCalls:newWorkGate(host.admin,'local').calls}).execute(executionId,publicProgress,resume)));
  try{await loadStagingPolicy(host.admin,host.actorId,process.env);}catch{
   const closed=await closeWaiting();if(closed)return closed;
   const observed=await host.admin.rpc('runtime_execution',{
    p_actor_id:host.actorId,p_execution_id:executionId,p_action:'read',
   });
   if(observed.error&&observed.error.code!=='42501')stagingRpcFailure(observed.error);
   if(!observed.error&&observed.data?.billing?.contractVersion==='bill2.v2'
    &&['waiting_credits','waiting_resume'].includes(observed.data.state)){
    const disabled={dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},
     lookup:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');}};
    const waiting=await runtimeExecutor({...base,adapter:disabled,callGate:denyNewCalls}).execute(executionId);
    return ['waiting_credits','waiting_resume'].includes(waiting.state)
     ?{...waiting,unavailable:'RUNTIME_PRICE_CONFIGURATION_PENDING'}:waiting;
   }

   const original=await loadStagingRecoveryPolicy(host.admin,host.actorId,executionId,process.env);
   if(observed.data?.pausedReason==='user_stop'){
    const recoveryAdapter=stagingTransport(host.admin,original,host.budget);
    return outcome(await runtimeExecutor({...base,adapter:{
     dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},lookup:recoveryAdapter.lookup,
    },callGate:denyNewCalls}).execute(executionId));
   }
   // This branch never constructs/runs an SDK request. It only looks up the
   // persisted original provider ID and finishes existing financial state.
   if(process.env.V3_RUNTIME_STAGING_ENABLED!=='true'){
    // An explicit host stop also closes this original execution. A failed or
    // lost cancellation response is inspected by financial recovery below;
    // there is no repeated cancellation or assumption of a refund.
    await host.admin.rpc('runtime_cancel',{p_actor_id:host.actorId,p_execution_id:executionId});
   }
   const adapter=stagingTransport(host.admin,original,host.budget);
   const replayOnly={dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},lookup:adapter.lookup};
   const state=await runtimeExecutor({...base,adapter:replayOnly,callGate:denyNewCalls}).recoverFinancial(executionId);
   // With p_finish, runtime_financial_recovery returns only these three states.
   return outcome({state:state.state as 'completed'|'cancelled'|'cost_pending'});
  }
  // Execution/recovery always uses its original quote and credential namespace,
  // even if a later test window is now selected in the host environment.
  const original=await loadStagingRecoveryPolicy(host.admin,host.actorId,executionId,process.env);
  const adapter=stagingTransport(host.admin,original,host.budget);
  return outcome(await run(adapter,()=>runtimeExecutor({...base,adapter,activateSkill,
   resumePricing:policies=>admitPricing(host.admin,policies),
   callGate:replayOnly?denyNewCalls:newWorkGate(host.admin,'staging').calls}).execute(executionId,publicProgress,resume)));
}
export type OriginalExecutionOutcome=AgentTurnOutcome;
export type ExecutionStreamEvent=RuntimeProgress|NativeTextDelta|{type:'result';result:OriginalExecutionOutcome};

/** Minimum spacing of text events. Legacy events carry the whole public text, so
 * one event per provider delta would grow transfer with the square of the
 * reply length. The first text is sent at once; the final text always
 * precedes the result. */
export const TEXT_EVENT_INTERVAL_MS=100;

/** Bounded ephemeral delivery of one execution's progress. SQL remains the
 * execution and billing authority. Disconnect discards display progress, not
 * provider evidence: the execution always runs to its own end. Only the latest
 * text and phase are kept; negotiated native events carry queued deltas. */
export async function* streamOriginalExecution(run:(onProgress:(event:RuntimeProgress)=>void)=>Promise<OriginalExecutionOutcome>,
 timing:RuntimeBudget['timing']|undefined,path:string,now:()=>number=()=>performance.now(),
 textProtocol?:'textDelta-v1',visible?:()=>Promise<void>):AsyncGenerator<ExecutionStreamEvent>{
 const transport=new NativeTextTransport();
 let nativePending=false;
 let textEvent:ExecutionStreamEvent|undefined,phaseEvent:ExecutionStreamEvent|undefined,resultEvent:ExecutionStreamEvent|undefined;
 let cardEvent:ExecutionStreamEvent|undefined,cardSeen=false;
 let done=false,failure:unknown,wake:()=>void=()=>{},lastText:number|undefined;
 const pending=run(event=>{if(event.type==='text'){
   if(textProtocol&&'delta' in event){transport.push(event);nativePending=true;textEvent=event;}
   else textEvent={type:'text',text:event.text};
  }
  else if(event.type==='card'){if(!cardSeen){cardSeen=true;cardEvent=event;}}else phaseEvent=event;wake();})
  .then(result=>{resultEvent={type:'result',result};},error=>{failure=error;}).finally(()=>{done=true;wake();});
 const idle=(ms?:number)=>new Promise<void>(resolve=>{
  const timer=ms===undefined?undefined:setTimeout(resolve,ms);
  wake=()=>{if(timer!==undefined)clearTimeout(timer);resolve();};
 });
 try{
  while(!done||textEvent||cardEvent||phaseEvent||resultEvent){
   if(textEvent){
    const wait=(done&&!nativePending)||lastText===undefined?0:lastText+TEXT_EVENT_INTERVAL_MS-now();
    if(wait>0){await idle(wait);continue;}
    const event=nativePending?transport.flush()!:textEvent;nativePending=false;textEvent=undefined;lastText=now();
    if((event.type==='text'||event.type==='textDelta')&&event.text)timing?.mark('firstPublicText');
    await visible?.();yield event;
   }
   else if(cardEvent){const event=cardEvent;cardEvent=undefined;await visible?.();yield event;}
   else if(phaseEvent){const event=phaseEvent;phaseEvent=undefined;await visible?.();yield event;}
   else if(resultEvent){const event=resultEvent;resultEvent=undefined;await visible?.();yield event;}
   else await idle();
  }
  if(failure)throw stagingProcedureError(failure,path);
 }finally{await pending;}
}
