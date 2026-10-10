/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type pg from 'pg';

/** Same nominal-price fixture shape as packages/db/tests/payg/fixture.mjs, without a provider request. */
export async function planBPayg(db: pg.Client, modelId: string, model: string) {
  const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
  const identity = {policyId: 'r13-local', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
    pricingHash, endpointTag, templateTokens: 4096, marginTokens: 4096,
    nominalPricing: {version: 'nominal-v1', pricingHash, endpointTag,
      tiers: [{minPromptTokens: 0, prompt: '1', completion: '0', request: '0'}], timeOfDay: []}};
  const base = {provider: 'fixture', account: 'sandbox', model, protocol: 'fixture-cost-v1',
    upperUsd: '0.008292', inputLimit: 8292, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true,
    providerLimits: {providerSlug: endpointTag, contextTokens: 100000, promptUsdPerMillion: '1',
      completionUsdPerMillion: '0', requestUsd: '0'}};
  const policy = {...base, modelId, multiplier: '1', payg: {...identity, version: 'v1', admissionPath: 'fixture',
    maxBytes: 196608, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['question', 'organizer'],
    expiresAt: new Date(Date.now() + 3600000).toISOString()}};
  const quote = {...base, billingUnit: {modelId, multiplier: '1'}, payg: {...identity, policyVersion: 'v1',
    bytes: 100, promptTokensUpper: 8292, messages: 1, tools: 0, schemaBytes: 0}};
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
      coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{version: 'local-v1', thresholds: ['question', 'organizer'].map(purpose => ({model, purpose, credits: 1}))}]);
  return {policy, quote};
}
