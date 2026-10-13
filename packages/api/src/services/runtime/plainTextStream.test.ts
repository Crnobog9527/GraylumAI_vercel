/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it,vi} from 'vitest';
import {runtimeContext} from './runtimeContext';
import {PLAIN_TEXT_STREAM,openRouterRequestBody,plainTextStreamAllowed,streamsPrimary} from './providerRequest';
import {completedOutput,visibleText} from './nativeOutput';
import {stoppedCompletion,type StopExecution} from './stoppedCompletion';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {frozenReasoningFields} from './reasoningPolicy';
import {INVALID_REPLY_NOTICE} from '../../shared/agentTurn';
import type {authoritativeBilling} from '../bill2/service';

// CHAT-NATIVE-OUTPUT: free chat (v6) and Skill (v2) turns frozen with textStream stream their
// primary reply. The marker never changes the format; unmarked turns keep their exact bytes.
const id='10000000-0000-4000-8000-000000000001';
const base={version:'runtime.v1',sdkVersion:'0.18.0',input:'input',instructions:'Answer',model:'synthetic/model',
 maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],nativeOutput:'native-output-v1',network:'deny'} as const;
const freeChat={...base,role:'ordinary',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'}} as const;
const skill={...base,role:'skill',providerRequestFormat:'serial-tools-v2'} as const;
const providerLimits={providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'};
const policy={modelId:id,provider:'openrouter',account:'synthetic',model:'synthetic/model',protocol:'openrouter-chat-v1' as const,
 providerLimits,upperUsd:openRouterBound(providerLimits,1000).upperUsd,inputLimit:32000,outputLimit:1000,
 automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
// What the SDK sends when the runner streams: the request asks for a stream and its usage.
const sdkRequest=(reasoning:boolean,stream:boolean)=>JSON.stringify({model:'synthetic/model',
 messages:[{role:'user',content:'input'}],...(reasoning?frozenReasoningFields({effort:'low'}):{}),
 ...(stream?{stream:true,stream_options:{include_usage:true}}:{stream:false})});
const send=(context:Record<string,unknown>,stream:boolean)=>JSON.parse(openRouterRequestBody(
 sdkRequest(Boolean(context.reasoning),stream),{context:runtimeContext.parse(context),policy,phase:String(context.role),primaryDialogue:true}));

describe('frozen plain-text stream marker',()=>{
 it('is accepted only on native plain replies: free chat v6 and Skill v2',()=>{
  expect(runtimeContext.safeParse({...freeChat,textStream:PLAIN_TEXT_STREAM}).success).toBe(true);
  expect(runtimeContext.safeParse({...skill,textStream:PLAIN_TEXT_STREAM}).success).toBe(true);
  for(const context of [
   {...freeChat,nativeOutput:undefined},
   {...freeChat,role:'skill'},
   {...skill,role:'ordinary'},
   {...skill,providerRequestFormat:'serial-tools-v4-stream',envelopeOrder:'message-first-v1',reasoning:{effort:'low'}},
   {...skill,providerRequestFormat:'agent-turn-v5-stream',reasoning:{effort:'low'}},
   {...freeChat,attachedOrganizer:{modelId:id,model:'synthetic/organizer',maxOutputTokens:100}},
  ])expect(runtimeContext.safeParse({...context,textStream:PLAIN_TEXT_STREAM}).success).toBe(false);
  expect(runtimeContext.safeParse({...freeChat,textStream:'plain-text-v2'}).success).toBe(false);
  expect(plainTextStreamAllowed({...skill,matching:{}})).toBe(false);
 });

 it('streams only marked turns; an unmarked v2/v6 turn never streams',()=>{
  expect(streamsPrimary({...freeChat,textStream:PLAIN_TEXT_STREAM})).toBe(true);
  expect(streamsPrimary(freeChat)).toBe(false);expect(streamsPrimary(skill)).toBe(false);
  expect(streamsPrimary({providerRequestFormat:'agent-turn-v5-stream'})).toBe(true);
 });

 it.each([['free chat',freeChat],['Skill',skill]] as const)('%s: a marked request equals the unmarked one except `stream`',(_label,context)=>{
  const unmarked=send(context,false),marked=send({...context,textStream:PLAIN_TEXT_STREAM},true);
  expect(marked.stream).toBe(true);expect(unmarked.stream).toBe(false);
  // The same frozen model, messages, reasoning, limits and routing: billing reads the same call either way.
  const omit=({stream,stream_options,...rest}:Record<string,unknown>)=>({rest,stream,stream_options});
  const {rest:markedRest,stream_options:usage}=omit(marked),{rest:unmarkedRest,stream_options:none}=omit(unmarked);
  expect(markedRest).toEqual(unmarkedRest);
  expect(usage).toEqual({include_usage:true});expect(none).toBeUndefined();
 });

 it('an unmarked turn keeps its original bytes even if the SDK asked for a stream',()=>{
  // Byte-identical to the request before this change: `stream` is still forced off for v2/v6.
  expect(send(freeChat,true).stream).toBe(false);
  expect(send(skill,true).stream).toBe(false);
 });
});

describe('plain-text visible reply',()=>{
 it('is the body itself, whatever it starts with; envelopes are read only without the marker',()=>{
  const code='```ts\nconst a=1;\n```';
  expect(visibleText(code,{textStream:PLAIN_TEXT_STREAM})).toBe(code);
  expect(visibleText('{"message":"x"}',{textStream:PLAIN_TEXT_STREAM})).toBe('{"message":"x"}');
  expect(visibleText(code,{})).toBe(INVALID_REPLY_NOTICE);
 });
 it('a completed marked turn re-sends its saved reply as the final snapshot (reconnect/refresh)',()=>{
  const progress=vi.fn();
  const result=completedOutput({body:'完整回复',kind:'usable_result'},{...freeChat,textStream:PLAIN_TEXT_STREAM},progress);
  expect(result).toMatchObject({state:'completed',body:'完整回复'});
  expect(progress).toHaveBeenCalledWith({type:'text',text:'完整回复',delta:'完整回复',replace:true,source:'final'});
  const unmarked=vi.fn();completedOutput({body:'完整回复'},freeChat,unmarked);expect(unmarked).not.toHaveBeenCalled();
 });
});

describe('停止 on a marked plain-text turn',()=>{
 function fixture(content:string){
  const execution={executionId:id,sessionId:id,runId:id,state:'interrupted',live:false,cancelRequested:false,
   pausedReason:'user_stop',stop:{stopAt:2,source:'assistant'},epoch:1,result:null,
   context:{...freeChat,textStream:PLAIN_TEXT_STREAM},billing:{contractVersion:'bill2.v2'},
   stopCalls:[{sequence:1,requestHash:'a'.repeat(64),phase:'ordinary',dispatched:true,settled:true}],
  } as StopExecution;
  const raw=JSON.stringify({model:'synthetic/model',choices:[{finish_reason:'stop',message:{content}}]});
  const results:unknown[]=[];
  const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
   if(name==='runtime_response')return {data:{rawBody:raw},error:null};
   if(args.p_action==='complete'){
    const result=(args.p_result as {value:unknown}).value;results.push(result);
    return {data:{state:result?'completed':'cancelled'},error:null};
   }
   return {data:structuredClone(execution),error:null};
  })};
  const billing={recoverReceipts:vi.fn(),finalizeRun:vi.fn(),dispatchOnce:vi.fn(),claimCall:vi.fn(),claimPaygCall:vi.fn()};
  const complete=stoppedCompletion({database,actor:async()=>id,callGate:vi.fn()},billing as unknown as ReturnType<typeof authoritativeBilling>);
  return {execution,results,billing,complete};
 }
 it('keeps exactly the shown prefix from the saved receipt, without new work; replays identically',async()=>{
  const f=fixture('中😀后面还有');
  const a=await f.complete(id),b=await f.complete(id);
  expect(a).toEqual(b);expect(f.results[0]).toEqual(f.results[1]);
  expect(a).toMatchObject({state:'completed',stopped:true,completeness:'stopped',body:'中😀'});
  // Settlement stays with the dispatched call's receipt: nothing is sent or claimed again.
  expect(f.billing.dispatchOnce).not.toHaveBeenCalled();expect(f.billing.claimCall).not.toHaveBeenCalled();
 });
 it('a plain reply that looks like JSON is still plain text',async()=>{
  const f=fixture('{"message":"不是信封"}');
  expect(await f.complete(id)).toMatchObject({state:'completed',stopped:true,body:'{"'});
 });
 it('a stop naming another source than the one shown cancels instead of guessing',async()=>{
  const f=fixture('中😀后');f.execution.stop!.source='message';
  expect(await f.complete(id)).toEqual({state:'cancelled'});
 });
});
