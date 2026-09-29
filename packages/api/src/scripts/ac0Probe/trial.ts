/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {Agent, OpenAIChatCompletionsModel, Runner, tool, type AgentInputItem} from '@openai/agents';
import OpenAI from 'openai';
import {agentTurnCardAvailable, agentTurnPrompt, agentTurnTool, firstCallOnly} from './agentTurn.ts';
import {z} from 'zod';
import type {Budget} from './budget.ts';
import type {ProbeConfig} from './config.ts';
import {askQuestionArgs, classifyAsk, type AskOutcome} from './classify.ts';
import {readReference, stepRules, type LoadedSkill, type Scenario} from './skill.ts';
import {LOCAL_BASE_URL, probeTransport, type CallRecord, type Upstream} from './transport.ts';

const readReferenceArgs = z.object({path: z.string().min(1).max(512)}).strict();

/** Probe host rules. Not Skill content; the Skill text follows them. */
const HOST_RULES = [
  'You are the Graylum mentor. Follow the Skill below to guide the user step by step.',
  'Reply in natural language. Never wrap your reply in JSON.',
  'When you need information from the user, call ask_question once with one main question and 2 to 5 short suggested answers.',
  'Do not also write that question in your reply text. Ask at most one question per turn.',
].join('\n');
const REFERENCE_RULE = 'Before you give guidance for a step, call read_reference with the path of that step\'s reference file from the Skill.';

export type TrialKind = Scenario['kind'];
export type TrialResult = {
  configId: string;
  kind: TrialKind;
  scenarioId: string;
  index: number;
  startedAt: string;
  outcome?: AskOutcome;
  /** Set when the trial could not produce a measurement. */
  stop?: 'budget' | 'provider_rejected' | 'unknown_result' | 'sdk_error';
  budgetStop?: string;
  httpStatus?: number;
  sdkError?: string;
  totalMs: number;
  /** First provider content delta, measured from trial start. */
  firstContentMs?: number;
  /** First text delta the SDK emitted to the caller, from trial start. */
  firstSdkTextMs?: number;
  /** AC1-4 only: valid complete card after SDK completion, not tool-argument start. */
  cardAvailableMs?: number;
  /** First visible element (text or tool-call start), from trial start. */
  firstVisibleMs?: number;
  contentChars: number;
  /** Characters per second between the first and last content delta. */
  charsPerSecond?: number;
  reasoningSeen: boolean;
  reasoningTokens?: number;
  referenceReads: number;
  /** ask_question executions by the SDK; above 1 shows what stopAtToolNames did with several calls in one turn. */
  askExecutions: number;
  finalOutput?: string;
  expectStepComplete?: boolean;
  calls: CallRecord[];
};

/** What the ask_question tool returns; history replays the same result. */
const askCard = (args: z.infer<typeof askQuestionArgs>) => JSON.stringify({card: 'question', ...args});

export function historyItems(scenario: Scenario): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  scenario.history.forEach((message, position) => {
    if (message.role === 'user') {
      items.push({role: 'user', content: message.content});
      return;
    }
    if (message.content) {
      items.push({role: 'assistant', status: 'completed', content: [{type: 'output_text', text: message.content}]});
    }
    if ('askQuestion' in message) {
      // The chat converter merges this into the preceding assistant message as tool_calls,
      // then sends the result as a tool message: the shape a stored question card has.
      const callId = `call_history_${position}`;
      items.push({type: 'function_call', callId, name: 'ask_question', arguments: JSON.stringify(message.askQuestion),
        status: 'completed'});
      items.push({type: 'function_call_result', callId, name: 'ask_question', status: 'completed',
        output: askCard(message.askQuestion)});
    }
  });
  items.push({role: 'user', content: scenario.input});
  return items;
}

const codePoints = (text: string) => [...text].length;

export async function runTrial(options: {
  agentTurn?: boolean;
  kind: TrialKind;
  scenario: Scenario;
  index: number;
  config: ProbeConfig;
  skill: LoadedSkill;
  maxTokens: number;
  timeoutMs: number;
  budget: Budget;
  upstream: Upstream;
  authorization: string;
  clock: () => number;
  redact: (text: string) => string;
}): Promise<TrialResult> {
  const {kind, scenario, config} = options;
  const trialStart = options.clock();
  const transport = probeTransport({...options, trialStart});
  const client = new OpenAI({
    apiKey: 'ac0-local-only', baseURL: LOCAL_BASE_URL,
    fetch: options.agentTurn ? async (url, init) => firstCallOnly(await transport.fetch(url, init)) : transport.fetch,
    maxRetries: 0, timeout: options.timeoutMs + 5_000,
  });
  const model = new OpenAIChatCompletionsModel(client, config.model, {strictFeatureValidation: true});
  let referenceReads = 0;
  let askExecutions = 0;
  const ask = tool({
    name: 'ask_question',
    description: 'Show the user one question card with suggested answers. Ends your turn.',
    parameters: askQuestionArgs, errorFunction: null,
    execute: async args => {
      askExecutions += 1;
      return askCard(args);
    },
  });
  const read = tool({
    name: 'read_reference',
    description: 'Read one reference file of the current Skill by its relative path. Read-only.',
    parameters: readReferenceArgs, errorFunction: null,
    execute: async args => {
      referenceReads += 1;
      return readReference(options.skill, args.path);
    },
  });
  const tools = options.agentTurn ? [agentTurnTool(() => { askExecutions += 1; })]
    : kind === 'text' ? [] : kind === 'ask' ? [ask] : [read, ask];
  const instructions = options.agentTurn ? agentTurnPrompt(options.skill, scenario)
    : [HOST_RULES, kind === 'reference' ? REFERENCE_RULE : '', stepRules(options.skill, scenario.step),
      '# Skill', options.skill.instructions].filter(Boolean).join('\n\n');
  const agent = new Agent({
    name: 'AC-0 probe mentor', model, instructions, tools,
    toolUseBehavior: !options.agentTurn && kind === 'text' ? 'run_llm_again' : {stopAtToolNames: ['ask_question']},
    // No parallelToolCalls: no catalogued route of the probed models declares
    // parallel_tool_calls, so with require_parameters every route was ineligible
    // (404). Several tool calls in one turn are counted instead (classify.ts).
    // A reasoning object travels as provider data; the SDK sends only effort itself.
    modelSettings: {store: false, maxTokens: options.maxTokens, retry: {maxRetries: 0},
      ...(config.reasoning ? {providerData: {reasoning: config.reasoning}} : {reasoning: {effort: config.effort}})},
  });
  const runner = new Runner({model, tracingDisabled: true, traceIncludeSensitiveData: false});
  // One turn for ask trials: if the SDK tried to continue after ask_question,
  // maxTurns stops it before a second provider call and the trial records it.
  const maxTurns = kind === 'reference' ? 3 : 1;
  let firstSdkTextMs: number | undefined;
  let cardAvailableMs: number | undefined;
  let finalOutput: string | undefined;
  let sdkError: string | undefined;
  try {
    const result = await runner.run(agent, historyItems(scenario), {stream: true, maxTurns});
    for await (const text of result.toTextStream()) {
      if (text) firstSdkTextMs ??= options.clock() - trialStart;
    }
    await result.completed;
    finalOutput = typeof result.finalOutput === 'string' ? result.finalOutput : undefined;
    if (options.agentTurn && agentTurnCardAvailable(finalOutput)) cardAvailableMs = options.clock() - trialStart;
  } catch (error) {
    sdkError = error instanceof Error ? error.constructor.name + ': ' + options.redact(error.message).slice(0, 200) : 'unknown';
  } finally {
    transport.close();
  }
  const totalMs = options.clock() - trialStart;
  const calls = transport.records;
  const content = calls.map(call => call.facts.content).join('');
  const firstContent = calls.find(call => call.facts.firstContentMs !== undefined);
  const lastContent = [...calls].reverse().find(call => call.facts.lastContentMs !== undefined);
  const firstContentMs = firstContent ? firstContent.sentAtMs + firstContent.facts.firstContentMs! : undefined;
  const lastContentMs = lastContent ? lastContent.sentAtMs + lastContent.facts.lastContentMs! : undefined;
  // read_reference is invisible to the user; only text or the question card count.
  const askCall = calls.find(call => call.facts.toolCalls.some(toolCall => toolCall.name === 'ask_question'));
  const firstAskMs = askCall?.facts.firstToolMs !== undefined ? askCall.sentAtMs + askCall.facts.firstToolMs : undefined;
  const visibleTimes = options.agentTurn ? [firstSdkTextMs, cardAvailableMs] : [firstContentMs, firstAskMs];
  const firstVisible = visibleTimes.filter((value): value is number => value !== undefined);
  const chars = codePoints(content);
  const window = firstContentMs !== undefined && lastContentMs !== undefined ? lastContentMs - firstContentMs : 0;
  const reasoningTokens = calls.reduce((sum, call) => sum + (call.facts.usage?.reasoningTokens ?? 0), 0);
  const stop = transport.state.budgetStop ? 'budget'
    : transport.state.stopped === 'provider_rejected' ? 'provider_rejected'
      : transport.state.stopped === 'unknown_result' ? 'unknown_result'
        : sdkError ? 'sdk_error' : undefined;
  return {
    configId: config.id, kind, scenarioId: scenario.id, index: options.index, startedAt: new Date().toISOString(),
    ...(kind === 'ask' ? {outcome: classifyAsk(calls, sdkError, stop)} : {}),
    ...(stop ? {stop} : {}),
    ...(transport.state.budgetStop ? {budgetStop: transport.state.budgetStop} : {}),
    ...(transport.state.httpStatus !== null ? {httpStatus: transport.state.httpStatus} : {}),
    ...(sdkError ? {sdkError} : {}),
    totalMs, firstContentMs, firstSdkTextMs,
    ...(options.agentTurn && cardAvailableMs !== undefined ? {cardAvailableMs} : {}),
    firstVisibleMs: firstVisible.length ? Math.min(...firstVisible) : undefined,
    contentChars: chars,
    charsPerSecond: window > 0 ? chars / (window / 1000) : undefined,
    reasoningSeen: calls.some(call => call.facts.firstReasoningMs !== undefined) || reasoningTokens > 0,
    reasoningTokens: calls.some(call => call.facts.usage?.reasoningTokens !== undefined) ? reasoningTokens : undefined,
    referenceReads, askExecutions, finalOutput,
    ...(scenario.expectStepComplete !== undefined ? {expectStepComplete: scenario.expectStepComplete} : {}),
    calls,
  };
}
