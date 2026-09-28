/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {openRouterBound} from './openRouterPolicy';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterStream} from './openRouterStream';
import {AGENT_TOOL_NAMES} from '../runtime/agentTools';

// AC-1 Agent turn tools at the provider boundary: allowlisted names only, at
// most two, never tool_choice or parallel_tool_calls, and older requests
// keep exactly their previous rules.
const identity={provider:'openrouter',account:'test',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,identity.outputLimit).routing;
const tool=(name:string)=>({type:'function',function:{name,description:'d',parameters:{type:'object'},strict:true}});
const call=(name:string,id='call_1')=>({id,type:'function',function:{name,arguments:'{}'}});
const request=(patch:Record<string,unknown>)=>JSON.stringify({model:identity.model,stream:true,stream_options:{include_usage:true},store:false,
 messages:[{role:'user',content:'hello'}],max_tokens:100,reasoning_effort:'none',tools:[tool('ask_question')],provider:routing,...patch});
const adapter=(options:{allowAgentTools?:boolean;allowWorkspaceRead?:boolean}={allowAgentTools:true,allowWorkspaceRead:true})=>{
 const transport=vi.fn(async()=>new Response('data: [DONE]\n\n')),credential=vi.fn(async()=> 'LOCAL_SYNTHETIC_KEY');
 return {transport,credential,adapter:openRouterAdapter({...options,credential,transport})};
};

describe('Agent turn request allowlist',()=>{
 it('accepts the question card tool, the Skill file tool, and their one-call history',async()=>{
  const history=[{role:'user',content:'hello'},{role:'assistant',content:'先问一个问题',tool_calls:[call('ask_question')]},
   {role:'tool',tool_call_id:'call_1',content:'{"card":"question"}'},{role:'user',content:'小红书'}];
  for(const body of [request({}),request({tools:[tool('ask_question'),tool('read_skill_file')],messages:history})]){
   const a=adapter();await a.adapter.dispatch({input:body},identity);expect(a.transport).toHaveBeenCalledTimes(1);
  }
 });

 it.each([
  ['an unknown tool name',{tools:[tool('delete_account')]}],
  ['more than two tools',{tools:[tool('ask_question'),tool('read_skill_file'),tool('ask_question')]}],
  ['a duplicated tool',{tools:[tool('ask_question'),tool('ask_question')]}],
  ['mixed with read_source',{tools:[tool('ask_question'),tool('read_source')]}],
  ['tool_choice',{tool_choice:'auto'}],
  ['a forced tool_choice',{tool_choice:{type:'function',function:{name:'ask_question'}}}],
  ['parallel_tool_calls true',{parallel_tool_calls:true}],
  ['parallel_tool_calls false',{parallel_tool_calls:false}],
  ['history with an unknown tool call',{messages:[{role:'assistant',content:null,tool_calls:[call('delete_account')]}]}],
  ['history with two calls in one message',{messages:[{role:'assistant',content:null,tool_calls:[call('ask_question'),call('ask_question','call_2')]}]}],
  ['history with a read_source call',{messages:[{role:'assistant',content:null,tool_calls:[call('read_source')]}]}],
 ])('rejects %s before credential access',async(_name,patch)=>{
  const a=adapter();
  await expect(a.adapter.dispatch({input:request(patch)},identity)).rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
  expect(a.credential).not.toHaveBeenCalled();expect(a.transport).not.toHaveBeenCalled();
 });

 it('rejects Agent turn tools unless the adapter allows them',async()=>{
  const a=adapter({allowWorkspaceRead:true});
  await expect(a.adapter.dispatch({input:request({})},identity)).rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
  expect(a.transport).not.toHaveBeenCalled();
 });

 it('keeps the older read_source rules unchanged, including parallel_tool_calls false',async()=>{
  const older=request({tools:[tool('read_source')],parallel_tool_calls:false,reasoning_effort:undefined,
   messages:[{role:'assistant',content:null,tool_calls:[call('read_source')]},{role:'tool',tool_call_id:'call_1',content:'{}'}]});
  const a=adapter();await a.adapter.dispatch({input:older},identity);expect(a.transport).toHaveBeenCalledTimes(1);
  const two=adapter();
  await expect(two.adapter.dispatch({input:request({tools:[tool('read_source'),tool('read_source')],reasoning_effort:undefined})},identity)).rejects.toThrow('DENIED');
 });
});

describe('Agent turn stream parsing',()=>{
 const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
 const usage='data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n';
 const twoCalls=frame({role:'assistant',content:'先问'})+
  frame({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'ask_question',arguments:'{}'}}]})+
  frame({tool_calls:[{index:1,id:'call_b',type:'function',function:{name:'ask_question',arguments:'{}'}}]})+frame({},'tool_calls')+usage;
 it('keeps every call of an Agent turn as evidence, in index order',()=>{
  const stream=openRouterStream('test/model',undefined,undefined,{toolNames:AGENT_TOOL_NAMES,maxCalls:8});stream.push(twoCalls);
  const result=stream.result();
  expect(result.error).toBeUndefined();
  expect(result.sdkResponse?.choices[0]?.message.tool_calls?.map(c=>c.id)).toEqual(['call_a','call_b']);
 });
 it('keeps the older single read_source rule by default',()=>{
  const stream=openRouterStream('test/model');stream.push(twoCalls);expect(stream.result().error).toBeTruthy();
 });
 it.each([
  ['an unknown name',frame({tool_calls:[{index:0,id:'x',type:'function',function:{name:'delete_account',arguments:'{}'}}]})],
  ['a gap in call indices',frame({tool_calls:[{index:1,id:'x',type:'function',function:{name:'ask_question',arguments:'{}'}}]})],
  ['an index beyond the limit',frame({tool_calls:[{index:8,id:'x',type:'function',function:{name:'ask_question',arguments:'{}'}}]})],
 ])('rejects %s',(_name,body)=>{
  const stream=openRouterStream('test/model',undefined,undefined,{toolNames:AGENT_TOOL_NAMES,maxCalls:8});
  stream.push(frame({role:'assistant'})+body+frame({},'tool_calls')+usage);
  expect(stream.result().error).toBeTruthy();
 });
});

describe('Agent turn receipt projection',()=>{
 const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
 const sse=frame({role:'assistant',content:'先问'})+
  frame({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'ask_question',arguments:'{}'}}]})+
  frame({tool_calls:[{index:1,id:'call_b',type:'function',function:{name:'ask_question',arguments:'{}'}}]})+frame({},'tool_calls')+
  'data: '+JSON.stringify({id:'gen-1',model:'test/model',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.001}})+'\n\ndata: [DONE]\n\n';
 const observe=async(body:string)=>{
  const adapter=openRouterAdapter({allowAgentTools:true,allowWorkspaceRead:true,credential:async()=> 'LOCAL_SYNTHETIC_KEY',
   transport:async()=>new Response(sse,{headers:{'x-generation-id':'gen-1'}})});
  const observation=await adapter.dispatch({input:body},identity);
  return {observation,evidence:adapter.evidence(observation,identity,'response') as {rawBody?:string;rejectedReason?:string}};
 };
 it('keeps both calls of an Agent turn response as the replayable body',async()=>{
  const {observation,evidence}=await observe(request({}));
  expect(observation.agentTools).toBe(true);expect(evidence.rejectedReason).toBeUndefined();
  expect(JSON.parse(evidence.rawBody!).choices[0].message.tool_calls.map((c:{id:string})=>c.id)).toEqual(['call_a','call_b']);
 });
 it('an older request never gets the flag, so the same bytes stay rejected',async()=>{
  const {observation,evidence}=await observe(request({tools:[tool('read_source')],reasoning_effort:undefined}));
  expect(observation.agentTools).toBeUndefined();expect(evidence.rejectedReason).toBeTruthy();
 });
});
