/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { frozenCallSchema, frozenPaygRunSchema, type BillingRpc, type FrozenCall, type FrozenPaygRun } from '../bill2/service';
import { decimal } from '../bill2/decimal';
import { assertFusionEntitlement, readMembershipEntitlements } from '../membershipEntitlements';
import { admissionDeadline } from '../runtime/admissionLimits';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { fitNativeRequestOutput, runtimePaygCall } from '../runtime/paygRuntime';
import { freezeStagingPaygPricing } from '../runtime/paygPricing';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { derivedUuid } from './admission';
import { assertCompareFits } from './compareSnapshot';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow } from './models';
import { fusionRequestBody, type FusionRequest } from './request';
import { readFusionSettings, type FusionSettings } from './settings';

const uuid = z.string().uuid();
const PHASE = 'fusion_compare' as const;

/** One column of a compare: the exact frozen request for one model and what it may cost at most. */
export type CompareColumn = { index: number; modelId: string; body: string; call: FrozenCall; upperCredits: number; upperUsd: string;
  outputLimit: number; policy: FrozenPaygRun['callPolicy'][number] };
export type CompareAdmitted = { groupId: string; replayed: boolean; runs: Array<{ runId: string; index: number; body: string; call: FrozenCall }> };

/** Exact SQL refusals only; anything else is reported as unavailable, never with database detail. */
const refusals = new Set(['FUSION_COMPARE_DISABLED', 'FUSION_COMPARE_FORBIDDEN', 'FUSION_COMPARE_TOO_FEW', 'FUSION_COMPARE_TOO_MANY',
  'FUSION_COMPARE_MODEL_NOT_ALLOWED', 'FUSION_COMPARE_DENIED', 'FUSION_COMPARE_ENDED', 'FUSION_COMPARE_GATE_REQUIRED',
  'FUSION_COMPARE_ACTIVE', 'FUSION_COMPARE_BREAKER', 'FUSION_COMPARE_STALE', 'FUSION_COMPARE_SESSION_GONE',
  'FUSION_COMPARE_REQUEST_CONFLICT', 'FUSION_COMPARE_INVALID', 'FUSION_COMPARE_SOURCE_REVOKED', 'FUSION_COMPARE_SETTINGS_INVALID',
  'FUSION_COMPARE_CLAIM_INCOMPLETE', 'FUSION_COMPARE_NOT_CLAIMED', 'FUSION_COMPARE_ADOPTED', 'FUSION_COMPARE_NOT_ADOPTABLE',
  'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE', 'FUSION_BUDGET_EXCEEDED',
  'FUSION_GROUP_INVALID', 'FUSION_GROUP_CONFLICT', 'FUSION_GROUP_DENIED', 'BILL2_REQUEST_CONFLICT', 'RUNTIME_TEST_WINDOW_DENIED',
  'RUNTIME_TEST_MODEL_DENIED']);
export async function compareRpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(refusals.has(message) ? message : 'FUSION_ADMISSION_UNAVAILABLE');
  }
  return result.data as T;
}

/** The live rules every compare start checks before anything is priced (also for a replay: a request admitted while
 * the user waited may meet a switch, allowlist or membership that changed since). Reads the stored settings and the
 * membership facts of this moment; the database repeats them in its own transaction. */
export async function assertCompareAllowed(admin: SupabaseClient, actorId: string, modelIds: string[]): Promise<FusionSettings['compare']> {
  const settings = (await readFusionSettings(admin)).compare;
  if (!settings.enabled) throw new Error('FUSION_COMPARE_DISABLED');
  const entitlements = await readMembershipEntitlements(admin, actorId);
  if (!entitlements.allowFusionCompare) throw new Error('FUSION_COMPARE_FORBIDDEN');
  if (modelIds.length < settings.minModels) throw new Error('FUSION_COMPARE_TOO_FEW');
  if (modelIds.length > Math.min(entitlements.fusionCompareMaxModels, 8)) throw new Error('FUSION_COMPARE_TOO_MANY');
  if (new Set(modelIds).size !== modelIds.length || modelIds.some(id => !settings.allowedModelIds.includes(id))) {
    throw new Error('FUSION_COMPARE_MODEL_NOT_ALLOWED');
  }
  assertFusionEntitlement(entitlements, 'compare', modelIds.length);
  return settings;
}

/** Prices and freezes one request for every chosen model, in the user's order, without creating anything. A model that
 * cannot take the request whole (input over its profile or window, or the answer limit would have to shrink) is listed in
 * `tooLarge` and never silently shortened: the caller refuses the whole compare. */
export async function buildCompareColumns(input: { admin: SupabaseClient; actorId: string; modelIds: string[]; request: FusionRequest;
  answerTokens: number; dispatchMinutes: number; env?: Record<string, string | undefined> }) {
  const { admin, actorId, modelIds } = input;
  const env = input.env ?? process.env;
  assertCompareFits(input.request);
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
  const rows = await admin.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', [...new Set(modelIds)]);
  if (rows.error) throw new Error('FUSION_ADMISSION_UNAVAILABLE');
  const deadline = new Date(Math.min(Date.now() + input.dispatchMinutes * 60_000,
    Date.parse(admissionDeadline(window.expiresAt)))).toISOString();
  const admitted = await Promise.all(modelIds.map(modelId => {
    const row = (rows.data as FusionModelRow[]).find(candidate => candidate.id === modelId);
    if (!row) throw new Error('FUSION_MODEL_UNAVAILABLE');
    return admitFusionModel(admin, window, row, PHASE, input.answerTokens, deadline, env);
  }));
  const priced = await freezeStagingPaygPricing(admin, admitted.map(model => model.policy));
  const billingUnit = await freezeWindowBillingUnit(admin, window, admitted.map(model => model.quote));
  const rules: FrozenPaygRun['rules'] = { version: 'runtime-staging-v1', quoteVersion: window.id,
    creditsPerUsd: window.creditsPerUsd, multiplier: window.multiplier, fx: {}, billingUnit };
  const columns: CompareColumn[] = [];
  const tooLarge: string[] = [];
  modelIds.forEach((modelId, index) => {
    const policy = priced[index]!;
    try {
      // Every column gets the one frozen answer limit. A model whose own limit is lower would silently answer shorter
      // (admission clamps to it), so it cannot take this compare as configured.
      if (admitted[index]!.outputLimit !== input.answerTokens) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
      const raw = fusionRequestBody(policy, input.request, admitted[index]!.outputLimit, admitted[index]!.reasoning);
      const body = fitNativeRequestOutput(raw, policy);
      // fitNativeRequestOutput lowers the answer limit when the window is too small; every column keeps the same
      // frozen limit, so a changed body means this model cannot take the request as asked.
      if (body !== raw) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
      const { call, upperCredits } = runtimePaygCall(body, PHASE, policy, rules, 1, true);
      delete call.runtimeEpoch; // A sessionless run has no runtime epoch.
      columns.push({ index, modelId, body, call, upperCredits, upperUsd: call.upperUsd, outputLimit: admitted[index]!.outputLimit, policy });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'FUSION_COMPARE_INPUT_TOO_LARGE' || message === 'BILL2_INPUT_PROFILE_INVALID') tooLarge.push(modelId);
      else throw error;
    }
  });
  return { window, deadline, rules, columns, tooLarge,
    totalCredits: columns.reduce((sum, column) => sum + column.upperCredits, 0),
    totalUsd: columns.reduce((sum, column) => sum + decimal(column.upperUsd), 0n) };
}

const admittedSchema = z.object({ groupId: uuid, replayed: z.boolean(), runs: z.array(z.object({ runId: uuid,
  fusion: z.object({ index: z.number().int().min(0), phase: z.literal(PHASE), body: z.string().min(1), call: frozenCallSchema }).strict() })
  .strict()).min(1).max(16) }).strict();
const toAdmitted = (value: unknown): CompareAdmitted => {
  const parsed = admittedSchema.parse(value);
  return { groupId: parsed.groupId, replayed: parsed.replayed,
    runs: parsed.runs.map(({ runId, fusion }) => ({ runId, index: fusion.index, body: fusion.body, call: fusion.call })) };
};

/** The frozen runs of an existing compare admission; null when this request has no group yet. */
export async function replayCompareGroup(admin: SupabaseClient, actorId: string, requestId: string, sourceSessionId: string) {
  try {
    return toAdmitted(await compareRpc<unknown>(admin, 'fusion_group_admit', { p_actor_id: actorId, p_request_id: uuid.parse(requestId),
      p_kind: 'compare', p_source_session_id: uuid.parse(sourceSessionId), p_runs: [] }));
  } catch (error) {
    if (error instanceof Error && error.message === 'FUSION_GROUP_INVALID') return null;
    throw error;
  }
}

/** What the user agreed to, per column in the chosen order. The group may not hold more than this, in credits or provider
 * cost, in total or in any column, and must have exactly these columns. Checked before anything is recorded and again at
 * admission, so a forged or stale quote never reaches the paid positioning judgement. */
export type ShownQuote = { credits: number; columns: Array<{ modelId?: string; credits: number; usd: string }> };
export function assertQuoteCovers(columns: ReadonlyArray<Pick<CompareColumn, 'index' | 'modelId' | 'upperCredits' | 'upperUsd'>>,
  shown: ShownQuote) {
  const shownUsd = shown.columns.reduce((sum, column) => sum + decimal(column.usd), 0n);
  const credits = columns.reduce((sum, column) => sum + column.upperCredits, 0);
  const usd = columns.reduce((sum, column) => sum + decimal(column.upperUsd), 0n);
  if (shown.columns.length !== columns.length || credits > shown.credits || usd > shownUsd
    || columns.some(column => { const cap = shown.columns[column.index];
      return !cap || (cap.modelId !== undefined && cap.modelId !== column.modelId)
        || column.upperCredits > cap.credits || decimal(column.upperUsd) > decimal(cap.usd); })) {
    throw new Error('FUSION_COMPARE_PRICE_CHANGED');
  }
}

/** Compare group admission (FUSION-COMPARE §3.1). The compare record must already exist with its positioning verdict
 * written (fusion_compare_begin / fusion_compare_gate): the database refuses a group otherwise. `shown` is what the user
 * agreed to: the group may not hold more, in credits or in provider cost, and no column more than its own shown bound. */
export async function admitCompareGroup(input: { admin: SupabaseClient; actorId: string; requestId: string; sourceSessionId: string;
  modelIds: string[]; request: FusionRequest; env?: Record<string, string | undefined>;
  shown: ShownQuote }): Promise<CompareAdmitted> {
  const { admin, actorId } = input;
  const settings = await assertCompareAllowed(admin, actorId, input.modelIds);
  // A replay first: the transaction answers an existing request before it reads any input.
  const replay = await replayCompareGroup(admin, actorId, input.requestId, input.sourceSessionId);
  if (replay) return replay;
  const built = await buildCompareColumns({ admin, actorId, modelIds: input.modelIds, request: input.request,
    answerTokens: settings.answerOutputTokens, dispatchMinutes: settings.dispatchMinutes, env: input.env });
  if (built.tooLarge.length) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
  // Prices or multipliers changed since the user saw the estimate: never hold more than the maximum shown.
  assertQuoteCovers(built.columns, input.shown);
  const runs = await Promise.all(built.columns.map(async column => {
    const draftId = await compareRpc<string>(admin, 'bill2_create_draft', { p_actor_id: actorId });
    const context = { version: 'runtime.v1', network: 'deny', tools: [], sources: [],
      fusion: { index: column.index, phase: PHASE, body: column.body, call: column.call } };
    // No Skill identity and no session on the run: the columns use different models than a Skill's own, and
    // adoption writes through its own zero-amount run (FUSION-COMPARE §3.4).
    const payload = frozenPaygRunSchema.parse({ contractVersion: 'bill2.v2', mode: 'staging_test', testWindowId: built.window.id,
      scope: { kind: 'positioning_draft', draftId: uuid.parse(draftId) }, operation: 'question', modelId: column.modelId,
      sourceHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'), input: context, callPolicy: [column.policy],
      rules: built.rules,
      limits: { costUsd: column.call.upperUsd, credits: 0, maxPreDeduct: column.upperCredits, maxCalls: 1, deadline: built.deadline } });
    return { requestId: derivedUuid(`fusion-compare-run:${input.requestId}:${column.index}`), payload };
  }));
  return toAdmitted(await compareRpc<unknown>(admin, 'fusion_group_admit', { p_actor_id: actorId,
    p_request_id: uuid.parse(input.requestId), p_kind: 'compare', p_source_session_id: uuid.parse(input.sourceSessionId), p_runs: runs }));
}
