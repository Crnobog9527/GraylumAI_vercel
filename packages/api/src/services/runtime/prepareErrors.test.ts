/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,expect,it,vi} from 'vitest';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {initTRPC} from '@trpc/server';
import {fetchRequestHandler} from '@trpc/server/adapters/fetch';
import {runtimeAdmissionService,runtimeAdmission} from './admission';
import {stagingProcedureError} from './stagingErrors';
import {createRuntimeBudget,withRuntimeBudget} from './budget';
import {logger} from '../../lib/logger';
const mocks=vi.hoisted(()=>({redis:vi.fn(async()=>({success:true}))}));
vi.mock('../redisRateLimiter',()=>({checkRuntimeRateLimit:mocks.redis}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input={sessionId:id(2),requestId:id(4),input:'synthetic',selection:{kind:'ordinary',modelId:id(3)},network:'deny'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(replay:()=>Promise<Response>,settingsFail=false){
 const budget=createRuntimeBudget(),paths:string[]=[];
 const transport=vi.fn<typeof fetch>(async(url)=>{
  const path=new URL(String(url)).pathname;paths.push(path);
  if(path.endsWith('/runtime_session_context'))return json({scope:{kind:'positioning_draft',draftId:id(2)}});
  if(path.endsWith('/runtime_admission_replay'))return replay();
  if(path.endsWith('/system_settings'))return settingsFail?json({code:'08006',message:'synthetic'},503):json([]);
  if(path.endsWith('/ai_models'))return json({id:id(3),model_id:'fixture',provider:'fixture',is_active:'true',max_tokens:1000,input_limit:32000});
  if(path.endsWith('/runtime_admit'))return json({executionId:id(4)});
  throw new Error('UNEXPECTED_DESTINATION');
 });
 const admin=createClient('https://synthetic.invalid','synthetic-key',{global:{fetch:withRuntimeBudget(budget,transport,true)},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 const user={auth:{getUser:async()=>({data:{user:{id:id(1),email_confirmed_at:'2026-01-01'}},error:null})}};
 const service=runtimeAdmissionService(user as unknown as SupabaseClient,admin,{account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:10});
 const log=vi.spyOn(logger,'error').mockImplementation(()=>{});
 const t=initTRPC.create();
 const procedure=t.procedure.use(async({next,path})=>{const result=await next();if(!result.ok)throw stagingProcedureError(result.error,path);return result;});
 const router=t.router({runtime:t.router({prepare:procedure.input(runtimeAdmission).mutation(({input})=>service.prepare(input))})});
 const handle=(req:Request)=>budget.timing.run(()=>fetchRequestHandler({endpoint:'/api/trpc',req,router,createContext:()=>({})}));
 const request=(signal?:AbortSignal)=>new Request('http://localhost/api/trpc/runtime.prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal});
 return {budget,paths,transport,log,handle,request};
}
afterEach(()=>{vi.restoreAllMocks();mocks.redis.mockClear();});
it.each([
 ['connection SQLSTATE',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE','08006',()=>Promise.resolve(json({code:'08006',message:'synthetic'},503))],
 ['statement cancellation',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE','57014',()=>Promise.resolve(json({code:'57014',message:'synthetic'},500))],
 ['resource exhaustion',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE','53300',()=>Promise.resolve(json({code:'53300',message:'synthetic'},500))],
 ['PostgREST connection',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE','PGRST000',()=>Promise.resolve(json({code:'PGRST000',message:'synthetic'},503))],
 ['missing schema',503,'RUNTIME_STAGING_SCHEMA_UNAVAILABLE','PGRST202',()=>Promise.resolve(json({code:'PGRST202',message:'synthetic'},404))],
 ['internal database error',500,'RUNTIME_STAGING_INTERNAL_ERROR','XX000',()=>Promise.resolve(json({code:'XX000',message:'synthetic'},500))],
 ['unsafe database code',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE',undefined,()=>Promise.resolve(json({code:'synthetic private code',message:'synthetic'},500))],
 ['permission denial',500,'UNEXPECTED_SERVER_ERROR',undefined,()=>Promise.resolve(json({code:'42501',message:'synthetic'},403))],
 ['business denial',500,'UNEXPECTED_SERVER_ERROR',undefined,()=>Promise.resolve(json({code:'PT400',message:'synthetic'},400))],
 ['request conflict',500,'UNEXPECTED_SERVER_ERROR',undefined,()=>Promise.resolve(json({code:'P0001',message:'RUNTIME_REQUEST_CONFLICT'},400))],
 ['scope denial',500,'UNEXPECTED_SERVER_ERROR',undefined,()=>Promise.resolve(json({code:'P0001',message:'RUNTIME_SCOPE_DENIED'},400))],
 ['fetch rejection',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE',undefined,()=>Promise.reject(new TypeError('fetch failed'))],
 ['upstream abort',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE',undefined,()=>Promise.reject(new DOMException('synthetic','AbortError'))],
 ['malformed response',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE',undefined,()=>Promise.resolve(new Response('{',{status:200}))],
 ['body reset',503,'RUNTIME_STAGING_SERVICE_UNAVAILABLE',undefined,()=>Promise.resolve(new Response(new ReadableStream({start(c){c.error(new TypeError('terminated'));}})))],
] as const)('replay %s preserves classification without proceeding',async(_name,status,reason,databaseCode,replay)=>{
 const f=fixture(replay);const response=await f.handle(f.request());expect(response.status).toBe(status);
 expect(f.log).toHaveBeenCalledWith('api','staging_service_failed',expect.objectContaining({reason}));
 expect(f.log.mock.calls[0][2]).toEqual({path:'runtime.prepare',diagnosticId:expect.any(String),reason,...(databaseCode?{databaseCode}:{})});
 const body=await response.text();expect(body).not.toContain('synthetic');
 if(databaseCode)expect(body).not.toContain(databaseCode);
 expect(f.budget.timing.summary().labels['rpc/runtime_admission_replay'].rt).toBe(1);
 expect(f.budget.timing.summary().phases.rateLimit).toBeUndefined();expect(f.budget.timing.summary().executionIds).toEqual([]);
 expect(f.paths.some(p=>p.endsWith('/ai_models')||p.endsWith('/runtime_admit'))).toBe(false);
 expect(mocks.redis).not.toHaveBeenCalled();
});
it('content binding denial is preserved as 412 rather than generic 500',async()=>{
 const f=fixture(async()=>json({code:'P0001',message:'OPC_CONTENT_BINDING'},400));expect((await f.handle(f.request())).status).toBe(412);
});
it('settings read failure enters rateLimit and returns 503, unlike incident',async()=>{
 const f=fixture(async()=>json(null),true);expect((await f.handle(f.request())).status).toBe(503);
 expect(f.budget.timing.summary().phases.rateLimit).toBeDefined();
});
it('delayed healthy replay remains 200',async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,300));return json(null);});
 expect((await f.handle(f.request())).status).toBe(200);expect(f.paths.filter(p=>p.endsWith('/runtime_admit'))).toHaveLength(1);
});
it('abort incoming request after body parsing does not abort database fetch',async()=>{
 const c=new AbortController();const f=fixture(async()=>{c.abort();await new Promise(r=>setTimeout(r,20));return json(null);});
 expect((await f.handle(f.request(c.signal))).status).toBe(200);expect(c.signal.aborted).toBe(true);
 expect(f.paths.filter(p=>p.endsWith('/runtime_admit'))).toHaveLength(1);
});
it('interrupted request body fails before admission and cannot produce replay timing',async()=>{
 const f=fixture(async()=>json(null));
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));c.error(new DOMException('client disconnected','AbortError'));}});
 const req=new Request('http://localhost/api/trpc/runtime.prepare',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'} as RequestInit & {duplex:'half'});
 expect((await f.handle(req)).status).toBe(400);expect(f.paths).toEqual([]);
});
it('slow chunked upload completes without generic 500',async()=>{
 const f=fixture(async()=>json(null)),bodyText=JSON.stringify(input);
 const body=new ReadableStream({async start(c){for(let i=0;i<bodyText.length;i+=30){c.enqueue(new TextEncoder().encode(bodyText.slice(i,i+30)));await new Promise(r=>setTimeout(r,40));}c.close();}});
 const req=new Request('http://localhost/api/trpc/runtime.prepare',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'} as RequestInit & {duplex:'half'});
 expect((await f.handle(req)).status).toBe(200);expect(f.paths.filter(p=>p.endsWith('/runtime_admit'))).toHaveLength(1);
});
