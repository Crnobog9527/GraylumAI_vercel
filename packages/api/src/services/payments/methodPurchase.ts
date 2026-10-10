/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOpeningGrantDigests } from '../accountErasure/openingGrantIdentity';
import { paymentMethodSchema } from './methodRouting';

export const methodPurchaseInputSchema = z.object({
  itemType: z.enum(['membership_plan', 'credit_package']),
  itemId: z.string().uuid(),
  billingCycle: z.enum(['monthly', 'yearly', 'one_time']),
  method: paymentMethodSchema,
  offer: z.enum(['standard', 'gold_first30', 'founder']),
  routingVersion: z.number().int().positive(),
  acceptedTerms: z.literal(true),
}).strict();

/** Server-only preparation, no provider dispatch. PR-2 supplies the authenticated route and
 * authoritative published terms version; caller input cannot set prices or provider scope. */
export async function prepareMethodPurchase(input: {
  admin: SupabaseClient; userId: string; purchase: z.infer<typeof methodPurchaseInputSchema>;
  merchantNamespace: string; paymentMode: 'test' | 'live'; termsVersion: string;
}) {
  const purchase = methodPurchaseInputSchema.parse(input.purchase);
  if (input.paymentMode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(input.termsVersion)) throw new Error('PAY_WAFFO_TERMS_UNAVAILABLE');
  const digests = await loadOpeningGrantDigests(input.admin, input.userId);
  const result = await input.admin.rpc('pay_waffo_create_purchase', {
    p_user: input.userId, p_item_type: purchase.itemType, p_item: purchase.itemId,
    p_cycle: purchase.billingCycle, p_method: purchase.method, p_offer: purchase.offer,
    p_merchant: input.merchantNamespace, p_mode: input.paymentMode,
    p_version: purchase.routingVersion, p_terms: input.termsVersion, p_digests: digests,
  });
  if (result.error) throw new Error('PAY_WAFFO_PURCHASE_DENIED', { cause: result.error });
  if (!result.data?.id || result.data.user_id !== input.userId) throw new Error('PAY_WAFFO_PURCHASE_UNAVAILABLE');
  return result.data;
}
