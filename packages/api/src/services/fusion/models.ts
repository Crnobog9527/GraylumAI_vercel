/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { readPaygHostPolicies } from '../runtime/paygHostPolicy';
import { admitReasoning } from '../runtime/reasoningAdmission';
import type { ReasoningPolicy } from '../runtime/reasoningPolicy';
import type { StagingPolicy } from '../runtime/stagingPolicy';

/** Fusion review calls: streamed, JSON-schema output, no tools, web plugin explicitly off. */
export const FUSION_REQUEST_FORMAT = 'fusion-json-v1-stream';
export type FusionPhase = 'fusion_review' | 'fusion_summary';
export type FusionModelRow = { id: string; name: string; model_id: string; provider: string; is_active: string;
  input_limit: number; max_tokens: number; config: unknown };
export const FUSION_MODEL_COLUMNS = 'id,name,model_id,provider,is_active,input_limit,max_tokens,config';
type CallPolicy = z.infer<typeof frozenCallPolicy>;
/** The host profile entry, before admission freezes its current prices (freezeStagingPaygPricing). */
type HostPolicy = NonNullable<Awaited<ReturnType<typeof readPaygHostPolicies>>>[number];
export type AdmittedFusionModel = { row: FusionModelRow; quote: CallPolicy; policy: HostPolicy; outputLimit: number;
  reasoning: ReasoningPolicy };

/** One model for one Fusion purpose, against the staging window and the per-call billing profile.
 * A purpose without a profile entry, reasoning setting or quote is refused explicitly; nothing
 * falls back to another model or to ordinary chat settings. Built-in search models are refused
 * (FUSION-REVIEW §4.1), here and again on every request. */
export async function admitFusionModel(db: SupabaseClient, window: StagingPolicy, row: FusionModelRow,
  phase: FusionPhase, outputTokens: number, deadline: string, env: Record<string, string | undefined> = process.env,
): Promise<AdmittedFusionModel> {
  if (row.is_active !== 'true' || !['openrouter', 'openai', 'anthropic'].includes(row.provider)) {
    throw new Error('FUSION_MODEL_UNAVAILABLE');
  }
  if (!isPlainOpenRouterModel(row.model_id)) throw new Error('FUSION_MODEL_SEARCH_DENIED');
  const quote = window.callPolicies.find(policy => policy.modelId === row.id);
  if (!quote || quote.model !== row.model_id || !quote.providerLimits
    || !Number.isSafeInteger(row.input_limit) || row.input_limit < quote.providerLimits.contextTokens
    || !Number.isSafeInteger(row.max_tokens) || row.max_tokens < 1) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
  const outputLimit = Math.min(outputTokens, row.max_tokens, quote.outputLimit, PURPOSE_OUTPUT_CAP);
  const reasoning = admitReasoning(row, phase === 'fusion_review' ? 'review' : 'writing',
    quote.providerLimits.providerSlug, outputLimit);
  const policies = await readPaygHostPolicies(db, window, [quote], [{ modelId: row.id, phase, outputLimit, reasoning,
    requestFormat: FUSION_REQUEST_FORMAT }], env, deadline);
  if (!policies?.[0]) throw new Error('FUSION_PAYG_REQUIRED');
  return { row, quote, policy: policies[0], outputLimit, reasoning };
}
