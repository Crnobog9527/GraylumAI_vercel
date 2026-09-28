/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {createRuntimeBudget,withRuntimeBudget,type RuntimeBudget} from './budget';
import {AUTH_REUSE_MAX_AGE_MS,expiringAuthAfterProvider} from './authReuse';
import type {BillingTransport} from '../bill2/service';

const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const AUTH='http://127.0.0.1/auth/v1/user';
type Verdict={status:number;id?:string;code?:string};
/** Synthetic Auth: each credential maps to its current server-side verdict. */
function auth(initial:Record<string,Verdict>){
 const verdicts=new Map(Object.entries(initial));
 const transport=vi.fn<typeof fetch>(async(url,init)=>{
  expect(String(url)).toBe(AUTH);
  const jwt=new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /,'')??'';
  const v=verdicts.get(jwt)??{status:401,code:'bad_jwt'};
  const body=v.status===200?{id:v.id,aud:'authenticated',email_confirmed_at:'2026-01-01T00:00:00Z'}:{code:v.code,message:'Synthetic denial'};
  return new Response(JSON.stringify(body),{status:v.status,headers:{'content-type':'application/json'}});
 });
 return {transport,set:(jwt:string,v:Verdict)=>verdicts.set(jwt,v)};
}
/** One budget is one HTTP invocation; every client in it shares the budget. */
function invocation(transport:typeof fetch,budget:RuntimeBudget=createRuntimeBudget()){
 const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:withRuntimeBudget(budget,transport,true)}});
 return {budget,verify:async(jwt:string)=>{const r=await client.auth.getUser(jwt);return r.error?'denied':r.data.user?.id;}};
}

it('verifies a valid session once per invocation and credential, without counting reuse as a round trip',async()=>{
 const {transport}=auth({a:{status:200,id:A}});
 const {budget,verify}=invocation(transport);
 for(let i=0;i<5;i++)expect(await verify('a')).toBe(A);
 expect(transport).toHaveBeenCalledTimes(1);
 expect(budget.timing.summary().labels['auth/v1/user']?.rt).toBe(1);
});

it.each([
 ['invalid',{status:401,code:'bad_jwt'}],
 ['expired',{status:401,code:'token_expired'}],
 ['revoked',{status:403,code:'session_not_found'}],
 ['unavailable',{status:500,code:'unexpected_failure'}],
] as const)('rejects an %s credential and never reuses the rejection',async(_name,verdict)=>{
 const {transport}=auth({x:verdict});
 const {verify}=invocation(transport);
 expect(await verify('x')).toBe('denied');expect(await verify('x')).toBe('denied');
 expect(transport).toHaveBeenCalledTimes(2);
});

it('rejects a missing credential without a reusable verdict',async()=>{
 const {transport}=auth({});
 const budget=createRuntimeBudget();
 const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:withRuntimeBudget(budget,transport,true)}});
 for(let i=0;i<2;i++){const r=await client.auth.getUser();expect(r.data.user).toBeNull();expect(r.error).not.toBeNull();}
 // No Bearer credential: nothing is keyed, so nothing can be reused.
 expect(budget.auth.keyOf(AUTH,{method:'GET',headers:{apikey:'SYNTHETIC'}})).toBeUndefined();
});

it('detects a session revoked mid-invocation after a provider response or the 30s limit',async()=>{
 let now=0;const budget=createRuntimeBudget(()=>now);
 const {transport,set}=auth({a:{status:200,id:A}});
 const {verify}=invocation(transport,budget);
 expect(await verify('a')).toBe(A);
 set('a',{status:403,code:'session_not_found'});
 // Accepted boundary: before the next provider response, the start verdict is reused.
 expect(await verify('a')).toBe(A);expect(transport).toHaveBeenCalledTimes(1);
 // A provider call through the budgeted transport ends reuse.
 const provider=withRuntimeBudget(budget,async()=>new Response('{}'));
 await provider('https://provider.invalid/v1/chat',{method:'POST'});
 expect(await verify('a')).toBe('denied');expect(transport).toHaveBeenCalledTimes(2);
 // The age limit ends reuse even without a provider call.
 set('a',{status:200,id:A});expect(await verify('a')).toBe(A);
 set('a',{status:403,code:'session_not_found'});
 now+=AUTH_REUSE_MAX_AGE_MS-1;expect(await verify('a')).toBe(A);
 now+=1;expect(await verify('a')).toBe('denied');expect(transport).toHaveBeenCalledTimes(4);
});

it('never reuses one user or credential verdict for another request or credential',async()=>{
 const {transport}=auth({a:{status:200,id:A},b:{status:200,id:B}});
 // Different invocations never share, even for the same credential.
 expect(await invocation(transport).verify('a')).toBe(A);
 expect(await invocation(transport).verify('a')).toBe(A);
 expect(transport).toHaveBeenCalledTimes(2);
 // Another user's request in its own invocation gets its own verdict.
 expect(await invocation(transport).verify('b')).toBe(B);
 expect(transport).toHaveBeenCalledTimes(3);
});

it('keeps mixed credentials in one batched invocation separate, including concurrent verifications',async()=>{
 const {transport}=auth({a:{status:200,id:A},b:{status:200,id:B},bad:{status:401,code:'bad_jwt'}});
 const {verify}=invocation(transport);
 const results=await Promise.all(['a','b','bad','a','b','bad'].map(verify));
 expect(results).toEqual([A,B,'denied',A,B,'denied']);
 // One shared in-flight lookup per credential; nothing crosses credentials.
 expect(transport.mock.calls.map(c=>new Headers(c[1]?.headers).get('Authorization')).sort())
  .toEqual(['Bearer a','Bearer b','Bearer bad']);
 expect(await verify('b')).toBe(B);expect(await verify('bad')).toBe('denied');
 expect(transport).toHaveBeenCalledTimes(4);
});

it('reuses only exact GET user verifications with a Bearer credential',async()=>{
 const {budget}=invocation(vi.fn<typeof fetch>());
 const headers={Authorization:'Bearer a',apikey:'SYNTHETIC'};
 expect(budget.auth.keyOf(AUTH,{method:'GET',headers})).toBeDefined();
 expect(budget.auth.keyOf(AUTH,{method:'GET',headers:{...headers,apikey:'OTHER'}})).not.toBe(budget.auth.keyOf(AUTH,{method:'GET',headers}));
 for(const [input,init] of [
  [AUTH,{method:'PUT',headers}],[AUTH+'?x=1',{method:'GET',headers}],['http://127.0.0.1/auth/v1/token',{method:'GET',headers}],
  ['http://127.0.0.1/rest/v1/profiles',{method:'GET',headers}],[new Request(AUTH,{headers}),undefined],
  [AUTH,{method:'GET',headers:{Authorization:'Basic a'}}],
 ] as [RequestInfo,RequestInit|undefined][])expect(budget.auth.keyOf(input,init)).toBeUndefined();
});

it('ends reuse after every provider dispatch and lookup, and passes prepareDispatch through unchanged',async()=>{
 const {transport}=auth({a:{status:200,id:A}});
 const {budget,verify}=invocation(transport);
 const prepareDispatch=vi.fn();
 const adapter={protocol:'fixture-cost-v1',dispatch:vi.fn(async()=>({})),lookup:vi.fn(async()=>{throw new Error('lookup');}),prepareDispatch} as unknown as BillingTransport;
 const wrapped=expiringAuthAfterProvider(adapter,budget.auth);
 // BILL2 binds its not-started proof to the exact prepared send function.
 expect(wrapped.prepareDispatch).toBe(prepareDispatch);expect((wrapped as unknown as {protocol:string}).protocol).toBe('fixture-cost-v1');
 await verify('a');await verify('a');expect(transport).toHaveBeenCalledTimes(1);
 await wrapped.dispatch('body',{} as never);await verify('a');expect(transport).toHaveBeenCalledTimes(2);
 await expect(wrapped.lookup('id',{} as never)).rejects.toThrow('lookup');await verify('a');expect(transport).toHaveBeenCalledTimes(3);
 expect(expiringAuthAfterProvider(adapter,undefined)).toBe(adapter);
});
