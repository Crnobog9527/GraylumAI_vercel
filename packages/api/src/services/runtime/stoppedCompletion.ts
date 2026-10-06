/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {allowedOutput} from './moderation';
import { agentTurnResult } from './agentTurnResult';
import { questionMessageFromArguments, QUESTION_CONTRACT, askQuestionTool } from './agentTools';
import { terminalAgentReplyFailure } from './terminalAgentReply';
import { NativeProgressProjection, type NativeTextSource } from './nativeProgress';
import { nativeVisible, prepareNativePrimary, completedOutput } from './nativeOutput';
import { stoppedResult } from './stoppedResult';
import { runtimeContext } from './runtimeContext';
import { paygOwnerDatabase } from './paygOwner';
import { executorRpc, type RuntimeExecutorOptions } from './executorRpc';
import type { authoritativeBilling } from '../bill2/service';
import type { RuntimeExecution } from './paygResume';
import type { RuntimeProgress } from './progress';

type StopCall = {sequence:number;requestHash:string;phase:string;dispatched:boolean;settled:boolean;responsePending?:boolean};
export type StopExecution = RuntimeExecution & {
  pausedReason?:string;stop?:{stopAt:number;source?:NativeTextSource};stopCalls?:StopCall[];
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
        const response=await rpc<{rawBody:string|null}|null>('runtime_response',{
          ...args,p_sequence:call.sequence,p_request_hash:call.requestHash});
        if(response?.rawBody){try{raws.set(call.sequence,JSON.parse(response.rawBody));}catch{/* Invalid stored output cannot be saved. */}}
        else {
          if(call.responsePending)responsePending=true;
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
    const primary=(execution.stopCalls??[]).findLast(call=>call.dispatched
      &&['ordinary','skill','organizer'].includes(call.phase));
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
    const step=Boolean(context.envelopeOrder);
    let body=typeof message?.content==='string'?message.content:'';
    let source:NativeTextSource='final',capacityLimited=false;
    let valid=Boolean(primary&&response?.model===context.model&&response?.choices?.length===1&&message
      &&['stop','length','tool_calls'].includes(choice?.finish_reason??'')
      &&!(choice?.finish_reason==='length'&&!body.trim()&&!message?.tool_calls?.length));
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
    }else if(message?.tool_calls?.length)valid=false;
    try{
      if(valid){
        const fitted=prepareNativePrimary(body,{}, {envelopeOrder:context.envelopeOrder,appendCard:Boolean(context.mentorText),
          length:choice?.finish_reason==='length',attachedOrganizer:Boolean(context.attachedOrganizer),executionId});
        body=execution.primaryResult?.body??fitted.body;
        capacityLimited=fitted.metadata.completeness==='length_limit'&&choice?.finish_reason!=='length';
        if(agent||step){
          const projection=new NativeProgressProjection({mode:agent?'agent':'message-first',
            toolMessage:agent&&Boolean(context.questionContract)&&!context.hostTurnContext?.cardContract,appendCard:Boolean(context.mentorText)});
          let update=projection.appendText(message?.content??'');
          const tool=message?.tool_calls?.[0];
          if(tool)update=projection.appendToolFrame({choices:[{delta:{tool_calls:[{index:0,function:tool.function}]}}]})??update;
          source=projection.finish(nativeVisible(body))?.source??update?.source??'final';
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
      ...(typeof summary==='string'?{summary}:{})}):null;
    if(result&&!await allowedOutput({actorId:await options.actor(),executionId,body:result.body,summary:result.summary}))result=null;
    const database=execution.billing.contractVersion==='bill2.v2'
      ?paygOwnerDatabase(options.database,{executionId,epoch:execution.epoch!}):options.database;
    const completed=await rpc<{state:'completed'|'cancelled'|'cost_pending'}>('runtime_execution',{
      ...args,p_action:'complete',p_result:result},database);
    return result?{...completedOutput(result,execution.context,onProgress),state:completed.state}:{state:completed.state};
  };
}
