/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const walletMocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('@repo/api/src/services/payments/walletWebhook', () => ({ recoverWalletCheckout: walletMocks.recover }));

const alertMocks = vi.hoisted(() => ({ captureMessage: vi.fn(), logServerError: vi.fn() }));
vi.mock('../../../../../apps/web/node_modules/@sentry/nextjs', () => ({ captureMessage: alertMocks.captureMessage }));

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
  logServerError: alertMocks.logServerError,
}));

import { handleStripeWebhookEvent, POST } from '../../../../../apps/web/src/app/api/stripe/webhook/route';

describe('stripe webhook route', () => {
  beforeEach(() => {
    walletMocks.recover.mockReset().mockResolvedValue(false);
    Object.values(alertMocks).forEach((mock) => mock.mockReset());
    Object.values(stripeServiceMocks).forEach((mock) => mock.mockReset());
    Object.values(stripeFulfillmentMocks).forEach((mock) => mock.mockReset());
  });

  it('routes method wallet delivery once and never falls through on recovery timeout', async () => {
    const event = { type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_wallet' } } } as Stripe.Event;
    walletMocks.recover.mockResolvedValue(true);
    await handleStripeWebhookEvent({} as never, event);
    expect(stripeFulfillmentMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
    walletMocks.recover.mockRejectedValue(new Error('timeout'));
    await expect(handleStripeWebhookEvent({} as never, event)).rejects.toThrow('timeout');
    expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it('passes the verified asynchronous failure event into wallet reconciliation', async () => {
    const event = { type: 'checkout.session.async_payment_failed', data: { object: { id: 'cs_failed' } } } as Stripe.Event;
    walletMocks.recover.mockResolvedValue(true);
    await handleStripeWebhookEvent({} as never, event);
    expect(walletMocks.recover).toHaveBeenCalledWith({}, undefined, 'cs_failed', 'checkout.session.async_payment_failed');
    expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it.each(['PAY_COMMON_RECEIPT_MISMATCH', 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH'])(
    'reports signed payment evidence conflict %s through existing logs and Sentry', async (reason) => {
      const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_fixture' } } };
      const stripe = new Stripe('fixture-client');
      const rawBody = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: 'fixture-signature-secret' });
      const constructEvent = vi.fn(stripe.webhooks.constructEvent.bind(stripe.webhooks));
      stripeServiceMocks.getStripeClient.mockReturnValue({ webhooks: { constructEvent } });
      stripeServiceMocks.getStripeWebhookSecret.mockReturnValue('fixture-signature-secret');
      stripeFulfillmentMocks.upsertPaymentOrderBySession.mockRejectedValue(new Error('write failed', { cause: { message: reason } }));
      const response = await POST(new Request('https://example.test/api/stripe/webhook', {
        method: 'POST', headers: { 'stripe-signature': signature }, body: rawBody,
      }));
      expect(constructEvent).toHaveBeenCalledWith(rawBody, signature, 'fixture-signature-secret');
      expect(response.status).toBe(500);
      expect(alertMocks.logServerError).toHaveBeenCalledWith('billing', 'stripe_webhook_handler_failed', {
        code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT', eventType: event.type,
      });
      expect(alertMocks.captureMessage).toHaveBeenCalledWith('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT', {
        level: 'error', fingerprint: ['PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'],
        tags: { category: 'billing', code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT', eventType: event.type },
      });
      expect(stripeFulfillmentMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid signature without classifying untrusted content as a financial conflict', async () => {
    stripeServiceMocks.getStripeClient.mockReturnValue(new Stripe('fixture-client'));
    stripeServiceMocks.getStripeWebhookSecret.mockReturnValue('fixture-signature-secret');
    const response = await POST(new Request('https://example.test/api/stripe/webhook', {
      method: 'POST', headers: { 'stripe-signature': 'invalid' }, body: 'untrusted',
    }));
    expect(response.status).toBe(400);
    expect(alertMocks.logServerError).toHaveBeenCalledWith('billing', 'stripe_webhook_invalid_signature');
    expect(alertMocks.captureMessage).not.toHaveBeenCalled();
    expect(stripeServiceMocks.createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('keeps a signed event transport failure retryable without a payment conflict alarm', async () => {
    const event = { type: 'invoice.paid', data: { object: { id: 'in_fixture' } } };
    stripeServiceMocks.getStripeClient.mockReturnValue({ webhooks: { constructEvent: () => event } });
    stripeFulfillmentMocks.fulfillMembershipInvoice.mockRejectedValue(new Error('ETIMEDOUT'));
    const response = await POST(new Request('https://example.test/api/stripe/webhook', {
      method: 'POST', headers: { 'stripe-signature': 'fixture-signature' }, body: 'fixture-body',
    }));
    expect(response.status).toBe(500);
    expect(alertMocks.logServerError).toHaveBeenCalledWith('billing', 'stripe_webhook_handler_failed', {
      code: 'PAY_COMMON_WEBHOOK_HANDLER_FAILED', eventType: 'invoice.paid',
    });
    expect(alertMocks.captureMessage).not.toHaveBeenCalled();
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
    stripeFulfillmentMocks.upsertPaymentOrderBySession.mockResolvedValue(session);

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
