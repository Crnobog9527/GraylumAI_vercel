/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {openRouterBound} from '../../services/bill2/openRouterPolicy';
import {openRouterRequestBody} from '../../services/runtime/providerRequest';
import {frozenReasoningFields} from '../../services/runtime/reasoningPolicy';
import {AGENT_TURN_CANDIDATES, AGENT_TURN_CONFIG, type AgentTurnCandidate} from './agentTurn.ts';
import {createBudget, HARD_MAX_CALLS, HARD_MAX_USD, memoryLedger} from './budget.ts';
import {resolveConfigs, routing, type ProbeConfig} from './config.ts';
import {sseResponse, toolDeltas} from './dryRun.ts';
import {runProbe} from './main.ts';
import {buildPlan, describePlan, parseProbeArgs} from './plan.ts';
import type {LoadedSkill, Scenario} from './skill.ts';
import {runTrial} from './trial.ts';

const skill: LoadedSkill = {instructions: 'Synthetic candidate mentor',
  references: new Map([['references/guide.md', 'Synthetic constraints.']]), digest: 'candidate-fixture', bytes: 26,
  isFixture: true, workflow: [{title: 'Audience', resources: ['references/guide.md'],
    information: [{id: 'audience', title: 'Audience', required: true, elicitation: 'user_fact'}]}]};
const scenarios: Scenario[] = (['ask', 'text'] as const).flatMap(kind =>
  Array.from({length: kind === 'ask' ? 30 : 10}, (_, index) => ({id: kind + index, kind, history: [],
    input: 'Synthetic ' + index, step: 0, currentStepId: 'step-1', questionId: 'audience'})));
const argv = (candidate: AgentTurnCandidate, ...extra: string[]) => ['--agent-turn', '--agent-turn-candidate', candidate, ...extra];
const args = (candidate: AgentTurnCandidate, ...extra: string[]) => parseProbeArgs(argv(candidate, ...extra), '/synthetic-home');
const card = {question: 'Which audience?', options: ['Neighbours', 'Volunteers']};
afterEach(() => vi.restoreAllMocks());

async function capture(config: ProbeConfig, kind: 'ask' | 'text' = 'ask') {
  const bodies: string[] = [];
  const result = await runTrial({agentTurn: true, kind, scenario: {...scenarios[0]!, kind, history: [
    {role: 'assistant', content: 'A prior suggestion.', askQuestion: card}, {role: 'user', content: 'Neighbours'},
  ]}, index: 0, skill, config, maxTokens: 8192, timeoutMs: 5000,
  budget: createBudget({maxCalls: 1, maxUsd: 3.5, ledger: memoryLedger()}),
  upstream: async (_url, init) => {
    bodies.push(String(init.body));
    return sseResponse(config.model, toolDeltas('ask_question', card), {finish: 'tool_calls'});
  }, authorization: 'Bearer synthetic', clock: () => performance.now(), redact: text => text});
  expect(bodies).toHaveLength(1);
  expect(result.askExecutions).toBe(1);
  expect(result.stop).toBeUndefined();
  return {body: JSON.parse(bodies[0]!), bytes: bodies[0]!};
}

describe('fixed AC1-4 candidates: offline preparation only', () => {
  it.each(['c1', 'c2'] as const)('fixes %s to forty distinct trials, 8192 output tokens and offline defaults', candidate => {
    const parsed = args(candidate);
    expect(parsed).toMatchObject({agentTurn: true, agentTurnCandidate: candidate, live: false,
      counts: {ask: 30, text: 10, reference: 0}, maxCalls: 40, maxUsd: 3.5, maxTokens: 8192});
    expect(args(candidate, '--max-tokens', '8192').maxTokens).toBe(8192);
    const plan = buildPlan(parsed, skill, scenarios, 'candidate-scenarios');
    expect(plan).toMatchObject({agentTurnCandidate: candidate, plannedCalls: 40, configs: [AGENT_TURN_CANDIDATES[candidate]]});
    expect(() => buildPlan({...parsed, counts: {...parsed.counts, ask: 29}}, skill, scenarios, 's')).toThrow('PLAN_FIXED');
    expect(() => buildPlan(parsed, skill, scenarios.slice(1), 's')).toThrow('DISTINCT_SCENARIOS');
    expect(() => buildPlan({...parsed, maxTokens: 1024}, skill, scenarios, 's')).toThrow('MAX_TOKENS_FIXED');
    expect(() => buildPlan({...parsed, live: true}, skill, scenarios, 's')).toThrow('PREPARATION_ONLY');
    const description = describePlan(plan, 'dry-run', {calls: 0, usd: 0});
    expect(description).toContain('Preparation only');
    expect(description).not.toContain('For real calls add:');
  });

  it('keeps the two public candidates exact and separate from the old baseline registry', () => {
    expect(AGENT_TURN_CANDIDATES).toEqual({
      c1: {id: 'ac14-c1-deepseek-deepinfra-low', model: 'deepseek/deepseek-v4.1-flash', route: 'deepinfra/fp8',
        effort: 'low', maxPrice: {prompt: 0.14, completion: 0.42}, dataCollection: 'omit', runtimeRouting: true},
      c2: {id: 'ac14-c2-gemini-vertex-low', model: 'google/gemini-3.8-flash', route: 'google-vertex/global',
        effort: 'low', maxPrice: {prompt: 0.75, completion: 3.75}, dataCollection: 'omit', runtimeRouting: true},
    });
    expect(buildPlan(args('c1'), skill, scenarios, 's').planId).not.toBe(buildPlan(args('c2'), skill, scenarios, 's').planId);
    expect(HARD_MAX_CALLS).toBe(493);
    expect(HARD_MAX_USD).toBe(3.5);
  });

  it.each([
    ['--agent-turn-candidate', 'c1'], ['--agent-turn', '--agent-turn-candidate', 'other'],
    argv('c1', '--configs', 'qwen-deepinfra-low'), argv('c1', '--configs', ''), argv('c2', '--config-file', '/unused'),
    argv('c1', '--max-tokens', '1024'), argv('c2', '--max-tokens', '8191'), argv('c2', '--max-tokens', '8193'),
    argv('c1', '--max-usd', '3.51'), argv('c1', '--max-calls', '494'),
    argv('c2', '--record-external-calls', '1', '--record-external-usd', '0.1'),
  ])('refuses conflicting candidate arguments %j', (...input) => {
    expect(() => parseProbeArgs(input, '/synthetic-home')).toThrow();
  });

  it.each(['c1', 'c2'] as const)('rejects %s live before reading Skill, creating results or opening a ledger', async candidate => {
    const home = mkdtempSync(join(tmpdir(), 'ac14-candidate-refused-'));
    try {
      const upstream = vi.fn();
      const globalFetch = vi.spyOn(globalThis, 'fetch');
      const errors: string[] = [];
      const outcome = await runProbe(argv(candidate, '--live', '--confirm', 'anything', '--skill-dir', '/does-not-exist'), {},
        {home, fetch: upstream, stdout: () => {}, stderr: text => errors.push(text)});
      expect(outcome.exitCode).toBe(2);
      expect(errors.join('')).toContain('PROBE_AGENT_TURN_CANDIDATE_PREPARATION_ONLY');
      expect(upstream).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
      expect(existsSync(join(home, '.graylum'))).toBe(false);
    } finally { rmSync(home, {recursive: true, force: true}); }
  });

  it('reports over-cap candidate estimates without changing or bypassing execution caps', () => {
    const plan = buildPlan(args('c2'), {...skill, instructions: 'x'.repeat(200_000)}, scenarios, 's');
    expect(plan.plannedUsdUpperBound).toBeGreaterThan(3.5);
    expect(plan.maxUsd).toBe(3.5);
    expect(describePlan(plan, 'dry-run', {calls: 493, usd: 3.5})).toContain('estimate is not executable');
    expect(() => buildPlan({...args('c2'), live: true}, skill, scenarios, 's')).toThrow('PREPARATION_ONLY');
    const ledger = memoryLedger({calls: 493, nanoUsd: 0});
    expect(() => createBudget({maxCalls: 40, maxUsd: 3.5, ledger}).reserve(1)).toThrow('total_call_cap');
  });

  it('preserves baseline identity, routing bytes, token default and USD 1 behavior', () => {
    const parsed = parseProbeArgs(['--agent-turn'], '/synthetic-home');
    expect(parsed).toMatchObject({maxCalls: 60, maxUsd: 1, maxTokens: 1024});
    const plan = buildPlan(parsed, skill, scenarios, 'candidate-scenarios');
    expect(plan.planId).toBe('ff2e859e22ad');
    expect(plan).not.toHaveProperty('agentTurnCandidate');
    expect(JSON.stringify(routing(AGENT_TURN_CONFIG))).toBe(
      '{"only":["deepinfra/fp8"],"allow_fallbacks":false,"require_parameters":true,"data_collection":"deny","max_price":{"prompt":0.3,"completion":0.9}}');
    expect(() => buildPlan({...parsed, maxUsd: 1.01}, skill, scenarios, 's')).toThrow('PLAN_FIXED');
    expect(() => buildPlan(parsed, {...skill, instructions: 'x'.repeat(200_000)}, scenarios, 's')).toThrow('RUN_BUDGET_INSUFFICIENT');
    expect(() => resolveConfigs(['custom'], [{id: 'custom', model: 'm/x', route: 'r', effort: 'low',
      maxPrice: {prompt: 1, completion: 1}, runtimeRouting: true}])).toThrow('runtimeRouting is built-in only');
  });

  it.each(['c1', 'c2'] as const)('matches %s real frozen provider/reasoning and full normalized request bytes', async candidate => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const config = AGENT_TURN_CANDIDATES[candidate];
    const baseline = await capture(AGENT_TURN_CONFIG);
    expect(Array.isArray(baseline.body.messages.find((message: any) => message.role === 'assistant').content)).toBe(true);
    const providerLimits = {providerSlug: config.route, contextTokens: 100_000,
      promptUsdPerMillion: String(config.maxPrice.prompt), completionUsdPerMillion: String(config.maxPrice.completion), requestUsd: '0'};
    const quoted = openRouterBound(providerLimits, 8192);
    for (const kind of ['ask', 'text'] as const) {
      const actual = await capture(config, kind);
      expect(JSON.stringify(actual.body.provider)).toBe(JSON.stringify(quoted.routing));
      const reasoning = Object.fromEntries(Object.entries(actual.body).filter(([key]) => key === 'reasoning_effort' || key === 'reasoning'));
      expect(JSON.stringify(reasoning)).toBe(JSON.stringify(frozenReasoningFields({effort: 'low'})));
      expect(JSON.stringify(actual.body.tools)).toBe(JSON.stringify(baseline.body.tools));
      expect(actual.body.tools).toHaveLength(1);
      expect(actual.body.tools[0].function).toMatchObject({name: 'ask_question', strict: true});
      expect(actual.body.max_tokens).toBe(8192);
      expect(actual.body.provider).not.toHaveProperty('data_collection');
      expect(actual.body).not.toHaveProperty('parallel_tool_calls');
      const policy = {modelId: '00000000-0000-4000-8000-000000000001', provider: 'openrouter', account: 'synthetic',
        model: config.model, protocol: 'openrouter-chat-v1' as const, providerLimits, upperUsd: quoted.upperUsd,
        inputLimit: 100_000, outputLimit: 8192, automaticRetry: false as const, hiddenTools: false as const, lookupSupported: true};
      expect(openRouterRequestBody(actual.bytes, {context: {providerRequestFormat: 'agent-turn-v5-stream',
        tools: ['ask_question'], network: 'deny', reasoning: {effort: 'low'}}, policy, phase: 'primary', primaryDialogue: true}))
        .toBe(actual.bytes);
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
