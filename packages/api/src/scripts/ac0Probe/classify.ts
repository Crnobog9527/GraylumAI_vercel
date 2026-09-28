/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {z} from 'zod';
import type {CallRecord} from './transport.ts';
import type {RawToolCall} from './sse.ts';

/** The card the host would render: one question and a few suggested answers. */
export const askQuestionArgs = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(5),
}).strict();

export const askCategories = [
  'correct', 'malformed', 'multiple_calls', 'text_question', 'no_question', 'turn_not_ended', 'provider_rejected', 'unknown',
  'not_run',
] as const;
export type AskCategory = typeof askCategories[number];
export type AskOutcome = {
  category: AskCategory;
  toolCalled: boolean;
  argsValid: boolean;
  /** Whether the run stopped right after ask_question, with no further provider call. */
  turnEnded: boolean | null;
  textBeforeTool: boolean;
  /** Tool calls in the first response. */
  toolCallCount: number;
  /** For multiple_calls: whether the first call alone is a valid ask_question, i.e. "take the first" would work. */
  firstCallValidAsk?: boolean;
  detail?: string;
};

/** Why one call is not a valid ask_question, or undefined when it is. */
function askProblem(call: RawToolCall): string | undefined {
  if (call.name !== 'ask_question') return 'wrong_tool';
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return 'invalid_json';
  }
  return askQuestionArgs.safeParse(parsed).success ? undefined : 'schema_mismatch';
}

/** Classifies one ask trial from what the provider actually returned, not from
 * the SDK's reaction to it. text_question vs no_question uses a question mark
 * as a measurement heuristic only; the full output is kept for manual review. */
export function classifyAsk(calls: CallRecord[], sdkError: string | undefined, stop: string | undefined): AskOutcome {
  const base = {toolCalled: false, argsValid: false, turnEnded: null, textBeforeTool: false, toolCallCount: 0};
  const first = calls[0];
  if (!first) return {...base, category: stop === 'budget' ? 'not_run' : 'unknown', detail: stop ?? 'no_call'};
  if (first.status === 'rejected') return {...base, category: 'provider_rejected', detail: first.errorCode};
  if (first.status !== 'ok') return {...base, category: 'unknown', detail: first.errorCode};
  const toolCalls = first.facts.toolCalls;
  const text = first.facts.content;
  const turnEnded = calls.length === 1 && !/MaxTurnsExceeded/.test(sdkError ?? '');
  if (!toolCalls.length) {
    const category = /[?？]/.test(text) ? 'text_question' : 'no_question';
    return {...base, category, turnEnded};
  }
  const called = {...base, toolCalled: true, turnEnded, textBeforeTool: text.trim().length > 0, toolCallCount: toolCalls.length};
  // Counted apart from malformed: whether the host could keep only the first
  // call is an AC-1 design question this measurement has to answer.
  if (toolCalls.length > 1) {
    const firstProblem = askProblem(toolCalls[0]!);
    return {...called, category: 'multiple_calls', firstCallValidAsk: !firstProblem, ...(firstProblem ? {detail: firstProblem} : {})};
  }
  const problem = askProblem(toolCalls[0]!);
  if (problem) return {...called, category: 'malformed', detail: problem};
  if (!turnEnded) return {...called, argsValid: true, category: 'turn_not_ended'};
  return {...called, argsValid: true, category: 'correct'};
}
