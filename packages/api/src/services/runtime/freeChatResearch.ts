/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT C (Owner 2026-10-17, questions 1-3 all A; docs/launch/tasks/CHAT-AUTO-CONTEXT.md §2.3, §6): a free chat
// reply may call the general research tools (social_search, social_account, web_search, web_fetch) up to three times,
// without asking first, billed per subcall like the positioning tools. Admission decides once and freezes it with the run:
// the admin switch, the research switches, vendor routes and prices (admitResearchTurn), three more tool rounds and model
// calls, the subcall allowance, and the 112000-byte input ceiling of a research turn. Without any of these the reply
// carries no research tool at all; nothing here can refuse the turn itself.
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimal } from '../bill2/decimal';
import type { FrozenPaygRun, FrozenRun } from '../bill2/service';
import { logger } from '../../lib/logger';
import { stagingRpcFailure } from './stagingErrors';
import { freezePaygMessageBudget } from './paygMessageBudget';
import { admitResearchTurn, RESEARCH_TURN_INPUT_BYTES, type ResearchAdmissionInput } from './researchAdmission';
import { FREE_CHAT_RESEARCH_CALLS, type FrozenResearchTurn } from './researchTurn';
import type { StagingPolicy } from './stagingPolicy';

/** Default off; the controller turns it on in staging after acceptance. */
export const CHAT_RESEARCH_KEY = 'chat_research_tools_enabled';
/** Frozen into the reply's instructions with the tools (the per-tool limits are in each tool description). */
export const FREE_CHAT_RESEARCH_INSTRUCTIONS = '\nResearch tools: when the answer needs current public data the user\'s own '
  + 'material lacks (an account\'s latest posts, recent posts for a keyword, a web page), look it up with the research tools '
  + 'instead of answering from memory. They cost the user credits, so look up only what this answer needs. '
  + 'If a lookup fails or returns nothing, say so plainly.';

export async function chatResearchEnabled(admin: SupabaseClient): Promise<boolean> {
  const rows = await admin.from('system_settings').select('key,value').in('key', [CHAT_RESEARCH_KEY]);
  if (rows.error) stagingRpcFailure(rows.error);
  const value = (rows.data ?? []).find(row => row.key === CHAT_RESEARCH_KEY)?.value;
  return value === true || value === 'true';
}

type FreeChatContext = Parameters<typeof freezePaygMessageBudget>[0] & {
  tools: string[]; instructions: string; research?: FrozenResearchTurn; sourceCalls?: 'first-call-v1';
  purposeBudget?: { purpose: string; inputBytes: number; historyItems: number };
};
const SCALE = 1_000_000_000_000n;
const usd = (value: bigint) => `${value / SCALE}.${(value % SCALE).toString().padStart(12, '0')}`;

/** true: the tools, calls and prices joined the context and run. false: nothing changed. */
export async function attachFreeChatResearch(input: {
  admin: SupabaseClient; real: StagingPolicy; context: FreeChatContext; billing: FrozenRun | FrozenPaygRun;
  /** Whether the required context still fits with these extra bytes (within `inputBytes` when given). */
  fits: (extraBytes: number, inputBytes?: number) => boolean;
}): Promise<boolean> {
  const { context, billing } = input;
  if (billing.contractVersion !== 'bill2.v2' || !await chatResearchEnabled(input.admin)) return false;
  const run = billing as FrozenPaygRun;
  const primary = run.callPolicy.find(policy => policy.modelId === context.modelId);
  if (!primary?.payg || !run.rules.billingUnit) return false;
  const slots = FREE_CHAT_RESEARCH_CALLS;
  // Each research round adds one tool call and the model call that reads it (freezePaygMessageBudget).
  if (2 + 4 * Math.min(context.maxToolCalls + slots, context.maxTurns + slots - 1) > primary.payg.maxMessages) return false;
  const budget = context.purposeBudget;
  const raised = budget?.purpose === 'interactive' && budget.inputBytes < RESEARCH_TURN_INPUT_BYTES ? RESEARCH_TURN_INPUT_BYTES : undefined;
  const instructionBytes = Buffer.byteLength(FREE_CHAT_RESEARCH_INSTRUCTIONS);
  const admission: ResearchAdmissionInput = {
    admin: input.admin, real: input.real, general: true, extraModelCalls: slots,
    modelCalls: run.limits.maxCalls, offeredTools: context.tools.length, maxTools: primary.payg.maxTools,
    defaultMultiplier: run.rules.billingUnit.defaultMultiplier, runMultiplier: run.rules.multiplier,
    deadline: run.limits.deadline, fits: extra => input.fits(extra + instructionBytes, raised),
    onRejected: rejection => logger.info('api', 'chat_research_not_attached', { reason: rejection.reason }),
  };
  const admitted = await admitResearchTurn(admission);
  if (!admitted) return false;
  context.tools.push(...admitted.tools);
  context.instructions += FREE_CHAT_RESEARCH_INSTRUCTIONS;
  context.maxTurns += slots;
  context.maxToolCalls += slots;
  context.research = admitted.research;
  // One tool call per response, the first (runner), like a reply that reads its sources.
  context.sourceCalls = 'first-call-v1';
  if (raised) budget!.inputBytes = raised;
  freezePaygMessageBudget(context, run.callPolicy);
  const toolUpper = admitted.policies.reduce((upper, policy) => decimal(policy.upperUsd) > upper ? decimal(policy.upperUsd) : upper, 0n);
  run.limits.costUsd = usd(decimal(run.limits.costUsd) + decimal(primary.upperUsd) * BigInt(slots)
    + toolUpper * BigInt(admitted.research.subcalls));
  run.limits.maxCalls += slots + admitted.research.subcalls;
  // The run stores tool prices beside its models (0255); TS readers split them with modelCallPolicies/toolCallPolicies.
  (run.callPolicy as unknown[]).push(...admitted.policies);
  run.rules.multiplier = admitted.policies.reduce((max, policy) =>
    decimal(policy.multiplier) > decimal(max) ? policy.multiplier : max, run.rules.multiplier);
  return true;
}
