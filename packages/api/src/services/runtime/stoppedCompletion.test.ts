/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {stoppedCompletion,type StopExecution} from './stoppedCompletion';
import type {authoritativeBilling} from '../bill2/service';
import {QUESTION_CONTRACT} from './agentTools';
import {agentTurnBody} from '../../shared/agentTurn';
const id='10000000-0000-4000-8000-000000000001';
function fixture(){
 const execution={executionId:id,sessionId:id,runId:id,state:'interrupted',live:false,cancelRequested:false,
  pausedReason:'user_stop',stop:{stopAt:2,source:'message'},epoch:1,result:null,
  context:{version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'input',instructions:'Answer',model:'model',
   maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],nativeOutput:'native-output-v1',
   providerRequestFormat:'serial-tools-v4-stream',envelopeOrder:'message-first-v1'},
  billing:{contractVersion:'bill2.v2'},stopCalls:[{sequence:1,requestHash:'a'.repeat(64),phase:'skill',dispatched:true,settled:true}],
 } as StopExecution;
 const response=(body:string,model='model')=>JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:body}}]});
 const raws=new Map<number,string>([[1,response('{"message":"中😀后","inputKind":"answer"}')]]);
 const results:unknown[]=[];
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')return {data:{rawBody:raws.get(Number(args.p_sequence))??null},error:null};
  if(args.p_action==='complete'){
   const result=(args.p_result as {value:unknown}).value;results.push(result);
   return {data:{state:result?'completed':'cancelled'},error:null};
  }
  if(args.p_action==='stop_pending')return {data:{state:'cost_pending'},error:null};
  return {data:structuredClone(execution),error:null};
 })};
 const billing={recoverReceipts:vi.fn(),finalizeRun:vi.fn(),dispatchOnce:vi.fn(),claimCall:vi.fn(),claimPaygCall:vi.fn()};
 const gate=vi.fn();
 const complete=stoppedCompletion({database,actor:async()=>id,callGate:gate},billing as unknown as ReturnType<typeof authoritativeBilling>);
 return {execution,raws,results,database,billing,complete,response,gate};
}
it('replays a step receipt without SDK/tool/new work and makes identical live/recovery results',async()=>{
 const f=fixture();
 const a=await f.complete(id),b=await f.complete(id);
 expect(a).toEqual(b);expect(f.results[0]).toEqual(f.results[1]);
 expect(a).toMatchObject({state:'completed',stopped:true,completeness:'stopped'});
 expect(JSON.parse(a && 'body' in a ? a.body! : '')).toEqual({message:'中😀',inputKind:'answer'});
 expect(f.billing.dispatchOnce).not.toHaveBeenCalled();expect(f.gate).not.toHaveBeenCalled();
});
it.each([undefined,'assistant'] as const)('missing or wrong source cancels (%s)',async source=>{
 const f=fixture();f.execution.stop!.source=source;
 expect(await f.complete(id)).toEqual({state:'cancelled'});expect(f.results).toEqual([null]);
});
it('zero position cancels after receipt settlement',async()=>{
 const f=fixture();f.execution.stop!.stopAt=0;
 expect(await f.complete(id)).toEqual({state:'cancelled'});
});
it('unknown receipts use financial lookup then cost_pending, never complete or redispatch',async()=>{
 const f=fixture();f.raws.clear();f.execution.stopCalls![0].settled=false;
 expect(await f.complete(id)).toEqual({state:'cost_pending'});
 expect(f.billing.recoverReceipts).toHaveBeenCalledExactlyOnceWith(id,undefined);
 expect(f.billing.finalizeRun).toHaveBeenCalledExactlyOnceWith(id);expect(f.results).toEqual([]);
 expect(f.billing.dispatchOnce).not.toHaveBeenCalled();
});
it('a recovered response resumes only receipt reconstruction',async()=>{
 const f=fixture();const saved=f.raws.get(1)!;f.raws.clear();f.execution.stopCalls![0].settled=false;
 f.billing.recoverReceipts.mockImplementation(async()=>{f.raws.set(1,saved);f.execution.stopCalls![0].settled=true;});
 expect(await f.complete(id)).toMatchObject({state:'completed',stopped:true});
 expect(f.results).toHaveLength(1);
});
it('a settled financial-only lookup without response prose cancels instead of inventing output',async()=>{
 const f=fixture();f.raws.clear();expect(await f.complete(id)).toEqual({state:'cancelled'});
});
it('primary stop without dispatched organizer saves unorganized',async()=>{
 const f=fixture();f.execution.context={...f.execution.context as object,
  attachedOrganizer:{modelId:id,model:'organizer',maxOutputTokens:100}};
 expect(await f.complete(id)).toMatchObject({state:'completed',organized:false,summary:''});
});
it.each([2,100])('inflight organizer receipt preserves summary only for complete primary (%s)',async stopAt=>{
 const f=fixture();f.execution.stop!.stopAt=stopAt;
 f.execution.context={...f.execution.context as object,attachedOrganizer:{modelId:id,model:'organizer',maxOutputTokens:100}};
 f.execution.primaryResult={body:'{"message":"中😀后","inputKind":"answer"}'};
 f.execution.stopCalls!.push({sequence:2,requestHash:'b'.repeat(64),phase:'attached_organizer',dispatched:true,settled:true});
 f.raws.set(2,f.response('summary','organizer'));
 expect(await f.complete(id)).toMatchObject(stopAt===2?{organized:false,summary:'',completeness:'stopped'}
  :{organized:true,summary:'summary',completeness:'complete'});
});
it('assistant receipt becomes a mentor envelope with the same normal parser',async()=>{
 const f=fixture();f.execution.context={...f.execution.context as object,providerRequestFormat:'agent-turn-v5-stream',envelopeOrder:undefined};
 f.execution.stop!.source='assistant';f.raws.set(1,f.response('中😀后'));
 expect(await f.complete(id)).toMatchObject({body:agentTurnBody('中😀',null),completeness:'stopped'});
});
it('final snapshots are authoritative and a malformed step cannot be saved as JSON fragments',async()=>{
 const f=fixture();f.execution.stop!.source='final';
 expect(await f.complete(id)).toEqual({state:'cancelled'});
 f.raws.set(1,f.response('{"inputKind":"answer","message":"中😀后"}'));
 expect(await f.complete(id)).toMatchObject({state:'completed'});
 f.raws.set(1,f.response('{"message":2}'));expect(await f.complete(id)).toEqual({state:'cancelled'});
});
it('terminal winner is read-only, including a crash followed by recovery',async()=>{
 const f=fixture();f.execution.state='completed';
 f.execution.result={kind:'usable_result',evidenceRef:id,evidenceHash:'a'.repeat(64),body:'saved',stopped:true,completeness:'stopped'};
 expect(await f.complete(id)).toMatchObject({state:'completed',body:'saved',stopped:true});
 expect(f.database.rpc).toHaveBeenCalledTimes(1);expect(f.results).toEqual([]);
});

it.each(['missing','content_filter','unknown'])('does not save an invalid terminal response (%s)',finish=>{
 const f=fixture();const raw=JSON.parse(f.raws.get(1)!);raw.choices[0].finish_reason=finish==='missing'?undefined:finish;
 f.raws.set(1,JSON.stringify(raw));return expect(f.complete(id)).resolves.toEqual({state:'cancelled'});
});
it('does not turn a truncated question tool into a usable card',async()=>{
 const f=fixture();f.execution.context={...f.execution.context as object,providerRequestFormat:'agent-turn-v5-stream',
  envelopeOrder:undefined,tools:['ask_question'],mentorText:'append-card-v1'};
 f.execution.stop!.source='assistant';f.raws.set(1,JSON.stringify({model:'model',choices:[{finish_reason:'length',message:{content:'analysis',
  tool_calls:[{id:'card',function:{name:'ask_question',arguments:JSON.stringify({question:'Q',options:['A','B'],recommended:0})}}]}}]}));
 expect(await f.complete(id)).toEqual({state:'cancelled'});
});
it('does not save a fallback notice for an empty length-limited mentor receipt',async()=>{
 const f=fixture();f.execution.context={...f.execution.context as object,providerRequestFormat:'agent-turn-v5-stream',envelopeOrder:undefined};
 f.execution.stop!.source='final';f.raws.set(1,JSON.stringify({model:'model',choices:[{finish_reason:'length',message:{content:''}}]}));
 expect(await f.complete(id)).toEqual({state:'cancelled'});
});

it.each(['\n',' '])('trailing whitespace preserves assistant stop source (%j)',async whitespace=>{
 for(const withCard of [false,true]){
  const f=fixture();f.execution.context={...f.execution.context as object,providerRequestFormat:'agent-turn-v5-stream',
   envelopeOrder:undefined,tools:['ask_question'],questionContract:QUESTION_CONTRACT,mentorText:'append-card-v1'};
  const card={message:'Pick one'+whitespace,question:'Q',options:['A','B'],recommended:0,recommendationReason:'Reason'};
  f.execution.stop={stopAt:5,source:'assistant'};
  f.raws.set(1,JSON.stringify({model:'model',choices:[{finish_reason:withCard?'tool_calls':'stop',message:{content:'Hello world'+whitespace,
   ...(withCard?{tool_calls:[{id:'card',function:{name:'ask_question',arguments:JSON.stringify(card)}}]}:{})}}]}));
  expect(await f.complete(id)).toMatchObject({state:'completed',body:agentTurnBody('Hello',null),stopped:true});
 }
});
it.each([false,true])('waits for the original HTTP response before financial lookup (settled=%s)',async settled=>{
 const f=fixture();f.raws.clear();Object.assign(f.execution.stopCalls![0],{settled,responsePending:true});
 for(let attempt=0;attempt<4;attempt++)expect(await f.complete(id)).toEqual({state:'stopping'});
 expect(f.billing.recoverReceipts).not.toHaveBeenCalled();expect(f.billing.finalizeRun).not.toHaveBeenCalled();
 expect(f.results).toEqual([]);
 f.raws.set(1,f.response('{"message":"中😀后","inputKind":"answer"}'));
 expect(await f.complete(id)).toMatchObject({state:'completed',stopped:true});
});

it('ordinary cancellation after stop delegates to existing financial recovery',async()=>{
 const f=fixture();f.execution.cancelRequested=true;
 expect(await f.complete(id)).toBeNull();expect(f.results).toEqual([]);
 expect(f.billing.recoverReceipts).not.toHaveBeenCalled();
});

it.each(['\n',' ','\u3000'])('step whitespace %j preserves the message source when stopped',async whitespace=>{
 for(const content of [whitespace+'Hello world','Hello world'+whitespace]){
  const f=fixture();f.execution.stop={stopAt:5,source:'message'};
  f.raws.set(1,f.response(JSON.stringify({message:content,inputKind:'answer'})));
  expect(await f.complete(id)).toMatchObject({state:'completed',stopped:true,
   body:JSON.stringify({message:'Hello',inputKind:'answer'})});
 }
});
it('the original finished HTTP immediately looks up a missing receipt inside the response window',async()=>{
 const f=fixture();f.raws.clear();Object.assign(f.execution.stopCalls![0],{settled:false,responsePending:true});
 expect(await f.complete(id,undefined,undefined,true)).toEqual({state:'cost_pending'});
 expect(f.billing.recoverReceipts).toHaveBeenCalledExactlyOnceWith(id,undefined);
});
