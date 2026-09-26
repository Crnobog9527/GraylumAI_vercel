/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {runtimeActor} from './actor';
import {createRuntimeBudget,withRuntimeBudget} from './budget';
const id='00000000-0000-4000-8000-000000000001';
const token=(exp:number)=>'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.synthetic';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it.each(['cookie','bearer'])('uses the original %s credential without late SDK refresh and still rejects changed/revoked identities',async(entry)=>{
 let elapsed=0,denied=false,mismatch=false;const budget=createRuntimeBudget(()=>elapsed);
 const now=Math.floor(Date.now()/1000),jwt=token(now+600);
 const storage=new Map<string,string>();
 if(entry==='cookie')storage.set('synthetic-actor',JSON.stringify({access_token:jwt,refresh_token:'synthetic-refresh',expires_at:now+600,user:{id}}));
 const transport=vi.fn<typeof fetch>(async(url,init)=>{
  expect(String(url)).toBe('http://127.0.0.1/auth/v1/user');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+jwt);
  return new Response(JSON.stringify(denied?{code:'session_not_found',message:'Synthetic revoked'}:{id:mismatch?'another-actor':id}),{status:denied?401:200,headers:{'content-type':'application/json'}});
 });
 const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{autoRefreshToken:false,storageKey:'synthetic-actor',storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}}},global:{fetch:withRuntimeBudget(budget,transport,true)}});
 const getSession=vi.spyOn(client.auth,'getSession');
 const actor=runtimeActor(client.auth,id,budget,entry==='bearer'?'Bearer '+jwt:undefined);
 expect(await actor()).toBe(id);
 // A session within the SDK's 90s expiry margin would refresh on getUser().
 vi.spyOn(Date,'now').mockReturnValue((now+550)*1000);elapsed=256_000;
 expect(await actor()).toBe(id);expect(getSession).toHaveBeenCalledTimes(1);
 mismatch=true;await expect(actor()).rejects.toThrow('RUNTIME_DENIED');mismatch=false;denied=true;
 await expect(actor()).rejects.toThrow('RUNTIME_DENIED');expect(transport).toHaveBeenCalledTimes(4);
 elapsed=285_000;await expect(actor()).rejects.toThrow('TIME_BUDGET');expect(transport).toHaveBeenCalledTimes(4);
});
it('leaves room for refresh on first use and refuses new auth after persistence expires',async()=>{
 let elapsed=0;const budget=createRuntimeBudget(()=>elapsed),getUser=vi.fn();
 const getSession=vi.fn(async()=>{elapsed=285_000;return {data:{session:{access_token:token(Math.floor(Date.now()/1000)+3600)}},error:null};});
 const actor=runtimeActor({getSession,getUser} as never,id,budget);
 elapsed=254_000;await expect(actor()).rejects.toThrow('TIME_BUDGET');expect(getUser).not.toHaveBeenCalled();
 const lateSession=vi.fn();elapsed=255_000;
 await expect(runtimeActor({getSession:lateSession,getUser} as never,id,budget)()).rejects.toThrow('TIME_BUDGET');expect(lateSession).not.toHaveBeenCalled();
});
it('does not accept a missing credential or cache a successful identity verdict',async()=>{
 const getUser=vi.fn();
 await expect(runtimeActor({getSession:async()=>({data:{session:null},error:null}),getUser} as never,id,createRuntimeBudget())()).rejects.toThrow('RUNTIME_DENIED');expect(getUser).not.toHaveBeenCalled();
});
it.each(['cookie','bearer'])('refuses a short-lived %s credential before any claim without rotating refresh tokens',async(entry)=>{
 const now=Math.floor(Date.now()/1000),jwt=token(now+150),budget=createRuntimeBudget();
 const transport=vi.fn<typeof fetch>();
 const storage=new Map<string,string>();
 if(entry==='cookie')storage.set('synthetic-expiry',JSON.stringify({access_token:jwt,refresh_token:'synthetic-refresh',expires_at:now+150,user:{id}}));
 const client=createClient('http://127.0.0.1','SYNTHETIC',{auth:{autoRefreshToken:false,storageKey:'synthetic-expiry',storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}}},global:{fetch:withRuntimeBudget(budget,transport,true)}});
 const actor=runtimeActor(client.auth,id,budget,entry==='bearer'?'Bearer '+jwt:undefined),claim=vi.fn();
 await expect((async()=>{await actor();claim();})()).rejects.toThrow('RUNTIME_STAGING_AUTH_REFRESH_REQUIRED');
 expect(claim).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
 expect(storage.get('synthetic-expiry')).toBe(entry==='cookie'?JSON.stringify({access_token:jwt,refresh_token:'synthetic-refresh',expires_at:now+150,user:{id}}):undefined);
});
it.each(['e30.e30.synthetic','invalid','e30.'+Buffer.from(JSON.stringify({exp:'2099'})).toString('base64url')+'.synthetic'])('does not accept a credential without a valid numeric expiry',async(jwt)=>{
 const getUser=vi.fn();
 await expect(runtimeActor({getSession:async()=>({data:{session:{access_token:jwt}},error:null}),getUser} as never,id,createRuntimeBudget())()).rejects.toThrow('RUNTIME_STAGING_AUTH_REFRESH_REQUIRED');expect(getUser).not.toHaveBeenCalled();
});
