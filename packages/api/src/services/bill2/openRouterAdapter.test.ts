/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {openRouterBound} from './openRouterPolicy';
import {openRouterAdapter} from './openRouterAdapter';
const identity={provider:'openrouter',account:'test',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const body=JSON.stringify({model:identity.model,stream:false,store:false,messages:[],max_tokens:100,provider:openRouterBound(identity.providerLimits,identity.outputLimit).routing});
it('dispatches once and preserves non-success bounded evidence',async()=>{
 const transport=vi.fn(async()=>new Response('{"id":"gen-test"}',{status:500}));
 const adapter=openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
 const observation=await adapter.dispatch({input:body},identity);
 expect(transport).toHaveBeenCalledTimes(1);
 expect(transport.mock.calls[0]?.length).toBe(2);
 expect(adapter.evidence(observation,identity,'response')).toMatchObject({providerId:'gen-test',cost:null,final:false});
});
it('denies implicit routing and tools before any transport',async()=>{
 const transport=vi.fn(); const adapter=openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
 await expect(adapter.dispatch({input:JSON.stringify({model:identity.model,messages:[]})},identity)).rejects.toThrow('DENIED');
 await expect(adapter.dispatch({input:JSON.stringify({...JSON.parse(body),tools:[{}]})},identity)).rejects.toThrow('DENIED');
 expect(transport).not.toHaveBeenCalled();
});
it('does not retry a transport failure',async()=>{
 const transport=vi.fn(async()=>{throw new Error('connection lost');});
 await expect(openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport}).dispatch({input:body},identity)).rejects.toThrow();
 expect(transport).toHaveBeenCalledTimes(1);
});
it.each(['test/model:online','openrouter/auto','openrouter/fusion'])('denies implicit research or model routing through %s',async model=>{
 const transport=vi.fn(),adapter=openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
 await expect(adapter.dispatch({input:JSON.stringify({...JSON.parse(body),model})},{...identity,model})).rejects.toThrow('MODEL_DENIED');
 expect(transport).not.toHaveBeenCalled();
});
it.each([
 {plugins:{id:'web'}},{plugins:[]},{tools:{}},{web_search_options:{}},{models:[]},
 {provider:{allow_fallbacks:false,require_parameters:true,only:['unexpected']}},
 {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://private.invalid/image'}}]}]},
 {messages:[{role:'assistant',content:'',tool_calls:[{}]}]},
 {messages:[null]},
])('rejects unsupported routing, tools and remote content %# before credential access',async(patch)=>{
 const transport=vi.fn(),credential=vi.fn();
 const adapter=openRouterAdapter({credential,transport});
 await expect(adapter.dispatch({input:JSON.stringify({...JSON.parse(body),...patch})},identity)).rejects.toThrow('DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it('preserves bounded bytes on an oversized error response',async()=>{
 const transport=vi.fn(async()=>new Response('x'.repeat(65537),{status:500}));
 const adapter=openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
 const observation=await adapter.dispatch({input:body},identity);
 expect(Buffer.from(observation.rawBodyBase64,'base64')).toHaveLength(65536);
 expect(observation).toMatchObject({complete:false,transportIssue:'body_limit'});
 expect(adapter.evidence(observation,identity,'response')).toMatchObject({cost:null,final:false});
 expect(transport).toHaveBeenCalledTimes(1);
});

it('preflights once and binds the captured credential before any HTTP',async()=>{
 let current='SYNTHETIC_ORIGINAL';const credential=vi.fn(async()=>current),transport=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const adapter=openRouterAdapter({credential,transport});
 const send=await adapter.prepareDispatch({input:body},identity);
 expect(transport).not.toHaveBeenCalled();current='SYNTHETIC_CHANGED';
 await send();expect(credential).toHaveBeenCalledTimes(1);
 expect(transport.mock.calls[0]?.[1]).toMatchObject({headers:{Authorization:'Bearer SYNTHETIC_ORIGINAL'}});
 expect(()=>send()).toThrow('CAPABILITY_CONSUMED');expect(transport).toHaveBeenCalledTimes(1);
});

it('allows only the opt-in first-party read_source tool and its message roundtrip',async()=>{
 const transport=vi.fn(async()=>new Response('{}'));
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});
 const source={type:'function',function:{name:'read_source',description:'Read own workspace',parameters:{type:'object',properties:{query:{type:'string'}}}}};
 const request={...JSON.parse(body),tools:[source],messages:[{role:'assistant',content:null,tool_calls:[{id:'call-source',type:'function',function:{name:'read_source',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-source',content:'{"entries":[]}'}]};
 await adapter.dispatch({input:JSON.stringify(request)},identity);
 expect(transport).toHaveBeenCalledTimes(1);
 for(const patch of [{tools:[{...source,function:{...source.function,name:'search'}}]},{plugins:[{id:'web'}]},{messages:[{role:'assistant',content:null,tool_calls:[{id:'bad',type:'function',function:{name:'search',arguments:'{}'}}]}]}]){
  await expect(adapter.dispatch({input:JSON.stringify({...request,...patch})},identity)).rejects.toThrow('DENIED');
 }
 expect(transport).toHaveBeenCalledTimes(1);
});
