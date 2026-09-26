/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,it,expect,vi} from 'vitest';
import type {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({context:vi.fn(),handle:vi.fn(),auth:vi.fn(),admin:vi.fn()}));
vi.mock('@trpc/server/adapters/fetch',()=>({fetchRequestHandler:mocks.handle}));
vi.mock('@repo/api/src/trpc',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),createTRPCContext:mocks.context}));
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
  expect(first.runtimeBudget.workDeadline).toBe(255_010);
  expect(second.runtimeBudget.remainingPersistence()).toBe(135_000);
  expect(()=>second.runtimeBudget.assertCanStart(120_000)).toThrow('TIME_BUDGET');
  return new Response('bounded');
 });
 const req={url:'http://localhost/api/trpc/runtime.execute,runtime.execute',headers:new Headers(),cookies:{getAll:()=>[]}} as unknown as NextRequest;
 expect(await (await POST(req)).text()).toBe('bounded');expect(maxDuration).toBe(300);
 expect(mocks.auth.mock.calls[0]?.[2].global.fetch).toBeTypeOf('function');
 expect(mocks.admin.mock.calls[0]?.[2].global.fetch).toBeTypeOf('function');
});
