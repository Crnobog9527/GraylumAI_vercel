/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripeServiceMocks = vi.hoisted(() => ({
  createServiceRoleSupabaseClient: vi.fn(),
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn(),
}));

const stripeFulfillmentMocks = vi.hoisted(() => ({
  fulfillCreditPackageOrder: vi.fn(),
  fulfillMembershipInvoice: vi.fn(),
  fulfillPaidMembershipCheckoutSession: vi.fn(),
  markMembershipInvoicePaymentFailed: vi.fn(),
  reconcileSubscriptionRefundFromStripeWebhook: vi.fn(),
  syncSubscriptionState: vi.fn(),
  upsertPaymentOrderBySession: vi.fn(),
}));

vi.mock('@repo/api/src/services/stripe', () => stripeServiceMocks);
vi.mock('@repo/api/src/services/stripeFulfillment', () => stripeFulfillmentMocks);
vi.mock('@/lib/server-log', () => ({
  logServerError: vi.fn(),
}));

import { handleStripeWebhookEvent } from '../../../../../apps/web/src/app/api/stripe/webhook/route';

describe('stripe webhook route', () => {
  beforeEach(() => {
    Object.values(stripeServiceMocks).forEach((mock) => mock.mockReset());
    Object.values(stripeFulfillmentMocks).forEach((mock) => mock.mockReset());
  });

  it.each(['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated', 'charge.refunded'])(
    'routes %s to subscription refund grant reconciliation',
    async (eventType) => {
      const supabase = { source: 'service-role-client' };
      const event = {
        id: `evt_${eventType.replace('.', '_')}`,
        type: eventType,
        data: {
          object: {
            id: eventType === 'charge.refunded' ? 'ch_test_refunded' : 're_test_refund',
          },
        },
      };

      await handleStripeWebhookEvent(supabase, event as any);

      expect(stripeFulfillmentMocks.reconcileSubscriptionRefundFromStripeWebhook)
        .toHaveBeenCalledWith(supabase, event);
      expect(stripeFulfillmentMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.fulfillPaidMembershipCheckoutSession).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.markMembershipInvoicePaymentFailed).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.syncSubscriptionState).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
    },
  );

  it('propagates subscription refund reconciliation failures so webhook delivery can retry', async () => {
    const supabase = { source: 'service-role-client' };
    const event = {
      id: 'evt_refund_created_retry_order_missing',
      type: 'refund.created',
      data: {
        object: {
          id: 're_test_retry_order_missing',
        },
      },
    };
    const retryError = new Error('subscription refund invoice payment order missing; retry webhook');

    stripeFulfillmentMocks.reconcileSubscriptionRefundFromStripeWebhook
      .mockRejectedValueOnce(retryError);

    await expect(handleStripeWebhookEvent(supabase, event as any)).rejects.toThrow(retryError);
    expect(stripeFulfillmentMocks.reconcileSubscriptionRefundFromStripeWebhook)
      .toHaveBeenCalledWith(supabase, event);
  });

  it('fulfills paid subscription checkout sessions after recording the session order', async () => {
    const supabase = { source: 'service-role-client' };
    const stripe = { source: 'stripe-client' };
    const session = {
      id: 'cs_test_paid_subscription',
      mode: 'subscription',
      payment_status: 'paid',
      subscription: 'sub_test_paid_subscription',
    };
    const event = {
      id: 'evt_checkout_session_completed_subscription',
      type: 'checkout.session.completed',
      data: {
        object: session,
      },
    };

    stripeServiceMocks.getStripeClient.mockReturnValue(stripe);

    await handleStripeWebhookEvent(supabase, event as any);

    expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).toHaveBeenCalledWith(supabase, session, {
      eventType: 'checkout.session.completed',
    });
    expect(stripeFulfillmentMocks.fulfillPaidMembershipCheckoutSession)
      .toHaveBeenCalledWith(supabase, stripe, session);
    expect(stripeFulfillmentMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(stripeFulfillmentMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
  });

  it.each(['invoice.payment_succeeded', 'invoice.paid'])(
    'routes %s to membership invoice fulfillment',
    async (eventType) => {
      const supabase = { source: 'service-role-client' };
      const invoice = {
        id: `in_${eventType.replace('.', '_')}`,
        status: 'paid',
      };
      const event = {
        id: `evt_${eventType.replace('.', '_')}`,
        type: eventType,
        data: {
          object: invoice,
        },
      };

      await handleStripeWebhookEvent(supabase, event as any);

      expect(stripeFulfillmentMocks.fulfillMembershipInvoice)
        .toHaveBeenCalledWith(supabase, invoice);
      expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.fulfillPaidMembershipCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it.each(['customer.subscription.created', 'customer.subscription.updated'])(
    'routes %s to subscription state sync',
    async (eventType) => {
      const supabase = { source: 'service-role-client' };
      const safeEventType = eventType.replace(/\./g, '_');
      const subscription = {
        id: `sub_${safeEventType}`,
        status: 'active',
      };
      const event = {
        id: `evt_${safeEventType}`,
        type: eventType,
        data: {
          object: subscription,
        },
      };

      await handleStripeWebhookEvent(supabase, event as any);

      expect(stripeFulfillmentMocks.syncSubscriptionState)
        .toHaveBeenCalledWith(supabase, subscription);
      expect(stripeFulfillmentMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.fulfillPaidMembershipCheckoutSession).not.toHaveBeenCalled();
    },
  );
});
