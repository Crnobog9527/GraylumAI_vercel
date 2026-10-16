/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { runtimePaygCall } from './paygRuntime';
import type { FrozenPaygRun } from '../bill2/service';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { PAYG_MAX_TOOLS } from '../bill2/paygPolicy';
import { askQuestionTool } from './agentTools';
import { skillFileTool } from './skillFile';
import { mentorHistoryTool } from './mentorHistory';
import type { RuntimeTool } from './runner';
import { researchRuntimeTools } from './researchRuntimeTool';
import { DISABLED_RESEARCH_TOOLS } from '../research/vendors/config';
import type { ResearchToolContext } from '../research/runtime/toolContext';
const modelId = '10000000-0000-4000-8000-000000000001';
const pricingHash = 'a'.repeat(64);
const limits = { providerSlug: 'local', contextTokens: 300000, promptUsdPerMillion: '1.25',
  cacheWriteUsdPerMillion: '1.25', completionUsdPerMillion: '2', requestUsd: '0' };
const policy: FrozenPaygRun['callPolicy'][number] = { modelId, model: 'model', provider: 'fixture',
  account: 'local', protocol: 'fixture-cost-v1', inputLimit: 196608, outputLimit: 1000,
  upperUsd: openRouterBound(limits, 1000).upperUsd, providerLimits: limits, multiplier: '3',
  automaticRetry: false, hiddenTools: false, lookupSupported: true,
  payg: { policyId: 'fixture', version: '1', profileVersion: '1', evidenceVersion: '1', pricingHash,
    endpointTag: 'local', templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
    maxBytes: 196608, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['ordinary'],
    expiresAt: '2099-01-01T00:00:00Z', nominalPricing: { version: 'nominal-v1', pricingHash,
      endpointTag: 'local', tiers: [{ minPromptTokens: 0, prompt: '1', completion: '2', request: '0' }], timeOfDay: [] } } };
const rules: FrozenPaygRun['rules'] = { version: '1', quoteVersion: '1', creditsPerUsd: '100', multiplier: '3', fx: {},
  billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '100', defaultMultiplier: '3', providers: {}, hash: 'b'.repeat(64),
    models: { [modelId]: { multiplier: '3', source: 'global' } } } };
// The request a mentor turn sends: the tool definitions exactly as the provider receives them.
const request = (tools: RuntimeTool[]) => JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'material' }],
  tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, strict: true,
    parameters: z.toJSONSchema(tool.parameters!) } })) });
const card = askQuestionTool(true), file = skillFileTool(async () => ''), history = mentorHistoryTool(async () => '');

it('#878 regression: a 2-tool profile still refuses card, Skill file and history before any claim', () => {
  expect(() => runtimePaygCall(request([card, file, history]), 'ordinary', policy, rules, 1)).toThrow('BILL2_INPUT_PROFILE_INVALID');
});

it('B1 (0250): a 3-tool profile accepts the full mentor turn with the history read', () => {
  const three = { ...policy, payg: { ...policy.payg!, maxTools: 3 } };
  const { call } = runtimePaygCall(request([card, file, history]), 'ordinary', three, rules, 1);
  expect(call.payg?.tools).toBe(3);
  expect(() => runtimePaygCall(request([card, file, history, card]), 'ordinary', three, rules, 1)).toThrow('BILL2_INPUT_PROFILE_INVALID');
});

it('RT-3b PR-2 (0267): a 9-tool profile accepts the mentor turn with all six research tools, never ten', () => {
  expect(PAYG_MAX_TOOLS).toBe(9);
  const research = researchRuntimeTools({ config: DISABLED_RESEARCH_TOOLS } as unknown as ResearchToolContext);
  expect(research).toHaveLength(6);
  const nine = { ...policy, payg: { ...policy.payg!, maxTools: 9 } };
  const { call } = runtimePaygCall(request([card, file, history, ...research]), 'ordinary', nine, rules, 1);
  expect(call.payg?.tools).toBe(9);
  expect(() => runtimePaygCall(request([card, file, history, ...research, card]), 'ordinary', nine, rules, 1))
    .toThrow('BILL2_INPUT_PROFILE_INVALID');
  // A run frozen with a 3-tool profile keeps refusing the research tools.
  const three = { ...policy, payg: { ...policy.payg!, maxTools: 3 } };
  expect(() => runtimePaygCall(request([card, file, history, research[0]!]), 'ordinary', three, rules, 1))
    .toThrow('BILL2_INPUT_PROFILE_INVALID');
});

it('the PAYG mentor turn without the history read is accepted for dispatch', () => {
  const { call } = runtimePaygCall(request([card, file]), 'ordinary', policy, rules, 1);
  expect(call.payg?.tools).toBe(2);
});

it('logs pre-dispatch failures by stable code only, never by free text', async () => {
  const { diagnosticCode } = await import('./executorRpc');
  expect(diagnosticCode(new Error('BILL2_INPUT_PROFILE_INVALID'))).toBe('BILL2_INPUT_PROFILE_INVALID');
  expect(diagnosticCode(new Error('Unexpected token in 我的资料 at position 3'))).toBe('UNCLASSIFIED');
  expect(diagnosticCode('BILL2_INPUT_PROFILE_INVALID')).toBe('UNCLASSIFIED');
});
