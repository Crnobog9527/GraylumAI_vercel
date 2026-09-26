/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';
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
  await vi.advanceTimersByTimeAsync(120_000);expect(timer.mock.calls.some(([,ms])=>ms===150_000)).toBe(true);expect(exchange).toHaveBeenCalledTimes(1);expect(ended).toBe(false);
  finish();expect(await pending).toBe('Late answer');expect(exchange).toHaveBeenCalledTimes(1);
 }finally{timer.mockRestore();vi.useRealTimers();}
});
