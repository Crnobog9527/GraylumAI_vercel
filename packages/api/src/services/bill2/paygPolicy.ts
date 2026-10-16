/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { nominalPricing } from '../../shared/nominalPricing';
import { imageInputPolicy, imageQuote, IMAGE_MAX_DATA_URL_BYTES } from './imageInput';
const reference = z.string().min(1).max(128);
const tokens = z.number().int().nonnegative().max(1_050_000);
const identity = {
  policyId: reference, profileVersion: reference, evidenceVersion: reference,
  pricingHash: z.string().regex(/^[0-9a-f]{64}$/), endpointTag: reference,
  nominalPricing, templateTokens: tokens, marginTokens: tokens,
};
/** Tool definitions one PAYG call may carry (card, Skill file, history read and the six research tools);
 * the SQL quote check (0267) enforces the same ceiling. */
export const PAYG_MAX_TOOLS = 9;
/** Text bytes one PAYG call may carry (SQL 0162). */
export const PAYG_TEXT_MAX_BYTES = 196_608;
export const paygStablePolicy = z.object({
  ...identity, version: reference, admissionPath: z.enum(['fixture', 'empirical', 'tokenizer']),
  maxBytes: z.number().int().min(1).max(196_608),
  maxMessages: z.number().int().min(1).max(128), maxTools: z.number().int().min(0).max(PAYG_MAX_TOOLS),
  maxSchemaBytes: z.number().int().min(0).max(16_384),
  purposes: z.array(reference).min(1).max(16), expiresAt: z.string().datetime(),
  // LIB-2d (0278): present only on a route admitted for one inline image per call.
  imageInput: imageInputPolicy.optional(),
}).strict().refine(value => value.pricingHash === value.nominalPricing.pricingHash
  && value.endpointTag === value.nominalPricing.endpointTag, { message: 'BILL2_NOMINAL_IDENTITY_CONFLICT' });
export const paygCallQuote = z.object({
  ...identity, policyVersion: reference,
  // With an image, bytes is the whole request and its text part (bytes − dataUrlBytes) keeps the 196,608 cap.
  bytes: z.number().int().min(1).max(PAYG_TEXT_MAX_BYTES + IMAGE_MAX_DATA_URL_BYTES), promptTokensUpper: tokens.positive(),
  messages: z.number().int().min(1).max(128), tools: z.number().int().min(0).max(PAYG_MAX_TOOLS),
  schemaBytes: z.number().int().min(0).max(16_384),
  image: imageQuote.optional(),
}).strict().refine(value => {
  const imageBytes = value.image?.dataUrlBytes ?? 0, text = value.bytes - imageBytes;
  return text >= 1 && text <= PAYG_TEXT_MAX_BYTES
    && value.promptTokensUpper === text + (value.image?.tokensUpper ?? 0) + value.templateTokens + value.marginTokens;
}, { message: 'BILL2_INPUT_BOUND_CONFLICT' })
  .refine(value => value.pricingHash === value.nominalPricing.pricingHash
    && value.endpointTag === value.nominalPricing.endpointTag, { message: 'BILL2_NOMINAL_IDENTITY_CONFLICT' });
export type PaygStablePolicy = z.infer<typeof paygStablePolicy>;
export type PaygCallQuote = z.infer<typeof paygCallQuote>;
