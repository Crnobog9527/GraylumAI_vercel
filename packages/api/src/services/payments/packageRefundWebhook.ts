/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from '../stripe';
import { recordPackageRefund } from './packageRefund';

// Called from the existing verified webhook reconciliation entry, including charge events.
// Metadata is only a lookup hint; the provider read and atomic result contract verify it.
export async function reconcileApprovedPackageRefundWebhook(
  db: Pick<SupabaseClient, 'from' | 'rpc'>, input: { refund?: Stripe.Refund; charge?: Stripe.Charge },
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const refund = input.refund ?? input.charge?.refunds?.data.find(row => row.metadata?.refundIntentId);
  if (!refund?.metadata?.refundIntentId || !refund.metadata.orderId) return { handled: false };
  const stripe = getStripeClient();
  const verified = await stripe.refunds.retrieve(refund.id);
  return { handled: true, result: await recordPackageRefund(db, stripe, refund.metadata.orderId, verified) };
}
