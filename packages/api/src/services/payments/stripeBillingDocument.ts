/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { getStripeClient } from '../stripe';
import { logger } from '../../lib/logger';
import { isSubscriptionPlanChangeOrder } from '../subscriptionPlanChangeLock';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { findCardSubscriptionInvoiceId, resolveStripeOrderIds } from './stripeReferences';
import type { PaymentOrderBillingRow } from './orderProjection';

/** Managed Payments adds tax on top of the order's pre-tax amount_total (0237), so the provider
 * total is compared after taking out the tax the same provider object reports. A tax that is not a
 * whole non-negative amount within the total never matches. */
function matchesPreTax(total: number | null | undefined, tax: number | null | undefined, amountTotal: unknown) {
  const added = tax ?? 0;
  return typeof total === 'number' && Number.isSafeInteger(total) && Number.isSafeInteger(added)
    && added >= 0 && added <= total && total - added === Number(amountTotal);
}

export async function loadStripeBillingDocument(
  stripe: ReturnType<typeof getStripeClient> | null, supabase: SupabaseClient, order: PaymentOrderBillingRow,
) {
  const emptyDocument = {
    invoiceNumber: null,
    invoicePdfUrl: null,
    hostedInvoiceUrl: null,
    receiptUrl: null,
  };

  if (!stripe) {
    return { ...emptyDocument, documentStatus: 'unknown' as const };
  }

  try {
    if ((isSubscriptionPlanChangeOrder(order) && !order.fulfilled_at) || order.payment_channel !== 'stripe') return emptyDocument;
    const scope = await resolveStripeScope(stripe);
    if (order.payment_channel !== 'stripe' || order.merchant_namespace !== scope.merchant || order.payment_mode !== scope.mode) {
      throw new Error('PAY_COMMON_ORDER_IDENTITY_UNKNOWN');
    }
    order = await resolveStripeOrderIds(supabase, order);
    if (!order.stripe_invoice_id) order = { ...order, stripe_invoice_id: await findCardSubscriptionInvoiceId(supabase, order) };
    if (order.stripe_invoice_id) {
      const invoice = await stripe.invoices.retrieve(order.stripe_invoice_id);
      if (invoice.id !== order.stripe_invoice_id || invoice.livemode !== (scope.mode === 'live')
        || !matchesPreTax(invoice.amount_paid, (invoice.total_taxes ?? []).reduce((sum, row) => sum + (row.amount ?? 0), 0),
          order.amount_total) || invoice.currency !== order.currency) {
        throw new Error('PAY_COMMON_INVOICE_RECEIPT_MISMATCH');
      }
      return {
        invoiceNumber: invoice.number ?? null,
        invoicePdfUrl: invoice.invoice_pdf ?? null,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        receiptUrl: null,
      };
    }

    if (!order.stripe_checkout_session_id) {
      return emptyDocument;
    }

    const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id, {
      expand: ['payment_intent.latest_charge'],
    });

    if (session.id !== order.stripe_checkout_session_id || session.metadata?.userId !== order.user_id
      || session.metadata?.orderId !== order.id || session.livemode !== (scope.mode === 'live')
      || !matchesPreTax(session.amount_total, session.total_details?.amount_tax, order.amount_total)
      || session.currency !== order.currency) {
      throw new Error('PAY_COMMON_RECEIPT_MISMATCH');
    }
    if (typeof session.payment_intent === 'string') throw new Error('PAY_COMMON_RECEIPT_NOT_EXPANDED');
    const paymentIntent = typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null;
    const latestCharge = paymentIntent?.latest_charge;
    if (typeof latestCharge === 'string') throw new Error('PAY_COMMON_RECEIPT_NOT_EXPANDED');
    const receiptUrl =
      latestCharge && typeof latestCharge === 'object' && 'receipt_url' in latestCharge
        ? latestCharge.receipt_url ?? null
        : null;

    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl,
    };
  } catch (error) {
    logger.warn('billing', 'payments_billing_document_lookup_failed', {
      orderId: order.id,
      stripeInvoiceId: order.stripe_invoice_id ?? null,
      stripeCheckoutSessionId: order.stripe_checkout_session_id ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ...emptyDocument, documentStatus: 'unknown' as const };
  }
}

export function createStripeBillingDocumentLoader(stripe: ReturnType<typeof getStripeClient> | null, supabase: SupabaseClient) {
  const documentCache = new Map<string, Promise<Awaited<ReturnType<typeof loadStripeBillingDocument>>>>();

  return async (order: PaymentOrderBillingRow) => {
    const cacheKey = `order:${order.id}`;

    const cached = documentCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = loadStripeBillingDocument(stripe, supabase, order);
    documentCache.set(cacheKey, promise);
    return promise;
  };
}
