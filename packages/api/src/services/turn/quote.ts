/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveFrozenPrices, deriveListPrices } from '../../shared/modelPriceBound';
import { validateNominalBound, type NominalPricing } from '../../shared/nominalPricing';
import { openRouterBound, type OpenRouterLimits } from '../bill2/openRouterPolicy';
import { readMultiplierSnapshot } from '../billingUnit';
import { openRouterAccount, readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { readAdmissionModel } from '../runtime/admissionConfiguration';
import { admittedOutputLimit } from '../runtime/admissionLimits';
import { catalogRead } from '../runtime/catalogCache';
import { isAdmittedRoute, PAYG_PROFILE_MAX_BYTES, paygProductionSettings } from '../runtime/paygHostPolicy';
import { pricingEndpoint, readPricingStates, type PricingDeps } from '../runtime/pricingAdmission';
import { admitReasoning } from '../runtime/reasoningAdmission';
import type { ReasoningPolicy } from '../runtime/reasoningPolicy';
import type { ModelCall } from './call';

/*
 * CORE-PATH-V2 2.8 (Fable 10-28): one quote path for staging and production, no test window, no environment branch. The route
 * profiles live in one settings key, runtime_payg (the shape of runtime_payg_production without window or expiry); a missing
 * key or enabled:false refuses the turn and never falls back to an older path. Every price comes from the model's stored
 * OpenRouter price snapshot (renewed first when older than seven days, the existing rule); q and m from the billing unit.
 * Settings, model rows and snapshots are catalog reads (catalogCache); the platform key is read fresh every time (OR-1).
 */
export const RUNTIME_PAYG_SETTING = 'runtime_payg';
/** In-flight calls per model across instances until the catalog carries a per-model value (3.3.2 item 10). */
export const DEFAULT_MODEL_CONCURRENCY = 20;

export class QuoteError extends Error {
  constructor(readonly code: 'TURN_PAYG_DISABLED' | 'TURN_MODEL_NOT_ADMITTED' | 'TURN_PRICE_UNAVAILABLE' | 'TURN_PROVIDER_KEY_UNAVAILABLE'
    | 'TURN_BILLING_UNIT_UNAVAILABLE') { super(code); }
}

export type ChatQuote = ModelCall & {
  model: string; q: string; reasoning: ReasoningPolicy; outputLimit: number; inputLimit: number;
  providerLimits: OpenRouterLimits; credential: () => Promise<string>;
};

type Row = { id: string; model_id: string; config: unknown; updated_at: string; is_active?: unknown; max_tokens?: unknown };

/** The OpenRouter limits of one admitted route, from the snapshot endpoint whose tag is the profile's (as production today). */
function routeLimits(row: Row, snapshot: Parameters<typeof pricingEndpoint>[1], endpointTag: string) {
  const probe = { modelId: row.id, model: row.model_id, providerLimits: { providerSlug: endpointTag, contextTokens: 1,
    promptUsdPerMillion: '0', completionUsdPerMillion: '0', requestUsd: '0' } };
  const endpoint = pricingEndpoint(row, snapshot, probe);
  if (!endpoint.contextLength) throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const prices = deriveFrozenPrices(row.model_id, endpoint, endpoint.contextLength);
  const nominal = deriveListPrices(endpoint, snapshot.pricingHash, row.model_id);
  if (typeof prices === 'string' || typeof nominal === 'string') throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const limits: OpenRouterLimits = { providerSlug: endpointTag, contextTokens: endpoint.contextLength,
    promptUsdPerMillion: prices.promptUsdPerMillion, completionUsdPerMillion: prices.completionUsdPerMillion, requestUsd: prices.requestUsd,
    ...(prices.cacheWriteUsdPerMillion !== undefined ? { cacheWriteUsdPerMillion: prices.cacheWriteUsdPerMillion } : {}) };
  validateNominalBound(nominal, { ...limits, promptTokensUpper: limits.contextTokens, pricingHash: snapshot.pricingHash,
    endpointTag: endpoint.tag });
  return { limits, nominal: nominal as NominalPricing };
}

export async function chatQuote(admin: SupabaseClient, input: { modelId: string; inputBytes: number; deps?: PricingDeps }): Promise<ChatQuote> {
  const setting = await catalogRead(admin, 'settings', 'runtime-payg', () =>
    admin.from('system_settings').select('value').eq('key', RUNTIME_PAYG_SETTING).maybeSingle());
  const parsed = paygProductionSettings.safeParse(setting.error ? null : setting.data?.value);
  if (!parsed.success || !parsed.data.enabled) throw new QuoteError('TURN_PAYG_DISABLED');

  const row = await readAdmissionModel(admin, input.modelId);
  if (row.error || !row.data || row.data.is_active !== 'true') throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const model = row.data.model_id as string;
  const profile = parsed.data.profiles.find(p => p.model === model && isAdmittedRoute(p.model, p.endpointTag));
  if (!profile) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');

  let states;
  try { states = await readPricingStates(admin, [{ modelId: input.modelId, model }], input.deps, false, [row.data]); }
  catch { throw new QuoteError('TURN_PRICE_UNAVAILABLE'); }
  const state = states.get(input.modelId);
  if (!state) throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const { limits, nominal } = routeLimits(state.row as Row, state.snapshot, profile.endpointTag);
  const outputLimit = admittedOutputLimit(profile.outputLimit, row.data.max_tokens);
  const upperUsd = openRouterBound(limits, outputLimit).upperUsd;

  let unit;
  try { unit = await readMultiplierSnapshot(admin, [input.modelId], undefined, { models: [row.data] }); }
  catch { throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE'); }
  const multiplier = unit.models[input.modelId]?.multiplier;
  if (!multiplier) throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE');

  const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
  if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
  return {
    modelId: input.modelId, model, q: unit.creditsPerUsd, multiplier, upperUsd, pricing: nominal, providerLimits: limits,
    identity: { provider: 'openrouter', account: openRouterAccount(key), model, protocol: 'openrouter-chat-v1',
      providerLimits: limits, outputLimit, upperUsd },
    reasoning: admitReasoning(row.data, 'interactive', limits.providerSlug, outputLimit),
    outputLimit, inputLimit: Math.min(input.inputBytes, PAYG_PROFILE_MAX_BYTES),
    concurrency: DEFAULT_MODEL_CONCURRENCY, credential: async () => key,
  };
}
