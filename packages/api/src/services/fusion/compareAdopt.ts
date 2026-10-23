/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { frozenPaygRunSchema, type BillingRpc, type FrozenPaygRun } from '../bill2/service';
import { admissionDeadline, admittedOutputLimit } from '../runtime/admissionLimits';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { runtimePaygCall } from '../runtime/paygRuntime';
import { freezeStagingPaygPricing } from '../runtime/paygPricing';
import { FREE_CHAT_REQUEST_FORMAT } from '../runtime/providerRequest';
import { readPaygPolicies, realContract } from '../runtime/realHost';
import { admitReasoning } from '../runtime/reasoningAdmission';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { compareRpc } from './compareAdmission';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow } from './models';
import { fusionRequestBody } from './request';

const uuid = z.string().uuid();
const cardSchema = z.object({ compareId: uuid, sessionId: uuid, question: z.string(), workspaceDependencies: z.array(z.unknown()),
  adoption: z.object({ requestId: uuid.optional(), column: z.number().int(), executionId: uuid }).passthrough().nullable().optional(),
  config: z.object({ skill: z.object({ moduleId: uuid, skillId: uuid, revisionId: uuid }).nullable().optional(),
    answerOutputTokens: z.number().int().positive().optional() }).passthrough() }).passthrough();
const readSchema = z.object({ sessionId: uuid, columns: z.array(z.object({ column: z.number().int(), modelId: uuid,
  body: z.string().nullable() }).passthrough()) }).passthrough();

export type AdoptResult = { state: 'adopted'; adoption: { executionId: string } & Record<string, unknown> } | { state: 'stale'; quote: string };

/** The zero-amount adoption run (FUSION-COMPARE §3.4): frozen like an ordinary turn of this conversation so the history
 * and its later permission checks treat the pair like any other turn. With a Skill the run carries the Skill identity and
 * the Skill's own model (the database checks both); without one it carries the chosen column's model. No call is ever
 * made on it: the database cancels and finalizes it at zero in the same transaction. */
async function adoptionRun(admin: SupabaseClient, actorId: string, card: z.infer<typeof cardSchema>, column: { modelId: string },
  sessionScope: unknown, env: Record<string, string | undefined>) {
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
  const deadline = admissionDeadline(window.expiresAt);
  const skill = card.config.skill ?? null;
  const module = skill ? await admin.from('modules').select('id,skill_id,model_id').eq('id', skill.moduleId).single() : null;
  // The module must still belong to the Skill frozen at start; a module re-bound to another Skill cannot take this adoption.
  if (module && (module.error || !module.data || String(module.data.skill_id) !== skill!.skillId)) throw new Error('FUSION_COMPARE_SKILL_MISMATCH');
  const modelId = module ? String(module.data!.model_id) : column.modelId;
  const rows = await admin.from('ai_models').select(FUSION_MODEL_COLUMNS).eq('id', modelId);
  const row = (rows.data as FusionModelRow[] | null)?.[0];
  if (rows.error || !row) throw new Error('FUSION_MODEL_UNAVAILABLE');
  let quote, policy, outputLimit, reasoning, phase: string;
  if (module) {
    // The Skill's own turn: the free-chat Skill purpose and request format, as an ordinary Skill turn freezes it.
    phase = 'skill';
    quote = window.callPolicies.find(p => p.modelId === modelId && p.model === row.model_id);
    if (!quote?.providerLimits) throw new Error('FUSION_MODEL_UNAVAILABLE');
    outputLimit = admittedOutputLimit(quote.outputLimit, row.max_tokens);
    reasoning = admitReasoning(row, 'interactive', quote.providerLimits.providerSlug, outputLimit);
    policy = (await readPaygPolicies(window)(admin, window, [quote], [{ modelId, phase: 'skill', outputLimit,
      requestFormat: FREE_CHAT_REQUEST_FORMAT, reasoning }], env, deadline))?.[0];
    if (!policy) throw new Error('FUSION_MODEL_UNAVAILABLE');
  } else {
    phase = 'fusion_compare';
    ({ quote, policy, outputLimit, reasoning } = await admitFusionModel(admin, window, row, 'fusion_compare',
      card.config.answerOutputTokens ?? 1024, deadline, env));
  }
  const [priced] = await freezeStagingPaygPricing(admin, [policy]);
  const billingUnit = await freezeWindowBillingUnit(admin, window, [quote]);
  const rules: FrozenPaygRun['rules'] = { ...realContract(window).rules,
    creditsPerUsd: window.creditsPerUsd, multiplier: window.multiplier, fx: {}, billingUnit };
  // Only the bound is used: it states what the run could cost if it ever called. It never claims, so nothing is held.
  const never = fusionRequestBody(priced!, { instructions: 'Adopted compare answer; never sent.', input: card.question }, outputLimit, reasoning);
  const { call, upperCredits } = runtimePaygCall(never, phase, priced!, rules, 1, true);
  return (columnIndex: number) => {
    const input = { version: 'runtime.v1', network: 'deny', tools: [], sources: [], input: card.question,
      dependencies: card.workspaceDependencies, fusionAdoption: { compareId: card.compareId, column: columnIndex } };
    return frozenPaygRunSchema.parse({ contractVersion: 'bill2.v2', ...realContract(window).host, scope: sessionScope,
      operation: 'question', modelId,
      ...(module ? { moduleId: skill!.moduleId, skillId: skill!.skillId, revisionId: skill!.revisionId } : {}),
      sourceHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), input, callPolicy: [priced],
      rules, limits: { costUsd: call.upperUsd, credits: 0, maxPreDeduct: upperCredits, maxCalls: 1, deadline } });
  };
}

/** "Use this answer": writes the question and the chosen column's saved answer into the main conversation, or hands back
 * a quote when the conversation moved on (the database decides, in one transaction under the session lock). Free. */
export async function adoptCompare(deps: { admin: SupabaseClient; actorId: string; env?: Record<string, string | undefined> },
  input: { compareId: string; column: number; requestId: string }): Promise<AdoptResult> {
  const { admin, actorId } = deps;
  const read = readSchema.parse(await compareRpc<unknown>(admin, 'fusion_compare_read', { p_actor_id: actorId, p_compare_id: input.compareId })
    ?? (() => { throw new Error('FUSION_COMPARE_DENIED'); })());
  const column = read.columns.find(c => c.column === input.column);
  if (!column?.body) throw new Error('FUSION_COMPARE_NOT_ADOPTABLE');
  const cards = z.array(cardSchema.passthrough()).parse(await compareRpc<unknown>(admin, 'fusion_compare_list',
    { p_actor_id: actorId, p_session_id: read.sessionId }));
  const card = cards.find(c => c.compareId === input.compareId);
  if (!card) throw new Error('FUSION_COMPARE_DENIED');
  // An adoption already written is answered from the stored record, with no staging window or billing needed: a retry whose
  // first response was lost gets the same result later, and a different request or column is refused as the database does.
  if (card.adoption) {
    if (card.adoption.requestId !== input.requestId) throw new Error('FUSION_COMPARE_ADOPTED');
    if (card.adoption.column !== input.column) throw new Error('FUSION_COMPARE_REQUEST_CONFLICT');
    return { state: 'adopted', adoption: card.adoption };
  }
  const session = await compareRpc<{ scope?: unknown }>(admin, 'runtime_session_context', { p_actor_id: actorId, p_session_id: read.sessionId });
  const run = await adoptionRun(admin, actorId, card, column, session.scope, deps.env ?? process.env);
  const items = [{ role: 'user', content: card.question },
    { role: 'assistant', content: [{ type: 'output_text', text: column.body }] }];
  return compareRpc<AdoptResult>(admin, 'fusion_compare_adopt', { p_actor_id: actorId, p_compare_id: input.compareId,
    p_column: input.column, p_request_id: input.requestId, p_billing: run(input.column), p_items: items });
}
