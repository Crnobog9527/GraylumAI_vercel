/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { openRouterBound, openRouterCallBound } from '../bill2/openRouterPolicy';
import { paygCallQuote, type PaygCallQuote } from '../bill2/paygPolicy';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';
import { readMultiplierSnapshot } from '../billingUnit';
import { fusionRequestFormat, reasoningPurpose, type FusionPhase } from '../fusion/models';
import { openRouterAccount } from '../models/openRouterKey';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { readAdmissionModel, type ConfigurationRows } from '../runtime/admissionConfiguration';
import { rowFor } from '../runtime/settingsRows';
import { admittedOutputLimit } from '../runtime/admissionLimits';
import { isAdmittedRoute, matchedProfile, paygProductionSettings } from '../runtime/paygHostPolicy';
import { readPricingStates, type PricingDeps } from '../runtime/pricingAdmission';
import { admitReasoning } from '../runtime/reasoningAdmission';
import type { ReasoningPolicy } from '../runtime/reasoningPolicy';
import { TurnStop, type ModelCall } from './call';
import { DEFAULT_MODEL_CONCURRENCY, QuoteError, routeLimits, RUNTIME_PAYG_SETTING, type Row } from './quote';

/*
 * CORE-PATH-V2 V2-7b: the quote of one compare column, review seat or summary on the turn path, as chatQuote (2.8): the
 * runtime_payg profiles (no test window), the model's stored OpenRouter price snapshot, q and m from the billing unit. The
 * profile must cover this Fusion purpose, its request format, reasoning and output limit (matchedProfile; e.g. Argon only for
 * the execution reviewer). Built-in search models are refused (FUSION-REVIEW §4.1). The platform key is read once per turn
 * (fresh, OR-1) by the caller and passed in.
 */
export type FusionQuote = ModelCall & {
  model: string; q: string; phase: FusionPhase; outputLimit: number; reasoning: ReasoningPolicy;
  /** What fusionRequestBody needs of the frozen call policy. */
  policy: { model: string; providerLimits: ModelCall['identity']['providerLimits']; outputLimit: number };
  /** The matched profile's per-request rules: one call's bound is measured on its exact body (fusionCall). */
  profile: Omit<PaygCallQuote, 'bytes' | 'promptTokensUpper' | 'messages' | 'tools' | 'schemaBytes' | 'image'>
    & { maxBytes: number; maxMessages: number; maxSchemaBytes: number };
};

/** One call of a quote, bounded on its exact request body as the old per-run admission did (runtimePaygCall): the prompt is
 * at most body bytes + template + margin tokens, so U_i is the price of that prompt and the output limit, not of the whole
 * context window. The adapter recomputes the same bound from the same body and refuses any other (BILL2_PROVIDER_QUOTE_CONFLICT). */
export function fusionCall(quote: FusionQuote, body: string): ModelCall {
  const parsed = JSON.parse(body) as { messages?: unknown[]; response_format?: unknown; tools?: unknown[] };
  const bytes = Buffer.byteLength(body);
  const messages = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
  const schemaBytes = parsed.response_format === undefined ? 0 : Buffer.byteLength(JSON.stringify(parsed.response_format));
  const { maxBytes, maxMessages, maxSchemaBytes, ...identity } = quote.profile;
  if (bytes > maxBytes || messages < 1 || messages > maxMessages || schemaBytes > maxSchemaBytes || parsed.tools?.length)
    throw new TurnStop('TURN_INPUT_TOO_LARGE');
  const payg = paygCallQuote.parse({ ...identity, bytes, promptTokensUpper: bytes + identity.templateTokens + identity.marginTokens,
    messages, tools: 0, schemaBytes });
  const upperUsd = openRouterCallBound(quote.policy.providerLimits!, quote.outputLimit, payg.promptTokensUpper).upperUsd;
  return { ...quote, upperUsd, identity: { ...quote.identity, upperUsd, payg } as ModelCall['identity'] };
}

export async function fusionQuote(admin: SupabaseClient, input: { configuration: ConfigurationRows; modelId: string; phase: FusionPhase;
  outputTokens: number; key: string; deps?: PricingDeps }): Promise<FusionQuote> {
  // From the admission configuration rows (one cached query for every setting), as chatQuote.
  const setting = rowFor(input.configuration, RUNTIME_PAYG_SETTING);
  const parsed = paygProductionSettings.safeParse(setting.error ? null : setting.data?.value);
  if (!parsed.success || !parsed.data.enabled) throw new QuoteError('TURN_PAYG_DISABLED');

  const row = await readAdmissionModel(admin, input.modelId);
  if (row.error || !row.data || row.data.is_active !== 'true') throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const model = row.data.model_id as string;
  if (!isPlainOpenRouterModel(model)) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const candidate = parsed.data.profiles.find(p => p.model === model && isAdmittedRoute(p.model, p.endpointTag));
  if (!candidate) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');

  let states;
  try { states = await readPricingStates(admin, [{ modelId: input.modelId, model }], input.deps, false, [row.data]); }
  catch { throw new QuoteError('TURN_PRICE_UNAVAILABLE'); }
  const state = states.get(input.modelId);
  if (!state) throw new QuoteError('TURN_PRICE_UNAVAILABLE');
  const { limits, nominal } = routeLimits(state.row as Row, state.snapshot, candidate.endpointTag);
  const outputLimit = Math.min(input.outputTokens, admittedOutputLimit(candidate.outputLimit, row.data.max_tokens), PURPOSE_OUTPUT_CAP);
  const reasoning = admitReasoning(row.data, reasoningPurpose(input.phase), limits.providerSlug, outputLimit);
  const profile = matchedProfile(parsed.data.profiles,
    { modelId: input.modelId, model, protocol: 'openrouter-chat-v1', providerLimits: limits } as Parameters<typeof matchedProfile>[1],
    [{ modelId: input.modelId, phase: input.phase, outputLimit, requestFormat: fusionRequestFormat(input.phase), reasoning }]);
  if (!profile || profile.endpointTag !== candidate.endpointTag) throw new QuoteError('TURN_MODEL_NOT_ADMITTED');
  const upperUsd = openRouterBound(limits, outputLimit).upperUsd;

  let unit;
  try { unit = await readMultiplierSnapshot(admin, [input.modelId], undefined, { models: [row.data] }); }
  catch { throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE'); }
  const multiplier = unit.models[input.modelId]?.multiplier;
  if (!multiplier) throw new QuoteError('TURN_BILLING_UNIT_UNAVAILABLE');
  return {
    modelId: input.modelId, model, q: unit.creditsPerUsd, multiplier, upperUsd, pricing: nominal, phase: input.phase,
    identity: { provider: 'openrouter', account: openRouterAccount(input.key), model, protocol: 'openrouter-chat-v1',
      providerLimits: limits, outputLimit, upperUsd },
    policy: { model, providerLimits: limits, outputLimit }, outputLimit, reasoning, concurrency: DEFAULT_MODEL_CONCURRENCY,
    profile: { policyId: RUNTIME_PAYG_SETTING, policyVersion: parsed.data.policyVersion, profileVersion: profile.profileVersion,
      evidenceVersion: profile.evidenceVersion, pricingHash: state.snapshot.pricingHash, endpointTag: profile.endpointTag,
      nominalPricing: nominal, templateTokens: profile.templateTokens, marginTokens: profile.marginTokens,
      maxBytes: profile.maxBytes, maxMessages: profile.maxMessages, maxSchemaBytes: profile.maxSchemaBytes },
  };
}
