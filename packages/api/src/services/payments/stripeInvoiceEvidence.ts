/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FulfillMembershipInvoiceWithCreditGrantsInput } from '../subscriptionCreditGrants';
import { freezePurchaseSnapshot } from './contracts';
import { snapshotAmountDue, type StripeScope } from './purchaseFacts';
import { recordStripeInvoiceConflict } from './stripeConflictEvidence';

const statuses = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled', 'paused'];
type Db = Pick<SupabaseClient, 'from'>;
export async function retrievePaidStripeInvoice(db: Db, stripe: Stripe, scope: StripeScope, id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  if (invoice.id !== id || invoice.object !== 'invoice' || invoice.livemode !== (scope.mode === 'live')
    || invoice.status !== 'paid' || invoice.currency !== 'usd' || invoice.amount_paid !== invoice.amount_due) {
    await recordStripeInvoiceConflict({ db, scope, invoiceId: id });
    throw new Error('PAY_COMMON_INVOICE_RECEIPT_MISMATCH');
  }
  return invoice;
}

export async function retrieveInvoiceSubscription(stripe: Stripe, scope: StripeScope, id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  if (subscription.id !== id || subscription.object !== 'subscription' || subscription.livemode !== (scope.mode === 'live')
    || typeof subscription.metadata?.userId !== 'string' || !subscription.metadata.userId.trim()
    || !statuses.includes(subscription.status)) throw new Error('PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH');
  return subscription;
}

export async function validateInvoiceSource(db: Db, input: FulfillMembershipInvoiceWithCreditGrantsInput, source: {
  id?: string | null; user_id: string; payment_channel?: string | null; merchant_namespace?: string | null;
  payment_mode?: string | null; purchase_snapshot?: unknown; item_id?: string | null;
  billing_cycle?: string | null; purchase_membership_level?: string | null; stripe_customer_id?: string | null;
}) {
  if (!input.scope || source.payment_channel !== 'stripe' || source.merchant_namespace !== input.scope.merchant
    || source.payment_mode !== input.scope.mode) throw new Error('PAY_COMMON_INVOICE_SOURCE_MISMATCH');
  if (!statuses.includes(input.providerSubscriptionStatus ?? '') || input.providerSubscriptionUserId !== source.user_id) {
    throw new Error('PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH');
  }
  const snapshot = freezePurchaseSnapshot(source.purchase_snapshot);
  if (snapshot.item_type !== 'membership_plan' || snapshot.item_id !== source.item_id
    || snapshot.billing_cycle !== source.billing_cycle || !['pro', 'gold'].includes(source.purchase_membership_level ?? '')) {
    throw new Error('PAY_COMMON_GRANT_SNAPSHOT_MISMATCH');
  }
  if (input.paymentStatus !== 'paid' || input.currency !== snapshot.currency || input.amountTotal !== snapshotAmountDue(snapshot)
    || (source.stripe_customer_id && input.stripeCustomerId !== source.stripe_customer_id)) {
    await recordStripeInvoiceConflict({ db, scope: input.scope, invoiceId: input.invoiceId, sourceOrderId: source.id });
    throw new Error('PAY_COMMON_INVOICE_RECEIPT_MISMATCH');
  }
  return snapshot;
}
