/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createRuntimeBudget,withRuntimeBudget} from './budget';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const body=JSON.stringify({model:identity.model,stream:false,store:false,messages:[],max_tokens:100,provider:openRouterBound(identity.providerLimits,identity.outputLimit).routing});
it('shares one monotonic budget across adapters and never sends a third slow request',async()=>{
 let elapsed=0;const budget=createRuntimeBudget(()=>elapsed),transport=vi.fn<typeof fetch>(async()=>{elapsed+=120_000;return new Response('{}');});
 const credential=vi.fn(async()=> 'SYNTHETIC');
 // New executor/adapter objects within one batch must not reset the start.
 for(let i=0;i<2;i++)await openRouterAdapter({budget,credential,transport}).dispatch({input:body},identity);
 const wall=vi.spyOn(Date,'now').mockReturnValue(0);
 try{await expect(openRouterAdapter({budget,credential,transport}).dispatch({input:body},identity)).rejects.toThrow('TIME_BUDGET');}
 finally{wall.mockRestore();}
 expect(transport).toHaveBeenCalledTimes(2);expect(credential).toHaveBeenCalledTimes(2);
 expect(budget.remainingPersistence()).toBe(45_000);
});
it.each(['credential','dispatch-permission'])('rechecks elapsed %s waits before any POST',async(stage)=>{
 let elapsed=0;const budget=createRuntimeBudget(()=>elapsed),transport=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const adapter=openRouterAdapter({budget,transport,credential:async()=>{if(stage==='credential')elapsed=136_000;return 'SYNTHETIC';}});
 if(stage==='credential')await expect(adapter.prepareDispatch({input:body},identity)).rejects.toThrow('TIME_BUDGET');
 else{const send=await adapter.prepareDispatch({input:body},identity);elapsed=136_000;await expect(send()).rejects.toThrow('TIME_BUDGET');}
 expect(transport).not.toHaveBeenCalled();
});
it('lookup needs its full 45 seconds inside the shared work budget',async()=>{
 let time=0;const shared=createRuntimeBudget(()=>time);time=210_000;
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({budget:shared,credential,transport}).lookup('gen-original',identity)).rejects.toThrow('TIME_BUDGET');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it('bounds an already-open body and late database fetch with the original persistence deadline',async()=>{
 vi.useFakeTimers();let elapsed=0;
 const timer=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('deadline','AbortError')),ms);return c.signal;});
 const transport=vi.fn<typeof fetch>(async(_url,init)=>new Response(new ReadableStream({start(controller){init!.signal!.addEventListener('abort',()=>controller.error(init!.signal!.reason),{once:true});}})));
 try{
  const budget=createRuntimeBudget(()=>elapsed);elapsed=280_000;
  const response=await withRuntimeBudget(budget,transport)('http://127.0.0.1/sql');
  const bodyRead=response.text().catch(error=>error);await vi.advanceTimersByTimeAsync(5000);expect((await bodyRead).name).toBe('AbortError');
  elapsed=285_000;await expect(withRuntimeBudget(budget,transport)('http://127.0.0.1/sql',{method:'POST'})).rejects.toThrow('TIME_BUDGET');
  expect(transport).toHaveBeenCalledTimes(1);expect(timer).toHaveBeenCalledWith(5000);
 }finally{timer.mockRestore();vi.useRealTimers();}
});
it('the default fractional monotonic clock produces a valid native timeout',async()=>{
 const transport=vi.fn<typeof fetch>(async(_url,init)=>{expect(init?.signal?.aborted).toBe(false);return new Response('ok');});
 expect(await (await withRuntimeBudget(createRuntimeBudget(),transport)('http://127.0.0.1/test')).text()).toBe('ok');
});
it.each([503,520])('does not let PostgREST Retry-After %s outlive the invocation',async(status)=>{
 const {createClient}=await import('@supabase/supabase-js');
 const transport=vi.fn<typeof fetch>(async()=>new Response('{}',{status,headers:{'retry-after':'3600'}}));
 const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{persistSession:false},global:{fetch:withRuntimeBudget(createRuntimeBudget(),transport,true)}});
 const result=await client.from('synthetic').select('id');
 expect(result.error?.message).toContain('RUNTIME_DATABASE_RETRY_DISABLED');expect(transport).toHaveBeenCalledTimes(1);
});
it('does not apply database retry policy to provider evidence',async()=>{
 const transport=vi.fn<typeof fetch>(async()=>new Response('{"error":"busy"}',{status:503,headers:{'retry-after':'3600','x-generation-id':'gen-busy'}}));
 const adapter=openRouterAdapter({budget:createRuntimeBudget(),transport,credential:async()=> 'SYNTHETIC'});
 const observation=await adapter.lookup('gen-busy',identity);
 expect(observation).toMatchObject({httpStatus:503,rawBody:'{"error":"busy"}',generationId:'gen-busy',complete:true});
 expect(adapter.evidence(observation,identity,'lookup','gen-busy')).toMatchObject({providerId:'gen-busy',cost:null,final:false});
 expect(transport).toHaveBeenCalledTimes(1);
});
it.each(['100',null])('prevents SDK sleep after a slow retryable database body (Retry-After %s)',async(retryAfter)=>{
 vi.useFakeTimers();let elapsed=0;
 try{
  const {createClient}=await import('@supabase/supabase-js');
  const budget=createRuntimeBudget(()=>elapsed);
  const text=vi.fn(async()=>{elapsed=284_500;return '{}';});
  const transport=vi.fn<typeof fetch>(async()=>{const response=new Response('{}',{status:503,headers:retryAfter?{'retry-after':retryAfter}:{}});response.text=text;return response;});
  const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{persistSession:false},global:{fetch:withRuntimeBudget(budget,transport,true)}});
  let done=false;const result=Promise.resolve(client.from('synthetic').select('id')).then(value=>{done=true;return value;});
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(true);expect((await result).error?.message).toContain('RUNTIME_DATABASE_RETRY_DISABLED');
  expect(text).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
it('binds the one-use not-started proof to the exact send capability, not another call with identical bytes',async()=>{
 const {consumeOpenRouterNotStarted}=await import('../bill2/openRouterAdapter'),{createHash}=await import('node:crypto');
 let elapsed=0;const budget=createRuntimeBudget(()=>elapsed),transport=vi.fn();
 const adapter=openRouterAdapter({budget,credential:async()=> 'SYNTHETIC',transport});
 const first=await adapter.prepareDispatch({input:body},identity),second=await adapter.prepareDispatch({input:body},identity);
 elapsed=136_000;const error=await first().catch(error=>error),hash=createHash('sha256').update(body).digest('hex');
 expect(consumeOpenRouterNotStarted(new Error('RUNTIME_TIME_BUDGET_EXHAUSTED'),hash,first)).toBe(false);
 expect(consumeOpenRouterNotStarted(error,hash,second)).toBe(false);
 expect(consumeOpenRouterNotStarted(error,'f'.repeat(64),first)).toBe(false);
 expect(consumeOpenRouterNotStarted(error,hash,first)).toBe(true);
 expect(consumeOpenRouterNotStarted(error,hash,first)).toBe(false);
 expect(()=>first()).toThrow('CAPABILITY_CONSUMED');expect(transport).not.toHaveBeenCalled();
});
