/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {BillingTransport} from '../bill2/service';
/** AC-0c: one HTTP invocation reuses Auth's own network verdict for the exact
 * same credential. Verification still happens through `GET /auth/v1/user`
 * (never local JWT verification); only a repeated identical lookup inside the
 * same invocation is answered from that invocation's earlier response.
 *
 * Scope is the invocation's RuntimeBudget, so nothing is shared across HTTP
 * requests, processes, users or credentials. Reuse ends when a provider call
 * returns (`expire`) or after AUTH_REUSE_MAX_AGE_MS, so the next operation
 * verifies with Auth again. Failed or non-200 verdicts are never reused. */
export const AUTH_REUSE_MAX_AGE_MS=30_000;
const USER_PATH='/auth/v1/user';
type Verdict={status:number;statusText:string;headers:[string,string][];body:string;at:number};
type Entry={verdict:Promise<Verdict>;settled?:Verdict};

export function createAuthReuse(now:()=>number){
 const entries=new Map<string,Entry>();
 const fresh=(entry:Entry)=>!entry.settled||now()-entry.settled.at<AUTH_REUSE_MAX_AGE_MS;
 return Object.freeze({
  /** Ends reuse: the next verification of every credential goes to Auth. */
  expire(){entries.clear();},
  /** Returns undefined when this call is not an exact user verification. */
  keyOf(input:RequestInfo|URL,init?:RequestInit):string|undefined{
   // Supabase Auth passes a URL string. A Request object is never reused.
   if(input instanceof Request)return undefined;
   const method=(init?.method??'GET').toUpperCase();
   let url:URL;try{url=new URL(String(input));}catch{return undefined;}
   if(method!=='GET'||url.pathname!==USER_PATH||url.search||url.hash)return undefined;
   const headers=new Headers(init?.headers);
   const authorization=headers.get('Authorization');
   if(!authorization||!/^Bearer \S+$/i.test(authorization))return undefined;
   return JSON.stringify([url.href,authorization,headers.get('apikey')??'']);
  },
  /** Shares one in-flight or successful verification for this exact key. */
  async fetch(key:string,load:()=>Promise<Response>):Promise<Response>{
   const current=entries.get(key);
   if(current&&fresh(current))return replay(await current.verdict);
   const entry:Entry={verdict:(async()=>{
    const response=await load();
    const verdict={status:response.status,statusText:response.statusText,headers:[...response.headers],body:await response.text(),at:now()};
    return verdict;
   })()};
   entries.set(key,entry);
   try{
    const verdict=await entry.verdict;
    if(verdict.status===200)entry.settled=verdict;
    else if(entries.get(key)===entry)entries.delete(key);
    return replay(verdict);
   }catch(error){
    if(entries.get(key)===entry)entries.delete(key);
    throw error;
   }
  },
 });
}
export type AuthReuse=ReturnType<typeof createAuthReuse>;
/** Every provider response or receipt lookup ends reuse, including the local
 * fixture whose fetch is not budgeted. prepareDispatch is passed through as the
 * same function: BILL2 binds its not-started proof to that exact send, and the
 * staging transport already expires reuse through its budgeted provider fetch. */
export function expiringAuthAfterProvider<T extends BillingTransport>(adapter:T,auth:AuthReuse|undefined):T{
 if(!auth)return adapter;
 const after=<R>(pending:Promise<R>)=>pending.finally(()=>auth.expire());
 return {...adapter,dispatch:(body,identity)=>after(adapter.dispatch(body,identity)),lookup:(id,identity)=>after(adapter.lookup(id,identity))};
}
function replay(verdict:Verdict){
 return new Response(verdict.body,{status:verdict.status,statusText:verdict.statusText,headers:verdict.headers});
}
