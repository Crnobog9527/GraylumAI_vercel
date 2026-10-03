/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';

// Pure contracts only. PR-1 does not select a channel, dispatch payments or write mappings.
export const paymentChannelSchema = z.enum(['stripe', 'waffo']);
export const paymentModeSchema = z.enum(['test', 'live']);
export const paymentDecimalSchema = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,12})?$/);
const credits = z.number().int().min(0).max(2147483647);
export const purchaseSnapshotSchema = z.object({
  version: z.literal(1),
  item_type: z.enum(['membership_plan', 'credit_package']),
  item_id: z.string().uuid(),
  item_updated_at: z.string().datetime(),
  billing_cycle: z.enum(['one_time', 'monthly', 'yearly']),
  currency: z.string().regex(/^[a-z]{3}$/),
  unit: z.literal('major'),
  price: paymentDecimalSchema,
  discount: paymentDecimalSchema,
  tax_behavior: z.enum(['inclusive', 'exclusive', 'unspecified']),
  credits,
  bonus_credits: credits,
}).strict().refine(value => (value.item_type === 'credit_package') === (value.billing_cycle === 'one_time'), {
  message: 'Product and billing cycle do not match',
});

export const paymentAmountFactSchema = z.object({
  kind: z.enum(['list_price', 'discount', 'tax', 'paid', 'refund', 'fee', 'net']),
  amount: z.string().regex(/^-?(0|[1-9]\d{0,17})(\.\d{1,12})?$/).nullable(), // Missing evidence is unknown, never a fabricated zero.
  currency: z.string().regex(/^[a-z]{3}$/),
  unit: z.literal('major'),
  evidence_ref: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
}).strict();
export const paymentAmountFactsSchema = z.array(paymentAmountFactSchema).max(128);
export type PurchaseSnapshot = z.infer<typeof purchaseSnapshotSchema>;

export function freezePurchaseSnapshot(input: unknown): Readonly<PurchaseSnapshot> {
  // Parsing copies the caller's data; changing a catalog object cannot mutate a frozen quote.
  return Object.freeze(purchaseSnapshotSchema.parse(input));
}
