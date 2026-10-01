/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import type {Session} from '@openai/agents';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
import {openRouterStream} from './openRouterStream';
import type {TransportObservation} from './fixtureAdapter';
import {askQuestionTool,questionCardFromResult,AGENT_STREAM_TOOLS} from '../runtime/agentTools';
import {runRuntime} from '../runtime/runner';

// Gemini with thinking streams several reasoning.text deltas and then its
// reasoning.encrypted signature, all at reasoning_details index 0 (#561, tenth
// reply). These are two details. Synthetic frames only: no provider response.
const model='test/model';
const identity={provider:'openrouter',account:'test',model,protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,
 promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,identity.outputLimit).routing;
const card={question:'你主要在哪个平台？',options:['小红书','抖音']};
const event=(delta:unknown,finish:string|null=null,extra:Record<string,unknown>={})=>
 'data: '+JSON.stringify({id:'gen-1',model,choices:[{index:0,delta,finish_reason:finish}],...extra})+'\n\n';
const text=(value:string,index=0)=>({type:'reasoning.text',index,format:'google-gemini-v1',text:value});
const signature=(index=0)=>({type:'reasoning.encrypted',index,format:'google-gemini-v1',data:'U1lOVEhFVElDLVNJR05BVFVSRQ=='});
const keepalive=': OPENROUTER PROCESSING\n\n';
const usage='data: '+JSON.stringify({id:'gen-1',model,choices:[],usage:{prompt_tokens:10,completion_tokens:40,total_tokens:50,
 completion_tokens_details:{reasoning_tokens:30},cost:0.00123}})+'\n\n';
const geminiEvents=[
 event({role:'assistant',content:'',reasoning:'先想',reasoning_details:[text('先想')]}),keepalive,
 event({content:'',reasoning:'平台',reasoning_details:[text('平台')]}),
 event({content:'',reasoning:'再问',reasoning_details:[text('再问')]}),keepalive,
 event({content:'',reasoning_details:[signature()]}),
 event({content:'先了解一下。'}),
 event({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'ask_question',arguments:JSON.stringify(card)}}]}),
 event({},'tool_calls'),usage,'data: [DONE]\n\n',
];
const expectedDetails=[{...text('先想平台再问')},signature()];
const agentRequest=JSON.stringify({model,stream:true,stream_options:{include_usage:true},store:false,messages:[{role:'user',content:'hello'}],
 max_tokens:100,reasoning_effort:'low',provider:routing,
 tools:[{type:'function',function:{name:'ask_question',description:'d',parameters:{type:'object'},strict:true}}]});

/** Serves one SSE event per pull, so a parser rejection cancels with events left. */
function eventTransport(events:string[]){
 const cancel=vi.fn();let at=0;
 const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream<Uint8Array>({
  pull(controller){if(at===events.length)controller.close();else controller.enqueue(new TextEncoder().encode(events[at++]));},cancel,
 }),{headers:{'x-generation-id':'gen-1'}}));
 return {transport,cancel,served:()=>at};
}
const adapterFor=(transport:typeof fetch)=>
 openRouterAdapter({allowAgentTools:true,allowWorkspaceRead:true,credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
type Evidence={final:boolean;cost:string|null;rejectedReason?:string;rawBody:string;usage:{sdkResponse?:unknown}|null};
const stable=(value:Record<string,unknown>)=>({...value,observedAt:undefined});

describe('reasoning_details with a type change at one index',()=>{
 it('parses text then a signature at index 0 as two details, in order',()=>{
  const stream=openRouterStream(model,undefined,undefined,AGENT_STREAM_TOOLS);stream.push(geminiEvents.join(''));
  const result=stream.result();expect(result.error).toBeUndefined();
  const message=result.sdkResponse!.choices[0]!.message as Record<string,unknown>;
  expect(message.reasoning_details).toEqual(expectedDetails);expect(message.reasoning).toBe('先想平台再问');
  expect(message.tool_calls).toEqual([{id:'call_a',type:'function',function:{name:'ask_question',arguments:JSON.stringify(card)}}]);
 });

 it('reads the whole stream, records a final receipt, shows the card, and re-parses the receipt identically',async()=>{
  const {transport,cancel,served}=eventTransport(geminiEvents),adapter=adapterFor(transport);
  const observations:TransportObservation[]=[],evidence:Evidence[]=[],chunks:string[]=[];
  // The Runtime dispatches through BILL2 and replays the receipt's sdkResponse to the SDK (execute.ts).
  const exchange=vi.fn(async(_sequence:number,_request:string,onChunk?:(chunk:string)=>void)=>{
   const send=await adapter.prepareDispatch({input:agentRequest},identity,chunk=>{chunks.push(chunk);onChunk?.(chunk);});
   const observation=await send();observations.push(observation);
   const receipt=adapter.evidence(observation,identity,'response') as unknown as Evidence;evidence.push(receipt);
   return JSON.stringify(receipt.usage!.sdkResponse);
  });
  const session:Session={getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}};
  const output=await runRuntime({model,instructions:'I',input:'hello',session,maxOutputTokens:4096,maxTurns:1,exchange,stream:true,
   tools:[askQuestionTool()],selectHistory:async(_h,i)=>i,stopAtToolNames:['ask_question'],firstToolCallOnly:true});
  expect(questionCardFromResult(output)).toEqual(card);expect(exchange).toHaveBeenCalledTimes(1);
  expect(served()).toBe(geminiEvents.length);expect(cancel).not.toHaveBeenCalled();expect(chunks).toHaveLength(8);
  expect(observations[0]).toMatchObject({complete:true,transportIssue:null,agentTools:true});
  expect(evidence[0]).toMatchObject({final:true,cost:'0.00123',providerId:'gen-1'});expect(evidence[0]!.rejectedReason).toBeUndefined();
  expect(JSON.parse(evidence[0]!.rawBody).choices[0].message.reasoning_details).toEqual(expectedDetails);
  // A stored receipt is JSON; re-projecting it later must give the same result.
  const stored=JSON.parse(JSON.stringify(observations[0])) as TransportObservation;
  const again=adapter.evidence(stored,identity,'response') as unknown as Record<string,unknown>;
  expect(stable(again)).toEqual(stable(evidence[0] as unknown as Record<string,unknown>));
 });

 it('orders details by index, then by first appearance within an index',()=>{
  const stream=openRouterStream(model);
  stream.push(event({reasoning_details:[text('b',1)]})+event({reasoning_details:[signature(0)]})+event({reasoning_details:[text('a',0)]})+
   event({reasoning_details:[text('c',1),signature(1)]})+event({content:'ok'},'stop')+'data: [DONE]\n\n');
  expect((stream.result().sdkResponse!.choices[0]!.message as Record<string,unknown>).reasoning_details)
   .toEqual([signature(0),text('a',0),text('bc',1),signature(1)]);
 });

 it('keeps the projection of single-type indices unchanged (older receipts)',()=>{
  const stream=openRouterStream(model);
  stream.push(event({reasoning_details:[{type:'reasoning.summary',index:0,format:'openai-responses-v1',summary:'sum'}]})+
   event({reasoning_details:[{type:'reasoning.encrypted',index:1,format:'openai-responses-v1',id:'rs-1',data:'op'},
    {type:'reasoning.summary',index:0,summary:'mary'}]})+event({reasoning_details:[{type:'reasoning.encrypted',index:1,data:'aque'}]})+
   event({content:'ok'},'stop')+'data: [DONE]\n\n');
  expect(JSON.stringify(stream.result().sdkResponse!.choices[0]!.message.reasoning_details)).toBe(JSON.stringify([
   {type:'reasoning.summary',index:0,format:'openai-responses-v1',summary:'summary'},
   {type:'reasoning.encrypted',index:1,format:'openai-responses-v1',id:'rs-1',data:'opaque'},
  ]));
 });

 const many=(count:number)=>Array.from({length:count},(_v,index)=>text('t',index));
 it('still accepts 64 details in total',()=>{
  const stream=openRouterStream(model);
  stream.push(event({reasoning_details:many(63)})+event({reasoning_details:[signature(0)]})+event({content:'ok'},'stop')+'data: [DONE]\n\n');
  expect(stream.result().sdkResponse!.choices[0]!.message.reasoning_details).toHaveLength(64);
 });
 it.each([
  ['a format change within one (index,type)',[text('a')],[{...text('b'),format:'other'}]],
  ['an id change within one (index,type)',[{...signature(),id:'a'}],[{...signature(),id:'b'}]],
  ['more than 64 details in total',many(64),[signature(0)]],
  ['an index above 63',[text('a',64)],[]],
  ['an unknown type',[{type:'reasoning.other',index:0,text:'a'}],[]],
  ['an unknown field',[{...text('a'),extra:'x'}],[]],
  ['a non-string text',[{...text('a'),text:1}],[]],
 ])('still rejects %s',(_name,first,second)=>{
  const stream=openRouterStream(model);
  stream.push(event({reasoning_details:first})+(second.length?event({reasoning_details:second}):'')+event({content:'ok'},'stop')+'data: [DONE]\n\n');
  expect(stream.result().error).toBe('invalid_stream');expect(stream.result()).not.toHaveProperty('sdkResponse');
 });
});
