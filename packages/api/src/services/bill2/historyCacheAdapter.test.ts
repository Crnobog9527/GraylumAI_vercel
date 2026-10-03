/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
const limits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
 requestUsd:'0',cacheWriteUsdPerMillion:'2.5'};
const identity={provider:'openrouter',account:'synthetic',model:'anthropic/test',protocol:'openrouter-chat-v1' as const,
 providerLimits:limits,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd};
const block={type:'text',text:'stable',cache_control:{type:'ephemeral'}};
const call={role:'assistant',content:null,tool_calls:[{id:'card',type:'function',function:{name:'ask_question',arguments:'{}'}}]};
const result={role:'tool',content:'shown',tool_call_id:'card'};
const system={role:'system',content:[block]}, history={role:'assistant',content:[block]}, user={role:'user',content:'current'};
const make=(messages:unknown[]=[system,history,call,result,user])=>({model:identity.model,stream:false,store:false,
 messages,max_tokens:100,provider:openRouterBound(limits,100).routing,
 tools:[{type:'function',function:{name:'ask_question',parameters:{}}}]});
it.each(['user','assistant'])('accepts the exact %s history shape and paired trailing tools',async role=>{
 const request=make([system,{...history,role},call,result,user]);
 const credential=vi.fn(async()=> 'SYNTHETIC'),transport=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const input=JSON.stringify(request);
 await openRouterAdapter({credential,transport,allowAgentTools:true}).dispatch({input},identity);
 expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0]?.[1]?.body).toBe(input);
});
it.each([
 make([{role:'system',content:'plain'},history,user]),
 make([system,{...result,content:[block]},user]),
 make([system,{...call,content:[block]},result,user]),
 make([system,history,{...user,content:[block]}]),
 make([system,history,history,user]),
 make([system,{...history,content:[{...block,cache_control:{type:'ephemeral',ttl:'1h'}}]},user]),
 {...make(),cache_control:{type:'ephemeral'}},
 make([system,{...history,content:[{...block,extra:true}]},user]),
 make([system,{...history,extra:true},user]),
 {...make(),tools:undefined,messages:[system,history,user]},
 make([system,history,call,user]), make([system,history,result,user]),
 make([system,history,call,{...result,tool_call_id:'wrong'},user]),
 make([system,history,{role:'assistant',content:'later plain'},user]),
 make([system,history,{role:'developer',content:'later rules'},user]),
 make([system,{...history,content:[{...block,text:''}]},user]),
 {...make(),tools:[{type:'function',function:{name:'ask_question',parameters:{},cache_control:{type:'ephemeral'}}}]},
])('rejects history cache violation %# before credentials/transport',async request=>{
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport,allowAgentTools:true}).dispatch({input:JSON.stringify(request)},identity))
  .rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it.each(['google/gemini','no-price','disabled-tools'])('rejects ineligible %s before credentials/transport',async mode=>{
 const request=make(), credential=vi.fn(),transport=vi.fn();
 const quote={...identity,providerLimits:{...limits}};
 if(mode==='google/gemini'){request.model=mode;quote.model=mode;}
 if(mode==='no-price'){
  delete (quote.providerLimits as {cacheWriteUsdPerMillion?:string}).cacheWriteUsdPerMillion;
  quote.upperUsd=openRouterBound(quote.providerLimits,100).upperUsd;
  request.provider=openRouterBound(quote.providerLimits,100).routing;
 }
 await expect(openRouterAdapter({credential,transport,allowAgentTools:mode!=='disabled-tools'})
  .dispatch({input:JSON.stringify(request)},quote)).rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
