/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import * as posts from './workspacePosts';
import {runtimeAdmissionService} from './admission';
vi.mock('./newWorkGate',async original=>({...await original<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates}));
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const modelId='10000000-0000-4000-8000-000000000003',requestId='10000000-0000-4000-8000-000000000004';
it.each([{capable:false,bytes:100000,on:false},{capable:true,bytes:20000,on:false},{capable:true,bytes:100000,on:true},{capable:true,bytes:20000,on:true,free:true}])(
 'only surviving own-post capability expands the paid call budget ($capable / $bytes)',async({capable,bytes,on,...options})=>{
 const enabled=vi.spyOn(posts,'admitOwnPosts').mockResolvedValue(true);
 let frozen:Record<string,unknown>|undefined,billing:{limits:{maxCalls:number}}|undefined;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId}},error:null};
  if(name==='runtime_workspace_post_window')return {data:options.free?0:30,error:null};
  if(name==='runtime_admission_replay')return {data:null,error:null};
  if(name==='runtime_workspace_session')return {data:capable,error:null};
  if(name==='runtime_admit'){frozen=args.p_payload as Record<string,unknown>;billing=args.p_billing as typeof billing;
   return {data:{executionId:requestId},error:null};}
  throw new Error(name);
 });
 const query={select:()=>query,eq:()=>query,in:async()=>({data:[],error:null}),single:async()=>({data:{id:modelId,
  model_id:'fixture',provider:'fixture',is_active:'true',max_tokens:1000,input_limit:bytes},error:null})};
 const admin={rpc,from:()=>query} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 try{
  await runtimeAdmissionService(user,admin,{workspaceContext:true,account:'test',costPerCall:'0.02',creditsPerUsd:'1000',
   multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:bytes,historyItems:0}).prepare({sessionId,requestId,
    input:'这周拍什么',selection:{kind:'ordinary',modelId},network:'deny'});
  expect(frozen?.ownPosts).toBe(on?true:undefined);
  expect(frozen?.maxTurns).toBe(on&&!options.free?6:3);expect(billing?.limits.maxCalls).toBe(on&&!options.free?6:3);
 }finally{enabled.mockRestore();}
});
