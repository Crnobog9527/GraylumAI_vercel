/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => {
  const supabaseClient = { serviceRole: true };

  return {
    constructEvent: vi.fn(),
    createServiceRoleSupabaseClient: vi.fn(() => supabaseClient),
    fulfillCreditPackageOrder: vi.fn(),
    fulfillMembershipInvoice: vi.fn(),
    markMembershipInvoicePaymentFailed: vi.fn(),
    getStripeWebhookSecret: vi.fn(() => 'whsec_test_secret'),
    logServerError: vi.fn(),
    reconcileSubscriptionRefundFromStripeWebhook: vi.fn(),
    listInvoicePayments: vi.fn(),
    retrieveCharge: vi.fn(),
    retrieveRefund: vi.fn(),
    retrieveInvoice: vi.fn(),
    supabaseClient,
    syncSubscriptionState: vi.fn(),
    upsertPaymentOrderBySession: vi.fn(),
  };
});

vi.mock('@repo/api/src/services/stripe', () => ({
  createServiceRoleSupabaseClient: routeMocks.createServiceRoleSupabaseClient,
  getStripeClient: () => ({
    charges: {
      retrieve: routeMocks.retrieveCharge,
    },
    invoices: {
      retrieve: routeMocks.retrieveInvoice,
    },
    invoicePayments: {
      list: routeMocks.listInvoicePayments,
    },
    refunds: {
      retrieve: routeMocks.retrieveRefund,
    },
    webhooks: {
      constructEvent: routeMocks.constructEvent,
    },
  }),
  getStripeWebhookSecret: routeMocks.getStripeWebhookSecret,
}));

vi.mock('@repo/api/src/services/stripeFulfillment', () => ({
  fulfillCreditPackageOrder: routeMocks.fulfillCreditPackageOrder,
  fulfillMembershipInvoice: routeMocks.fulfillMembershipInvoice,
  markMembershipInvoicePaymentFailed: routeMocks.markMembershipInvoicePaymentFailed,
  reconcileSubscriptionRefundFromStripeWebhook: routeMocks.reconcileSubscriptionRefundFromStripeWebhook,
  syncSubscriptionState: routeMocks.syncSubscriptionState,
  upsertPaymentOrderBySession: routeMocks.upsertPaymentOrderBySession,
}));

vi.mock('@/lib/server-log', () => ({
  logServerError: routeMocks.logServerError,
}));

const { POST } = await import('../../../../apps/web/src/app/api/stripe/webhook/route');

function makeWebhookRequest(signature = 'sig_test') {
  return new Request('https://graylum.test/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'stripe-signature': signature,
    },
    body: JSON.stringify({ object: 'event' }),
  });
}

describe('stripe webhook route refund routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.listInvoicePayments.mockReset();
    routeMocks.retrieveCharge.mockReset();
    routeMocks.retrieveRefund.mockReset();
    routeMocks.retrieveInvoice.mockReset();
  });

  it('returns 400 for invalid Stripe webhook signatures', async () => {
    routeMocks.constructEvent.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(400);
    expect(routeMocks.createServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_webhook_invalid_signature',
    );
  });

  it.each([
    'charge.refunded',
    'charge.refund.updated',
    'refund.created',
    'refund.updated',
    'refund.failed',
  ] as const)('routes %s to subscription refund reconciliation with the full event', async (eventType) => {
    const stripeObject = eventType === 'charge.refunded'
      ? { id: 'ch_test_refunded', object: 'charge' }
      : { id: `re_test_${eventType.replaceAll('.', '_')}`, object: 'refund' };
    const event = {
      id: `evt_test_${eventType.replaceAll('.', '_')}`,
      type: eventType,
      data: { object: stripeObject },
    };
    routeMocks.constructEvent.mockReturnValue(event);

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.reconcileSubscriptionRefundFromStripeWebhook).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      event,
    );
    expect(routeMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(routeMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(routeMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it('routes invoice.payment_succeeded to membership invoice fulfillment', async () => {
    const invoice = { id: 'in_test_invoice_payment_succeeded', object: 'invoice' };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_invoice_payment_succeeded',
      type: 'invoice.payment_succeeded',
      data: { object: invoice },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.fulfillMembershipInvoice).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      invoice,
    );
  });

  it('routes invoice.payment_failed to failed membership invoice handling', async () => {
    const invoice = { id: 'in_test_invoice_payment_failed', object: 'invoice' };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_invoice_payment_failed',
      type: 'invoice.payment_failed',
      data: { object: invoice },
    });

    const response = await POST(makeWebhookRequest());

    expect(routeMocks.markMembershipInvoicePaymentFailed).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      invoice,
    );
    expect(response.status).toBe(200);
  });

  it.each([
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])('routes %s to subscription state sync only', async (eventType) => {
    const subscription = {
      id: 'sub_test_cancel_only',
      object: 'subscription',
      status: eventType.endsWith('deleted') ? 'canceled' : 'active',
      cancel_at_period_end: eventType.endsWith('updated'),
    };
    routeMocks.constructEvent.mockReturnValue({
      id: `evt_test_${eventType.replaceAll('.', '_')}`,
      type: eventType,
      data: { object: subscription },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.syncSubscriptionState).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      subscription,
    );
    expect(routeMocks.reconcileSubscriptionRefundFromStripeWebhook).not.toHaveBeenCalled();
    expect(routeMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(routeMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(routeMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it('returns 500 when subscription state sync fails', async () => {
    const subscription = {
      id: 'sub_test_deleted_retryable',
      object: 'subscription',
      status: 'canceled',
      cancel_at_period_end: false,
    };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_subscription_deleted_failure',
      type: 'customer.subscription.deleted',
      data: { object: subscription },
    });
    routeMocks.syncSubscriptionState.mockRejectedValueOnce(new Error('profile downgrade recovery failed'));

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.syncSubscriptionState).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      subscription,
    );
    expect(routeMocks.reconcileSubscriptionRefundFromStripeWebhook).not.toHaveBeenCalled();
    expect(routeMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(routeMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(routeMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_webhook_handler_failed',
      { eventType: 'customer.subscription.deleted' },
    );
  });

  it('safely ignores unknown Stripe events', async () => {
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_unknown',
      type: 'customer.created',
      data: { object: { id: 'cus_test_unknown' } },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.reconcileSubscriptionRefundFromStripeWebhook).not.toHaveBeenCalled();
    expect(routeMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(routeMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(routeMocks.syncSubscriptionState).not.toHaveBeenCalled();
    expect(routeMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when a refund handler fails', async () => {
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_refund_handler_failure',
      type: 'refund.created',
      data: { object: { id: 're_test_handler_failure' } },
    });
    routeMocks.reconcileSubscriptionRefundFromStripeWebhook.mockRejectedValue(new Error('rpc failure'));

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_webhook_handler_failed',
      { eventType: 'refund.created' },
    );
  });
});
