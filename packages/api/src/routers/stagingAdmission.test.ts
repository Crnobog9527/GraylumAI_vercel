/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), list: vi.fn(), library: vi.fn(), start: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: mocks.info, error: mocks.error, warn: vi.fn() } }));
vi.mock('../services/opc/service', async original => ({ ...await original<typeof import('../services/opc/service')>(), opcService: () => ({ catalog: mocks.catalog, list: mocks.list, library: mocks.library }) }));
vi.mock('../services/runtime/admission', async original => ({ ...await original<typeof import('../services/runtime/admission')>(), runtimeAdmissionService: () => ({ start: mocks.start }) }));
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
function context(privileged = true) {
  const profile = { select() { return this; }, eq() { return this; }, single: async () => ({ data: { id: actor, role: 'user', status: 'active', nickname: 'Fixture', email: 'fixture@example.test', created_at: '2020-01-01', credits: 100 }, error: null }) };
  const client = { from: () => profile, rpc, auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) } };
  return { user: { id: actor, email: 'fixture@example.test' }, isEmailVerified: true, supabase: client, supabaseAuth: client, supabaseAdmin: client, hasSupabaseAdminPrivileges: privileged } as never;
}
beforeEach(() => {
  vi.clearAllMocks();
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
