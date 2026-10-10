/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { frozenReasoningFields } from './reasoningPolicy';
import type { runRuntime } from './runner';
const runner = vi.hoisted(() => ({ run: vi.fn<typeof runRuntime>() }));
vi.mock('./runner', () => ({ runRuntime: runner.run }));
const id = '10000000-0000-4000-8000-000000000001';
const providerLimits = { providerSlug: 'anthropic', contextTokens: 10000,
  promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' };
const reportGeneration = { version: 1, projectId: id, roundId: id, sections: ['One'], maxCharacters: 1000,
  snapshotHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), workflowHash: 'c'.repeat(64), templateHash: 'd'.repeat(64) };

it.each(['report', 'mentor', 'step', 'organizer'].flatMap(kind =>
  ['low', 'high', 'missing'].map(wire => ({ kind, wire }))))(
  '$kind primary call validates frozen low reasoning against $wire before billing', async ({ kind, wire }) => {
    const context = { version: 'runtime.v1', sdkVersion: '0.18.0', model: 'anthropic/claude-sonnet-5.5',
      role: kind === 'organizer' ? 'organizer' : kind === 'mentor' ? 'ordinary' : 'skill',
      input: 'Synthetic input', instructions: 'Answer', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0,
      tools: [], network: 'deny', reasoning: { effort: 'low' },
      providerRequestFormat: kind === 'step' ? 'serial-tools-v4-stream'
        : kind === 'organizer' ? 'serial-tools-v6-reasoning' : 'agent-turn-v5-stream',
      ...(kind === 'report' ? { reportGeneration, purposeBudget: { purpose: 'report', inputBytes: 10000, historyItems: 0 } } : {}) };
    const policy = { modelId: id, model: context.model, provider: 'openrouter', account: 'synthetic',
      protocol: 'openrouter-chat-v1', providerLimits, upperUsd: openRouterBound(providerLimits, 1000).upperUsd,
      inputLimit: 10000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'runtime_execution' && args.p_action === 'begin') return { error: null, data: {
        state: 'running', live: true, runId: id, sessionId: id, context,
        billing: { callPolicy: [policy], rules: {}, limits: { maxCalls: 1 } } } };
      if (name === 'runtime_response') return { error: null, data: null };
      return { error: null, data: { state: 'cancelled' } };
    }) };
    const gate = vi.fn(async () => ({ ok: false as const, reason: 'paused' as const, retryAfter: 60 }));
    runner.run.mockImplementationOnce(async options => {
      await options.exchange(1, JSON.stringify({ model: options.model,
        messages: [{ role: 'user', content: 'Synthetic input' }], ...(wire === 'missing' ? {} : frozenReasoningFields({ effort: wire as 'low' | 'high' })) }));
      return 'unreachable';
    });
    const result = await runtimeExecutor({ database, actor: async () => id, callGate: gate, endpoint: 'http://127.0.0.1:9' }).execute(id);
    expect(result).toEqual({ state: 'cancelled', unavailable: wire === 'low' ? 'paused' : 'preflight',
      ...(wire === 'low' ? { code: 'RUNTIME_NEW_CALLS_STOPPED' } : {}) });
    if (wire === 'low') expect(gate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v1');
    else expect(gate).not.toHaveBeenCalled();
    expect(database.rpc.mock.calls.some(([name]) => name.startsWith('bill2_'))).toBe(false);
  });
