/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * I1: a real host admits only through a per-call (v2) profile. Admission unit tests that exercise a real host mock the
 * staging profile reader and the price freeze with these synthetic values; nothing reaches a database or a provider.
 *   vi.mock('./paygHostPolicy', async o => ({...(await o()), readPaygHostPolicies: paygHostPolicies}));
 *   vi.mock('./paygPricing', async o => ({...(await o()), freezeStagingPaygPricing: frozenPaygPricing}));
 */
export const PAYG_TEST_PRICING_HASH = 'a'.repeat(64);
export const paygTestProfile = {version: 'test-only', policyId: 'test-only', profileVersion: 'test-only',
  evidenceVersion: 'test-only', admissionPath: 'empirical' as const, templateTokens: 4096, marginTokens: 4096,
  maxBytes: 196608, maxMessages: 128, maxTools: 9, maxSchemaBytes: 16384,
  purposes: ['ordinary', 'skill', 'organizer', 'attached_organizer', 'report', 'skill_matching', 'mentor'],
  expiresAt: '2099-01-01T00:00:00Z'};
type Quote = {modelId: string; providerLimits?: {providerSlug: string}};
/** Every selected window quote gets the same synthetic profile (the reader's requirements are not re-checked here). */
export async function paygHostPolicies<T extends Quote>(_admin: unknown, _window: unknown, policies: readonly T[]) {
  return policies.map(policy => ({...policy, payg: paygTestProfile}));
}
/** The frozen nominal prices of each policy's own route. */
export async function frozenPaygPricing<T extends Quote & {payg?: object}>(_admin: unknown, policies: readonly T[]) {
  return policies.map(policy => {
    const endpointTag = policy.providerLimits?.providerSlug ?? 'synthetic';
    return {...policy, payg: {...paygTestProfile, ...policy.payg, pricingHash: PAYG_TEST_PRICING_HASH, endpointTag,
      nominalPricing: {version: 'nominal-v1', pricingHash: PAYG_TEST_PRICING_HASH, endpointTag,
        tiers: [{minPromptTokens: 0, prompt: '1', completion: '1', request: '0'}], timeOfDay: []}}};
  });
}
