/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { createRuntimeBudget } from './budget';
import { CONTENT_SOURCE_MESSAGES } from '../../shared/contentSourceMessages';
const mock = vi.hoisted(() => ({ run: vi.fn(), billing: {
  claimCall: vi.fn(), dispatchOnce: vi.fn(), recoverRun: vi.fn(), recoverReceipts: vi.fn(),
} }));
vi.mock('../bill2/service', () => ({ authoritativeBilling: () => mock.billing }));
vi.mock('./runner', () => ({ runRuntime: mock.run }));
vi.mock('./session', () => ({ PostgresSession: class {} }));
const id = '10000000-0000-4000-8000-000000000001';
const contentId = '20000000-0000-4000-8000-000000000002';

// A2 through the real executor: a directly chosen storyboard Skill admitted with a frozen script version.
function fixture(checkpoint: unknown, role = 'skill') {
  const policy = { modelId: id, provider: 'fixture', account: 'synthetic', model: 'primary', protocol: 'fixture-cost-v1',
    upperUsd: '0.02', inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true };
  const execution = { state: 'running', live: true, cancelRequested: false, runId: id, sessionId: id,
    context: { version: 'runtime.v1', sdkVersion: '0.18.0', role, input: '出分镜', instructions: 'STORYBOARD_SKILL',
      model: 'primary', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny',
      ...(role === 'skill' ? { sourceContent: { contentId, kind: 'script' } } : {}) },
    billing: { callPolicy: [policy], rules: {}, limits: { maxCalls: 1 } }, result: null };
  const calls: string[] = [];
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push(name === 'runtime_execution' ? String(args.p_action) : name);
    if (name === 'runtime_execution' && args.p_action === 'begin') return { data: execution, error: null };
    if (name === 'runtime_execution' && args.p_action === 'checkpoint_source') return { data: checkpoint, error: null };
    if (name === 'runtime_cancel') return { data: { state: 'cancelled' }, error: null };
    if (name === 'runtime_response') return { data: null, error: null };
    return { data: { state: 'completed', runId: id }, error: null };
  }) };
  const instructions: string[] = [];
  mock.run.mockImplementation(async options => { instructions.push(options.instructions); return 'STORYBOARD_REPLY'; });
  const options = { database, actor: async () => id, adapter: { dispatch: vi.fn() } as never,
    callGate: vi.fn().mockResolvedValue({ ok: true }), budget: createRuntimeBudget() };
  return { options, calls, instructions };
}
beforeEach(() => vi.clearAllMocks());

it('injects the recorded script into this call\'s instructions before the content call', async () => {
  const f = fixture({ status: 'injected', contentId, kind: 'script', version: 3, body: 'SCRIPT_V3_BODY' });
  expect(await runtimeExecutor(f.options).execute(id)).toMatchObject({ state: 'completed', body: 'STORYBOARD_REPLY' });
  expect(f.calls.indexOf('checkpoint_source')).toBeGreaterThan(-1);
  expect(f.instructions).toHaveLength(1);
  expect(f.instructions[0]).toMatch(/^STORYBOARD_SKILL[\s\S]*version 3[\s\S]*SCRIPT_V3_BODY$/);
});

it.each(['RUNTIME_CONTENT_SOURCE_MISSING', 'RUNTIME_CONTENT_SOURCE_STALE'] as const)(
  'a refused source (%s) ends the turn with its fixed notice and never runs the content call', async code => {
    const f = fixture({ status: 'refused', code });
    expect(await runtimeExecutor(f.options).execute(id))
      .toEqual({ state: 'cancelled', code, notice: CONTENT_SOURCE_MESSAGES[code] });
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.billing.claimCall).not.toHaveBeenCalled();
    expect(f.calls).toContain('runtime_cancel');
  });

it('a source too large for the call is refused before any dispatch', async () => {
  const f = fixture({ status: 'injected', contentId, kind: 'script', version: 1, body: '长'.repeat(20000) });
  expect(await runtimeExecutor(f.options).execute(id)).toMatchObject({ state: 'cancelled', code: 'RUNTIME_CONTENT_SOURCE_TOO_LARGE' });
  expect(mock.run).not.toHaveBeenCalled();
});

it('an ordinary turn never reads a source', async () => {
  const f = fixture({ status: 'injected', contentId, kind: 'script', version: 1, body: 'NEVER' }, 'ordinary');
  await runtimeExecutor(f.options).execute(id);
  expect(f.calls).not.toContain('checkpoint_source');
  expect(f.instructions[0]).toBe('STORYBOARD_SKILL');
});
