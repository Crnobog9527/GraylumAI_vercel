/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {readOpenAIUsageStream,parseProviderUsage} from '../providerUsage';
const citation={type:'url_citation',url_citation:{url:'https://example.test/source',title:'Verified source',start_index:0,end_index:6,content:'public excerpt'}};
const usage=(count:number)=>({prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.021,cost_details:{upstream_inference_prompt_cost:0.0005,upstream_inference_completions_cost:0.0005},server_tool_use:{web_search_requests:count}});
const stream=(events:unknown[],done=true)=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+(done?'data: [DONE]\n\n':'')).body!;
const event=(count:number)=>({id:'gen-original',choices:[{index:0,delta:{content:'answer',...(count?{annotations:[citation]}:{})},finish_reason:'stop'}],usage:usage(count)});
const read=(events:unknown[],enabled=true,done=true)=>readOpenAIUsageStream(stream(events,done),undefined,undefined,{searchEnabled:enabled});
it.each([0,1,3])('OpenRouter records %s performed searches, never annotations or repeated metadata',async count=>{
 const result=await read([event(count),{id:'gen-original',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:usage(count)}]);
 expect(result.search).toMatchObject({queries:null,queryCount:count,providerUnit:'search-query',providerUnits:count});
 expect(result.search?.sources).toHaveLength(count?1:0);
 expect(result.evidence.openRouterCost).toMatchObject({totalUsd:0.021,searchUsd:null});
});
it('accepts the official OpenAPI counter alias and de-duplicates matching aliases',async()=>{
 const v=usage(3);const {server_tool_use,...rest}=v;
 for(const raw of [{...rest,server_tool_use_details:server_tool_use},{...v,server_tool_use_details:server_tool_use}]){
  expect((await read([{...event(3),usage:raw}])).search?.queryCount).toBe(3);
 }
});
it('keeps nullable official counters unknown for search, while ordinary no-tool responses remain usable',async()=>{
 for(const raw of [null,{web_search_requests:null}]){
  const e={...event(0),usage:{...usage(0),server_tool_use:undefined,server_tool_use_details:raw,completion_tokens_details:{reasoning_tokens:null}}};
  expect((await read([e],false)).content).toBe('answer');
  await expect(read([e],true)).rejects.toThrow('SEARCH_EVIDENCE_UNAVAILABLE');
  expect((await read([{...e,usage:{...e.usage,server_tool_use:{web_search_requests:0}}}],true)).search?.queryCount).toBe(0);
 }
});
it('cannot hide contradictory execution evidence by filtering an unsafe citation URL',async()=>{
 const e={...event(0),choices:[{delta:{annotations:[{...citation,url_citation:{...citation.url_citation,url:'javascript:alert(1)'}}]}}]};
 await expect(read([e])).rejects.toThrow();await expect(read([e],false)).rejects.toThrow('SEARCH_EXECUTION_NOT_ALLOWED');
});
it.each([undefined,null,{}, {web_search_requests:'1'},{web_search_requests:-1},{web_search_requests:1.5},{web_search_requests:1001}])('requires valid OpenRouter search count %j',async counter=>{
 await expect(read([{...event(1),usage:{...usage(1),server_tool_use:counter}}])).rejects.toThrow();
});
it.each([undefined,null,-1,'0.01',Infinity])('requires reported total cost for search, %s is unknown',async cost=>{
 await expect(read([{...event(1),usage:{...usage(1),cost}}])).rejects.toThrow();
});
it('rejects contradictory aliases, regressing counts, mixed response identities and zero with citations',async()=>{
 for(const events of [[{...event(1),usage:{...usage(1),server_tool_use_details:{web_search_requests:2}}}],[event(3),{...event(1),choices:[]}],[event(1),{...event(1),id:'gen-foreign'}],[{...event(1),usage:usage(0)}]])await expect(read(events)).rejects.toThrow();
});
it('does not expose unsafe source links or treat model prose as evidence',async()=>{
 const e=event(1);e.choices[0].delta.annotations=[citation,{...citation,url_citation:{...citation.url_citation,url:'javascript:alert(1)'}}];
 const r=await read([e]);expect(r.search?.sources).toEqual([{url:'https://example.test/source',title:'Verified source'}]);
 await expect(read([{...event(0),usage:{prompt_tokens:100,completion_tokens:20},choices:[{delta:{content:'I searched twice. https://example.test'}}]}])).rejects.toThrow();
});
it('rejects corrupt structured annotations, unfinished streams and usage followed by content',async()=>{
 await expect(read([{...event(1),choices:[{delta:{annotations:[{type:'url_citation',url_citation:{url:4}}]}}]}])).rejects.toThrow();
 await expect(read([event(1)],true,false)).rejects.toThrow();
 await expect(read([event(1),{choices:[{delta:{content:'later'}}]}])).rejects.toThrow();
});
it('preserves partial answer when evidence is missing; denies unexpected search execution',async()=>{
 let saved='';await expect(readOpenAIUsageStream(stream([{...event(1),usage:{prompt_tokens:100,completion_tokens:20}}]),undefined,v=>{saved=v;},{searchEnabled:true})).rejects.toThrow();expect(saved).toBe('answer');
 await expect(read([event(1)],false)).rejects.toThrow('SEARCH_EXECUTION_NOT_ALLOWED');
});
it.each([{error:{code:500,message:'server tool failed'}},{finish_reason:'error'}])('retains partial output and rejects official choice error %j even with valid final usage',async error=>{
 let saved='';const e={...event(1),choices:[{...event(1).choices[0],...error}]};
 await expect(readOpenAIUsageStream(stream([e]),undefined,v=>{saved=v;},{searchEnabled:true})).rejects.toThrow('PROVIDER_STREAM_FAILED');
 expect(saved).toBe('answer');
});
it.each([false,true])('rejects pending client tool execution with separate final usage=%s',async separate=>{
 const e={...event(0),choices:[{index:0,delta:{content:'Let me search',tool_calls:[{type:'function',function:{name:'search',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
 await expect(read(separate?[{...e,usage:undefined},{id:e.id,choices:[],usage:usage(0)}]:[e])).rejects.toThrow('PROVIDER_TOOL_EXECUTION_INCOMPLETE');
 expect((await read([e,event(0)])).search?.queryCount).toBe(0);
});
it('records provider total and upstream fields separately, without claiming the difference is search cost',()=>{
 const r=parseProviderUsage({...usage(1),is_byok:true,cost_details:{upstream_inference_cost:0.03,upstream_inference_prompt_cost:0.01,upstream_inference_completions_cost:0.02,server_tool_cost:0.001}});
 expect(r.evidence.openRouterCost).toEqual({totalUsd:0.021,upstreamInferenceUsd:0.03,upstreamPromptUsd:0.01,upstreamCompletionUsd:0.02,serverToolUsd:0.001,isByok:true,searchUsd:null});
});
