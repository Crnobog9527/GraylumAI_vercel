/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import type {Session} from '@openai/agents';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
import {openRouterStream,SOURCE_STREAM_TOOLS} from './openRouterStream';
import type {TransportObservation} from './fixtureAdapter';
import {runRuntime} from '../runtime/runner';

// CHAT-AUTO-CONTEXT: a model may answer a read_source-only request with several parallel read_source calls (Claude did on
// staging: a search at index 0 and a second call at index 1). The stream used to be rejected at index 1 (invalid_stream),
// the call was never settled and the turn hung. Synthetic frames only.
const model='test/model';
const identity={provider:'openrouter',account:'test',model,protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,
 promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,identity.outputLimit).routing;
const event=(delta:unknown,finish:string|null=null,extra:Record<string,unknown>={})=>
 'data: '+JSON.stringify({id:'gen-1',model,choices:[{index:0,delta,finish_reason:finish}],...extra})+'\n\n';
const usage='data: '+JSON.stringify({id:'gen-1',model,choices:[],usage:{prompt_tokens:10,completion_tokens:40,total_tokens:50,cost:0.00123}})+'\n\n';
const call=(index:number,id:string,query:string,name='read_source')=>
 event({tool_calls:[{index,id,type:'function',function:{name,arguments:JSON.stringify({query})}}]});
const parallel=[event({role:'assistant',content:''}),call(0,'call_a','search:古代 历史'),call(1,'call_b','search:历史'),
 event({},'tool_calls'),usage,'data: [DONE]\n\n'];
const answer=[event({role:'assistant',content:'没有找到相关资料。'}),event({},'stop'),usage,'data: [DONE]\n\n'];
const readSource={type:'function',function:{name:'read_source',description:'d',parameters:{type:'object'},strict:true}};
const request=JSON.stringify({model,stream:true,stream_options:{include_usage:true},store:false,messages:[{role:'user',content:'hello'}],
 max_tokens:100,provider:routing,tools:[readSource]});

// The second request: history keeps only the first call and its result, and (maxToolCalls reached) offers no tool.
const followUp=JSON.stringify({model,stream:true,stream_options:{include_usage:true},store:false,max_tokens:100,provider:routing,messages:[
 {role:'user',content:'hello'},
 {role:'assistant',content:null,tool_calls:[{id:'call_a',type:'function',function:{name:'read_source',arguments:JSON.stringify({query:'search:古代 历史'})}}]},
 {role:'tool',tool_call_id:'call_a',content:'{"kind":"library_search","hits":[]}'}]});

function transportOf(responses:string[][]){
 let n=0;
 return vi.fn<typeof fetch>(async()=>{
  const events=responses[n++]!;let at=0;
  return new Response(new ReadableStream<Uint8Array>({pull(controller){
   if(at===events.length)controller.close();else controller.enqueue(new TextEncoder().encode(events[at++]));}}),
   {headers:{'x-generation-id':'gen-1'}});
 });
}
const adapterFor=(transport:typeof fetch)=>
 openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
type Evidence={rejectedReason?:string;usage:{sdkResponse?:{choices:Array<{message:{tool_calls?:unknown[]}}>}}|null};

describe('parallel read_source calls in one response',()=>{
  it('the stream parser keeps every indexed read_source call as evidence',()=>{
    const stream=openRouterStream(model,undefined,undefined,SOURCE_STREAM_TOOLS);stream.push(parallel.join(''));
    const result=stream.result();expect(result.error).toBeUndefined();
    expect(result.sdkResponse!.choices[0]!.message.tool_calls).toHaveLength(2);
    // The default parser (no tool rules) still accepts exactly one call, so other requests are unchanged.
    const strict=openRouterStream(model);strict.push(parallel.join(''));expect(strict.result().error).toBe('invalid_stream');
  });

  it('only read_source is accepted: another name, a gap or a ninth call is still an invalid stream',()=>{
    for(const events of [
      [event({role:'assistant',content:''}),call(0,'call_a','x'),call(1,'call_b','y','ask_question'),event({},'tool_calls'),usage,'data: [DONE]\n\n'],
      [event({role:'assistant',content:''}),call(0,'call_a','x'),call(2,'call_c','y'),event({},'tool_calls'),usage,'data: [DONE]\n\n'],
      [event({role:'assistant',content:''}),...Array.from({length:9},(_,i)=>call(i,'call_'+i,'q')),event({},'tool_calls'),usage,'data: [DONE]\n\n'],
    ]){
      const stream=openRouterStream(model,undefined,undefined,SOURCE_STREAM_TOOLS);stream.push(events.join(''));
      expect(stream.result().error).toBeDefined();
    }
  });

  it('a retrieval turn settles the whole response, executes only the first call and then answers',async()=>{
    const transport=transportOf([parallel,answer]),adapter=adapterFor(transport);
    const observations:TransportObservation[]=[],receipts:Evidence[]=[],executed:string[]=[];
    const exchange=vi.fn(async(sequence:number,_body:string,onChunk?:(chunk:string)=>void)=>{
      const send=await adapter.prepareDispatch({input:sequence===1?request:followUp},identity,onChunk);
      const observation=await send();observations.push(observation);
      const receipt=adapter.evidence(observation,identity,'response') as unknown as Evidence;receipts.push(receipt);
      return JSON.stringify(receipt.usage!.sdkResponse);
    });
    const session:Session={getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}};
    const output=await runRuntime({model,instructions:'I',input:'hello',session,maxOutputTokens:4096,maxTurns:3,exchange,stream:true,
      libraryRetrieval:true,maxToolCalls:1,selectHistory:async(_h,i)=>i,
      tools:[{name:'read_source',description:'d',parameters:undefined,execute:async(arguments_)=>{executed.push(String(arguments_.query));return '{"kind":"library_search","hits":[]}';}}]});
    expect(output).toBe('没有找到相关资料。');
    expect(executed).toEqual(['search:古代 历史']);
    // The first response is complete, flagged for the same re-parse, and carries no rejection; the call is settled.
    expect(observations[0]).toMatchObject({complete:true,transportIssue:null,sourceTools:true});
    expect(receipts[0]!.rejectedReason).toBeUndefined();
    expect(receipts[0]!.usage!.sdkResponse!.choices[0]!.message.tool_calls).toHaveLength(2);
    expect(receipts[1]!.rejectedReason).toBeUndefined();
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});
