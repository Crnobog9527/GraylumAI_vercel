/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOriginalExecution } from './executionStream';
import { createRuntimeBudget } from './budget';
import { denyNewCalls } from './newWorkGate';
const mock = vi.hoisted(() => ({ factory: vi.fn(), policy: vi.fn(), gate: vi.fn(), recover: vi.fn() }));
vi.mock('./execute', () => ({ runtimeExecutor: mock.factory }));
vi.mock('./stagingPolicy', () => ({ loadStagingPolicy: mock.policy, loadStagingRecoveryPolicy: async () => ({}) }));
vi.mock('./stagingTransport', () => ({ stagingTransport: () => ({ lookup: vi.fn() }) }));
vi.mock('./newWorkGate', async importOriginal => ({
  ...await importOriginal<typeof import('./newWorkGate')>(),
  newWorkGate: (_db: unknown, environment: string) => ({ calls: mock.gate(environment) }),
}));
beforeEach(() => {
  vi.clearAllMocks(); mock.policy.mockResolvedValue({});
  mock.factory.mockReturnValue({ execute: async () => ({ state: 'completed' }), recoverFinancial: mock.recover });
  mock.recover.mockResolvedValue({ state: 'completed' });
  mock.gate.mockImplementation(() => async () => ({ ok: true }));
});
afterEach(() => vi.unstubAllEnvs());
it.each(['local', 'staging', 'recovery'])('wires the %s host gate explicitly', async mode => {
  vi.stubEnv('V3_RUNTIME_STAGING_ENABLED', 'true');
  if (mode === 'recovery') mock.policy.mockRejectedValue(new Error('not enabled'));
  await executeOriginalExecution({ admin: {rpc:async()=>({data:null,error:null})} as never, user: { auth: {} } as never,
    actorId: 'actor', budget: createRuntimeBudget(),
    ...(mode === 'local' ? { maintenanceEndpoint: 'http://127.0.0.1:1' } : {}) }, 'execution');
  const options = mock.factory.mock.calls[0][0];
  expect(typeof options.callGate).toBe('function');
  if (mode === 'recovery') {
    expect(options.callGate).toBe(denyNewCalls);
    expect(await options.callGate('actor', 2)).toMatchObject({ ok: false, reason: 'limit_unavailable' });
    expect(mock.gate).not.toHaveBeenCalled(); expect(mock.recover).toHaveBeenCalled();
  } else expect(mock.gate).toHaveBeenCalledExactlyOnceWith(mode);
});
it('router constructor wires its authenticated admin and resolved environment', () => {
  const source = readFileSync(new URL('../../routers/runtime.ts', import.meta.url), 'utf8');
  expect(source).toContain("callGate:newWorkGate(ctx.supabaseAdmin,endpoint?'local':'staging').calls");
});
it('no production source imports the test-only allowing gate', () => {
  // pathname keeps percent-encoding, which breaks checkouts under non-ASCII or spaced paths.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['__tests__', 'tests'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith('.ts') && !/\.(test|integration|spec)\.ts$/.test(path)) {
        expect(readFileSync(path, 'utf8')).not.toMatch(/allowTestCalls|fixtures\/runtimeGates/);
      }
    }
  }
  visit(root);
});

it.each(['waiting_credits','waiting_resume'])('keeps %s when the original staging window closes',async state=>{
 vi.stubEnv('V3_RUNTIME_STAGING_ENABLED','false');
 mock.policy.mockRejectedValue(Error('window unavailable'));
 const execute=vi.fn(async()=>({state,code:state==='waiting_credits'?'RUNTIME_WAITING_CREDITS':'RUNTIME_WAITING_RESUME'}));
 mock.factory.mockReturnValue({execute,recoverFinancial:mock.recover});
 const rpc=vi.fn(async()=>({data:{state,billing:{contractVersion:'bill2.v2'}},error:null}));
 const result=await executeOriginalExecution({admin:{rpc} as never,user:{auth:{}} as never,
  actorId:'actor',budget:createRuntimeBudget()},'execution');
 expect(result).toMatchObject({state,unavailable:'RUNTIME_PRICE_CONFIGURATION_PENDING'});
 expect(mock.recover).not.toHaveBeenCalled();
 expect(rpc.mock.calls).toHaveLength(2);
 expect(execute).toHaveBeenCalledExactlyOnceWith('execution');
});
it.each(['auth', 'waiting', 'window'])('finishes erased waiting v2 when %s expires without new generation', async mode => {
  vi.stubEnv('V3_RUNTIME_STAGING_ENABLED', 'false');
  if (mode === 'window') mock.policy.mockRejectedValue(Error('expired window'));
  const execute = mode === 'auth' ? vi.fn(async () => { throw Error('RUNTIME_DENIED'); })
    : vi.fn(async () => ({ state: 'waiting_credits', body: 'PRIVATE_CANARY' }));
  mock.factory.mockReturnValue({ execute, recoverFinancial: mock.recover });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'runtime_financial_recovery') throw Error('UNEXPECTED_RPC');
    return { data: { state: args.p_finish ? 'cancelled' : 'waiting_credits',
      billing: { contractVersion: 'bill2.v2', accountClosed: true }, body: 'PRIVATE_CANARY' }, error: null };
  });
  const getUser = vi.fn(async () => { throw Error('AUTH_REVOKED'); });
  expect(await executeOriginalExecution({ admin: { rpc } as never, user: { auth: { getUser } } as never,
    actorId: 'actor', budget: createRuntimeBudget(),
    ...(mode === 'window' ? {} : { maintenanceEndpoint: 'http://127.0.0.1:1' }) }, 'execution'))
    .toEqual({ state: 'cancelled' });
  expect(rpc.mock.calls.map(([, args]) => args.p_finish)).toEqual([false, true]);
  expect(mock.recover).not.toHaveBeenCalled(); expect(getUser).not.toHaveBeenCalled();
  if (mode === 'window') expect(execute).not.toHaveBeenCalled();
});

it('preserves the original execution failure when erased-waiting maintenance also fails',async()=>{
 const original=Error('RUNTIME_ORIGINAL_FAILURE');
 mock.factory.mockReturnValue({execute:async()=>{throw original;},recoverFinancial:mock.recover});
 const rpc=vi.fn(async()=>({data:null,error:{code:'08006',message:'synthetic storage failure'}}));
 await expect(executeOriginalExecution({admin:{rpc} as never,user:{auth:{}} as never,
  actorId:'actor',budget:createRuntimeBudget(),maintenanceEndpoint:'http://127.0.0.1:1'},'execution'))
  .rejects.toBe(original);
 expect(rpc).toHaveBeenCalledExactlyOnceWith('runtime_financial_recovery',{
  p_actor_id:'actor',p_execution_id:'execution',p_finish:false,
 });
});
