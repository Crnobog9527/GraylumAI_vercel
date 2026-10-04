/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {TRPCError,type inferProcedureOutput} from '@trpc/server';
import type {opcRouter} from '../../routers/opc';
import type {runtimeRouter} from '../../routers/runtime';
import type {AgentTurnEvent} from '../../shared/agentTurn';
import type {RuntimeProgress} from './progress';
import {createRequestTiming} from './timing';
import {runtimeLocalEndpoint,streamOriginalExecution,TEXT_EVENT_INTERVAL_MS,type OriginalExecutionOutcome} from './executionStream';

// Compile-time contract: both streamed procedures emit only AC-1 events
// (packages/api/src/shared/agentTurn.ts). This file is in the web typecheck.
type Events<T>=T extends AsyncIterable<infer E>?E:never;
type TurnEvent=Events<inferProcedureOutput<typeof opcRouter['mentorTurnStream']>>;
type ExecutionEvent=Events<inferProcedureOutput<typeof runtimeRouter['executeStream']>>;
export const turnEventsFollowContract:(event:TurnEvent)=>AgentTurnEvent=event=>event;
export const executionEventsFollowContract:(event:ExecutionEvent)=>AgentTurnEvent=event=>event;

function controlled(){
 let emit:(event:RuntimeProgress)=>void=()=>{},finish:(value:OriginalExecutionOutcome)=>void=()=>{},fail:(error:unknown)=>void=()=>{};
 let settled=false;
 const run=(onProgress:(event:RuntimeProgress)=>void)=>{emit=onProgress;return new Promise<OriginalExecutionOutcome>((resolve,reject)=>{
  finish=value=>{settled=true;resolve(value);};fail=error=>{settled=true;reject(error);};
 });};
 return {run,emit:(event:RuntimeProgress)=>emit(event),finish:(value:OriginalExecutionOutcome)=>finish(value),fail:(error:unknown)=>fail(error),settled:()=>settled};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

describe('streamOriginalExecution',()=>{
 it('delivers the latest text and phase, then the result, and marks first public text once',async()=>{
  const c=controlled(),timing=createRequestTiming();
  const stream=streamOriginalExecution(c.run,timing,'opc.mentorTurnStream');
  const first=stream.next();
  c.emit({type:'phase',phase:'mentor'});
  expect(await first).toEqual({done:false,value:{type:'phase',phase:'mentor'}});
  const second=stream.next();
  // Only the latest pending text is delivered: each one carries the whole text.
  c.emit({type:'text',text:'先'});c.emit({type:'text',text:'先说说'});
  expect(await second).toEqual({done:false,value:{type:'text',text:'先说说'}});
  c.emit({type:'phase',phase:'saving'});c.finish({state:'completed',body:'{"message":"先说说"}'});
  const rest=[];for await(const event of stream)rest.push(event);
  expect(rest).toEqual([{type:'phase',phase:'saving'},{type:'result',result:{state:'completed',body:'{"message":"先说说"}'}}]);
  expect(timing.summary().marks.firstPublicTextMs).toBeGreaterThanOrEqual(0);
 });

 it('spaces text events, keeping the latest text, and always sends the final text before the result',async()=>{
  const c=controlled();let clock=0;
  const stream=streamOriginalExecution(c.run,undefined,'opc.mentorTurnStream',()=>clock);
  const first=stream.next();c.emit({type:'text',text:'一'});
  expect((await first).value).toEqual({type:'text',text:'一'});
  // Within the interval, later texts wait and replace each other.
  const second=stream.next();let delivered=false;void second.then(()=>{delivered=true;});
  clock=50;c.emit({type:'text',text:'一二'});await tick();c.emit({type:'text',text:'一二三'});await tick();
  expect(delivered).toBe(false);
  clock=100;await new Promise(resolve=>setTimeout(resolve,TEXT_EVENT_INTERVAL_MS+20));
  expect((await second).value).toEqual({type:'text',text:'一二三'});
  // The execution ends inside the next interval: the last text is not held back.
  clock=120;c.emit({type:'text',text:'一二三四'});c.finish({state:'completed',body:'x'});
  const rest=[];for await(const event of stream)rest.push(event);
  expect(rest).toEqual([{type:'text',text:'一二三四'},{type:'result',result:{state:'completed',body:'x'}}]);
 });

 it('maps an execution failure after all progress, through the staging error mapper',async()=>{
  const c=controlled(),stream=streamOriginalExecution(c.run,undefined,'opc.mentorTurnStream');
  const first=stream.next();c.emit({type:'text',text:'部分'});expect((await first).value).toEqual({type:'text',text:'部分'});
  c.fail(new Error('RAW_PRIVATE_DETAIL'));
  const error=await stream.next().catch(cause=>cause);
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
  expect((error as TRPCError).message).not.toContain('RAW_PRIVATE_DETAIL');
 });

 it('a disconnected reader never stops the execution: return waits for it to settle',async()=>{
  const c=controlled(),stream=streamOriginalExecution(c.run,undefined,'runtime.executeStream');
  const first=stream.next();c.emit({type:'text',text:'部分'});await first;
  const closed=stream.return(undefined as never);let returned=false;void closed.then(()=>{returned=true;});
  await tick();expect(returned).toBe(false);expect(c.settled()).toBe(false);
  c.finish({state:'completed',body:'x'});await closed;expect(returned).toBe(true);
 });
});

it('delivers the first card after final text even when organizer/saving arrive before the reader resumes',async()=>{
 const c=controlled(),stream=streamOriginalExecution(c.run,undefined,'opc.mentorTurnStream');
 const first=stream.next();c.emit({type:'text',text:'先分析'});await first;
 const card={question:'下一步？',options:['甲','乙'],recommended:0};
 c.emit({type:'text',text:'先分析，再选择。'});c.emit({type:'card',card});
 c.emit({type:'phase',phase:'organizer'});
 c.emit({type:'card',card:{question:'不应显示的第二张',options:['丙','丁'],recommended:null}});
 c.emit({type:'phase',phase:'saving'});c.finish({state:'completed',body:'saved-envelope'});
 const events=[];for await(const event of stream)events.push(event);
 expect(events).toEqual([{type:'text',text:'先分析，再选择。'},{type:'card',card},
  {type:'phase',phase:'saving'},{type:'result',result:{state:'completed',body:'saved-envelope'}}]);
});

describe('runtimeLocalEndpoint',()=>{
 it('accepts only loopback HTTP for both the endpoint and the database',()=>{
  const saved={endpoint:process.env.V3_RUNTIME_LOCAL_ENDPOINT,database:process.env.NEXT_PUBLIC_SUPABASE_URL};
  try{
   process.env.V3_RUNTIME_LOCAL_ENDPOINT='http://127.0.0.1:9';process.env.NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:8';
   expect(runtimeLocalEndpoint()).toBe('http://127.0.0.1:9');
   process.env.NEXT_PUBLIC_SUPABASE_URL='https://example.supabase.co';expect(()=>runtimeLocalEndpoint()).toThrow('RUNTIME_DISABLED');
   process.env.NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:8';delete process.env.V3_RUNTIME_LOCAL_ENDPOINT;
   expect(()=>runtimeLocalEndpoint()).toThrow('RUNTIME_DISABLED');
  }finally{
   for(const [key,value] of [['V3_RUNTIME_LOCAL_ENDPOINT',saved.endpoint],['NEXT_PUBLIC_SUPABASE_URL',saved.database]] as const){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
   }
  }
 });
});

it('negotiates native deltas while legacy clients receive whole-text replacements',async()=>{
 for(const protocol of [undefined,'textDelta-v1'] as const){
  const c=controlled(),stream=streamOriginalExecution(c.run,undefined,'test',undefined,protocol);
  const first=stream.next();c.emit({type:'text',text:'😀a',delta:'😀a',replace:true});
  expect((await first).value).toEqual(protocol?{type:'textDelta',offset:0,rev:0,text:'😀a'}:{type:'text',text:'😀a'});
  c.emit({type:'text',text:'😀ab',delta:'b',replace:false});
  c.emit({type:'text',text:'card',delta:'card',replace:true});c.finish({state:'completed'});
  const rest=[];for await(const event of stream)rest.push(event);
  expect(rest[0]).toEqual(protocol?{type:'textDelta',offset:0,rev:1,text:'card'}:{type:'text',text:'card'});
 }
});

it('holds even the terminal native snapshot until the 100ms window ends',async()=>{
 const c=controlled();let clock=0;
 const stream=streamOriginalExecution(c.run,undefined,'test',()=>clock,'textDelta-v1');
 const first=stream.next();c.emit({type:'text',text:'a',delta:'a',replace:true});await first;
 clock=50;c.emit({type:'text',text:'ab',delta:'b',replace:false});c.finish({state:'completed'});
 const second=stream.next();let delivered=false;void second.then(()=>{delivered=true;});
 await tick();expect(delivered).toBe(false);
 clock=100;await new Promise(resolve=>setTimeout(resolve,100));
 expect((await second).value).toEqual({type:'textDelta',offset:1,rev:0,text:'b'});
 expect((await stream.next()).value).toEqual({type:'result',result:{state:'completed'}});
 await stream.next();
});
