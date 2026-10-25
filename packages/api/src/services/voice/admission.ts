/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { frozenPaygRunSchema, type BillingRpc, type FrozenCall, type FrozenPaygRun } from '../bill2/service';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';
import { RUNTIME_MODEL_COLUMNS, runtimeModelOption, type RuntimeModelRow } from '../models/runtimeEligibility';
import { openRouterAccount, readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { admissionDeadline } from '../runtime/admissionLimits';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { fitNativeRequestOutput, runtimePaygCall } from '../runtime/paygRuntime';
import { freezeStagingPaygPricing } from '../runtime/paygPricing';
import { readPaygPolicies, realContract } from '../runtime/realHost';
import { admitReasoning } from '../runtime/reasoningAdmission';
import { loadStagingPolicy, type StagingPolicy } from '../runtime/stagingPolicy';
import { derivedUuid } from '../fusion/admission';
import { fusionRequestBody } from '../fusion/request';
import { SUMMARY_MODEL_SETTING } from '../artifacts/summaryPolicy';
import { VOICE_INSTRUCTIONS, voiceInput, type VoiceMaterial } from './profile';

/** Master Plan 5.3 step 2: "整理模型读取语料". The generation runs on the administrator's summary (organizer) model under
 * its existing organizer billing profile: a plain system + user streamed request without tools, the organizer's request
 * format. One sessionless PAYG run with one call, like a Fusion member (no new billing purpose or configuration). */
export const VOICE_PHASE = 'organizer';
export const VOICE_REQUEST_FORMAT = 'serial-tools-v6-reasoning';
/** Room for the profile (~3k tokens of JSON) plus the model's reasoning. */
export const VOICE_OUTPUT_TOKENS = 8192;
const DISPATCH_MINUTES = 10;

export type AdmittedVoiceRun = { runId: string; body: string; call: FrozenCall; window: StagingPolicy };
type ModelRow = RuntimeModelRow & { provider: string; is_active: string; input_limit: number; max_tokens: number };

/** Freezes the exact request and its price, prepares the run (no hold yet: the claim holds). */
export async function admitVoiceRun(input: { admin: SupabaseClient; actorId: string; versionId: string;
  material: VoiceMaterial[]; env?: Record<string, string | undefined> }): Promise<AdmittedVoiceRun> {
  const { admin, actorId } = input;
  const env = input.env ?? process.env;
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
  const setting = await admin.from('system_settings').select('value').eq('key', SUMMARY_MODEL_SETTING).maybeSingle();
  const modelId = z.string().uuid().safeParse(setting.data?.value);
  if (setting.error || !modelId.success) throw new Error('VOICE_MODEL_NOT_CONFIGURED');
  const rows = await admin.from('ai_models').select(RUNTIME_MODEL_COLUMNS).eq('id', modelId.data).maybeSingle();
  if (rows.error || !rows.data) throw new Error('VOICE_MODEL_UNAVAILABLE');
  const row = rows.data as unknown as ModelRow;
  const deadline = new Date(Math.min(Date.now() + DISPATCH_MINUTES * 60_000, Date.parse(admissionDeadline(window.expiresAt)))).toISOString();
  // The same checks as a Fusion member (admitFusionModel), for the organizer purpose and format.
  if (row.is_active !== 'true' || !['openrouter', 'openai', 'anthropic'].includes(row.provider)) throw new Error('VOICE_MODEL_UNAVAILABLE');
  if (!isPlainOpenRouterModel(row.model_id)) throw new Error('VOICE_MODEL_UNAVAILABLE');
  const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
  if (!runtimeModelOption(row, 'organizer', key !== undefined).available) throw new Error('VOICE_MODEL_UNAVAILABLE');
  const quote = window.callPolicies.find(policy => policy.modelId === row.id);
  if (!quote || quote.account !== openRouterAccount(key ?? '') || quote.model !== row.model_id || !quote.providerLimits
    || !Number.isSafeInteger(row.input_limit) || row.input_limit < quote.providerLimits.contextTokens
    || !Number.isSafeInteger(row.max_tokens) || row.max_tokens < 1) throw new Error('VOICE_MODEL_UNAVAILABLE');
  const outputLimit = Math.min(VOICE_OUTPUT_TOKENS, row.max_tokens, quote.outputLimit, PURPOSE_OUTPUT_CAP);
  const reasoning = admitReasoning(row, 'organize', quote.providerLimits.providerSlug, outputLimit);
  const policies = await readPaygPolicies(window)(admin, window, [quote], [{ modelId: row.id, phase: VOICE_PHASE, outputLimit,
    reasoning, requestFormat: VOICE_REQUEST_FORMAT }], env, deadline);
  if (!policies?.[0]) throw new Error('VOICE_MODEL_UNAVAILABLE');
  const [policy] = await freezeStagingPaygPricing(admin, policies);
  const billingUnit = await freezeWindowBillingUnit(admin, window, [quote]);
  const rules: FrozenPaygRun['rules'] = { ...realContract(window).rules,
    creditsPerUsd: window.creditsPerUsd, multiplier: window.multiplier, fx: {}, billingUnit };
  const body = fitNativeRequestOutput(fusionRequestBody(policy!, { instructions: VOICE_INSTRUCTIONS,
    input: voiceInput(input.material) }, outputLimit, reasoning), policy!);
  const { call, upperCredits } = runtimePaygCall(body, VOICE_PHASE, policy!, rules, 1, true);
  delete call.runtimeEpoch; // A sessionless run has no runtime epoch.
  const draftId = await rpc<string>(admin, 'bill2_create_draft', { p_actor_id: actorId });
  // The frozen input names the version only; the request bytes are held by the call (requestHash) and the dispatch.
  const context = { version: 'runtime.v1', network: 'deny', tools: [], sources: [], voice: { versionId: input.versionId } };
  const payload = frozenPaygRunSchema.parse({ contractVersion: 'bill2.v2', ...realContract(window).host,
    scope: { kind: 'positioning_draft', draftId }, operation: 'question', modelId: row.id,
    sourceHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'), input: context, callPolicy: [policy], rules,
    limits: { costUsd: call.upperUsd, credits: 0, maxPreDeduct: upperCredits, maxCalls: 1, deadline } });
  const run = z.object({ id: z.string().uuid() }).passthrough().parse(await rpc(admin, 'bill2_prepare', { p_actor_id: actorId,
    p_request_id: derivedUuid(`voice-run:${input.versionId}`), p_payload: payload }));
  await rpc(admin, 'voice_generation_bind', { a: actorId, vid: input.versionId, run: run.id });
  return { runId: run.id, body, call, window };
}

async function rpc<T = unknown>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(/^(VOICE|BILL2|RUNTIME)_[A-Z_]+$/.test(message) ? message : 'VOICE_UNAVAILABLE');
  }
  return result.data as T;
}
