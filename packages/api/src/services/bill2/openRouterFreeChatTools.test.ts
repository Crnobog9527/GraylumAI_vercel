/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {openRouterBound} from './openRouterPolicy';
import {openRouterAdapter} from './openRouterAdapter';
import {historyToolNames} from '../runtime/providerRequest';
import {openRouterStream,SOURCE_STREAM_TOOLS} from './openRouterStream';

// CHAT-AUTO-CONTEXT C at the provider boundary: a free chat request may offer read_source and the general research
// tools (each once) and replay their one-call history; the positioning flow tools and the Agent card tools stay out.
const identity={provider:'openrouter',account:'test',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,identity.outputLimit).routing;
const tool=(name:string)=>({type:'function',function:{name,description:'d',parameters:{type:'object'},strict:true}});
const call=(name:string,id='call_1')=>({id,type:'function',function:{name,arguments:'{}'}});
const general=['read_source','social_search','social_account','web_search','web_fetch'];
const request=(patch:Record<string,unknown>)=>JSON.stringify({model:identity.model,stream:true,stream_options:{include_usage:true},store:false,
 messages:[{role:'user',content:'对标账号最近在发什么'}],max_tokens:100,tools:general.map(tool),provider:routing,...patch});
const adapter=()=>{
 const transport=vi.fn(async()=>new Response('data: [DONE]\n\n'));
 return {transport,adapter:openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport})};
};

describe('free chat research tools at the provider boundary',()=>{
 it('accepts read_source with the four general research tools and their one-call history',async()=>{
  const history=[{role:'user',content:'对标账号最近在发什么'},{role:'assistant',content:null,tool_calls:[call('social_account')]},
   {role:'tool',tool_call_id:'call_1',content:'{"status":"ok"}'},{role:'user',content:'再搜一下关键词'}];
  for(const body of [request({}),request({messages:history})]){
   const a=adapter();await a.adapter.dispatch({input:body},identity);expect(a.transport).toHaveBeenCalledTimes(1);
  }
 });

 it.each([
  ['a positioning flow tool',{tools:[tool('read_source'),tool('benchmark_fetch')]}],
  ['the question card tool',{tools:[tool('read_source'),tool('ask_question')]}],
  ['a duplicated research tool',{tools:[tool('web_search'),tool('web_search')]}],
  ['history calling a positioning flow tool',{messages:[{role:'assistant',content:null,tool_calls:[call('benchmark_discover')]}]}],
  ['history with two calls in one message',{messages:[{role:'assistant',content:null,tool_calls:[call('web_search'),call('web_fetch','call_2')]}]}],
 ])('rejects %s before any transport',async(_case,patch)=>{
  const a=adapter();
  await expect(a.adapter.dispatch({input:request(patch)},identity)).rejects.toThrow('DENIED');
  expect(a.transport).not.toHaveBeenCalled();
 });

 it('only the free chat format replays research history',()=>{
  expect(historyToolNames('serial-tools-v6-reasoning').has('social_search')).toBe(true);
  expect(historyToolNames('serial-tools-v2').has('social_search')).toBe(false);
  expect(historyToolNames('agent-turn-v5-stream').has('social_account')).toBe(false);
 });
});

describe('free chat research tool calls in a streamed response',()=>{
 const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
 const usage='data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n';
 it.each(['social_search','web_fetch'])('parses a %s call of a free chat response',name=>{
  const stream=openRouterStream('test/model',undefined,undefined,SOURCE_STREAM_TOOLS);
  stream.push(frame({tool_calls:[{index:0,id:'call_a',type:'function',function:{name,arguments:'{}'}}]})+frame({},'tool_calls')+usage);
  const result=stream.result();
  expect(result.error).toBeUndefined();
  expect(result.sdkResponse?.choices[0]?.message.tool_calls?.map(c=>c.function.name)).toEqual([name]);
 });
 it('still refuses a positioning flow tool in a free chat response',()=>{
  const stream=openRouterStream('test/model',undefined,undefined,SOURCE_STREAM_TOOLS);
  stream.push(frame({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'benchmark_fetch',arguments:'{}'}}]})+frame({},'tool_calls')+usage);
  expect(stream.error??stream.result().error).toBeDefined();
 });
});
