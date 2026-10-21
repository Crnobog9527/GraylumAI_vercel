/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';
import { observeStripeTestClock, stripeTestClockRuntimeOpen } from './stripeTestClock';
import { recoverMethodCheckout } from './walletWebhook';
import { handleCardSubscriptionInvoice, handleCardSubscriptionState } from './cardSubscriptionWebhook';
import { handleCardRefund } from './cardRefundWebhook';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';
import { readDisputePayment } from './disputePayment';
import type { StripeCardFinding } from './stripeCardReconciliation';
import type { DisputeAlert } from './disputes';
const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;

/** Stripe excludes test-clock invoices from global lists. Enumerate only frozen local sources by customer;
 * all writes still use the normal authoritative, idempotent handlers. Wall-clock work budgets stay unchanged. */
export async function reconcileStripeTestClockSources(db: SupabaseClient, stripe: Stripe, scope: StripeScope,
  options: { deadline: number; maxPages: number; alert?: () => void; disputeAlert?: DisputeAlert }):
  Promise<{ checked: number; repaired: number; complete: boolean; findings: StripeCardFinding[] }> {
  const findings: StripeCardFinding[] = [];
  let checked = 0, repaired = 0;
  if (!stripeTestClockRuntimeOpen() || scope.mode !== 'test') return { checked, repaired, complete: true, findings };
  const sources = await db.from('payment_orders').select('*').eq('payment_channel', 'stripe')
    .eq('merchant_namespace', scope.merchant).eq('payment_mode', 'test').eq('payment_method', 'card')
    .eq('purchase_membership_level', 'pro').eq('billing_cycle', 'monthly').eq('purchase_action', 'checkout')
    .not('checkout_request->providerRequest->>customer', 'is', null).limit(101);
  if (sources.error || !Array.isArray(sources.data)) {
    return { checked, repaired, complete: false, findings: [{ kind: 'scan_failed' as const, object: 'invoice' as const,
      code: 'PAY_STRIPE_TEST_CLOCK_UNAVAILABLE' }] };
  }
  if (sources.data.length > 100) return { checked, repaired, complete: false,
    findings: [{ kind: 'scan_incomplete' as const, object: 'invoice' as const, code: 'PAY_STRIPE_TEST_CLOCK_SOURCE_LIMIT' }] };
  for (const source of sources.data) {
    if (Date.now() > options.deadline) return { checked, repaired, complete: false,
      findings: [...findings, { kind: 'scan_incomplete', object: 'invoice', code: 'TIME_BUDGET' }] };
    checked++;
    try {
      const clock = await observeStripeTestClock(db, stripe, scope, source);
      if (!clock) continue;
      const refs = await db.from('payment_provider_refs').select('external_id').eq('order_id', source.id)
        .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', 'test').eq('object_type', 'checkout').limit(2);
      if (refs.error || !Array.isArray(refs.data) || refs.data.length !== 1) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
      const session = await stripe.checkout.sessions.retrieve(refs.data[0]!.external_id);
      if (session.id !== refs.data[0]!.external_id || session.object !== 'checkout.session' || session.livemode !== false
        || session.metadata?.orderId !== source.id || session.metadata?.userId !== source.user_id
        || session.client_reference_id !== source.user_id || id(session.customer) !== clock.customerId
        || session.mode !== 'subscription' || session.managed_payments?.enabled !== true) {
        throw new Error(PAYMENT_EVIDENCE_CONFLICT);
      }
      if (!source.fulfilled_at && session.status === 'complete' && session.payment_status === 'paid') {
        await recoverMethodCheckout(db, stripe, session.id, undefined, options.disputeAlert);
      }
      const subscriptionId = id(session.subscription);
      if (!subscriptionId) continue;
      let after: string | undefined;
      for (let page = 0; page < options.maxPages; page++) {
        if (Date.now() > options.deadline) return { checked, repaired, complete: false,
          findings: [...findings, { kind: 'scan_incomplete', object: 'invoice', code: 'TIME_BUDGET' }] };
        const invoices = await stripe.invoices.list({ customer: clock.customerId, subscription: subscriptionId,
          status: 'paid', limit: 100, ...(after ? { starting_after: after } : {}) });
        for (const invoice of invoices.data) {
          if (Date.now() > options.deadline) return { checked, repaired, complete: false,
            findings: [...findings, { kind: 'scan_incomplete', object: 'invoice', code: 'TIME_BUDGET' }] };
          checked++;
          if (invoice.billing_reason === 'subscription_cycle') {
            const known = await db.from('payment_provider_refs').select('order_id').eq('channel', 'stripe')
              .eq('merchant_namespace', scope.merchant).eq('mode', 'test').eq('object_type', 'payment')
              .eq('external_id', invoice.id).maybeSingle();
            if (known.error) throw new Error('PAY_COMMON_MAPPING_READ_FAILED');
            const handled = await handleCardSubscriptionInvoice(db, stripe, invoice.id, 'invoice.paid', undefined,
              options.alert, options.disputeAlert);
            if (handled && !known.data) repaired++;
          }
          const payment = await readDisputePayment(stripe, scope, { invoiceId: invoice.id });
          const refunds = await stripe.refunds.list({ charge: payment.chargeId, limit: 1 });
          if (refunds.data.length) await handleCardRefund(db, stripe, { chargeId: payment.chargeId }, options.alert);
        }
        if (!invoices.has_more) break;
        if (!invoices.data.length || page === options.maxPages - 1) {
          findings.push({ kind: 'scan_incomplete', object: 'invoice', orderId: source.id });
          break;
        }
        after = invoices.data.at(-1)!.id;
      }
      await handleCardSubscriptionState(db, stripe, subscriptionId);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNEXPECTED';
      findings.push({ kind: 'repair_failed', object: 'invoice', orderId: source.id, code });
    }
  }
  return { checked, repaired, complete: !findings.some(row => row.kind === 'scan_incomplete'), findings };
}
