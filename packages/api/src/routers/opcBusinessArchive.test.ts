/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {inferRouterContext} from '@trpc/server';
import {opcRouter} from './opc';
import {stagingProcedureError,stagingRpcFailure} from '../services/runtime/stagingErrors';
import {throwOpcRpcError} from '../services/opc/contentBindingError';
import {claimFailure,BillingClaimRejection} from '../services/bill2/claimFailure';
import {reportError} from '../services/report/service';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const archived={businessId:id(1),name:'摄影课程',archivedAt:'2026-10-20T10:00:00Z',isArchived:true};
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321'));
afterEach(()=>vi.unstubAllEnvs());
function fixture(result:{data?:unknown;error?:{code:string;message:string}}) {
 const profile={id:id(9),nickname:'Test',email:'fixture@example.test',role:'user',
  status:'active',is_deleted:'false',membership_level:'free'};
 const user={id:profile.id,email:profile.email,email_confirmed_at:'2026-01-01'};
 const rpc=vi.fn(async()=>({data:result.data??null,error:result.error??null}));
 const db={rpc,auth:{getUser:async()=>({data:{user},error:null})},
  from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:profile,error:null})})};
 const ctx={headers:new Headers(),user,isEmailVerified:true,hasSupabaseAdminPrivileges:true,
  supabase:db,supabasePublic:db,supabaseAdmin:db} as unknown as inferRouterContext<typeof opcRouter>;
 return {caller:opcRouter.createCaller(ctx),rpc};
}
it('archives only as the verified session actor and returns the frontend archive state',async()=>{
 const f=fixture({data:archived});
 await expect(f.caller.archiveBusiness({businessId:id(1)})).resolves.toEqual(archived);
 expect(f.rpc).toHaveBeenCalledExactlyOnceWith('opc_business_archive',{p_actor_id:id(9),p_business_id:id(1)});
});
it('lists archived and active businesses with draft read identities',async()=>{
 const data=[{...archived,currentSourceVersionId:null,createdAt:'2026-10-19T00:00:00Z',
  drafts:[{draftId:id(2),projectId:id(3),roundId:id(4),sessionId:id(5)}]}];
 const f=fixture({data});
 await expect(f.caller.businesses()).resolves.toEqual(data);
 expect(f.rpc).toHaveBeenCalledExactlyOnceWith('opc_businesses_list',{p_actor_id:id(9)});
});
it.each([['OPC_BUSINESS_DENIED','FORBIDDEN'],['OPC_BUSINESS_BUSY','CONFLICT']])(
 'returns stable %s refusal',async(message,code)=>{
  const f=fixture({error:{code:'P0001',message}});
  await expect(f.caller.archiveBusiness({businessId:id(1)})).rejects.toMatchObject({code,message});
 });
it('refuses actor injection, undo fields and invalid ids before calling the database',async()=>{
 const f=fixture({});
 for(const input of [{businessId:id(1),actorId:id(2)},{businessId:id(1),archivedAt:null},{businessId:'no'}])
  await expect(f.caller.archiveBusiness(input as never)).rejects.toThrow();
 expect(f.rpc).not.toHaveBeenCalled();
});
it('keeps raw database errors private',async()=>{
 const f=fixture({error:{code:'XX000',message:'private SQL'}});
 await expect(f.caller.archiveBusiness({businessId:id(1)})).rejects.not.toThrow('private SQL');
});
it('keeps the archive denial stable across OPC, runtime and report paid paths',()=>{
 const error={code:'P0001',message:'OPC_BUSINESS_ARCHIVED'};
 expect(()=>throwOpcRpcError(error)).toThrow('OPC_BUSINESS_ARCHIVED');
 expect(()=>stagingRpcFailure(error)).toThrow('OPC_BUSINESS_ARCHIVED');
 try {stagingRpcFailure(error);} catch(cause) {
  expect(stagingProcedureError(cause,'runtime.prepare')).toMatchObject({code:'FORBIDDEN'});
  expect(stagingProcedureError(cause,'runtime.prepare').message).toContain('OPC_BUSINESS_ARCHIVED');
 }
 expect(()=>reportError(error)).toThrow('OPC_BUSINESS_ARCHIVED');
 expect(claimFailure(error)).toBeInstanceOf(BillingClaimRejection);
 expect(claimFailure(error).message).toBe('OPC_BUSINESS_ARCHIVED');
});
