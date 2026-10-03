/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC1-4 preparation only. Live execution still requires separate Owner approval.
import {tool} from '@openai/agents';
import {createRequire, registerHooks} from 'node:module';
import type * as Tools from '../../services/runtime/agentTools.ts';
import type * as Prompt from '../../services/opc/agentTurnPrompt.ts';
import type * as History from '../../services/runtime/openRouterHistory.ts';

let loaded: {tools: typeof Tools; prompt: typeof Prompt; history?: typeof History} | undefined;
/** Node's standalone strip-types entry needs explicit filenames. Resolve only
 * the fixed module graph below, then immediately remove the temporary hook.
 * History normalization is loaded only for candidate wire-byte alignment. */
function runtime(includeHistory = false) {
  if (loaded && (!includeHistory || loaded.history)) return loaded;
  const root = new URL('../../', import.meta.url);
  const known = new Map([
    'shared/agentTurn', 'shared/opcMethodPolicy', 'shared/modelReasoning', 'lib/logger',
    'services/runtime/agentTools', 'services/runtime/openRouterHistory', 'services/runtime/reasoningPolicy',
    'services/runtime/budget', 'services/runtime/timing', 'services/runtime/authReuse',
    'services/bill2/cacheMessages', 'services/bill2/openRouterAdapter', 'services/bill2/openRouterStream', 'services/bill2/openRouterPolicy',
    'services/bill2/openRouterEvidence', 'services/bill2/decimal', 'services/bill2/responseCapacity',
  ].map(path =>
    [new URL(path, root).href, new URL(path + '.ts', root).href]));
  const hook = registerHooks({resolve(specifier, context, next) {
    const mapped = context.parentURL && known.get(new URL(specifier, context.parentURL).href);
    return next(mapped || specifier, context);
  }});
  try {
    const require = createRequire(import.meta.url);
    loaded ??= {tools: require('../../services/runtime/agentTools.ts'), prompt: require('../../services/opc/agentTurnPrompt.ts')};
    if (includeHistory) loaded.history ??= require('../../services/runtime/openRouterHistory.ts');
    return loaded;
  } finally { hook.deregister(); }
}
import type {LoadedSkill, Scenario} from './skill.ts';
import type {ProbeConfig} from './config.ts';
import type {TrialResult} from './trial.ts';
import {stats} from './summary.ts';

export const AGENT_TURN_CONFIG: ProbeConfig = {
  id: 'ac14-deepseek-deepinfra-fp8-off', model: 'deepseek/deepseek-v4.1-flash',
  route: 'deepinfra/fp8', effort: 'none', maxPrice: {prompt: 0.3, completion: 0.9},
};

export type AgentTurnCandidate = 'c1' | 'c2' | 'c3' | 'c4';
/** C1/C2 (2026-09-29 comparison) keep 8192; C3/C4 leave room for low thinking at 4096. */
export const AGENT_TURN_CANDIDATE_MAX_TOKENS = 8192;
export const AGENT_TURN_CANDIDATE_TOKENS: Record<AgentTurnCandidate, number> = {c1: 8192, c2: 8192, c3: 4096, c4: 4096};
/** Candidates measured with the Owner card design (A12 B6 C12 D5 E5); C1/C2 keep their 30 + 10 design. */
export const CARD_DESIGN_CANDIDATES: ReadonlySet<AgentTurnCandidate> = new Set(['c3', 'c4']);
/** Offline preparation only; parse/buildPlan refuse --live for these fixed candidates. */
export const AGENT_TURN_CANDIDATES: Record<AgentTurnCandidate, ProbeConfig> = {
  c1: {id: 'ac14-c1-deepseek-deepinfra-low', model: 'deepseek/deepseek-v4.1-flash',
    route: 'deepinfra/fp8', effort: 'low', maxPrice: {prompt: 0.14, completion: 0.42},
    dataCollection: 'omit', runtimeRouting: true},
  c2: {id: 'ac14-c2-gemini-vertex-low', model: 'google/gemini-3.8-flash',
    route: 'google-vertex/global', effort: 'low', maxPrice: {prompt: 0.75, completion: 3.75},
    dataCollection: 'omit', runtimeRouting: true},
  // Catalog read 2026-09-29T16:10:25Z. Owner: compare these two, thinking on (lowest effort).
  // Sonnet 5.5 thinking is mandatory (low..max); GPT-6 Sol lists none..max.
  c3: {id: 'ac14-c3-claude-sonnet-anthropic-low', model: 'anthropic/claude-sonnet-5.5',
    route: 'anthropic', effort: 'low', maxPrice: {prompt: 2, completion: 10},
    dataCollection: 'omit', runtimeRouting: true},
  c4: {id: 'ac14-c4-gpt-sol-openai-low', model: 'openai/gpt-6-sol',
    route: 'openai', effort: 'low', maxPrice: {prompt: 2, completion: 10},
    dataCollection: 'omit', runtimeRouting: true},
};

/** Candidate-only byte alignment with the real v5 provider request; baseline probe history stays frozen. */
export function normalizeCandidateRequestHistory(request: {messages?: unknown}): void {
  const dependencies = runtime(true);
  dependencies.history!.normalizeOpenRouterHistory(request, dependencies.tools.AGENT_TOOL_NAMES);
}

export function agentTurnPrompt(skill: LoadedSkill, scenario: Scenario): string {
  const current = scenario.step === undefined ? undefined : skill.workflow?.[scenario.step];
  if (!current || !scenario.currentStepId || !scenario.questionId) throw new Error('PROBE_AGENT_TURN_CONTEXT_REQUIRED');
  const question = current.information?.find(field => field.id === scenario.questionId);
  if (!question) throw new Error('PROBE_AGENT_TURN_QUESTION_INVALID');
  const resources = current.resources.map(path => {
    const content = skill.references.get(path);
    if (content === undefined) throw new Error('PROBE_AGENT_TURN_RESOURCE_UNAVAILABLE');
    return {path, content};
  });
  return [skill.instructions, JSON.stringify({scopedMaterial: resources}), runtime().prompt.agentTurnInstructions({
    step: {id: scenario.currentStepId, title: current.title, schema: current.information ?? [], values: scenario.fieldValues},
    question, questionLabel: null, opening: scenario.opening ?? false,
    workflowContext: skill.workflow?.map((step, index) => ({index, title: step.title, information: step.information ?? []})),
  })].join('\n\n');
}

/** The runtime definition, including strict schema and invalid-result behavior. */
export function agentTurnTool(onExecute: () => void) {
  const definition = runtime().tools.askQuestionTool();
  return tool({name: definition.name, description: definition.description, parameters: definition.parameters!,
    errorFunction: () => definition.invalidResult!, execute: async (args, _context, details) => {
      onExecute();
      try { return await definition.execute(args, details?.toolCall?.callId ?? 'probe'); }
      catch { return definition.invalidResult!; }
    }});
}

/** Only SDK-visible bytes are filtered. The probe transport retains every original
 * tool call as evidence, exactly as the v5 runtime's first-call-only boundary does. */
export function firstCallOnly(response: Response): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let hasTool = false;
  let truncated = false;
  let done = false;
  const filter = (line: string) => {
    if (!line.startsWith('data:')) return line;
    if (line.slice(5).trim() === '[DONE]') { done = true; return ''; }
    const frame = JSON.parse(line.slice(5));
    const delta = frame.choices?.[0]?.delta;
    hasTool ||= Boolean(delta?.tool_calls?.length);
    truncated ||= frame.choices?.[0]?.finish_reason === 'length';
    if (Array.isArray(delta?.tool_calls)) {
      delta.tool_calls = delta.tool_calls.filter((call: {index: number}) => call.index === 0);
      if (!delta.tool_calls.length) delete delta.tool_calls;
    }
    // A cut-off tool response is never accepted as a valid card.
    return 'data: ' + JSON.stringify(frame);
  };
  const stream = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, {stream: true});
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        controller.enqueue(encoder.encode(filter(pending.slice(0, end).replace(/\r$/, '')) + '\n'));
        pending = pending.slice(end + 1);
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(filter(pending)));
      if (hasTool && truncated) throw new Error('RUNTIME_OUTPUT_TRUNCATED');
      if (done) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  }));
  return new Response(stream, {status: response.status, headers: response.headers});
}

/** The v5 card rules (including `recommended`) for the per-trial ask classification. */
export function agentTurnCardArgsValid(args: unknown): boolean {
  try {
    runtime().tools.questionCardToolResult(args);
    return true;
  } catch { return false; }
}

/** Called only after the SDK turn completes, never on a partial tool delta. */
export function agentTurnCardAvailable(output: string | undefined): boolean {
  return Boolean(runtime().tools.questionCardFromResult(output ?? ''));
}

/** AC1-4 latency contract; the older AC-0 summary keeps its existing statistics. */
export function agentTurnStats(values: Array<number | undefined>) {
  const sorted = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const rounded = (value: number | undefined) => value === undefined ? undefined : Math.round(value * 10) / 10;
  return {...stats(sorted), p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    min: rounded(sorted[0]), max: rounded(sorted.at(-1))};
}

export function agentTurnMeasurement(result: TrialResult) {
  const call = result.calls[0];
  const raw = call?.facts.toolCalls ?? [];
  const card = runtime().tools.questionCardFromResult(result.finalOutput ?? '');
  const content = call?.facts.content.trim() ?? '';
  let oldEnvelope = false;
  try {
    const candidate = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content)?.[1] ?? content;
    const value = JSON.parse(candidate);
    oldEnvelope = Boolean(value && typeof value === 'object' && ('message' in value || 'informationPatch' in value));
  } catch { /* public prose */ }
  const completed = (!result.stop || result.stop === 'sdk_error') && result.calls.length === 1 && call?.status === 'ok';
  const malformed = Boolean(result.sdkError) || raw.some(item => item.name !== 'ask_question') || raw.length > 0 && !card ||
    !content && !card || oldEnvelope || call?.facts.finishReason === 'length' && raw.length > 0;
  return {completed, formatError: completed && malformed,
    validCardCandidate: completed && !malformed && raw.length === 1 && Boolean(card),
    // Semantic relevance and recommendation quality require manual labels.
    semanticReview: 'pending' as const};
}

/** Owner card design (2026-09-29): fixed categories of the agent-turn baseline probe.
 * A and B expect a valid card (A recommends an option, B is neutral); C, D and E expect prose only. */
export const CARD_CATEGORIES = {
  A: {kind: 'ask', count: 12}, B: {kind: 'ask', count: 6},
  C: {kind: 'text', count: 12}, D: {kind: 'text', count: 5}, E: {kind: 'text', count: 5},
} as const;
export type CardCategory = keyof typeof CARD_CATEGORIES;

/** Fixed denominators: exactly the planned categories, no openings (they are admitted without the card tool). */
export function assertCardDesignScenarios(scenarios: readonly Scenario[]): void {
  for (const scenario of scenarios) {
    const category = scenario.category;
    if (!category || CARD_CATEGORIES[category].kind !== scenario.kind) throw new Error('PROBE_CARD_CATEGORY_INVALID: ' + scenario.id);
    if (scenario.opening) throw new Error('PROBE_CARD_OPENING_UNSUPPORTED: ' + scenario.id);
  }
  for (const [category, {count}] of Object.entries(CARD_CATEGORIES)) {
    if (scenarios.filter(scenario => scenario.category === category).length !== count) {
      throw new Error('PROBE_CARD_CATEGORY_COUNTS_FIXED: A12 B6 C12 D5 E5');
    }
  }
}

function cardDesignSummary(results: TrialResult[]) {
  const rows = results.map(result => {
    const measurement = agentTurnMeasurement(result);
    const card = runtime().tools.questionCardFromResult(result.finalOutput ?? '');
    const toolCalled = Boolean(result.calls[0]?.facts.toolCalls.length);
    // Owner rule: a card always follows prose; a card-only reply fails the card decision.
    const cardWithoutProse = toolCalled && !result.calls[0]!.facts.content.trim();
    const expectsCard = result.category === 'A' || result.category === 'B';
    const usable = measurement.completed && !measurement.formatError;
    const cardDecisionCorrect = usable && !cardWithoutProse && (expectsCard ? measurement.validCardCandidate : !toolCalled);
    const recommendationCorrect = expectsCard && measurement.validCardCandidate && Boolean(card) &&
      (result.category === 'A' ? card!.recommended !== null : card!.recommended === null);
    return {result, measurement, cardWithoutProse, cardDecisionCorrect, recommendationCorrect};
  });
  const completed = rows.filter(row => row.measurement.completed);
  const formatErrors = completed.filter(row => row.measurement.formatError).length;
  const byCategory = Object.fromEntries(Object.entries(CARD_CATEGORIES).map(([category, {count}]) => {
    const own = rows.filter(row => row.result.category === category);
    return [category, {planned: count, completed: own.filter(row => row.measurement.completed).length,
      cardDecisionCorrect: own.filter(row => row.cardDecisionCorrect).length,
      ...(category === 'A' || category === 'B' ? {recommendationCorrect: own.filter(row => row.recommendationCorrect).length} : {})}];
  }));
  const cardDecisionCorrect = rows.filter(row => row.cardDecisionCorrect).length;
  const cardWithoutProse = rows.filter(row => row.cardWithoutProse).length;
  const recommendationCorrect = rows.filter(row => row.recommendationCorrect).length;
  const failed = formatErrors > 1 || cardDecisionCorrect < 36 || recommendationCorrect < 17;
  return {design: 'owner-card-2026-09-29' as const, plannedTotal: 40, completed: completed.length, formatErrors,
    formatErrorRate: formatErrors / 40, cardDecisionCorrect, cardDecisionThreshold: 36, cardWithoutProse,
    recommendationCorrect, recommendationDenominator: 18, recommendationThreshold: 17, byCategory,
    verdict: completed.length !== 40 ? 'incomplete' : failed ? 'fail' : 'manual_review_required',
    semanticReview: 'Required (blind): 0 fabrications (invented user facts, unlabelled guesses) and 0 prose/card inconsistencies.',
    firstContentMs: agentTurnStats(completed.map(row => row.result.firstContentMs)),
    firstSdkTextMs: agentTurnStats(completed.map(row => row.result.firstSdkTextMs)),
    cardAvailableMs: agentTurnStats(completed.map(row => row.result.cardAvailableMs))};
}

export function agentTurnSummary(results: TrialResult[]) {
  return results.some(result => result.category) ? cardDesignSummary(results) : legacySummary(results);
}

/** The earlier 30 ask + 10 text design (rounds 1 and 2, candidates C1 and C2). */
function legacySummary(results: TrialResult[]) {
  const measured = results.map(result => ({result, measurement: agentTurnMeasurement(result)}));
  const completed = measured.filter(item => item.measurement.completed);
  const text = completed.filter(item => item.result.kind === 'text');
  const plainTextOnly = text.filter(item => !item.measurement.formatError &&
    !item.result.calls[0]!.facts.toolCalls.length).length;
  const unexpectedToolCalls = text.filter(item => item.result.calls[0]!.facts.toolCalls.length > 0).length;
  const errors = completed.filter(item => item.measurement.formatError).length;
  const askCandidates = measured.filter(item => item.result.kind === 'ask' && item.measurement.validCardCandidate).length;
  return {plannedAsk: 30, plannedTotal: 40, completed: completed.length, formatErrors: errors,
    // Diagnostic only: a valid card is displayable but violates a text sample's expectation.
    textCompliance: {planned: 10, completed: text.length, plainTextOnly, unexpectedToolCalls},
    formatErrorRate: errors / 40, validCardCandidates: askCandidates, candidateRate: askCandidates / 30,
    verdict: completed.length !== 40 ? 'incomplete' : errors > 1 || askCandidates < 27 ? 'fail' : 'manual_review_required',
    semanticReview: 'Required: label each of the 30 ask samples for relevance and useful grounded options; at least 27 must pass.',
    firstContentMs: agentTurnStats(completed.map(item => item.result.firstContentMs)),
    firstSdkTextMs: agentTurnStats(completed.map(item => item.result.firstSdkTextMs)),
    cardAvailableMs: agentTurnStats(completed.map(item => item.result.cardAvailableMs)),
    cardOnlyAvailableMs: agentTurnStats(completed.filter(item => item.result.firstSdkTextMs === undefined)
      .map(item => item.result.cardAvailableMs)),
    cardOnlyTrials: completed.filter(item => item.result.firstSdkTextMs === undefined &&
      item.result.cardAvailableMs !== undefined).length,
    firstTextMetric: 'firstSdkTextMs; card-only trials have no first text and stay counted separately'};
}

export function agentTurnMarkdown(results: TrialResult[], mode: string) {
  if (results.some(result => result.category)) {
    const summary = cardDesignSummary(results);
    const latency = (value: ReturnType<typeof agentTurnStats>) =>
      [value.median, value.p95, value.min, value.max].map(item => item ?? 'N/A').join(' / ') + ` (n=${value.n})`;
    return [`# AC1-4 card design probe (${mode})`, '',
      `Completed: ${summary.completed}/40; format errors: ${summary.formatErrors}/40 (max 1); verdict: ${summary.verdict}.`,
      `Card decision correct: ${summary.cardDecisionCorrect}/40 (at least 36); card-only replies without prose: ${summary.cardWithoutProse} (each fails).`,
      `Recommendation correct (A recommends, B neutral): ${summary.recommendationCorrect}/18 (at least 17).`,
      ...Object.entries(summary.byCategory).map(([category, value]) => `  ${category}: ${JSON.stringify(value)}`),
      `First SDK public text, median / p95 / min / max ms: ${latency(summary.firstSdkTextMs)}.`, '',
      summary.semanticReview, 'Rejections, timeouts and unknown results never reduce the fixed denominators.', ''].join('\n');
  }
  const summary = legacySummary(results);
  const latency = (value: ReturnType<typeof agentTurnStats>) =>
    [value.median, value.p95, value.min, value.max].map(item => item ?? 'N/A').join(' / ') + ` (n=${value.n})`;
  return [
    `# AC1-4 probe (${mode})`, '',
    `Completed: ${summary.completed}/40; valid card candidates: ${summary.validCardCandidates}/30 (semantic review pending).`,
    `Format errors: ${summary.formatErrors}/40; verdict: ${summary.verdict}.`,
    `Text samples: ${summary.textCompliance.plainTextOnly}/10 plain text only; ` +
      `${summary.textCompliance.unexpectedToolCalls} unexpected tool calls (diagnostic, no additional gate).`,
    `First provider content, median / p95 / min / max ms: ${latency(summary.firstContentMs)}.`,
    `First SDK public text, median / p95 / min / max ms: ${latency(summary.firstSdkTextMs)}.`,
    `Complete card available, median / p95 / min / max ms: ${latency(summary.cardAvailableMs)}.`,
    `Card-only trials: ${summary.cardOnlyTrials}; first text N/A; complete card timing: ${latency(summary.cardOnlyAvailableMs)}.`, '',
    summary.semanticReview,
    'Rejections, timeouts and unknown results never reduce the fixed denominators. No semantic pass is automatic.', '',
  ].join('\n');
}
