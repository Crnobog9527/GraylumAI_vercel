/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { RUNTIME_MODEL_COLUMNS, runtimeModelOption, type RuntimeModelRow } from '../models/runtimeEligibility';
import { openRouterAccount, readOpenRouterKey } from '../models/openRouterKey';
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { readPaygHostPolicies } from '../runtime/paygHostPolicy';
import { readPaygPolicies } from '../runtime/realHost';
import { admitReasoning } from '../runtime/reasoningAdmission';
import type { ReasoningPolicy } from '../runtime/reasoningPolicy';
import type { StagingPolicy } from '../runtime/stagingPolicy';

/** Fusion review calls: streamed, JSON-schema output, no tools, web plugin explicitly off. */
export const FUSION_REQUEST_FORMAT = 'fusion-json-v1-stream';
export type FusionPhase = 'fusion_review' | 'fusion_summary';
export type FusionModelRow = RuntimeModelRow & { provider: string; is_active: string; input_limit: number; max_tokens: number };
/** Includes the endpoint; the OpenRouter key is the platform secret (OR-1), checked here only and never returned. */
export const FUSION_MODEL_COLUMNS = RUNTIME_MODEL_COLUMNS;
type CallPolicy = z.infer<typeof frozenCallPolicy>;
/** The host profile entry, before admission freezes its current prices (freezeStagingPaygPricing). */
type HostPolicy = NonNullable<Awaited<ReturnType<typeof readPaygHostPolicies>>>[number];
export type AdmittedFusionModel = { quote: CallPolicy; policy: HostPolicy; outputLimit: number; reasoning: ReasoningPolicy };

/** One model for one Fusion purpose, against the staging window and the per-call billing profile.
 * A purpose without a profile entry, reasoning setting or quote is refused explicitly; nothing
 * falls back to another model or to ordinary chat settings. Built-in search models are refused
 * (FUSION-REVIEW §4.1), here and again on every request. */
export async function admitFusionModel(db: SupabaseClient, window: StagingPolicy, row: FusionModelRow,
  phase: FusionPhase, outputTokens: number, deadline: string, env: Record<string, string | undefined> = process.env,
  knownKey?: string | null,
): Promise<AdmittedFusionModel> {
  if (row.is_active !== 'true' || !['openrouter', 'openai', 'anthropic'].includes(row.provider)) {
    throw new Error('FUSION_MODEL_UNAVAILABLE');
  }
  if (!isPlainOpenRouterModel(row.model_id)) throw new Error('FUSION_MODEL_SEARCH_DENIED');
  // The stored transport must be able to dispatch (key, OpenRouter endpoint, id, limits, reasoning config),
  // and the key must be the one the window's quote is bound to, as stagingTransport checks at dispatch:
  // otherwise credits would be held for calls that can never be sent (#954 review).
  // Admission creates the runs and credit holds that dispatch (a fresh read) will check: read fresh here too, so a
  // cleared or replaced key is refused now instead of after holds were created. A caller that checks many models
  // without creating anything (the settings listing and save) reads once and passes it: string = the key, null = none.
  const key = knownKey === undefined ? await readOpenRouterKey(db, { fresh: true }).catch(() => undefined) : knownKey ?? undefined;
  if (!runtimeModelOption(row, 'organizer', key !== undefined).available) throw new Error('FUSION_MODEL_UNAVAILABLE');
  const quote = window.callPolicies.find(policy => policy.modelId === row.id);
  if (quote && quote.account !== openRouterAccount(key ?? '')) {
    throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
  }
  if (!quote || quote.model !== row.model_id || !quote.providerLimits
    || !Number.isSafeInteger(row.input_limit) || row.input_limit < quote.providerLimits.contextTokens
    || !Number.isSafeInteger(row.max_tokens) || row.max_tokens < 1) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
  const outputLimit = Math.min(outputTokens, row.max_tokens, quote.outputLimit, PURPOSE_OUTPUT_CAP);
  const reasoning = admitReasoning(row, phase === 'fusion_review' ? 'review' : 'writing',
    quote.providerLimits.providerSlug, outputLimit);
  const policies = await readPaygPolicies(window)(db, window, [quote], [{ modelId: row.id, phase, outputLimit, reasoning,
    requestFormat: FUSION_REQUEST_FORMAT }], env, deadline);
  if (!policies?.[0]) throw new Error('FUSION_PAYG_REQUIRED');
  return { quote, policy: policies[0], outputLimit, reasoning };
}
