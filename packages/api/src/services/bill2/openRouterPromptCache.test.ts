/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
const limits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
 requestUsd:'0',cacheWriteUsdPerMillion:'2.5'};
const identity={provider:'openrouter',account:'synthetic',model:'anthropic/test',protocol:'openrouter-chat-v1' as const,
 providerLimits:limits,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd};
const marked={type:'text',text:'stable',cache_control:{type:'ephemeral'}};
const plain={type:'text',text:'dynamic'};
const make=(content:unknown=[marked,plain])=>({model:identity.model,stream:false,store:false,
 messages:[{role:'system',content}],max_tokens:100,provider:openRouterBound(limits,100).routing});
it.each([[marked],[marked,plain]])('accepts only the first system block and forwards exact bytes',async (...content)=>{
 const transport=vi.fn<typeof fetch>(async()=>new Response('{}')),credential=vi.fn(async()=> 'SYNTHETIC');
 const input=JSON.stringify(make(content));
 await openRouterAdapter({credential,transport}).dispatch({input},identity);
 expect(transport).toHaveBeenCalledTimes(1);
 expect(transport.mock.calls[0]?.[1]?.body).toBe(input);
});
it.each([
 make([plain,marked]),make([marked,marked]),make([marked,plain,plain]),
 make([{...marked,cache_control:{type:'ephemeral',ttl:'5m'}}]),
 make([{...marked,cache_control:{type:'ephemeral',ttl:'1h'}}]),
 make([{...marked,cache_control:{type:'ephemeral',extra:1}}]),
 make([{...marked,extra:1}]),make([{...marked,text:''}]),
 {...make(),cache_control:{type:'ephemeral'}},
 {...make(),messages:[{role:'user',content:[marked]}]},
 {...make(),messages:[{role:'assistant',content:[marked]}]},
 {...make(),messages:[{role:'tool',content:[marked],tool_call_id:'c'}]},
 {...make(),messages:[{role:'user',content:'hi'},{role:'system',content:[marked]}]},
 {...make(),messages:[{role:'system',content:[marked]},{role:'system',content:[marked]}]},
 {...make(),tools:[{type:'function',function:{name:'read_source',parameters:{},cache_control:{type:'ephemeral'}}}]},
])('rejects unsupported marker shape %# before credentials and transport',async request=>{
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport,allowWorkspaceRead:true}).dispatch({input:JSON.stringify(request)},identity))
  .rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it.each(['google/gemini','openai/gpt-6-luna'])('rejects explicit markers for %s',async model=>{
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport}).dispatch({input:JSON.stringify({...make(),model})},{...identity,model}))
  .rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it('requires a write price even when the ordinary input bound would suffice',async()=>{
 const withoutWrite={...limits,cacheWriteUsdPerMillion:undefined};
 const q=openRouterBound(withoutWrite,100),credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport}).dispatch({input:JSON.stringify({...make(),provider:q.routing})},
  {...identity,providerLimits:withoutWrite,upperUsd:q.upperUsd})).rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it('independently rejects a frozen upper bound that excludes the write premium',async()=>{
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport}).dispatch({input:JSON.stringify(make())},
  {...identity,upperUsd:'0.021'})).rejects.toThrow('BILL2_PROVIDER_QUOTE_CONFLICT');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
