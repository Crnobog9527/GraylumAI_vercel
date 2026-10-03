/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { nominalPricing } from '../../shared/nominalPricing';
const reference = z.string().min(1).max(128);
const tokens = z.number().int().nonnegative().max(1_050_000);
const identity = {
  policyId: reference, profileVersion: reference, evidenceVersion: reference,
  pricingHash: z.string().regex(/^[0-9a-f]{64}$/), endpointTag: reference,
  nominalPricing, templateTokens: tokens, marginTokens: tokens,
};
export const paygStablePolicy = z.object({
  ...identity, version: reference, admissionPath: z.enum(['fixture', 'empirical', 'tokenizer']),
  maxBytes: z.number().int().min(1).max(196_608),
  maxMessages: z.number().int().min(1).max(32), maxTools: z.number().int().min(0).max(2),
  maxSchemaBytes: z.number().int().min(0).max(16_384),
  purposes: z.array(reference).min(1).max(16), expiresAt: z.string().datetime(),
}).strict().refine(value => value.pricingHash === value.nominalPricing.pricingHash
  && value.endpointTag === value.nominalPricing.endpointTag, { message: 'BILL2_NOMINAL_IDENTITY_CONFLICT' });
export const paygCallQuote = z.object({
  ...identity, policyVersion: reference,
  bytes: z.number().int().min(1).max(196_608), promptTokensUpper: tokens.positive(),
  messages: z.number().int().min(1).max(32), tools: z.number().int().min(0).max(2),
  schemaBytes: z.number().int().min(0).max(16_384),
}).strict().refine(value => value.promptTokensUpper === value.bytes + value.templateTokens + value.marginTokens,
  { message: 'BILL2_INPUT_BOUND_CONFLICT' })
  .refine(value => value.pricingHash === value.nominalPricing.pricingHash
    && value.endpointTag === value.nominalPricing.endpointTag, { message: 'BILL2_NOMINAL_IDENTITY_CONFLICT' });
export type PaygStablePolicy = z.infer<typeof paygStablePolicy>;
export type PaygCallQuote = z.infer<typeof paygCallQuote>;
