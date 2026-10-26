/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,it,expect,vi} from 'vitest';
import type {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({context:vi.fn(),handle:vi.fn(),auth:vi.fn(),admin:vi.fn(),log:vi.fn()}));
vi.mock('@trpc/server/adapters/fetch',()=>({fetchRequestHandler:mocks.handle}));
vi.mock('@repo/api/src/trpc',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),createTRPCContext:mocks.context}));
vi.mock('@/lib/server-log',()=>({logServerError:mocks.log}));
vi.mock('@repo/api/src/root',()=>({appRouter:{}}));
vi.mock('@supabase/ssr',()=>({createServerClient:mocks.auth}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.admin}));
vi.mock('@/lib/site-config',()=>({resolveSupabaseCookieOptions:()=>({})}));
import {POST,maxDuration} from './route';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.clearAllMocks();});
it('starts the shared batch budget before auth and pins the platform limit to 300 seconds',async()=>{
 let clock=10;vi.spyOn(performance,'now').mockImplementation(()=>clock);
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','SYNTHETIC');
 mocks.auth.mockReturnValue({auth:{getUser:async()=>{clock+=50_000;return {data:{user:{id:'synthetic'}}};}}});
 mocks.admin.mockReturnValue({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{value:false},error:null})})})})});
 mocks.context.mockImplementation(async opts=>opts);
 mocks.handle.mockImplementation(async({createContext})=>{
  const first=await createContext();clock+=100_000;const second=await createContext();
  expect(first.runtimeBudget).toBe(second.runtimeBudget);
  expect(first.runtimeBudget.workDeadline).toBe(265_010);
  expect(second.runtimeBudget.remainingPersistence()).toBe(135_000);
  expect(()=>second.runtimeBudget.assertCanStart(120_000)).toThrow('TIME_BUDGET');
  return new Response('bounded');
 });
 const req={url:'http://localhost/api/trpc/runtime.execute,runtime.execute',headers:new Headers(),cookies:{getAll:()=>[]}} as unknown as NextRequest;
 expect(await (await POST(req)).text()).toBe('bounded');expect(maxDuration).toBe(300);
 expect(mocks.auth.mock.calls[0]?.[2].global.fetch).toBeTypeOf('function');
 expect(mocks.admin.mock.calls[0]?.[2].global.fetch).toBeTypeOf('function');
});

it('starts a fresh secret scope for each HTTP request and retains it for response async work', async () => {
 const {getPlatformSecret,resetPlatformSecretCacheForTests}=await import('../../../../../../../packages/api/src/services/platformSecrets/reader');
 resetPlatformSecretCacheForTests();
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','SYNTHETIC');
 mocks.auth.mockReturnValue({auth:{getUser:async()=>({data:{user:{id:'synthetic'}}})}});
 mocks.admin.mockReturnValue({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{value:false},error:null})})})})});
 let value:string|null='synthetic-old';
 const rpc=vi.fn(()=>({abortSignal:async()=>({data:value,error:null})}));
 const db={rpc} as never;
 const read=()=>getPlatformSecret(db,'openrouter',{fresh:true});
 mocks.handle.mockImplementation(async()=>{
  const first=await read();
  const work=(async()=>{
   await new Promise(resolve=>setTimeout(resolve,0));
   value='changed-inside-response';
   const second=await read();
   expect(second.value).toBe(first.value);
  })();
  return new Response(new ReadableStream({async start(controller){await work;controller.enqueue(new TextEncoder().encode('done'));controller.close();}}));
 });
 const req=()=>({url:'http://localhost/api/trpc/opc.mentorTurnStream',headers:new Headers(),cookies:{getAll:()=>[]}} as unknown as NextRequest);
 expect(await(await POST(req())).text()).toBe('done');
 expect(rpc).toHaveBeenCalledTimes(1);
 value='synthetic-replacement';
 expect(await(await POST(req())).text()).toBe('done');
 expect(rpc).toHaveBeenCalledTimes(2);
 value=null;
 await expect(POST(req())).rejects.toMatchObject({code:'PLATFORM_SECRET_NOT_CONFIGURED'});
 expect(rpc).toHaveBeenCalledTimes(3);
});

it('DB-PERF PR-5a: reads the maintenance switch at most once per two seconds; a change is honoured after that', async () => {
 let now=10_000_000_000_000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','SYNTHETIC');
 const role={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'user'},error:null})})})})};
 mocks.auth.mockReturnValue({auth:{getUser:async()=>({data:{user:{id:'synthetic'}}})},...role});
 let maintenance=false;const reads=vi.fn(async()=>({data:{value:maintenance},error:null}));
 mocks.admin.mockReturnValue({from:()=>({select:()=>({eq:()=>({maybeSingle:reads})})})});
 mocks.handle.mockImplementation(async()=>new Response('handled'));
 const req=()=>({url:'http://localhost/api/trpc/runtime.executeStream',nextUrl:{pathname:'/api/trpc/runtime.executeStream'},
  headers:new Headers(),cookies:{getAll:()=>[]}} as unknown as NextRequest);
 expect(await(await POST(req())).text()).toBe('handled');
 maintenance=true;now+=1_500;
 expect(await(await POST(req())).text()).toBe('handled'); // within two seconds: the switch is not read again
 expect(reads).toHaveBeenCalledTimes(1);
 now+=600;
 expect((await POST(req())).status).toBe(503); // after two seconds: maintenance refuses the call
 expect(reads).toHaveBeenCalledTimes(2);
 // A failed read fails as before (open outside production) and is retried after one second, not two.
 reads.mockImplementationOnce(async()=>({data:null,error:{code:'57014'}} as never));
 now+=2_100;
 expect(await(await POST(req())).text()).toBe('handled');
 now+=1_100;
 expect((await POST(req())).status).toBe(503);
 expect(reads).toHaveBeenCalledTimes(4);
});

it('logs every tRPC 503 with the rejecting layer and no private error text',async()=>{
 const {TRPCError}=await import('@trpc/server');
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','SYNTHETIC');
 vi.spyOn(Date,'now').mockReturnValue(20_000_000_000_000);
 mocks.auth.mockReturnValue({auth:{getUser:async()=>({data:{user:{id:'synthetic'}}})}});
 mocks.admin.mockReturnValue({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{value:false},error:null})})})})});
 mocks.handle.mockImplementation(async({onError})=>{
  expect(onError).toBeTypeOf('function');
  onError({path:'account.conversationErasure',error:new TRPCError({code:'SERVICE_UNAVAILABLE',message:'PRIVATE database body'})});
  return new Response('refused',{status:503});
 });
 const req={url:'http://localhost/api/trpc/account.conversationErasure',nextUrl:{pathname:'/api/trpc/account.conversationErasure'},
  headers:new Headers(),cookies:{getAll:()=>[]}} as unknown as NextRequest;
 expect((await POST(req)).status).toBe(503);
 expect(mocks.log).toHaveBeenCalledWith('api','trpc_service_unavailable',{
  procedure:'account.conversationErasure',reasonCode:'PROCEDURE_UNAVAILABLE',
 });
 expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('PRIVATE');
});
