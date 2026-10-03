/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';
import type {ReasoningPolicy} from './reasoningPolicy';
import {admitReasoning} from './reasoningAdmission';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
const session=():Session=>({getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}});
it.each([null,'','  '])('stops final truncated empty output (%s) without a second SDK turn',async(content)=>{
 const exchange=vi.fn(async()=>JSON.stringify({id:'local',object:'chat.completion',created:1,model:'test/model',choices:[{index:0,finish_reason:'length',message:{role:'assistant',content,reasoning:'PRIVATE_REASONING'}}],usage:{prompt_tokens:1,completion_tokens:1000,total_tokens:1001}}));
 await expect(runRuntime({model:'test/model',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:1000,maxTurns:2,tools:[],selectHistory:async(_h,i)=>i,exchange})).rejects.toThrow('RUNTIME_OUTPUT_TRUNCATED');
 expect(exchange).toHaveBeenCalledTimes(1);
});
it.each(['stop','length'])('retains nonempty %s responses',async(finish_reason)=>{
 const exchange=vi.fn(async()=>JSON.stringify({id:'local',object:'chat.completion',created:1,model:'test/model',choices:[{index:0,finish_reason,message:{role:'assistant',content:'Actual text'}}],usage:{prompt_tokens:1,completion_tokens:3,total_tokens:4}}));
 await expect(runRuntime({model:'test/model',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:1000,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange})).resolves.toBe('Actual text');
});
it('does not classify transport uncertainty as a final truncation',async()=>{
 await expect(runRuntime({model:'test/model',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:1000,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange:async()=>{throw new Error('unknown transport');}})).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
});
it('original SDK waits for a slow bounded exchange once without a hidden retry',async()=>{
 vi.useFakeTimers();const timer=vi.spyOn(globalThis,'setTimeout');let finish!:()=>void;
 const exchange=vi.fn(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return JSON.stringify({id:'late',object:'chat.completion',created:1,model:'test/model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Late answer'}}]});});
 let ended=false;const pending=runRuntime({model:'test/model',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:1000,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange}).then(value=>{ended=true;return value;});
 try{
  await vi.advanceTimersByTimeAsync(120_000);expect(timer.mock.calls.some(([,ms])=>ms===270_000)).toBe(true);expect(exchange).toHaveBeenCalledTimes(1);expect(ended).toBe(false);
  finish();expect(await pending).toBe('Late answer');expect(exchange).toHaveBeenCalledTimes(1);
 }finally{timer.mockRestore();vi.useRealTimers();}
});
it('streams actual SDK deltas before the exchange finishes and makes exactly one POST',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let first!:()=>void;const visible=new Promise<void>(resolve=>{first=resolve;});
 const chunks:string[]=[];let completed=false;
 const exchange=vi.fn(async(_sequence:number,body:string,onChunk?:((chunk:string)=>void))=>{
  expect(JSON.parse(body).stream).toBe(true);
  onChunk!(JSON.stringify({id:'stream-one',object:'chat.completion.chunk',created:1,model:'test/model',choices:[{index:0,delta:{role:'assistant',content:'First '},finish_reason:null}]}));
  await gate;
  onChunk!(JSON.stringify({id:'stream-one',object:'chat.completion.chunk',created:1,model:'test/model',choices:[{index:0,delta:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}}));
  return JSON.stringify({id:'stream-one',object:'chat.completion',created:1,model:'test/model',choices:[{index:0,message:{role:'assistant',content:'First answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}});
 });
 const pending=runRuntime({model:'test/model',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:4096,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange,stream:true,onText:text=>{chunks.push(text);first();}}).then(value=>{completed=true;return value;});
 await visible;expect(chunks.join('')).toBe('First ');expect(completed).toBe(false);release();
 expect(await pending).toBe('First answer');expect(chunks.join('')).toBe('First answer');expect(exchange).toHaveBeenCalledTimes(1);
});

async function generatedBody(stream:boolean,reasoning?:ReasoningPolicy,model='m/x'){
 let body='';
 const exchange=vi.fn(async(_sequence:number,request:string,onChunk?:(chunk:string)=>void)=>{
  body=request;const response={id:'local',object:'chat.completion',created:1,model,choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}]};
  onChunk?.(JSON.stringify({...response,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));
  return JSON.stringify(response);
 });
 await runRuntime({model,instructions:'系统说明 "quoted"\n第二行',input:'HOST_OPEN_CURRENT_QUESTION',session:session(),maxOutputTokens:4096,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange,stream,...(reasoning?{reasoning}:{})});
 expect(exchange).toHaveBeenCalledTimes(1);return body;
}
it.each([false,true])('keeps pre-policy SDK request bytes when no reasoning policy is frozen (stream=%s)',async(stream)=>{
 // Golden hashes were generated by the locked SDK on staging 93b855b0 before this policy existed.
 const golden=stream?'2fbc2f6b9786b3ca9d51034a7510e940fdaeda1f80a758b1318f560eeb5b23a4':'d5775f64b6a2217798aa8b2783919558a5a91d3c08ff448b30f00c948a247d59';
 const body=await generatedBody(stream);
 expect(createHash('sha256').update(body).digest('hex')).toBe(golden);
 expect(body).not.toMatch(/reasoning/);
});
it.each([false,true])('emits the frozen policy through the SDK as exactly one reasoning_effort field (stream=%s)',async(stream)=>{
 const body=JSON.parse(await generatedBody(stream,{effort:'none'}));
 expect(body.reasoning_effort).toBe('none');expect(body).not.toHaveProperty('reasoning');
 expect(Object.keys(body)).toEqual(['model','messages','max_tokens','stream',...(stream?['stream_options']:[]),'store','reasoning_effort']);
 expect(body.max_tokens).toBe(4096);expect(body.stream).toBe(stream);
});
it('never shows reasoning-only stream frames and leaves an interrupted exchange pending after one POST',async()=>{
 const shown:string[]=[];
 const exchange=vi.fn(async(_sequence:number,_body:string,onChunk?:(chunk:string)=>void)=>{
  for(let i=0;i<50;i++)onChunk!(JSON.stringify({id:'gen-reasoning',object:'chat.completion.chunk',created:1,model:'m/x',choices:[{index:0,delta:{role:'assistant',content:'',reasoning:'PRIVATE_REASONING',reasoning_details:[{type:'reasoning.text',index:0,text:'PRIVATE_REASONING'}]},finish_reason:null}]}));
  throw new Error('body_timeout');
 });
 await expect(runRuntime({model:'m/x',instructions:'Answer',input:'hello',session:session(),maxOutputTokens:4096,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange,stream:true,reasoning:{effort:'none'},onText:text=>shown.push(text)})).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
 expect(shown.join('')).toBe('');expect(exchange).toHaveBeenCalledTimes(1);
});

it.each([false,true])('provider default keeps exact pre-policy SDK bytes (stream=%s)',async stream=>{
 expect(await generatedBody(stream,{parameter:'none'})).toBe(await generatedBody(stream));
});
it.each([{enabled:false},{effort:'max'},{max_tokens:2048}])('sends frozen reasoning object through SDK providerData %#',async value=>{
 for(const stream of [false,true]){
  const before=await generatedBody(stream);
  const sent=await generatedBody(stream,{parameter:'reasoning',value} as ReasoningPolicy);
  expect(sent).toBe(JSON.stringify({...JSON.parse(before),reasoning:value}));
 }
});
it('current staging mentor configuration generates exactly the previous v4 SDK bytes',async()=>{
 const model='deepseek/deepseek-v4.1-flash';
 const config=configuredReasoning(model);config.reasoning.route='deepinfra/fp8';config.reasoning.catalog!.endpoints[0]!.tag='deepinfra/fp8';
 const frozen=admitReasoning({model_id:model,config},'interactive','deepinfra/fp8',4096);
 expect(frozen).toEqual({effort:'none'});
 expect(await generatedBody(true,frozen,model)).toBe(await generatedBody(true,{effort:'none'},model));
});

it.each([false,true])('explicit organizer history read flag=%s preserves writes and wire selection',async readSessionHistory=>{
 const saved:unknown[]=[];let reads=0;
 const local=session();
 local.getItems=async()=>{reads++;return [{role:'user',content:'Historical material'}];};
 local.addItems=async items=>{saved.push(...items);};
 const requests:string[]=[];
 await runRuntime({model:'test/model',instructions:'Organize explicit input',input:'Explicit material',
  session:local,maxOutputTokens:1000,maxTurns:1,tools:[],readSessionHistory,
  selectHistory:async(history,incoming)=>[...history,...incoming],exchange:async(_sequence,body)=>{
   requests.push(body);
   return JSON.stringify({id:'test',object:'chat.completion',created:1,model:'test/model',
    choices:[{index:0,message:{role:'assistant',content:'Organized'},finish_reason:'stop'}]});
  }});
 expect(reads).toBe(readSessionHistory?1:0);
 expect(requests[0]!.includes('Historical material')).toBe(readSessionHistory);
 expect(requests[0]).toContain('Explicit material');
 expect(JSON.stringify(saved)).toContain('Organized');
});
