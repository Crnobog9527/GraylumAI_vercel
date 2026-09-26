/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
const mocks = vi.hoisted(() => ({ realOpc: false, realAdmission: false, prepareStep: vi.fn(), catalog: vi.fn(), list: vi.fn(), library: vi.fn(), start: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: mocks.info, error: mocks.error, warn: vi.fn() } }));
vi.mock('../services/opc/service', async original => { const actual = await original<typeof import('../services/opc/service')>(); return { ...actual, opcService: (...args: Parameters<typeof actual.opcService>) => mocks.realOpc ? actual.opcService(...args) : ({ catalog: mocks.catalog, list: mocks.list, library: mocks.library, prepareStep: mocks.realAdmission ? async (input:{requestId:string;input:string;organizeAfter:boolean}) => (await import('../services/runtime/admission')).runtimeAdmissionService(args[0],args[1],{real:args[2],account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:100,inputBytes:8000,historyItems:20}).prepare({sessionId:actor,requestId:input.requestId,input:input.input,organizeAfter:input.organizeAfter,selection:{kind:'ordinary',modelId:actor},network:'deny'}) : mocks.prepareStep }) }; });
vi.mock('../services/runtime/admission', async original => {const actual=await original<typeof import('../services/runtime/admission')>();return {...actual,runtimeAdmissionService:(...args:Parameters<typeof actual.runtimeAdmissionService>)=>mocks.realAdmission?actual.runtimeAdmissionService(...args):{start:mocks.start}};});
import { opcRouter } from './opc';
import { runtimeRouter } from './runtime';
import { router } from '../trpc';
const app = router({ opc: opcRouter, runtime: runtimeRouter });
const actor = '00000000-0000-4000-8000-000000000001';
const windowId = '00000000-0000-4000-8000-000000000002';
const remote = {
  V3_RUNTIME_STAGING_ENABLED: 'true', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'graylumai-staging.vercel.app',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  V3_RUNTIME_STAGING_PROJECT_ID: 'test-project', VERCEL_PROJECT_ID: 'test-project',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co',
  V3_RUNTIME_STAGING_WINDOW_ID: windowId, V3_RUNTIME_LOCAL_ENDPOINT: undefined,
};
const policy = { id: windowId, expiresAt: '2099-01-01T00:00:00Z', creditsPerUsd: '1000', multiplier: '1', callPolicies: [{
  modelId: actor, provider: 'openrouter', account: 'synthetic', model: 'test/model', protocol: 'openrouter-chat-v1',
  upperUsd: '0.02', inputLimit: 8000, outputLimit: 100, automaticRetry: false, hiddenTools: false, lookupSupported: true,
  providerLimits: { providerSlug: 'synthetic', contextTokens: 10000, promptUsdPerMillion: '2', completionUsdPerMillion: '0', requestUsd: '0' },
}] };
const rpc = vi.fn();
const summaryId='00000000-0000-4000-8000-000000000003';
let modelFault:string|null=null,summaryModel=summaryId;

function context(privileged = true) {
  const profile = { select() { return this; }, eq() { return this; }, single: async () => ({ data: { id: actor, role: 'user', status: 'active', nickname: 'Fixture', email: 'fixture@example.test', created_at: '2020-01-01', credits: 100 }, error: null }) };
  const client = { from: (table:string) => {
    if(!mocks.realAdmission||table==='profiles')return profile;
    if(table==='system_settings')return {select(){return this;},in:async()=>({data:[{key:'v3_summary_model_id',value:summaryModel},{key:'v3_summary_max_tokens',value:128}],error:null})};
    let id=actor;const query={select(){return this;},eq(_key:string,value:string){id=value;return this;},single:async()=>({data:{id,model_id:id===actor?'test/model':'test/summary',provider:'openrouter',is_active:modelFault==='inactive'?'false':'true',input_limit:10000,max_tokens:1000},error:modelFault&&modelFault!=='inactive'?{code:modelFault,message:'SYNTHETIC_PRIVATE_DATABASE_BODY'}:null})};return query;
  }, rpc, auth: { getUser: async () => ({ data: { user: { id: actor, email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }) } };
  return { user: { id: actor, email: 'fixture@example.test' }, isEmailVerified: true, supabase: client, supabaseAuth: client, supabaseAdmin: client, hasSupabaseAdminPrivileges: privileged } as never;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.realOpc = false;mocks.realAdmission=false;modelFault=null;summaryModel=summaryId;
  for (const [key, value] of Object.entries(remote)) vi.stubEnv(key, value);
  mocks.catalog.mockResolvedValue([]); mocks.list.mockResolvedValue({ drafts: [], accounts: [] }); mocks.library.mockResolvedValue({ businesses: [] }); mocks.start.mockResolvedValue({ sessionId: actor });
  rpc.mockImplementation(async (name: string) => ({ data: name === 'runtime_test_policy' ? policy : name === 'runtime_test_actor_access' ? true : [], error: null }));
});
afterEach(() => vi.unstubAllEnvs());
const libraryInput = { search: '', from: null, to: null };
const startInput = { requestId: actor, scope: { kind: 'positioning_draft' } };
describe('remote staging admission and HTTP error boundary', () => {
  it('reproduces the deployed remote target with no configured window, without entering business RPCs', async () => {
    vi.stubEnv('V3_RUNTIME_STAGING_WINDOW_ID', undefined);
    const caller = app.createCaller(context());
    for (const call of [() => caller.opc.catalog(), () => caller.opc.library(libraryInput), () => caller.opc.list(), () => caller.opc.conversations(), () => caller.runtime.start(startInput), () => caller.runtime.view({sessionId: actor})])
      await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('尚未配置') });
    expect(rpc).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('returns per-procedure 412 bodies for the same failing read batch, rather than three 500s', async () => {
    vi.stubEnv('V3_RUNTIME_STAGING_PROJECT_ID', undefined);
    const url = 'http://localhost/api/trpc/opc.library,opc.list,opc.conversations?batch=1&input=' + encodeURIComponent(JSON.stringify({0: libraryInput}));
    const response = await fetchRequestHandler({ endpoint: '/api/trpc', req: new Request(url), router: app, createContext: () => context() });
    expect(response.status).toBe(412);
    const body = await response.json();
    expect(body.map((row: {error: {data: {code: string; path: string}}}) => row.error.data.code)).toEqual(['PRECONDITION_FAILED','PRECONDITION_FAILED','PRECONDITION_FAILED']);
    expect(JSON.stringify(body)).not.toContain('RUNTIME_STAGING_');
  });
  it('distinguishes a missing/closed/expired window denial from actor read denial when remote config exists', async () => {
    rpc.mockImplementation(async (name: string) => ({data: null, error: {code:'42501', message:name === 'runtime_test_policy' ? 'RUNTIME_TEST_WINDOW_DENIED' : 'RUNTIME_TEST_ACTOR_DENIED'}}));
    const caller = app.createCaller(context());
    await expect(caller.opc.catalog()).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(caller.runtime.start(startInput)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(caller.opc.library(libraryInput)).rejects.toMatchObject({code:'FORBIDDEN',message:expect.stringContaining('账号未获准')});
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each(['false', undefined])('keeps read recovery for an allowed actor after host enablement is %s', async enabled => {
    vi.stubEnv('V3_RUNTIME_STAGING_ENABLED', enabled);
    const caller = app.createCaller(context());
    await expect(caller.opc.library(libraryInput)).resolves.toEqual({businesses:[]});
    await expect(caller.opc.conversations()).resolves.toEqual([]);
    await expect(caller.runtime.start(startInput)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  });
  it('allows genuine empty results and session admission for a valid remote window', async () => {
    const caller = app.createCaller(context());
    await expect(caller.opc.catalog()).resolves.toEqual([]);
    await expect(caller.opc.list()).resolves.toEqual({drafts:[],accounts:[]});
    await expect(caller.runtime.start(startInput)).resolves.toEqual({sessionId:actor});
  });
  it('rejects an expired returned policy even when the RPC reports success', async () => {
    rpc.mockResolvedValue({data:{...policy,expiresAt:'2020-01-01T00:00:00Z'},error:null});
    await expect(app.createCaller(context()).runtime.start(startInput)).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:expect.stringContaining('已过期')});
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each(['PGRST202','42883','42P01','42501','PGRST301'])('does not mislabel RPC/schema/credential error %s as an actor refusal', async code => {
    rpc.mockResolvedValue({data:null,error:{code,message:'private credential SQL details'}});
    await expect(app.createCaller(context()).opc.library(libraryInput)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
    expect(JSON.stringify(mocks.error.mock.calls)).toContain(code);
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private credential');
  });
  it('reports absent service credentials as unavailable without querying the database', async () => {
    await expect(app.createCaller(context(false)).opc.library(libraryInput)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
    expect(rpc).not.toHaveBeenCalled();
  });
  it('fails closed for a wrong remote target even if a local runtime endpoint is set', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID','wrong'); vi.stubEnv('V3_RUNTIME_LOCAL_ENDPOINT','http://127.0.0.1:5555');
    await expect(app.createCaller(context()).runtime.start(startInput)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(rpc).not.toHaveBeenCalled();
  });
  it('keeps unexpected internal errors at 500 with a safe correlatable diagnostic', async () => {
    mocks.library.mockRejectedValueOnce(new Error('secret business SQL body'));
    await expect(app.createCaller(context()).opc.library(libraryInput)).rejects.toMatchObject({code:'INTERNAL_SERVER_ERROR',message:expect.stringContaining('诊断编号')});
    expect(JSON.stringify(mocks.error.mock.calls)).toContain('opc.library');
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('secret business');
  });
});

// Exercise actual OPC and shared catalog services, not their admission mocks.
it.each(['catalog','list','library','conversations'] as const)('classifies downstream %s schema faults after successful admission', async route => {
  mocks.realOpc = true;
  rpc.mockImplementation((name: string) => Object.assign(Promise.resolve(
    name === 'runtime_test_actor_access' ? {data:true,error:null} : name === 'runtime_test_policy' ? {data:policy,error:null}
      : {data:null,error:{code:'PGRST202',message:'private SQL credential details'}}
  ), {abortSignal() {return this;}}));
  const caller = app.createCaller(context());
  const request = route === 'library' ? caller.opc.library(libraryInput) : caller.opc[route]();
  await expect(request).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE',message:expect.stringContaining('尚未就绪')});
  expect(JSON.stringify(mocks.error.mock.calls)).toContain('PGRST202');
  expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private SQL');
});
it('preserves unexpected database faults as sanitized 500 rather than schema unavailability', async () => {
  rpc.mockImplementation(async (name: string) => name === 'runtime_test_actor_access' ? {data:true,error:null} : {data:null,error:{code:'XX000',message:'private SQL body'}});
  await expect(app.createCaller(context()).opc.conversations()).rejects.toMatchObject({code:'INTERNAL_SERVER_ERROR',message:expect.stringContaining('诊断编号')});
  expect(JSON.stringify(mocks.error.mock.calls)).toContain('XX000');
  expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private SQL');
});

describe('downstream real-model admission after a valid remote window',()=>{
 const stepInput={draftId:actor,requestId:windowId,stepId:'step-1',purpose:'mentor' as const,questionId:'time',organizeAfter:true,input:'Synthetic reply'};
 const runtimeInput={sessionId:actor,requestId:windowId,input:'Synthetic reply',selection:{kind:'ordinary' as const,modelId:actor},organizeAfter:true,network:'deny' as const};
 function configure(allModels:boolean){
  mocks.realAdmission=true;
  const calls=allModels?[...policy.callPolicies,{...policy.callPolicies[0],modelId:summaryId,model:'test/summary'}]:policy.callPolicies;
  rpc.mockImplementation(async(name:string)=>({data:name==='runtime_test_policy'?{...policy,callPolicies:calls}:name==='runtime_test_actor_access'?true:name==='runtime_session_context'?{scope:{kind:'positioning_draft',draftId:actor},dialogueModelId:actor,dialogueModel:'test/model'}:name==='runtime_admission_replay'?null:name==='runtime_admit'?{executionId:windowId}:[],error:null}));
 }
 async function post(path:string,input:unknown){
  return fetchRequestHandler({endpoint:'/api/trpc',req:new Request('http://localhost/api/trpc/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),router:app,createContext:()=>context()});
 }
 it.each(['opc.prepareStep','runtime.prepare'])('returns 412 before admission when %s needs an unapproved organizer',async path=>{
  configure(false);const response=await post(path,path==='opc.prepareStep'?stepInput:runtimeInput),body=await response.json();
  expect(response.status).toBe(412);expect(body.error.data.code).toBe('PRECONDITION_FAILED');expect(body.error.message).toContain('所需模型尚未获准');
  expect(rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);expect(JSON.stringify(body)).not.toContain('CAPABILITY_UNVERIFIED');
 });
 it.each(['opc.prepareStep','runtime.prepare'])('admits separate primary and organizer models for %s only when both are approved',async path=>{
  configure(true);const response=await post(path,path==='opc.prepareStep'?stepInput:runtimeInput);expect(response.status).toBe(200);
  const admitted=rpc.mock.calls.find(([name])=>name==='runtime_admit')!;expect(admitted).toBeDefined();
  expect(admitted[1].p_payload.modelId).toBe(actor);expect(admitted[1].p_payload.attachedOrganizer.modelId).toBe(summaryId);
  expect(admitted[1].p_billing.callPolicy.map((call:{modelId:string})=>call.modelId)).toEqual([actor,summaryId]);
 });
 it.each(['inactive','PGRST116','same_model','missing_summary'])('reports known %s model configuration as unavailable without admitting',async fault=>{
  configure(true);if(['inactive','PGRST116'].includes(fault))modelFault=fault;else summaryModel=fault==='same_model'?actor:'';
  const response=await post('opc.prepareStep',stepInput);expect(response.status).toBe(503);expect((await response.json()).error.message).toContain('模型配置暂不可用');
  expect(rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
 });
 it.each(['opc.prepareStep','runtime.prepare'])('keeps unknown model database faults in %s at sanitized 500',async path=>{
  configure(true);modelFault='XX000';const response=await post(path,path==='opc.prepareStep'?stepInput:runtimeInput),body=await response.json();
  expect(response.status).toBe(500);expect(body.error.message).toContain('诊断编号');expect(JSON.stringify(body)+JSON.stringify(mocks.error.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_DATABASE_BODY');
  expect(JSON.stringify(mocks.error.mock.calls)).toContain('XX000');expect(rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
 });
 it('maps execute recovery denial after maintenance initialization',async()=>{
  rpc.mockImplementation(async(name:string)=>name==='runtime_test_actor_access'?{data:true,error:null}:{data:null,error:{code:'42501',message:name==='runtime_test_policy'?'RUNTIME_TEST_WINDOW_DENIED':'RUNTIME_TEST_RECOVERY_DENIED'}});
  const response=await post('runtime.execute',{executionId:actor});expect(response.status).toBe(403);expect((await response.json()).error.message).toContain('无法恢复');
 });
 it('preserves bounded OPC recovery refusals and sanitizes unexpected downstream exceptions',async()=>{
  mocks.prepareStep.mockRejectedValueOnce(new Error('OPC_REQUEST_CONFLICT'));
  await expect(app.createCaller(context()).opc.prepareStep(stepInput)).rejects.toMatchObject({message:'OPC_REQUEST_CONFLICT'});
  mocks.prepareStep.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_UNEXPECTED_BODY'));
  const response=await post('opc.prepareStep',stepInput),body=await response.json();expect(response.status).toBe(500);expect(body.error.message).toContain('诊断编号');
  expect(JSON.stringify(body)+JSON.stringify(mocks.error.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_UNEXPECTED_BODY');
 });
});
