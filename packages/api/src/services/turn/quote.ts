/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { deriveFrozenPrices, deriveListPrices } from '../../shared/modelPriceBound';
import { validateNominalBound, type NominalPricing } from '../../shared/nominalPricing';
import { openRouterBound, openRouterCallBound, type OpenRouterLimits } from './provider/openRouterPolicy';
import { readMultiplierSnapshot } from '../billingUnit';
import { openRouterAccount, readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { readAdmissionModel } from './admission/admissionConfiguration';
import { rowFor, type ConfigurationRows } from './settings/settingsRows';
import { RUNTIME_PAYG_SETTING } from './settingKeys';
import { admittedOutputLimit } from './admission/admissionLimits';
import { isAdmittedRoute, matchedProfile, PAYG_PROFILE_MAX_BYTES, paygProductionSettings } from './admission/paygHostPolicy';
import { FREE_CHAT_REQUEST_FORMAT } from './provider/providerRequest';
import { pricingEndpoint, readPricingStates, type PricingDeps } from './admission/pricingAdmission';
import { admitReasoning } from './admission/reasoningAdmission';
import type { ReasoningPolicy } from './admission/reasoningPolicy';
import type { ModelCall } from './call';
import type { PaygCallQuote } from './admission/paygPolicy';
import { imageTokensUpper, type ImageInputPolicy } from './provider/imageInput';

/*
 * CORE-PATH-V2 2.8 (Fable 10-28): one quote path for staging and production, no test window, no environment branch. The route
 * profiles live in one settings key, runtime_payg (the shape of runtime_payg_production without window or expiry); a missing
 * key or enabled:false refuses the turn and never falls back to an older path. Every price comes from the model's stored
 * OpenRouter price snapshot (renewed first when older than seven days, the existing rule); q and m from the billing unit.
 * Settings, model rows and snapshots are catalog reads (catalogCache); the platform key is read fresh every time (OR-1).
 */
export { RUNTIME_PAYG_SETTING } from './settingKeys';
/** In-flight calls per model across instances (3.3.2 item 10) when runtime_payg.modelConcurrency does not name the model: about
 * 100 users on real models peak near 100 calls, plus room for the burst when many turns open together. */
export const DEFAULT_MODEL_CONCURRENCY = 150;
/** The largest per-model value accepted; anything above would no longer limit anything. */
export const MAX_MODEL_CONCURRENCY = 1000;

/** The in-flight limit of `model` (an OpenRouter model id, as in the profiles). A value that is not an integer from 1 to
 * MAX_MODEL_CONCURRENCY is logged and replaced by the default, so a typo never stops every turn. */
export function modelConcurrency(settings: { modelConcurrency?: Record<string, unknown> }, model: string): number {
  if (!settings.modelConcurrency || !Object.hasOwn(settings.modelConcurrency, model)) return DEFAULT_MODEL_CONCURRENCY;
  const value = settings.modelConcurrency[model];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_MODEL_CONCURRENCY) return value;
  logger.warn('ai', 'turn_model_concurrency_invalid', { model });
  return DEFAULT_MODEL_CONCURRENCY;
}

export class QuoteError extends Error {
  constructor(readonly code: 'TURN_PAYG_DISABLED' | 'TURN_MODEL_NOT_ADMITTED' | 'TURN_PRICE_UNAVAILABLE' | 'TURN_PROVIDER_KEY_UNAVAILABLE'
    | 'TURN_BILLING_UNIT_UNAVAILABLE' | 'TURN_INPUT_TOO_LARGE' | 'TURN_IMAGE_UNSUPPORTED') { super(code); }
}

/** The matched profile's per-request rules, as FusionQuote.profile: one call's bound can be measured on its exact body (bodyBoundCall). */
export type BodyProfile = Omit<PaygCallQuote, 'bytes' | 'promptTokensUpper' | 'messages' | 'tools' | 'schemaBytes' | 'image'>
  & { maxBytes: number; maxMessages: number; maxSchemaBytes: number };

/** Opt-in tighter bound of a quote whose request size is known before it is sent (a review): the prompt is at most `promptBytes`
 * bytes of request body (a token is at least one byte) plus the profile's template and margin tokens, and the output at most
 * `outputTokens`; not the whole context window. The call is then sent with a body-measured identity (bodyBoundCall) that the
 * adapter re-measures, and the request is refused when it is larger than `promptBytes` (assertRuntimeRequestCapacity). */
export type RequestBound = { promptBytes: number; outputTokens?: number };

export type ChatQuote = ModelCall & {
  model: string; q: string; reasoning: ReasoningPolicy; outputLimit: number; inputLimit: number;
  /** V2-6: the billing unit's default multiplier (research routes without their own) and the profile's tool ceiling. */
  defaultMultiplier: string; maxTools: number;
  providerLimits: OpenRouterLimits; credential: () => Promise<string>;
  /** The matched profile's rules for a body-measured call (see RequestBound). */
  profile: BodyProfile;
  /** PUBLISH-MONITOR B2: present on a quote made for a request with one image (the route's allowance; also on identity). */
  imageInput?: ImageInputPolicy;
};

export type Row = { id: string; model_id: string; config: unknown; updated_at: string; is_active?: unknown; max_tokens?: unknown };

/** The OpenRouter limits of one admitted route, from the snapshot endpoint whose tag is the profile's (as production today). */
export function routeLimits(row: Row, snapshot: Parameters<typeof pricingEndpoint>[1], endpointTag: string) {
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
  // PUBLISH-MONITOR B2: an image is billed as prompt tokens on the routes Graylum admits for it. A route that also prices the image itself
  // would cost more than the user's nominal charge says, so a request with an image refuses it (imageFree false).
  const imagePrices = [endpoint.base.image, ...endpoint.overrides.map(override => override.prices.image ?? endpoint.base.image)];
  const imageFree = imagePrices.every(price => price === undefined || Number(price) === 0);
  return { limits, nominal: nominal as NominalPricing, imageFree };
}

/** What a quoted call is for: the profile must cover exactly this use (free chat by default; the mentor's Skill call and its
 * organizer use the agent-turn format, V2-5; a report its own report phase, V2-7a). outputCap: a lower output limit of that
 * use (the organizer's summary limit). */
export type QuoteUse = { phase: 'ordinary' | 'skill' | 'attached_organizer' | 'report'; requestFormat: string;
  purpose: 'interactive' | 'organize'; outputCap?: number };
const FREE_CHAT_USE: QuoteUse = { phase: 'ordinary', requestFormat: FREE_CHAT_REQUEST_FORMAT, purpose: 'interactive' };

export async function chatQuote(admin: SupabaseClient, input: { configuration: ConfigurationRows; modelId: string; inputBytes: number;
  deps?: PricingDeps; use?: QuoteUse; bound?: RequestBound;
  /** PUBLISH-MONITOR B2: the request carries one inline JPEG; the route must admit it (TURN_IMAGE_UNSUPPORTED otherwise). */
  image?: boolean;
  /** The platform key this request already read fresh (a second quote in one request reads it once, OR-1). */ key?: string })
  : Promise<ChatQuote> {
  const use = input.use ?? FREE_CHAT_USE;
  // From the admission configuration rows (one cached query for every setting), never a query of its own.
  const setting = rowFor(input.configuration, RUNTIME_PAYG_SETTING);
  const parsed = paygProductionSettings.safeParse(setting.error ? null : setting.data?.value);
  if (!parsed.success || !parsed.data.enabled) throw new QuoteError('TURN_PAYG_DISABLED');

  const row = await readAdmissionModel(admin, input.modelId);
  if (row.error || !row.data || row.data.is_active !== 'true') throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const model = row.data.model_id as string;
  const candidate = parsed.data.profiles.find(p => p.model === model && isAdmittedRoute(p.model, p.endpointTag));
  if (!candidate) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  // Two reads that need nothing from the pricing below start now, so their waits overlap it: the billing unit (from the same
  // settings rows and model row) and the platform key, still read fresh once per request. Each is awaited, and its refusal raised,
  // where it was before, so the refusal a request gets does not change. A read that fails is only awaited later.
  const unitRead = readMultiplierSnapshot(admin, [input.modelId], undefined, { configuration: Promise.resolve(input.configuration),
    models: [row.data] }).then(value => ({ value }), () => ({ value: undefined }));
  const keyRead = input.key === undefined ? readOpenRouterKeyOrUnset(admin, { fresh: true }) : Promise.resolve(input.key);

  let states;
  try { states = await readPricingStates(admin, [{ modelId: input.modelId, model }], input.deps, false, [row.data]); }
  catch { throw new QuoteError('TURN_PRICE_UNAVAILABLE'); }
  const state = states.get(input.modelId);
  if (!state) throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const route = routeLimits(state.row as Row, state.snapshot, candidate.endpointTag), nominal = route.nominal;
  let limits = route.limits;
  const outputLimit = admittedOutputLimit(candidate.outputLimit, row.data.max_tokens, use.outputCap);
  const reasoning = admitReasoning(row.data, use.purpose, limits.providerSlug, outputLimit);
  // The profile must cover this exact use, as admission checks it (paygHostPolicy.matchedProfile): its phase and purpose, its
  // request format, this reasoning variant and output limit, and a context that holds bytes, template and output.
  // A profile approved for another use (e.g. Argon only for fusion_review) never admits a free chat.
  const profile = matchedProfile(parsed.data.profiles,
    { modelId: input.modelId, model, protocol: 'openrouter-chat-v1', providerLimits: limits } as Parameters<typeof matchedProfile>[1],
    [{ modelId: input.modelId, phase: use.phase, outputLimit, requestFormat: use.requestFormat, reasoning }]);
  if (!profile || profile.endpointTag !== candidate.endpointTag) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  // An image needs the route's image allowance (set by the administrator only for a model that reads images) and a route that does not
  // price the image itself. Its cost is then prompt tokens: the context-window bound below already covers them (a request cannot hold
  // more prompt tokens than the context), a body bound adds the largest image the allowance lets through, and max_price.image = 0
  // (imageUsd) keeps OpenRouter from routing to a provider that would charge for it.
  if (input.image && (!profile.imageInput || !route.imageFree)) throw new QuoteError('TURN_IMAGE_UNSUPPORTED');
  const imageInput = input.image ? profile.imageInput : undefined;
  if (imageInput) limits = { ...limits, imageUsd: '0' };
  const imageTokens = imageInput ? imageTokensUpper(imageInput.maxEdge, imageInput.maxEdge) : 0;
  let upperUsd: string;
  if (input.bound) {
    const promptTokensUpper = Math.min(input.bound.promptBytes, profile.maxBytes) + imageTokens + profile.templateTokens + profile.marginTokens;
    try { upperUsd = openRouterCallBound(limits, Math.min(outputLimit, input.bound.outputTokens ?? outputLimit), promptTokensUpper,
      imageTokens).upperUsd; }
    catch { throw new QuoteError('TURN_INPUT_TOO_LARGE'); }
  } else upperUsd = openRouterBound(limits, outputLimit).upperUsd;

  const unit = (await unitRead).value;
  if (!unit) throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE');
  const multiplier = unit.models[input.modelId]?.multiplier;
  if (!multiplier) throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE');

  const key = await keyRead;
  if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
  return {
    modelId: input.modelId, model, q: unit.creditsPerUsd, multiplier, upperUsd, pricing: nominal, providerLimits: limits,
    defaultMultiplier: unit.defaultMultiplier, maxTools: profile.maxTools,
    identity: { provider: 'openrouter', account: openRouterAccount(key), model, protocol: 'openrouter-chat-v1',
      providerLimits: limits, outputLimit, upperUsd, ...(imageInput ? { imageInput } : {}) },
    reasoning,
    outputLimit, inputLimit: Math.min(input.inputBytes, PAYG_PROFILE_MAX_BYTES),
    concurrency: modelConcurrency(parsed.data, model), credential: async () => key,
    profile: { policyId: RUNTIME_PAYG_SETTING, policyVersion: parsed.data.policyVersion, profileVersion: profile.profileVersion,
      evidenceVersion: profile.evidenceVersion, pricingHash: state.snapshot.pricingHash, endpointTag: profile.endpointTag,
      nominalPricing: nominal, templateTokens: profile.templateTokens, marginTokens: profile.marginTokens,
      maxBytes: profile.maxBytes, maxMessages: profile.maxMessages, maxSchemaBytes: profile.maxSchemaBytes },
    ...(imageInput ? { imageInput } : {}),
  };
}
