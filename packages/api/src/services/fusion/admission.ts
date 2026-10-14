/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { frozenCallSchema, frozenPaygRunSchema, type BillingRpc, type FrozenCall, type FrozenPaygRun } from '../bill2/service';
import { assertFusionEntitlement, readMembershipEntitlements } from '../membershipEntitlements';
import { admissionDeadline } from '../runtime/admissionLimits';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { fitNativeRequestOutput, runtimePaygCall } from '../runtime/paygRuntime';
import { freezeStagingPaygPricing } from '../runtime/paygPricing';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow, type FusionPhase } from './models';
import { fusionRequestBody, type FusionRequest } from './request';
import { readFusionSettings } from './settings';

export type FusionMember = { modelId: string; phase: FusionPhase; request: FusionRequest };
export type AdmittedFusionRun = { runId: string; index: number; phase: FusionPhase; body: string; call: FrozenCall };
export type AdmittedFusionGroup = { groupId: string; replayed: boolean; runs: AdmittedFusionRun[] };
const uuid = z.string().uuid();
const admitted = z.object({ groupId: uuid, replayed: z.boolean(), runs: z.array(z.object({ runId: uuid,
  fusion: z.object({ index: z.number().int().min(0), phase: z.enum(['fusion_review', 'fusion_summary']),
    body: z.string().min(1), call: frozenCallSchema }).strict() }).strict()).min(1).max(16) }).strict();
/** Exact SQL refusals only; anything else is reported as unavailable, never with database detail. */
const refusals = new Set(['FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED',
  'REPORT_ENTITLEMENTS_UNAVAILABLE', 'FUSION_MODEL_DENIED', 'FUSION_BUDGET_EXCEEDED', 'FUSION_GROUP_INVALID',
  'FUSION_GROUP_CONFLICT', 'FUSION_GROUP_DENIED', 'BILL2_REQUEST_CONFLICT', 'RUNTIME_TEST_WINDOW_DENIED',
  'RUNTIME_TEST_MODEL_DENIED']);
/** A stable UUID derived from a seed (retries of the same step reuse the same request ids). */
export function derivedUuid(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const memberRequest = (requestId: string, index: number) => derivedUuid(`fusion-run:${requestId}:${index}`);

/** The frozen runs of an existing admission, without pricing anything; null when the request was never admitted. */
export async function replayFusionGroup(admin: SupabaseClient, actorId: string, requestId: string, sourceSessionId: string) {
  try {
    return toGroup(await rpc<unknown>(admin, 'fusion_group_admit', { p_actor_id: actorId, p_request_id: uuid.parse(requestId),
      p_kind: 'review', p_source_session_id: uuid.parse(sourceSessionId), p_runs: [] }));
  } catch (error) {
    if (error instanceof Error && error.message === 'FUSION_GROUP_INVALID') return null;
    throw error;
  }
}

/** Group admission (FUSION-REVIEW §2.1, §3.2). The host freezes each model's exact request and call;
 * the database (0235 fusion_group_admit) then rechecks the switch, membership, allowlist and group
 * budget in one transaction, creates the group and its runs, and replays the first admission for the
 * same request. The early checks here only give a clear reason before any work is frozen. */
export async function admitFusionGroup(input: { admin: SupabaseClient; actorId: string; requestId: string;
  sourceSessionId: string; members: FusionMember[]; env?: Record<string, string | undefined> }): Promise<AdmittedFusionGroup> {
  const { admin, actorId, members } = input;
  const env = input.env ?? process.env;
  if (!members.length || members.length > 16) throw new Error('FUSION_GROUP_INVALID');
  const groupArgs = { p_actor_id: actorId, p_request_id: uuid.parse(input.requestId), p_kind: 'review',
    p_source_session_id: uuid.parse(input.sourceSessionId) };
  // Replay first: the transaction answers an existing request before it reads any input, so a retried
  // request gets the first frozen runs without re-pricing or creating billing drafts.
  try { return toGroup(await rpc<unknown>(admin, 'fusion_group_admit', { ...groupArgs, p_runs: [] })); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'FUSION_GROUP_INVALID') throw error; }
  const settings = await readFusionSettings(admin);
  if (!settings.review.enabled) throw new Error('FUSION_REVIEW_DISABLED');
  assertFusionEntitlement(await readMembershipEntitlements(admin, actorId), 'review', members.length);
  for (const member of members) {
    const allowed = member.phase === 'fusion_review' ? settings.review.reviewerModelIds.includes(member.modelId)
      : settings.review.summaryModelId === member.modelId;
    if (!allowed) throw new Error('FUSION_MODEL_DENIED');
  }
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
  const rows = await admin.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', [...new Set(members.map(m => m.modelId))]);
  if (rows.error) throw new Error('FUSION_ADMISSION_UNAVAILABLE');
  const deadline = new Date(Math.min(Date.now() + settings.review.dispatchMinutes * 60_000,
    Date.parse(admissionDeadline(window.expiresAt)))).toISOString();
  const models = await Promise.all(members.map(member => {
    const row = (rows.data as FusionModelRow[]).find(candidate => candidate.id === member.modelId);
    if (!row) throw new Error('FUSION_MODEL_UNAVAILABLE');
    const tokens = member.phase === 'fusion_review' ? settings.review.opinionOutputTokens : settings.review.summaryOutputTokens;
    return admitFusionModel(admin, window, row, member.phase, tokens, deadline, env);
  }));
  const priced = await freezeStagingPaygPricing(admin, models.map(model => model.policy));
  const billingUnit = await freezeWindowBillingUnit(admin, window, models.map(model => model.quote));
  const rules: FrozenPaygRun['rules'] = { version: 'runtime-staging-v1', quoteVersion: window.id,
    creditsPerUsd: window.creditsPerUsd, multiplier: window.multiplier, fx: {}, billingUnit };
  const runs = await Promise.all(members.map(async (member, index) => {
    const policy = priced[index]!;
    const body = fitNativeRequestOutput(fusionRequestBody(policy, member.request, models[index]!.outputLimit,
      models[index]!.reasoning), policy);
    const { call, upperCredits } = runtimePaygCall(body, member.phase, policy, rules, 1, true);
    delete call.runtimeEpoch; // A sessionless run has no runtime epoch.
    const draftId = await rpc<string>(admin, 'bill2_create_draft', { p_actor_id: actorId });
    const context = { version: 'runtime.v1', network: 'deny', tools: [], sources: [],
      fusion: { index, phase: member.phase, body, call } };
    const payload = frozenPaygRunSchema.parse({ contractVersion: 'bill2.v2', mode: 'staging_test', testWindowId: window.id,
      scope: { kind: 'positioning_draft', draftId: uuid.parse(draftId) }, operation: 'question', modelId: member.modelId,
      sourceHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'), input: context, callPolicy: [policy], rules,
      limits: { costUsd: call.upperUsd, credits: 0, maxPreDeduct: upperCredits, maxCalls: 1, deadline } });
    return { requestId: memberRequest(input.requestId, index), payload };
  }));
  return toGroup(await rpc<unknown>(admin, 'fusion_group_admit', { ...groupArgs, p_runs: runs }));
}

function toGroup(value: unknown): AdmittedFusionGroup {
  const parsed = admitted.parse(value);
  return { groupId: parsed.groupId, replayed: parsed.replayed,
    runs: parsed.runs.map(({ runId, fusion }) => ({ runId, ...fusion })) };
}

async function rpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(refusals.has(message) ? message : 'FUSION_ADMISSION_UNAVAILABLE');
  }
  return result.data as T;
}
