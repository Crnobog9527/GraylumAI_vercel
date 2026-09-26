/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,it,expect,vi} from 'vitest';
import {createRuntimeBudget} from '../services/runtime/budget';
const mocks=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('../services/runtime/execute',async original=>({...await original<typeof import('../services/runtime/execute')>(),runtimeExecutor:(options:{actor:()=>Promise<string>})=>({execute:()=>mocks.execute(options.actor)})}));
import {runtimeRouter} from './runtime';
const id='00000000-0000-4000-8000-000000000001';
const jwt=(entry:string)=>'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.synthetic-'+entry;
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it.each(['cookie','bearer'])('preserves actor checks for late receipts and interruption through the %s entry',async(entry)=>{
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('V3_RUNTIME_LOCAL_ENDPOINT','http://127.0.0.1:12345');
 let elapsed=0;const runtimeBudget=createRuntimeBudget(()=>elapsed);
 const getUser=vi.fn(async()=>({data:{user:{id}},error:null}));
 const getSession=vi.fn(async()=>({data:{session:entry==='cookie'?{access_token:jwt('cookie')}:null},error:null}));
 const profile={select(){return this;},eq(){return this;},single:async()=>({data:{id,role:'user',status:'active',credits:100,nickname:'Fixture',email:'fixture@example.test'},error:null})};
 const client={from:()=>profile,auth:{getUser,getSession}};
 const operations:string[]=[];
 mocks.execute.mockImplementation(async actor=>{
  for(const [time,operation] of [[0,'begin'],[254_000,'recordReceipt'],[256_000,'runtime_receipt_saved'],[270_000,'interrupt']] as const){elapsed=time;expect(await actor()).toBe(id);operations.push(operation);}
  elapsed=285_000;await expect(actor()).rejects.toThrow('TIME_BUDGET');return {state:'pending'};
 });
 const caller=runtimeRouter.createCaller({headers:new Headers(entry==='bearer'?{Authorization:'Bearer '+jwt('bearer')}:{}),runtimeBudget,user:{id,email:'fixture@example.test'},isEmailVerified:true,supabase:client,supabaseAuth:client,supabaseAdmin:client,hasSupabaseAdminPrivileges:true} as never);
 expect(await caller.execute({executionId:id})).toEqual({state:'pending'});
 expect(operations).toEqual(['begin','recordReceipt','runtime_receipt_saved','interrupt']);
 expect(getSession).toHaveBeenCalledTimes(1);expect(getUser).toHaveBeenCalledTimes(4);
 expect(getUser.mock.calls.every(call=>(call as unknown[])[0]===jwt(entry))).toBe(true);
});
it('maps insufficient auth lifetime before any claim to an explicit recoverable refusal',async()=>{
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('V3_RUNTIME_LOCAL_ENDPOINT','http://127.0.0.1:12345');
 const jwt='e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+150})).toString('base64url')+'.synthetic';
 const profile={select(){return this;},eq(){return this;},single:async()=>({data:{id,role:'user',status:'active',credits:100,nickname:'Fixture',email:'fixture@example.test'},error:null})};
 const client={from:()=>profile,auth:{getSession:async()=>({data:{session:{access_token:jwt}},error:null}),getUser:vi.fn()}},claim=vi.fn();
 mocks.execute.mockImplementation(async actor=>{await actor();claim();});
 const caller=runtimeRouter.createCaller({headers:new Headers(),runtimeBudget:createRuntimeBudget(),user:{id,email:'fixture@example.test'},isEmailVerified:true,supabase:client,supabaseAuth:client,supabaseAdmin:client,hasSupabaseAdminPrivileges:true} as never);
 await expect(caller.execute({executionId:id})).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:'登录会话剩余时间不足，请重新登录后继续原请求。'});
 expect(claim).not.toHaveBeenCalled();expect(client.auth.getUser).not.toHaveBeenCalled();
});
