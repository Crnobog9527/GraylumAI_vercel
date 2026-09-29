/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {openRouterRequestBody,PROVIDER_REQUEST_FORMATS,type ProviderRequestFormat,type RequestContext} from './providerRequest';

const policy={modelId:'00000000-0000-4000-8000-000000000001',provider:'openrouter',account:'a',model:'m/x',protocol:'openrouter-chat-v1' as const,
 upperUsd:'0.02',inputLimit:10000,outputLimit:100,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true,
 providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'}};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const call=(name:string)=>({id:'call_1',type:'function',function:{name,arguments:'{}'}});
const tool=(name:string)=>({type:'function',function:{name,description:'d',parameters:{type:'object'},strict:true}});
/** An SDK 0.18 request with one earlier tool round, as runner.ts produces it. */
const sdk=(name:string,patch:Record<string,unknown>={})=>JSON.stringify({model:'m/x',messages:[{content:'I',role:'system'},{role:'user',content:'hello'},
 {role:'assistant',content:[{type:'text',text:'先看看',role:'assistant',tool_calls:[call(name)]}],tool_calls:[call(name)]},
 {role:'tool',tool_call_id:'call_1',content:'R'}],tools:[tool(name)],max_tokens:100,parallel_tool_calls:false,stream:false,store:false,...patch});
const body=(request:string,context:RequestContext,phase='skill',primaryDialogue=true)=>openRouterRequestBody(request,{context,policy,phase,primaryDialogue});
const streamed={stream:true,stream_options:{include_usage:true}};
const older=(format:ProviderRequestFormat|undefined):RequestContext=>({providerRequestFormat:format,tools:['read_source'],workspaceContext:true,network:'deny',
 ...(['serial-tools-v4-stream','serial-tools-v6-reasoning'].includes(format??'')?{reasoning:{effort:'none'}}:{})});
const agent=(patch:Partial<RequestContext>={}):RequestContext=>({providerRequestFormat:'agent-turn-v5-stream',tools:['ask_question'],network:'deny',reasoning:{effort:'none'},...patch});

describe('older formats',()=>{
 // Recorded from execute.ts at the AC1-2 head (903be613) before this function
 // was extracted; the extraction was compared byte for byte on 20 variants.
 it.each([
  ['unmarked',undefined,{},'b39fb80d676111a775a945cff9b4e4a5a49eea54befb8affab219a6f724d8bf5'],
  ['serial-tools-v1',"serial-tools-v1",{},'1c53dec41eadf4934b34fa6b03f40713636a76276ca6692751b349e191c27c6b'],
  ['serial-tools-v2',"serial-tools-v2",{},'adc2f91cdd2aa46c9978aa31f937e14b841df368d6c71309070bccd8aa218b97'],
  ['serial-tools-v3-stream',"serial-tools-v3-stream",streamed,'bef152faa5ee93ce7385ffbe1d649057783ef54c0d00616965c303a05ee78160'],
  ['serial-tools-v4-stream',"serial-tools-v4-stream",{...streamed,reasoning_effort:'none'},'f713a36b6db43c4a9fef7004de4ba5ec2dcad8dda4a78034b098c6a7b2f8964b'],
 ] as const)('keeps %s request bytes unchanged',(_name,format,patch,golden)=>{
  expect(sha(body(sdk('read_source',patch),older(format)))).toBe(golden);
 });

 it('still refuses the question card tool',()=>{
  expect(()=>body(sdk('ask_question',{...streamed,reasoning_effort:'none'}),{...older('serial-tools-v4-stream'),tools:['ask_question']})).toThrow('RUNTIME_REAL_TOOLS_DISABLED');
  expect(()=>body(sdk('ask_question',{...streamed,reasoning_effort:'none'}),older('serial-tools-v4-stream'))).toThrow('RUNTIME_REAL_TOOLS_DISABLED');
 });
});

describe('real request bytes never carry parallel_tool_calls',()=>{
 it.each(PROVIDER_REQUEST_FORMATS.map(format=>[format]))('%s',format=>{
  const agentTurn=format==='agent-turn-v5-stream',reasoning=format==='serial-tools-v4-stream'||format==='serial-tools-v6-reasoning'||agentTurn;
  const request=sdk(agentTurn?'ask_question':'read_source',{...(format.includes('stream')?streamed:{}),...(reasoning?{reasoning_effort:'none'}:{}),parallel_tool_calls:false});
  const sent=JSON.parse(body(request,agentTurn?agent():older(format)));
  expect(sent).not.toHaveProperty('parallel_tool_calls');expect(sent).not.toHaveProperty('tool_choice');
 });
});

describe('Agent turn format',()=>{
 const request=sdk('ask_question',{...streamed,reasoning_effort:'none'});
 it('sends the question card tool with its history, streaming, reasoning and the frozen route',()=>{
  const sent=JSON.parse(body(request,agent()));
  expect(sent.tools.map((t:{function:{name:string}})=>t.function.name)).toEqual(['ask_question']);
  expect(sent.messages[2]).toEqual({role:'assistant',content:'先看看',tool_calls:[call('ask_question')]});
  expect(sent).toMatchObject({stream:true,reasoning_effort:'none',provider:{allow_fallbacks:false,require_parameters:true,only:['synthetic']}});
 });
 it.each([
  ['a tool the context does not list',agent({tools:[]})],
  ['read_source',agent({tools:['read_source']})],
  ['a workspace context',agent({workspaceContext:true})],
  ['a network other than deny',agent({network:'allow'})],
 ])('refuses %s',(_name,context)=>{
  expect(()=>body(request,context)).toThrow('RUNTIME_REAL_TOOLS_DISABLED');
 });
 it('refuses a read_source call replayed in its history',()=>{
  const mixed=JSON.parse(request);mixed.messages[2].tool_calls=[call('read_source')];mixed.messages[2].content[0].tool_calls=[call('read_source')];
  expect(()=>body(JSON.stringify(mixed),agent())).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 });
 it('carries reasoning only on the primary dialogue call',()=>{
  expect(()=>body(request,agent(),'attached_organizer',false)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
 });
});

describe('MR-2 frozen reasoning binding',()=>{
 it.each([{enabled:false},{effort:'max'},{max_tokens:2048}])('sends only the frozen object %#',value=>{
  const context={...older('serial-tools-v4-stream'),reasoning:{parameter:'reasoning' as const,value}} as RequestContext;
  const request=sdk('read_source',{...streamed,reasoning:value});
  expect(JSON.parse(body(request,context)).reasoning).toEqual(value);
  for(const patch of [{},{reasoning:{enabled:true}},{reasoning:{...value,exclude:true}},
   {reasoning_effort:'none'},{reasoning:value,reasoning_effort:'none'}])
   expect(()=>body(sdk('read_source',{...streamed,...patch}),context)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
 });
 it.each([undefined,'serial-tools-v1','serial-tools-v2','serial-tools-v3-stream'] as const)('rejects reasoning on incompatible format %s',format=>{
  expect(()=>body(sdk('read_source',{reasoning_effort:'none'}),{...older(format),reasoning:{effort:'none'}})).toThrow('RUNTIME_CONTEXT_INVALID');
  expect(()=>body(sdk('read_source'),{...older(format),attachedOrganizer:{reasoning:{parameter:'none'}}})).toThrow('RUNTIME_CONTEXT_INVALID');
 });
 it.each(['serial-tools-v4-stream','agent-turn-v5-stream','serial-tools-v6-reasoning'] as const)('requires reasoning on format %s',format=>{
  expect(()=>body(sdk('read_source'),{...older(format),reasoning:undefined})).toThrow('RUNTIME_CONTEXT_INVALID');
 });
 it('unset and explicit-default organization have identical legacy v2 bytes',()=>{
  const request=sdk('read_source');
  const before=body(request,older('serial-tools-v2'),'attached_organizer',false);
  const context={...older('serial-tools-v6-reasoning'),reasoning:{parameter:'none' as const},attachedOrganizer:{reasoning:{parameter:'none' as const}}};
  expect(body(request,context,'attached_organizer',false)).toBe(before);
  expect(body(request,context,'organizer',true)).toBe(body(request,older('serial-tools-v2'),'organizer',true));
 });
 it('binds organizer independently and never leaks primary or organizer reasoning into matching',()=>{
  const context={...older('serial-tools-v4-stream'),attachedOrganizer:{reasoning:{parameter:'reasoning' as const,value:{max_tokens:2048}}}};
  expect(JSON.parse(body(sdk('read_source',{reasoning:{max_tokens:2048}}),context,'attached_organizer',false)).reasoning).toEqual({max_tokens:2048});
  for(const phase of ['matching','attached_organizer'])
   expect(()=>body(sdk('read_source',{reasoning_effort:'none'}),context,phase,false)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
  expect(()=>body(sdk('read_source',{reasoning:{max_tokens:2048}}),context)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
 });
});
