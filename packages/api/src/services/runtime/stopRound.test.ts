/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {stoppedCompletion,type StopExecution} from './stoppedCompletion';
import {NativeProgressProjection,NativeTextTransport} from './nativeProgress';
import {nativeFrameProjection} from './nativeOutput';
import {runtimeRouter} from '../../routers/runtime';
import {createRuntimeBudget} from './budget';
import type {authoritativeBilling} from '../bill2/service';

// CHAT-NATIVE-OUTPUT follow-up (0260): a stop names the round whose text was on screen.
const id='10000000-0000-4000-8000-000000000001';
const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'input',instructions:'Answer',model:'synthetic/model',
 maxOutputTokens:1000,maxTurns:2,historyItems:0,tools:['read_source'],workspaceContext:true,nativeOutput:'native-output-v1',
 network:'deny',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'},textStream:'plain-text-v1'};
const response=(message:Record<string,unknown>,finish='stop')=>JSON.stringify({model:'synthetic/model',choices:[{finish_reason:finish,message}]});
// Round 1: prose, then a read_source call. Round 2: the answer, already started when the stop arrived.
const raws=new Map([[1,response({content:'我先读一下资料再回答',tool_calls:[{id:'c1',function:{name:'read_source',arguments:'{}'}}]},'tool_calls')],
 [2,response({content:'根据资料，结论如下'})]]);
function complete(stop:{stopAt:number;source:'assistant';call?:number}){
 const execution={executionId:id,sessionId:id,runId:id,state:'interrupted',live:false,cancelRequested:false,pausedReason:'user_stop',
  stop,epoch:1,result:null,context,billing:{contractVersion:'bill2.v2'},
  stopCalls:[1,2].map(sequence=>({sequence,requestHash:'a'.repeat(64),phase:'ordinary',dispatched:true,settled:true}))} as StopExecution;
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')return {data:{rawBody:raws.get(Number(args.p_sequence))??null},error:null};
  if(args.p_action==='complete'){const value=(args.p_result as {value:unknown}).value;return {data:{state:value?'completed':'cancelled'},error:null};}
  return {data:structuredClone(execution),error:null};
 })};
 const billing={recoverReceipts:vi.fn(),finalizeRun:vi.fn(),dispatchOnce:vi.fn(),claimCall:vi.fn(),claimPaygCall:vi.fn()};
 return stoppedCompletion({database,actor:async()=>id,callGate:vi.fn()},billing as unknown as ReturnType<typeof authoritativeBilling>)(id);
}

describe('stop bound to the round on screen',()=>{
 it('keeps the round the user saw even when a later round started before the stop arrived',async()=>{
  expect(await complete({stopAt:5,source:'assistant',call:1})).toMatchObject({state:'completed',stopped:true,body:'我先读一下'});
 });
 it('a stop on the later round keeps that round',async()=>{
  expect(await complete({stopAt:2,source:'assistant',call:2})).toMatchObject({state:'completed',stopped:true,body:'根据'});
 });
 it('a stop without a round (an older client) keeps the last dispatched round, as before',async()=>{
  expect(await complete({stopAt:2,source:'assistant'})).toMatchObject({state:'completed',body:'根据'});
 });
 it('a round that was never dispatched saves nothing instead of guessing',async()=>{
  expect(await complete({stopAt:2,source:'assistant',call:7})).toEqual({state:'cancelled'});
 });
});

describe('streamed text names its round',()=>{
 it('every text event carries the call of the round it came from, across a tool round',()=>{
  const transport=new NativeTextTransport(),events:unknown[]=[];
  for(const [call,content] of [[1,'我先读一下'],[2,'结论']] as const){
   const project=nativeFrameProjection(new NativeProgressProjection({mode:'agent'}),update=>transport.push({...update,call}));
   project(JSON.stringify({choices:[{delta:{content}}]}));events.push(transport.flush());
  }
  expect(events).toMatchObject([{offset:0,text:'我先读一下',rev:0,call:1},{offset:0,text:'结论',rev:1,call:2}]);
 });
});

describe('runtime.cancel',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('passes the round with the stop intent; a plain cancel is unchanged',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('V3_RUNTIME_LOCAL_ENDPOINT','http://127.0.0.1:12345');
  const rpc=vi.fn(async()=>({data:{state:'stopping'},error:null}));
  const token='e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.synthetic';
  const profile={select(){return this;},eq(){return this;},single:async()=>({data:{id,role:'user',status:'active',credits:100,
   nickname:'Fixture',email:'fixture@example.test'},error:null})};
  const client={from:()=>profile,rpc,auth:{getSession:async()=>({data:{session:{access_token:token}},error:null}),
   getUser:async()=>({data:{user:{id}},error:null})}};
  const caller=runtimeRouter.createCaller({headers:new Headers(),runtimeBudget:createRuntimeBudget(),user:{id,email:'fixture@example.test'},
   isEmailVerified:true,supabase:client,supabaseAuth:client,supabaseAdmin:client,hasSupabaseAdminPrivileges:true} as never);
  await caller.cancel({executionId:id,stopAt:5,source:'assistant',call:1});
  expect(rpc).toHaveBeenLastCalledWith('runtime_execution',{p_actor_id:id,p_execution_id:id,p_action:'stop',
   p_result:{stopAt:5,source:'assistant',call:1}});
  await caller.cancel({executionId:id});
  expect(rpc).toHaveBeenLastCalledWith('runtime_cancel',{p_actor_id:id,p_execution_id:id});
  await expect(caller.cancel({executionId:id,stopAt:5,call:0})).rejects.toBeTruthy();
 });
});
