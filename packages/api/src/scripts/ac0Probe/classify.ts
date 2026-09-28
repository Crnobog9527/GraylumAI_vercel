/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {z} from 'zod';
import type {CallRecord} from './transport.ts';

/** The card the host would render: one question and a few suggested answers. */
export const askQuestionArgs = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(5),
}).strict();

export const askCategories = [
  'correct', 'malformed', 'text_question', 'no_question', 'turn_not_ended', 'provider_rejected', 'unknown', 'not_run',
] as const;
export type AskCategory = typeof askCategories[number];
export type AskOutcome = {
  category: AskCategory;
  toolCalled: boolean;
  argsValid: boolean;
  /** Whether the run stopped right after ask_question, with no further provider call. */
  turnEnded: boolean | null;
  textBeforeTool: boolean;
  detail?: string;
};

/** Classifies one ask trial from what the provider actually returned, not from
 * the SDK's reaction to it. text_question vs no_question uses a question mark
 * as a measurement heuristic only; the full output is kept for manual review. */
export function classifyAsk(calls: CallRecord[], sdkError: string | undefined, stop: string | undefined): AskOutcome {
  const base = {toolCalled: false, argsValid: false, turnEnded: null, textBeforeTool: false};
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
  const called = {...base, toolCalled: true, turnEnded, textBeforeTool: text.trim().length > 0};
  if (toolCalls.length > 1) return {...called, category: 'malformed', detail: 'multiple_tool_calls'};
  const call = toolCalls[0]!;
  if (call.name !== 'ask_question') return {...called, category: 'malformed', detail: 'wrong_tool'};
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return {...called, category: 'malformed', detail: 'invalid_json'};
  }
  if (!askQuestionArgs.safeParse(parsed).success) return {...called, category: 'malformed', detail: 'schema_mismatch'};
  if (!turnEnded) return {...called, argsValid: true, category: 'turn_not_ended'};
  return {...called, argsValid: true, category: 'correct'};
}
