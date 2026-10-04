/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveFrozenPrices, deriveListPrices } from '../../shared/modelPriceBound';
import { validateNominalBound } from '../../shared/nominalPricing';
import { paygStablePolicy, type PaygStablePolicy } from '../bill2/paygPolicy';
import { admitPricingSnapshots, pricingEndpoint, readPricingStates,
  type PricingDeps, type PricingQuote } from './pricingAdmission';
import { StagingAccessError } from './stagingErrors';

type PaygTemplate = Omit<PaygStablePolicy, 'nominalPricing' | 'pricingHash' | 'endpointTag'>;
type PaygPolicy = PricingQuote & { payg?: PaygTemplate };

/** The old window supplies ceilings, not nominal prices. Freeze from the same checked snapshot. */
export async function freezeStagingPaygPricing<T extends PaygPolicy>(
  admin: SupabaseClient, policies: readonly T[], deps: PricingDeps = {},
): Promise<Array<T & { payg: PaygStablePolicy }>> {
  const states = await admitPricingSnapshots(admin, policies, deps);
  return policies.map(policy => {
    if (!policy.payg) throw new Error('BILL2_PAYG_QUOTE_INVALID');
    const { row, snapshot } = states.get(policy.modelId)!;
    const endpoint = pricingEndpoint(row, snapshot, policy);
    const nominalPricing = deriveListPrices(endpoint, snapshot.pricingHash, row.model_id);
    if (typeof nominalPricing === 'string') throw new StagingAccessError(nominalPricing === 'UNKNOWN_PRICE_FIELD'
      ? 'RUNTIME_PRICE_UNKNOWN_FIELD' : 'RUNTIME_PRICE_SNAPSHOT_MISSING');
    const payg = paygStablePolicy.parse({ ...policy.payg, pricingHash: snapshot.pricingHash,
      endpointTag: endpoint.tag, nominalPricing });
    validateNominalBound(nominalPricing, { ...policy.providerLimits!, pricingHash: snapshot.pricingHash,
      endpointTag: endpoint.tag, promptTokensUpper: policy.providerLimits!.contextTokens });
    return { ...policy, payg };
  });
}

/** Future production host: derive per claim from a persisted fresh snapshot only.
 * This is a quote helper, not dispatch authorization: callers must still satisfy
 * the frozen run policy and SQL contract. It does not enable production Runtime.
 */
export async function deriveProductionPaygPricing(admin: SupabaseClient, policy: PricingQuote,
  promptTokensUpper: number, deps: PricingDeps = {}) {
  if (!Number.isSafeInteger(promptTokensUpper) || promptTokensUpper < 1
    || !policy.providerLimits || promptTokensUpper > policy.providerLimits.contextTokens)
    throw new Error('BILL2_INPUT_BOUND_CONFLICT');
  const states = await readPricingStates(admin, [policy], deps, true);
  const { row, snapshot } = states.get(policy.modelId)!;
  const endpoint = pricingEndpoint(row, snapshot, policy);
  const prices = deriveFrozenPrices(row.model_id, endpoint, promptTokensUpper);
  const nominalPricing = deriveListPrices(endpoint, snapshot.pricingHash, row.model_id);
  if (typeof prices === 'string' || typeof nominalPricing === 'string')
    throw new StagingAccessError(prices === 'UNKNOWN_PRICE_FIELD' || nominalPricing === 'UNKNOWN_PRICE_FIELD'
      ? 'RUNTIME_PRICE_UNKNOWN_FIELD' : 'RUNTIME_PRICE_SNAPSHOT_MISSING');
  const providerLimits = { ...policy.providerLimits, promptUsdPerMillion: prices.promptUsdPerMillion,
    completionUsdPerMillion: prices.completionUsdPerMillion, requestUsd: prices.requestUsd };
  // Remove an old cache-write rate when the new snapshot no longer provides it.
  delete providerLimits.cacheWriteUsdPerMillion;
  if (prices.cacheWriteUsdPerMillion !== undefined)
    providerLimits.cacheWriteUsdPerMillion = prices.cacheWriteUsdPerMillion;
  validateNominalBound(nominalPricing, { ...providerLimits, promptTokensUpper,
    pricingHash: snapshot.pricingHash, endpointTag: endpoint.tag });
  return { providerLimits, nominalPricing, pricingHash: snapshot.pricingHash, endpointTag: endpoint.tag };
}
