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

it.each(['complete','timeout'])('bounds the full response, not each keepalive (%s)',async(mode)=>{
 vi.useFakeTimers();
 const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('Timed out','TimeoutError')),ms);return c.signal;});
 let signal:AbortSignal|undefined,ended=false;
 const transport=vi.fn<typeof fetch>(async(_url,init)=>{
  signal=init!.signal as AbortSignal;
  return new Response(new ReadableStream({start(controller){
   controller.enqueue(new TextEncoder().encode(' '.repeat(165)));
   signal!.addEventListener('abort',()=>controller.error(signal!.reason),{once:true});
   // A late nonstream response may send keepalives before any JSON.
   if(mode==='complete')setTimeout(()=>{controller.enqueue(new TextEncoder().encode('{"id":"gen-late"}'));controller.close();},60_000);
   else setTimeout(()=>controller.enqueue(new TextEncoder().encode(' ')),119_000);
  }}),{headers:{'X-Generation-Id':'gen-late'}});
 });
 try{
  const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport});
  const pending=adapter.dispatch({input:body},identity).then(v=>{ended=true;return v;});
  await vi.advanceTimersByTimeAsync(45_001);expect(ended).toBe(false);expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(mode==='complete'?14_999:74_999);
  const observed=await pending;expect(observed).toMatchObject({generationId:'gen-late',complete:mode==='complete',transportIssue:mode==='complete'?null:'body_timeout'});
  expect(timeout).toHaveBeenCalledWith(120_000);expect(transport).toHaveBeenCalledTimes(1);
  expect(adapter.evidence(observed,identity,'response')).toMatchObject({providerId:'gen-late',cost:null,final:false});
 }finally{timeout.mockRestore();vi.useRealTimers();}
});
it('keeps lookup timeout bounded separately and does not retry it',async()=>{
 vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
 const transport=vi.fn<typeof fetch>(async(_url,init)=>new Response(new ReadableStream({start(controller){init!.signal!.addEventListener('abort',()=>controller.error(new Error('stopped')),{once:true});}})));
 try{
  const pending=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport}).lookup('gen-local',identity);
  await vi.advanceTimersByTimeAsync(45_000);expect(await pending).toMatchObject({complete:false,transportIssue:'body_timeout'});
  expect(timeout).toHaveBeenCalledWith(45_000);expect(transport).toHaveBeenCalledTimes(1);
 }finally{timeout.mockRestore();vi.useRealTimers();}
});
it('retains only the bounded generation header when the network interrupts a body',async()=>{
 let reads=0;const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('   '));else controller.error(new Error('disconnect'));}}),{headers:{'X-Generation-Id':'gen-local','Authorization':'DO_NOT_RETAIN'}}));
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport});const observed=await adapter.dispatch({input:body},identity);
 expect(observed).toMatchObject({generationId:'gen-local',rawBody:'   ',complete:false,transportIssue:'body_interrupted'});
 expect(JSON.stringify(observed)).not.toContain('DO_NOT_RETAIN');expect(adapter.evidence(observed,identity,'response')).toMatchObject({providerId:'gen-local',cost:null,final:false});
});
it.each(['','a'.repeat(257),'gen-first, gen-second','gen unsafe'])('does not retain malformed generation header %#',async id=>{
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport:async()=>new Response('broken',{headers:{'X-Generation-Id':id}})});
 expect(await adapter.dispatch({input:body},identity)).not.toHaveProperty('generationId');
});
it('preserves the lookup identity even when a response exceeds the unchanged byte cap',async()=>{
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport:async()=>new Response('x'.repeat(65537),{headers:{'X-Generation-Id':'gen-limit'}})});
 const observation=await adapter.dispatch({input:body},identity);
 expect(Buffer.from(observation.rawBodyBase64,'base64')).toHaveLength(65536);
 expect(adapter.evidence(observation,identity,'response')).toMatchObject({providerId:'gen-limit',cost:null,final:false,evidenceKind:'transport_observation'});
});
