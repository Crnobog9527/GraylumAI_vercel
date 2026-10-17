/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-3b PR-3: tool-route prices live beside the model prices of a run and a staging window; every reader splits them.
import { describe, expect, it, vi } from 'vitest';
import { modelCallPolicies, toolCallPolicies } from '../bill2/runPolicies';
import { toolCallPolicy } from '../bill2/toolBilling';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { parseStagingPolicy } from './stagingPolicy';
import { StagingAccessError } from './stagingErrors';
import { beginPaygExecution, type RuntimeExecution } from './paygResume';
import { runRuntime, type RuntimeTool } from './runner';

const id = '10000000-0000-4000-8000-000000000001';
const limits = { providerSlug: 'vendor/fp8', contextTokens: 32000, promptUsdPerMillion: '1', completionUsdPerMillion: '2', requestUsd: '0' };
const model = { modelId: id, provider: 'openrouter', account: 'or', model: 'vendor/model', protocol: 'openrouter-chat-v1' as const,
  providerLimits: limits, upperUsd: openRouterBound(limits, 100).upperUsd, inputLimit: 32000, outputLimit: 100,
  automaticRetry: false as const, hiddenTools: false as const, lookupSupported: true };
const tool = toolCallPolicy({ vendor: 'firecrawl', account: 'firecrawl-staging', route: 'firecrawl:scrape:markdown', purposes: ['research'],
  maxUnitsPerCall: '1', price: { entryHash: 'e'.repeat(64), matchedBy: 'route', multiplier: '1', multiplierSource: 'global',
    entry: { provider: 'firecrawl', route: 'firecrawl:scrape:markdown', appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'credit',
      unitsPerPrice: '1', price: '0.001', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
      pricingBasis: 'list', sourceUrl: 'https://example.com/p', evidenceHash: 'a'.repeat(64), verifiedAt: '2026-10-01T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z', chargeCondition: 'per page', includedInReceipt: false, priceMultiplier: null } } });
const window = (callPolicies: unknown[]) => ({ id, creditsPerUsd: '100', multiplier: '1', expiresAt: '2099-01-01T00:00:00Z', callPolicies });

describe('run and window policies', () => {
  it('splits a stored list into models and validated tool routes', () => {
    expect(modelCallPolicies([model, tool] as never[])).toEqual([model]);
    expect(toolCallPolicies([model, tool])).toEqual([tool]);
    expect(() => toolCallPolicies([{ ...tool, modelId: id }])).toThrow();
  });

  it('a staging window may approve tool routes beside its models; an invalid tool entry refuses the window', () => {
    const parsed = parseStagingPolicy(window([model, tool]));
    expect(parsed.callPolicies).toEqual([model]);
    expect(parsed.toolPolicies).toEqual([tool]);
    expect(parseStagingPolicy(window([model])).toolPolicies).toBeUndefined();
    expect(() => parseStagingPolicy(window([model, { ...tool, upperUsd: 'x' }]))).toThrow(StagingAccessError);
    expect(() => parseStagingPolicy(window([tool]))).toThrow(StagingAccessError);
  });

  it('resuming a staging run rechecks model prices only; tool prices are checked by each claim', async () => {
    const execution = { executionId: id, state: 'waiting_credits', cursor: 3, epoch: 2, remainingCalls: 2,
      billing: { contractVersion: 'bill2.v2', mode: 'staging_test', callPolicy: [model, tool] } } as unknown as RuntimeExecution;
    const resumePricing = vi.fn(async () => {});
    const read = vi.fn(async (action: string) => action === 'payg_resume' ? { ...execution, state: 'running', live: true } : execution);
    await beginPaygExecution({ executionId: id, read, actor: async () => id, callGate: async () => ({ ok: true as const }),
      resume: { executionId: id, cursor: 3, epoch: 2 }, resumePricing });
    expect(resumePricing).toHaveBeenCalledExactlyOnceWith([model]);
  });
});

describe('bounded Agent turn shape', () => {
  const named = (name: string): RuntimeTool => ({ name, description: name, execute: async () => '' });
  const turn = (maxTurns: number, tools: RuntimeTool[]) => runRuntime({ model: 'm', instructions: 'i', input: 'x',
    session: {} as never, maxOutputTokens: 10, maxTurns, tools, commitSessionOnSuccess: true, firstToolCallOnly: true,
    selectHistory: async () => [], exchange: async () => { throw new Error('offline'); } });
  it('one extra turn per frozen slot: a Skill file read and one research call', async () => {
    await expect(turn(3, [named('ask_question'), named('read_skill_file')])).rejects.toThrow('RUNTIME_CONTEXT_INVALID');
    await expect(turn(2, [named('ask_question')])).rejects.toThrow('RUNTIME_CONTEXT_INVALID');
    for (const [maxTurns, tools] of [[2, [named('ask_question'), named('web_search')]],
      [3, [named('ask_question'), named('read_skill_file'), named('benchmark_fetch')]]] as const) {
      await expect(turn(maxTurns, [...tools])).rejects.not.toThrow('RUNTIME_CONTEXT_INVALID');
    }
  });
});
