/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002',modelId='10000000-0000-4000-8000-000000000003',requestId='10000000-0000-4000-8000-000000000004';
it.each(['PGRST202','42883','42501','PGRST301','XX000',null].flatMap(code=>[false,true].map(real=>({code,real}))))('workspace capability $code (real=$real) preserves free chat only for genuinely missing RPC',async({code,real})=>{
 let frozen:Record<string,unknown>|undefined;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId}},error:null};
  if(name==='runtime_admission_replay')return {data:null,error:null};
  if(name==='runtime_workspace_session')return {data:code?null:true,error:code?{code}:null};
  if(name==='runtime_admit'){frozen=args.p_payload as Record<string,unknown>;return {data:{executionId:requestId},error:null};}
  throw new Error(name);
 });
 const query={select:()=>query,eq:()=>query,single:async()=>({data:{id:modelId,model_id:real?'test/model':'fixture',provider:real?'openrouter':'fixture',is_active:'true',max_tokens:1000,input_limit:32000},error:null})};
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})}} as unknown as SupabaseClient;
 const admin={rpc,from:()=>query} as unknown as SupabaseClient;
 const admission=runtimeAdmissionService(user,admin,{...(real?{real:{id:sessionId,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01T00:00:00Z',callPolicies:[{modelId,provider:'openrouter',account:'test',model:'test/model',protocol:'openrouter-chat-v1' as const,providerLimits:{providerSlug:'synthetic',contextTokens:32000,promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'},upperUsd:'0.004',inputLimit:32000,outputLimit:1000,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true}]}}:{}),workspaceContext:true,account:'test',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:10});
 const promise=admission.prepare({sessionId,requestId,input:'General travel tips',selection:{kind:'ordinary',modelId},network:'deny'});
 if(code&&!['PGRST202','42883'].includes(code)){await expect(promise).rejects.toThrow('RUNTIME_WORKSPACE_UNAVAILABLE');expect(frozen).toBeUndefined();}
 else{await promise;expect(frozen?.inputSelection).toBe('scope-projection-v1');expect(frozen?.providerRequestFormat).toBe(real?'serial-tools-v1':undefined);expect(frozen?.workspaceContext).toBe(code?undefined:true);expect(frozen?.scopeMaterial).toBeUndefined();expect(frozen?.sources).toEqual([]);}
});
