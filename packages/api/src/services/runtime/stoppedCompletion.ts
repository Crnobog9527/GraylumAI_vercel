/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {allowedOutput} from './moderation';
import {logger} from '../../lib/logger';
import { agentTurnResult } from './agentTurnResult';
import { questionMessageFromArguments, QUESTION_CONTRACT, askQuestionTool } from './agentTools';
import { terminalAgentReplyFailure } from './terminalAgentReply';
import { NativeProgressProjection, type NativeTextSource } from './nativeProgress';
import { visibleText, prepareNativePrimary, completedOutput } from './nativeOutput';
import { stoppedResult } from './stoppedResult';
import { runtimeContext } from './runtimeContext';
import { paygOwnerDatabase } from './paygOwner';
import { executorRpc, type RuntimeExecutorOptions } from './executorRpc';
import type { authoritativeBilling } from '../bill2/service';
import type { RuntimeExecution } from './paygResume';
import type { RuntimeProgress } from './progress';
import { runtimeIdentityGuard } from '../modelIdentity/runtimeGuard';
import { frozenBrandIdentity } from '../modelIdentity/brandIdentity';

type StopCall = {sequence:number;requestHash:string;phase:string;dispatched:boolean;settled:boolean;responsePending?:boolean};
export type StopExecution = RuntimeExecution & {
  pausedReason?:string;stop?:{stopAt:number;source?:NativeTextSource;call?:number};stopCalls?:StopCall[];
};
/** Shared by the original HTTP, cancel host and later recovery. Never invokes the SDK,
 * tools or provider dispatch: the normal parsers reconstruct only durable receipts. */
export function stoppedCompletion(options: RuntimeExecutorOptions, billing: ReturnType<typeof authoritativeBilling>, lookupTimeoutMs?:number) {
  const rpc=executorRpc(options);
  return async(executionId:string,onProgress?:(event:RuntimeProgress)=>void,observed?:StopExecution,responseFinished=false) => {
    const args={p_execution_id:executionId};
    let execution=observed??await rpc<StopExecution>('runtime_execution',{...args,p_action:'read'});
    if(execution.pausedReason!=='user_stop')return null;
    if(execution.state==='completed')return completedOutput(execution.result,execution.context,onProgress);
    if(execution.state==='cancelled')return {state:'cancelled' as const};
    if(execution.cancelRequested)return null; // Ordinary cancellation owns financial-only recovery.
    const raws=new Map<number,unknown>();
    let responsePending=false;
    const collect=async()=>{
      let unknown=false;responsePending=false;
      for(const call of execution.stopCalls??[]){
        if(!call.dispatched)continue;
        // Research receipts contain supplier data, not model prose. A settled tool has no
        // runtime_response to wait for; unsettled tools still retain their financial/window guards.
        if(call.phase==='research'){
          if(!call.settled){unknown=true;if(call.responsePending)responsePending=true;}
          continue;
        }
        const response=await rpc<{rawBody:string|null}|null>('runtime_response',{
          ...args,p_sequence:call.sequence,p_request_hash:call.requestHash});
        if(response?.rawBody){try{raws.set(call.sequence,JSON.parse(response.rawBody));}catch{/* Invalid stored output cannot be saved. */}}
        else {
          // A billed organizer without a stored body is lost (organizerLost.ts): its summary is optional,
          // so the stop saves the reply as not organized instead of waiting out the 300-second window.
          if(call.phase==='attached_organizer'&&call.settled)logger.warn('api','runtime_organizer_output_lost',
            {executionId,sequence:call.sequence,phase:call.phase,code:'RUNTIME_ORGANIZER_OUTPUT_LOST',stop:true});
          else if(call.responsePending)responsePending=true;
          if(!call.settled)unknown=true;
        }
      }
      return unknown;
    };
    const unknown=await collect();
    // Refresh/maintenance must not spend lookup attempts or cancel a result while
    // the original HTTP can still persist its response, even if cost arrived first.
    // Only the live dispatch owner may bypass this after its provider interaction ends.
    if(responsePending&&!responseFinished)return {state:'stopping' as const};
    if(unknown){
      await billing.recoverReceipts(execution.runId,lookupTimeoutMs===undefined?undefined:{timeoutMs:lookupTimeoutMs});
      if(execution.billing.contractVersion==='bill2.v2')await billing.finalizeRun(execution.runId);
      execution=await rpc<StopExecution>('runtime_execution',{...args,p_action:'read'});
      if(execution.state==='completed')return completedOutput(execution.result,execution.context,onProgress);
      if(execution.state==='cancelled')return {state:'cancelled' as const};
      if(await collect())return rpc<{state:'cost_pending'}>('runtime_execution',{...args,p_action:'stop_pending'});
    }
    const context=runtimeContext.parse(execution.context);
    // A stop that names its round (the call whose text was on screen) keeps that round, even when a later
    // round started before the stop arrived; an older stop without it keeps the last dispatched round.
    const round=execution.stop?.call;
    const primary=(execution.stopCalls??[]).findLast(call=>call.dispatched
      &&['ordinary','skill','organizer'].includes(call.phase)&&(round===undefined||call.sequence===round));
    const organizer=(execution.stopCalls??[]).findLast(call=>call.dispatched&&call.phase==='attached_organizer');
    const decode=(call:StopCall|undefined)=>{
      const raw=call?raws.get(call.sequence):undefined;
      if(!raw||typeof raw!=='object')return null;
      return ('usage' in raw && raw.usage && typeof raw.usage==='object' && 'sdkResponse' in raw.usage
        ? raw.usage.sdkResponse:raw) as {model?:string;choices?:Array<{finish_reason?:string;message?:{
          content?:string;tool_calls?:Array<{id?:string;function?:{name?:string;arguments?:string}}>}}>};
    };
    const response=decode(primary),choice=response?.choices?.[0],message=choice?.message;
    const agent=context.providerRequestFormat==='agent-turn-v5-stream';
    const step=Boolean(context.envelopeOrder),plainStream=context.textStream==='plain-text-v1';
    let body=typeof message?.content==='string'?message.content:'';
    let source:NativeTextSource='final',capacityLimited=false;
    let valid=Boolean(primary&&response?.model===context.model&&response?.choices?.length===1&&message
      &&['stop','length','tool_calls'].includes(choice?.finish_reason??'')
      &&!(choice?.finish_reason==='length'&&!body.trim()&&!message?.tool_calls?.length));
    // A checkpointed primary of another round is not what the user saw, and SQL keeps a stop only under the
    // checkpoint: with a named round, a different checkpointed round saves nothing rather than unseen text.
    const checkpoint=execution.primaryResult as {body?:string;lastSequence?:number}|null|undefined;
    if(round!==undefined&&typeof checkpoint?.body==='string'&&checkpoint.lastSequence!==primary?.sequence)valid=false;
    if(valid&&agent){
      valid=!terminalAgentReplyFailure(response,false,context.tools.includes('ask_question'))
        &&!(choice?.finish_reason==='length'&&message?.tool_calls?.length);
      const tool=message?.tool_calls?.[0];
      let output=body;
      if(tool&&context.hostTurnContext?.cardContract){
        // Guarded card arguments never streamed as public text. A stop can keep already
        // emitted assistant prose or a saved checked primary, never rebuild an unchecked card.
        valid=Boolean(body.trim()||execution.primaryResult?.body);
        body=execution.primaryResult?.body??agentTurnResult(body,body,false,undefined,true).body;
      }else if(tool){
        try{output=await askQuestionTool(context.questionContract===QUESTION_CONTRACT)
          .execute(JSON.parse(tool.function?.arguments??''),tool.id??'');}
        catch{valid=false;}
      }
      if(valid&&!(tool&&context.hostTurnContext?.cardContract))body=agentTurnResult(body,output,Boolean(tool),tool
        ?questionMessageFromArguments(tool.function?.arguments??''):undefined,true,Boolean(context.mentorText)).body;
    // A plain-text stream showed the prose of a tool round as it arrived: a stop there keeps that prose.
    }else if(message?.tool_calls?.length&&!(plainStream&&body.trim()))valid=false;
    // MODEL-IDENTITY-GUARD: redact before rebuilding the projection, in the live executor's order, so the
    // stop source derived here matches the replacement snapshot the client saw (review P1).
    const identity=runtimeIdentityGuard(frozenBrandIdentity(context.instructions));
    body=identity.body(body);
    try{
      if(valid){
        const fitted=prepareNativePrimary(body,{}, {envelopeOrder:context.envelopeOrder,appendCard:Boolean(context.mentorText),
          length:choice?.finish_reason==='length',attachedOrganizer:Boolean(context.attachedOrganizer),executionId});
        body=execution.primaryResult?.body??fitted.body;
        capacityLimited=fitted.metadata.completeness==='length_limit'&&choice?.finish_reason!=='length';
        if(agent||step||plainStream){
          const projection=new NativeProgressProjection({mode:agent||plainStream?'agent':'message-first',
            toolMessage:agent&&Boolean(context.questionContract)&&!context.hostTurnContext?.cardContract,appendCard:Boolean(context.mentorText)});
          let update=projection.appendText(message?.content??'');
          const tool=message?.tool_calls?.[0];
          if(tool)update=projection.appendToolFrame({choices:[{delta:{tool_calls:[{index:0,function:tool.function}]}}]})??update;
          // What streamed before any identity rewrite (MODEL-IDENTITY-GUARD) and from which source.
          const streamed=projection.text,streamedSource=update?.source;
          source=projection.finish(visibleText(body,context))?.source??streamedSource??'final';
          // Only the first stopAt code points are kept. When they read the same before and after the rewrite, a
          // rewrite after the stop point cannot change what the user saw: accept the source the client recorded.
          const stopAt=execution.stop!.stopAt,shown=(text:string)=>Array.from(text).slice(0,stopAt).join('');
          const recorded=execution.stop?.source;
          // A final snapshot the client really received already yields 'final' above; one it claims without it does not.
          if(recorded!==undefined&&recorded===streamedSource&&shown(visibleText(body,context))===shown(streamed))source=recorded;
        }
      }
    }catch{valid=false;}
    const organized=decode(organizer);
    const summary=organized?.model===context.attachedOrganizer?.model&&organized?.choices?.length===1
      &&organized.choices[0]?.finish_reason==='stop'&&!terminalAgentReplyFailure(organized,true)
      ?organized.choices[0]?.message?.content:undefined;
    let result=valid?stoppedResult({executionId,format:agent?'agent':step?'step':'plain',body,
      appendCard:Boolean(context.mentorText),stopAt:execution.stop!.stopAt,source:execution.stop?.source,expectedSource:source,
      capacityLimited,primaryComplete:choice?.finish_reason!=='length',attachedOrganizer:Boolean(context.attachedOrganizer),
      ...(typeof summary==='string'?{summary:identity.summary(summary)}:{})}):null;
    if(result&&!await allowedOutput({actorId:await options.actor(),executionId,body:result.body,summary:result.summary}))result=null;
    const database=execution.billing.contractVersion==='bill2.v2'
      ?paygOwnerDatabase(options.database,{executionId,epoch:execution.epoch!}):options.database;
    const completed=await rpc<{state:'completed'|'cancelled'|'cost_pending'}>('runtime_execution',{
      ...args,p_action:'complete',p_result:result},database);
    return result?{...completedOutput(result,execution.context,onProgress),state:completed.state}:{state:completed.state};
  };
}
