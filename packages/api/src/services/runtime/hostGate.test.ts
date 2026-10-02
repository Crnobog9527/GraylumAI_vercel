/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  await executeOriginalExecution({ admin: {} as never, user: { auth: {} } as never,
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
  const root = new URL('../../', import.meta.url).pathname;
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
