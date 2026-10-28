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
import { isAdmittedRoute, matchedProfile, PAYG_PROFILE_MAX_BYTES, paygProductionSettings } from '../runtime/paygHostPolicy';
import { FREE_CHAT_REQUEST_FORMAT } from '../runtime/providerRequest';
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

/** What a quoted call is for: the profile must cover exactly this use (free chat by default; the mentor's Skill call and its
 * organizer use the agent-turn format, V2-5). outputCap: a lower output limit of that use (the organizer's summary limit). */
export type QuoteUse = { phase: 'ordinary' | 'skill' | 'attached_organizer'; requestFormat: string;
  purpose: 'interactive' | 'organize'; outputCap?: number };
const FREE_CHAT_USE: QuoteUse = { phase: 'ordinary', requestFormat: FREE_CHAT_REQUEST_FORMAT, purpose: 'interactive' };

export async function chatQuote(admin: SupabaseClient, input: { modelId: string; inputBytes: number; deps?: PricingDeps;
  use?: QuoteUse; /** The platform key this request already read fresh (a second quote in one request reads it once, OR-1). */ key?: string })
  : Promise<ChatQuote> {
  const use = input.use ?? FREE_CHAT_USE;
  const setting = await catalogRead(admin, 'settings', 'runtime-payg', () =>
    admin.from('system_settings').select('value').eq('key', RUNTIME_PAYG_SETTING).maybeSingle());
  const parsed = paygProductionSettings.safeParse(setting.error ? null : setting.data?.value);
  if (!parsed.success || !parsed.data.enabled) throw new QuoteError('TURN_PAYG_DISABLED');

  const row = await readAdmissionModel(admin, input.modelId);
  if (row.error || !row.data || row.data.is_active !== 'true') throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const model = row.data.model_id as string;
  const candidate = parsed.data.profiles.find(p => p.model === model && isAdmittedRoute(p.model, p.endpointTag));
  if (!candidate) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');

  let states;
  try { states = await readPricingStates(admin, [{ modelId: input.modelId, model }], input.deps, false, [row.data]); }
  catch { throw new QuoteError('TURN_PRICE_UNAVAILABLE'); }
  const state = states.get(input.modelId);
  if (!state) throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const { limits, nominal } = routeLimits(state.row as Row, state.snapshot, candidate.endpointTag);
  const outputLimit = admittedOutputLimit(candidate.outputLimit, row.data.max_tokens, use.outputCap);
  const reasoning = admitReasoning(row.data, use.purpose, limits.providerSlug, outputLimit);
  // The profile must cover this exact use, as admission checks it (paygHostPolicy.matchedProfile): the ordinary purpose, the
  // free-chat request format, this reasoning variant and output limit, and a context that holds bytes, template and output.
  // A profile approved for another use (e.g. Argon only for fusion_review) never admits a free chat.
  const profile = matchedProfile(parsed.data.profiles,
    { modelId: input.modelId, model, protocol: 'openrouter-chat-v1', providerLimits: limits } as Parameters<typeof matchedProfile>[1],
    [{ modelId: input.modelId, phase: use.phase, outputLimit, requestFormat: use.requestFormat, reasoning }]);
  if (!profile || profile.endpointTag !== candidate.endpointTag) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const upperUsd = openRouterBound(limits, outputLimit).upperUsd;

  let unit;
  try { unit = await readMultiplierSnapshot(admin, [input.modelId], undefined, { models: [row.data] }); }
  catch { throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE'); }
  const multiplier = unit.models[input.modelId]?.multiplier;
  if (!multiplier) throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE');

  const key = input.key ?? await readOpenRouterKeyOrUnset(admin, { fresh: true });
  if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
  return {
    modelId: input.modelId, model, q: unit.creditsPerUsd, multiplier, upperUsd, pricing: nominal, providerLimits: limits,
    identity: { provider: 'openrouter', account: openRouterAccount(key), model, protocol: 'openrouter-chat-v1',
      providerLimits: limits, outputLimit, upperUsd },
    reasoning,
    outputLimit, inputLimit: Math.min(input.inputBytes, PAYG_PROFILE_MAX_BYTES),
    concurrency: DEFAULT_MODEL_CONCURRENCY, credential: async () => key,
  };
}
