/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';
const id = (value: string | { id: string } | null) => typeof value === 'string' ? value : value?.id;

/** Stripe keeps charge.disputed=true after won. A manual local withdrawal alone is never enough to permit cash. */
export async function disputeAllowsRefund(db: Pick<SupabaseClient, 'from'> | undefined,
  stripe: Partial<Pick<Stripe, 'disputes'>>, scope: StripeScope, orderId: string, charge: Stripe.Charge) {
  if (charge.disputed === false) return true;
  if (charge.disputed !== true || !db || !stripe.disputes || charge.livemode !== (scope.mode === 'live')) return false;
  try {
    const local = await db.from('payment_disputes').select('provider_dispute_id,provider_charge_id,provider_payment_intent_id,freeze_state')
      .eq('order_id', orderId).eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).limit(101);
    if (local.error || !Array.isArray(local.data) || !local.data.length || local.data.length > 100
      || local.data.some(row => row.freeze_state !== 'withdrawn' || row.provider_charge_id !== charge.id
        || row.provider_payment_intent_id !== id(charge.payment_intent))) return false;
    const actual = await stripe.disputes.list({ charge: charge.id, limit: 100 });
    if (actual.has_more || !actual.data.length || actual.data.length !== local.data.length) return false;
    const seen = new Set<string>();
    for (const dispute of actual.data) {
      if (seen.has(dispute.id) || dispute.object !== 'dispute' || dispute.livemode !== charge.livemode
        || id(dispute.charge) !== charge.id || id(dispute.payment_intent) !== id(charge.payment_intent)
        || dispute.status !== 'won' || dispute.is_charge_refundable !== true
        || !local.data.some(row => row.provider_dispute_id === dispute.id)) return false;
      seen.add(dispute.id);
    }
    return true;
  } catch { return false; }
}
