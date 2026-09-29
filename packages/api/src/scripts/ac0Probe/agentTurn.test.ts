/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {Agent, OpenAIChatCompletionsModel, Runner, tool} from '@openai/agents';
import OpenAI from 'openai';
import {askQuestionTool} from '../../services/runtime/agentTools';
import {AGENT_TURN_CONFIG, agentTurnMeasurement, agentTurnPrompt, agentTurnSummary, agentTurnStats, agentTurnMarkdown} from './agentTurn.ts';
import {createBudget, HARD_MAX_CALLS, memoryLedger} from './budget.ts';
import {buildPlan, parseProbeArgs} from './plan.ts';
import {sseResponse, textDeltas, toolDeltas} from './dryRun.ts';
import {runTrial, type TrialResult} from './trial.ts';
import type {LoadedSkill, Scenario} from './skill.ts';

const skill: LoadedSkill = {instructions: 'Synthetic workshop mentor', references: new Map([['references/guide.md', 'Ask for concrete audience constraints.']]), digest: 'synthetic',
  bytes: 25, isFixture: true, workflow: [{title: 'Workshop audience', resources: ['references/guide.md'],
    information: [{id: 'audience', title: 'Audience', required: true, elicitation: 'user_fact'}]}]};
const scenario: Scenario = {id: 'ask-1', kind: 'ask', history: [], input: 'I am not sure. Help me analyse.',
  step: 0, currentStepId: 'workshop-audience', questionId: 'audience'};
const card = {question: 'Which group do you want to help?', options: ['Neighbours', 'New volunteers']};
async function trial(kind: 'ask' | 'text', deltas: Record<string, unknown>[], finish = 'stop', clock = () => performance.now()) {
  const bodies: any[] = [];
  const result = await runTrial({agentTurn: true, kind, scenario: {...scenario, kind}, index: 0, skill,
    config: AGENT_TURN_CONFIG, maxTokens: 1024, timeoutMs: 5000,
    budget: createBudget({maxCalls: 1, maxUsd: 1, ledger: memoryLedger()}),
    upstream: async (_url, init) => { const body = JSON.parse(String(init.body)); bodies.push(body);
      return sseResponse(body.model, deltas, {finish}); },
    authorization: 'Bearer synthetic', clock, redact: text => text});
  return {result, bodies};
}

describe('AC1-4 prepared probe (synthetic transport only)', () => {
  it('reports p95 and extrema separately from p90, with N/A for missing first text', () => {
    expect(agentTurnStats([...Array.from({length: 20}, (_, i) => i + 1), undefined, NaN, Infinity, -1]))
      .toEqual({n: 20, median: 10.5, p90: 18, p95: 19, min: 1, max: 20});
    expect(agentTurnStats([undefined, NaN])).toEqual({n: 0, p95: undefined, min: undefined, max: undefined});
    expect(agentTurnMarkdown([], 'dry-run')).toContain('First SDK public text, median / p95 / min / max ms: N/A / N/A / N/A / N/A');
  });

  it('timestamps only a fully validated card after SDK completion, never partial tool arguments', async () => {
    let time = 0;
    const pureCard = await trial('ask', toolDeltas('ask_question', card), 'tool_calls', () => ++time);
    const {result} = pureCard;
    expect(result.firstSdkTextMs).toBeUndefined();
    expect(result.cardAvailableMs).toBeGreaterThan(result.calls[0].sentAtMs + result.calls[0].facts.firstToolMs!);
    expect(result.firstVisibleMs).toBe(result.cardAvailableMs);
    const summary = agentTurnSummary([result]);
    expect(summary.firstSdkTextMs.n).toBe(0);
    expect(summary.cardOnlyTrials).toBe(1);
    expect(summary.cardOnlyAvailableMs).toMatchObject({n: 1, min: result.cardAvailableMs, max: result.cardAvailableMs});
    const invalid = await trial('ask', toolDeltas('ask_question', {...card, options: ['same', 'same']}), 'tool_calls');
    expect(invalid.result.cardAvailableMs).toBeUndefined();
    expect(agentTurnSummary([invalid.result]).cardOnlyTrials).toBe(0);
    const text = await trial('text', textDeltas('Only text.'));
    expect(text.result.cardAvailableMs).toBeUndefined();
  });

  it('keeps the old cumulative cap and fixes forty calls, exact route, thinking off and a USD 1 run cap', () => {
    const args = parseProbeArgs(['--agent-turn'], '/synthetic-home');
    const scenarios = ['ask', 'text'].flatMap(kind => Array.from({length: kind === 'ask' ? 30 : 10}, (_, i) =>
      ({...scenario, id: kind + i, kind: kind as 'ask' | 'text'})));
    const plan = buildPlan(args, skill, scenarios, 'synthetic');
    expect(HARD_MAX_CALLS).toBe(453);
    expect(plan).toMatchObject({agentTurn: true, plannedCalls: 40, maxUsd: 1, configs: [AGENT_TURN_CONFIG]});
    expect(() => parseProbeArgs(['--agent-turn', '--configs', 'other'], '/synthetic')).toThrow('CONFIG_FIXED');
    expect(() => buildPlan({...args, counts: {...args.counts, text: 9}}, skill, scenarios, 's')).toThrow('PLAN_FIXED');
    expect(() => buildPlan(args, skill, [scenario], 's')).toThrow('DISTINCT_SCENARIOS');
    expect(agentTurnPrompt(skill, scenario)).toContain('Field roles for the current question:');
    expect(agentTurnPrompt(skill, scenario)).toContain('user_fact');
  });

  it('sends exactly the real strict tool schema on both ask and text trials', async () => {
    const ask = await trial('ask', [...textDeltas('Consider who benefits most.'), ...toolDeltas('ask_question', card)], 'tool_calls');
    const text = await trial('text', textDeltas('Start from concrete constraints.'));
    let actualTools: unknown;
    const definition = askQuestionTool();
    const client = new OpenAI({apiKey: 'synthetic', baseURL: 'http://127.0.0.1/synthetic', maxRetries: 0,
      fetch: async (_url, init) => {actualTools = JSON.parse(String(init?.body)).tools;
        return sseResponse(AGENT_TURN_CONFIG.model, textDeltas('done'));}});
    const model = new OpenAIChatCompletionsModel(client, AGENT_TURN_CONFIG.model, {strictFeatureValidation: true});
    const agent = new Agent({name: 'schema golden', model, tools: [tool({name: definition.name,
      description: definition.description, parameters: definition.parameters!, execute: async () => ''})]});
    const output = await new Runner({model, tracingDisabled: true}).run(agent, 'synthetic', {stream: true, maxTurns: 1});
    for await (const _ of output.toTextStream()) { /* drain synthetic stream */ }
    await output.completed;
    expect(JSON.stringify(ask.bodies[0].tools)).toBe(JSON.stringify(actualTools));
    expect(JSON.stringify(text.bodies[0].tools)).toBe(JSON.stringify(actualTools));
    expect(text.bodies[0]).toMatchObject({reasoning: {enabled: false}, provider: {only: ['deepinfra/fp8']}});
    expect(text.bodies[0]).not.toHaveProperty('parallel_tool_calls');
    expect(ask.result.askExecutions).toBe(1);
    expect(agentTurnMeasurement(ask.result)).toMatchObject({completed: true, validCardCandidate: true, formatError: false});
    expect(agentTurnMeasurement(text.result).formatError).toBe(false);
  });

  it('keeps raw multiple calls as evidence, executes just the first and rejects invalid card or old envelope', async () => {
    const deltas = toolDeltas('ask_question', card);
    deltas.push({tool_calls: [{index: 1, id: 'second', type: 'function', function: {name: 'ask_question', arguments: JSON.stringify(card)}}]});
    const multiple = await trial('ask', deltas, 'tool_calls');
    expect(multiple.result.askExecutions).toBe(1);
    expect(multiple.result.calls[0].facts.toolCalls).toHaveLength(2);
    expect(agentTurnMeasurement(multiple.result).validCardCandidate).toBe(false);
    const invalid = await trial('ask', toolDeltas('ask_question', {...card, options: ['Same', 'Same']}), 'tool_calls');
    expect(agentTurnMeasurement(invalid.result).formatError).toBe(true);
    const old = await trial('text', textDeltas(JSON.stringify({message: 'old payload'})));
    expect(agentTurnMeasurement(old.result).formatError).toBe(true);
    const fenced = await trial('text', textDeltas('```json\n' + JSON.stringify({message: 'old payload'}) + '\n```'));
    expect(agentTurnMeasurement(fenced.result).formatError).toBe(true);
  });

  it('does not execute a truncated tool and keeps fixed denominators with no automatic semantic pass', async () => {
    const cut = await trial('ask', toolDeltas('ask_question', card), 'length');
    expect(cut.result.askExecutions).toBe(0);
    expect(agentTurnMeasurement(cut.result).formatError).toBe(true);
    const good = (await trial('ask', toolDeltas('ask_question', card), 'tool_calls')).result;
    const forty: TrialResult[] = Array.from({length: 40}, (_, i) => ({...good, kind: i < 30 ? 'ask' : 'text'}));
    expect(agentTurnSummary(forty).verdict).toBe('manual_review_required');
    expect(agentTurnSummary(forty).textCompliance).toEqual({planned: 10, completed: 10, plainTextOnly: 0, unexpectedToolCalls: 10});
    expect(agentTurnSummary(forty.slice(0, 39))).toMatchObject({plannedAsk: 30, plannedTotal: 40, verdict: 'incomplete'});
    expect(agentTurnSummary([...forty.slice(2), cut.result, cut.result])).toMatchObject({formatErrors: 2, formatErrorRate: 0.05, verdict: 'fail'});
  });
});
