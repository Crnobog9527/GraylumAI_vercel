/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {captureAdmissionReplay} from './captureReplay';
const request=()=>({sessionId:'session',requestId:'request',input:'original input',selection:{task:'opc-question:old'}});
it('fresh requests need only the original replay RPC, with no raw table access',async()=>{
 const rpc=vi.fn(async()=>({data:null,error:null}));
 expect(await captureAdmissionReplay({rpc} as unknown as SupabaseClient,'actor',request(),true)).toBeNull();
 expect(rpc).toHaveBeenCalledOnce();
});
it.each(['legacy','changed-input','unavailable','wrong-session','v2'])('conflict recovery never bypasses SQL identity or access: %s',async mode=>{
 const req=request();let reads=0;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_admission_replay') {
   ++reads;
   if(reads===2 && mode==='v2'){
    expect(args.p_request).toEqual({...request(),selection:{task:'opc-question:saved'}});
    return {data:{executionId:'saved'},error:null};
   }
   return {data:null,error:{message:'RUNTIME_REQUEST_CONFLICT'}};
  }
  if(name==='runtime_view')return {data:{executions:mode==='unavailable'?[]:[{executionId:'saved',request:{requestId:'request'}}]},error:null};
  if(name==='runtime_execution')return {data:{sessionId:mode==='wrong-session'?'other':'session',context:{
   inputSelection:mode==='legacy'?'scope-projection-v1':'scope-projection-v2',request:{selection:{task:'opc-question:saved'}},
  }},error:null};
  throw new Error(name);
 });
 const operation=captureAdmissionReplay({rpc} as unknown as SupabaseClient,'actor',req,true);
 if(mode==='v2')expect(await operation).toEqual({executionId:'saved'});
 else await expect(operation).rejects.toThrow('OPC_REQUEST_CONFLICT');
 expect(reads).toBe(mode==='v2'||mode==='changed-input'?2:1);
});
