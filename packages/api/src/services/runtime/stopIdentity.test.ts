/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it,vi} from 'vitest';
import {stoppedCompletion,type StopExecution} from './stoppedCompletion';
import {withBrandIdentity} from '../modelIdentity/brandIdentity';
import type {authoritativeBilling} from '../bill2/service';

// CHAT-NATIVE-OUTPUT follow-up: a stop keeps the first stopAt code points the user saw. An identity rewrite
// (MODEL-IDENTITY-GUARD) that only touches text after the stop point must not cancel the stop.
const id='10000000-0000-4000-8000-000000000001';
const base={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'input',model:'synthetic/model',
 maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],nativeOutput:'native-output-v1',network:'deny',
 instructions:withBrandIdentity('Answer',true)} as const;
function complete(context:Record<string,unknown>,content:string,stop:{stopAt:number;source:'assistant'|'message'|'final'}){
 const execution={executionId:id,sessionId:id,runId:id,state:'interrupted',live:false,cancelRequested:false,
  pausedReason:'user_stop',stop,epoch:1,result:null,context,billing:{contractVersion:'bill2.v2'},
  stopCalls:[{sequence:1,requestHash:'a'.repeat(64),phase:'skill',dispatched:true,settled:true}]} as StopExecution;
 const raw=JSON.stringify({model:'synthetic/model',choices:[{finish_reason:'stop',message:{content}}]});
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')return {data:{rawBody:raw},error:null};
  if(args.p_action==='complete'){const value=(args.p_result as {value:unknown}).value;return {data:{state:value?'completed':'cancelled'},error:null};}
  return {data:structuredClone(execution),error:null};
 })};
 const billing={recoverReceipts:vi.fn(),finalizeRun:vi.fn(),dispatchOnce:vi.fn(),claimCall:vi.fn(),claimPaygCall:vi.fn()};
 return stoppedCompletion({database,actor:async()=>id,callGate:vi.fn()},billing as unknown as ReturnType<typeof authoritativeBilling>)(id);
}
describe('identity rewrite after the stop point',()=>{
 it('control: the same stops without an identity sentence complete',async()=>{
  expect(await complete({...base,providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'}},
   '好的，先说结论。后面是正文。',{stopAt:4,source:'assistant'})).toMatchObject({state:'completed',stopped:true});
  expect(await complete({...base,providerRequestFormat:'serial-tools-v4-stream',envelopeOrder:'message-first-v1',reasoning:{parameter:'none'}},
   JSON.stringify({message:'好的，先说结论。后面是正文。',inputKind:'answer'}),{stopAt:4,source:'message'}))
   .toMatchObject({state:'completed',stopped:true});
 });
 it('Agent turn (agent-turn-v5) keeps the shown prefix',async()=>{
  const result=await complete({...base,providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'}},
   '好的，先说结论。I am Claude.',{stopAt:4,source:'assistant'});
  expect(result).toMatchObject({state:'completed',stopped:true});
 });
 it('step envelope (v4 message-first) keeps the shown prefix',async()=>{
  const result=await complete({...base,providerRequestFormat:'serial-tools-v4-stream',envelopeOrder:'message-first-v1',
   reasoning:{parameter:'none'}},JSON.stringify({message:'好的，先说结论。I am Claude.',inputKind:'answer'}),{stopAt:4,source:'message'});
  expect(result).toMatchObject({state:'completed',stopped:true});
 });
});

describe('a rewrite inside the shown text is not what the user saw',()=>{
 it('keeps the old rule: the stop is cancelled rather than saving text that differs from the screen',async()=>{
  const result=await complete({...base,providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'}},
   'I am Claude. 后面是正文。',{stopAt:6,source:'assistant'});
  expect(result).toEqual({state:'cancelled'});
 });
});
