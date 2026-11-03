/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
import {cacheMarkerCount} from './cacheMessages';
const limits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
 requestUsd:'0',cacheWriteUsdPerMillion:'2.5'};
const identity={provider:'openrouter',account:'synthetic',model:'anthropic/test',protocol:'openrouter-chat-v1' as const,
 providerLimits:limits,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd};
const block=(text:string)=>({type:'text',text,cache_control:{type:'ephemeral'}});
const system={role:'system',content:[block('shared'),block('per-user')]};
const history={role:'assistant',content:[block('earlier answer')]},user={role:'user',content:'current'};
const call={role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'web_search',arguments:'{}'}}]};
const result={role:'tool',content:'found',tool_call_id:'c1'};
const tools=[{type:'function',function:{name:'web_search',parameters:{}}}];
const make=(messages:unknown[],withTools=true)=>({model:identity.model,stream:false,store:false,messages,max_tokens:100,
 provider:openRouterBound(limits,100).routing,...(withTools?{tools}:{})});
async function accepted(request:unknown){
 const credential=vi.fn(async()=> 'SYNTHETIC'),transport=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const input=JSON.stringify(request);
 await openRouterAdapter({credential,transport,allowWorkspaceRead:true}).dispatch({input},identity);
 expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0]?.[1]?.body).toBe(input);
}
async function denied(request:unknown,quote:typeof identity=identity){
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport,allowWorkspaceRead:true}).dispatch({input:JSON.stringify(request)},quote))
  .rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
}
it.each([
 make([system,user]),
 make([system,{role:'user',content:'q1'},history,user]),
 make([system,{role:'user',content:'q1'},call,result,history,user]),
 make([system,{role:'user',content:'q1'},history,user],false),
 make([{role:'system',content:[block('shared')]},{role:'user',content:'q1'},{...history,role:'user'},user],false),
])('accepts two marked system blocks and one marked plain history message (%#) and forwards exact bytes',accepted);
it.each([
 make([system,{role:'user',content:'q1'},history,history,user]),
 make([system,{role:'user',content:'q1'},history,{role:'assistant',content:'later plain'},user]),
 make([system,{role:'user',content:'q1'},history,call,result]),
 make([system,{...user,content:[block('current')]}]),
 make([system,{role:'user',content:'q1'},{...result,content:[block('found')]},user]),
 make([{role:'system',content:[block('a'),block('b'),block('c')]},user]),
 make([{role:'system',content:[{type:'text',text:'plain'},block('b')]},user]),
 make([{role:'system',content:[block('a'),{type:'text',text:'plain'},block('c')]},user]),
 make([{role:'system',content:[block('a'),{...block('b'),cache_control:{type:'ephemeral',ttl:'1h'}}]},user]),
 make([system,{role:'user',content:'q1'},history,{role:'user',content:'q2'},{role:'assistant',content:[block('x')]},user]),
])('rejects marker violation %# before credentials and transport',request=>denied(request));
it('rejects every marker for a model or quote that cannot carry one',async()=>{
 await denied({...make([system,{role:'user',content:'q1'},history,user]),model:'google/gemini'},{...identity,model:'google/gemini'});
 const withoutWrite:Partial<typeof limits>={...limits};delete withoutWrite.cacheWriteUsdPerMillion;
 const q=openRouterBound(withoutWrite as typeof limits,100);
 await denied({...make([system,{role:'user',content:'q1'},history,user]),provider:q.routing},
  {...identity,providerLimits:withoutWrite as typeof limits,upperUsd:q.upperUsd});
});
it('counts markers anywhere in the messages, never above three',()=>{
 expect(cacheMarkerCount([system,{role:'user',content:'q1'},history,user])).toBe(3);
 expect(cacheMarkerCount([{role:'system',content:'plain'}])).toBe(0);
 expect(cacheMarkerCount([{role:'user',content:[{type:'text',text:'a',cache_control:{type:'ephemeral'}}]}])).toBe(1);
});
