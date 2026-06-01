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
    getStripeWebhookSecret: vi.fn(() => 'whsec_test_secret'),
    logServerError: vi.fn(),
    reconcileStripeRefund: vi.fn(),
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
  reconcileStripeRefund: routeMocks.reconcileStripeRefund,
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

  it('routes charge.refunded to refund reconciliation with the charge payload', async () => {
    const charge = { id: 'ch_test_refunded', object: 'charge' };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_charge_refunded',
      type: 'charge.refunded',
      data: { object: charge },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.retrieveCharge).toHaveBeenCalledWith(
      'ch_test_refunded',
      {
        expand: expect.arrayContaining([
          'payment_intent',
        ]),
      },
    );
    expect(routeMocks.reconcileStripeRefund).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      {
        eventId: 'evt_test_charge_refunded',
        eventType: 'charge.refunded',
        charge,
      },
    );
  });

  it.each([
    'charge.refund.updated',
    'refund.created',
    'refund.updated',
    'refund.failed',
  ] as const)('routes %s to refund reconciliation with the refund payload', async (eventType) => {
    const refund = { id: `re_test_${eventType.replaceAll('.', '_')}`, object: 'refund' };
    routeMocks.retrieveRefund.mockResolvedValue(refund);
    routeMocks.constructEvent.mockReturnValue({
      id: `evt_test_${eventType.replaceAll('.', '_')}`,
      type: eventType,
      data: { object: refund },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.retrieveRefund).toHaveBeenCalledWith(
      refund.id,
      {
        expand: expect.arrayContaining([
          'charge',
          'charge.payment_intent',
          'payment_intent',
        ]),
      },
    );
    expect(routeMocks.reconcileStripeRefund).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      {
        eventId: `evt_test_${eventType.replaceAll('.', '_')}`,
        eventType,
        refund,
      },
    );
  });

  it('enriches charge.refunded payloads with payment intent invoice lookup details', async () => {
    const charge = { id: 'ch_test_subscription_refunded', object: 'charge' };
    const enrichedCharge = {
      ...charge,
      amount: 990,
      amount_refunded: 990,
      payment_intent: {
        id: 'pi_test_subscription_refunded',
      },
      refunded: true,
    };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_subscription_charge_refunded',
      type: 'charge.refunded',
      data: { object: charge },
    });
    routeMocks.retrieveCharge.mockResolvedValue(enrichedCharge);
    routeMocks.listInvoicePayments.mockResolvedValue({
      data: [
        {
          invoice: 'in_test_subscription_refunded',
        },
      ],
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.listInvoicePayments).toHaveBeenCalledWith({
      limit: 1,
      payment: {
        type: 'payment_intent',
        payment_intent: 'pi_test_subscription_refunded',
      },
      expand: expect.arrayContaining(['data.invoice']),
    });
    expect(routeMocks.reconcileStripeRefund).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      {
        eventId: 'evt_test_subscription_charge_refunded',
        eventType: 'charge.refunded',
        charge: expect.objectContaining({
          id: 'ch_test_subscription_refunded',
          payment_intent: expect.objectContaining({
            id: 'pi_test_subscription_refunded',
            invoice: 'in_test_subscription_refunded',
          }),
        }),
      },
    );
  });

  it('enriches refund payloads with expanded charge payment intent invoice lookup details', async () => {
    const refund = {
      id: 're_test_subscription_refund_created',
      object: 'refund',
      charge: 'ch_test_subscription_refund_created',
    };
    const enrichedRefund = {
      ...refund,
      payment_intent: 'pi_test_subscription_refund_created',
    };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_subscription_refund_created',
      type: 'refund.created',
      data: { object: refund },
    });
    routeMocks.retrieveRefund.mockResolvedValue(enrichedRefund);
    routeMocks.retrieveCharge.mockResolvedValue({
      id: 'ch_test_subscription_refund_created',
      payment_intent: {
        id: 'pi_test_subscription_refund_created',
      },
    });
    routeMocks.listInvoicePayments.mockResolvedValue({
      data: [
        {
          invoice: 'in_test_subscription_refund_created',
        },
      ],
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.retrieveCharge).toHaveBeenCalledWith(
      'ch_test_subscription_refund_created',
      {
        expand: expect.arrayContaining([
          'payment_intent',
        ]),
      },
    );
    expect(routeMocks.reconcileStripeRefund).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      {
        eventId: 'evt_test_subscription_refund_created',
        eventType: 'refund.created',
        refund: expect.objectContaining({
          id: 're_test_subscription_refund_created',
          charge: expect.objectContaining({
            id: 'ch_test_subscription_refund_created',
            payment_intent: expect.objectContaining({
              invoice: 'in_test_subscription_refund_created',
            }),
          }),
          payment_intent: expect.objectContaining({
            invoice: 'in_test_subscription_refund_created',
          }),
        }),
      },
    );
  });

  it('retrieves invoice.payment_succeeded with invoice payment expansions before fulfillment', async () => {
    const invoice = { id: 'in_test_invoice_payment_succeeded', object: 'invoice' };
    const expandedInvoice = {
      ...invoice,
      payments: {
        data: [
          {
            payment: {
              payment_intent: {
                id: 'pi_test_invoice_payment_succeeded',
                latest_charge: 'ch_test_invoice_payment_succeeded',
              },
            },
          },
        ],
      },
    };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_invoice_payment_succeeded',
      type: 'invoice.payment_succeeded',
      data: { object: invoice },
    });
    routeMocks.retrieveInvoice.mockResolvedValue(expandedInvoice);

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.retrieveInvoice).toHaveBeenCalledWith(
      'in_test_invoice_payment_succeeded',
      {
        expand: expect.arrayContaining([
          'payments',
          'payments.data.payment.charge',
          'payments.data.payment.payment_intent',
          'payments.data.payment.payment_intent.latest_charge',
        ]),
      },
    );
    expect(routeMocks.fulfillMembershipInvoice).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      expandedInvoice,
    );
  });

  it('continues invoice fulfillment with the webhook invoice when lookup expansion fails', async () => {
    const invoice = { id: 'in_test_invoice_retrieve_failure', object: 'invoice' };
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_invoice_retrieve_failure',
      type: 'invoice.payment_succeeded',
      data: { object: invoice },
    });
    routeMocks.retrieveInvoice.mockRejectedValue(new Error('Stripe retrieve unavailable'));

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.fulfillMembershipInvoice).toHaveBeenCalledWith(
      routeMocks.supabaseClient,
      invoice,
    );
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_invoice_refund_lookup_retrieve_failed',
      { invoiceId: 'in_test_...ailure' },
    );
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
    expect(routeMocks.reconcileStripeRefund).not.toHaveBeenCalled();
    expect(routeMocks.fulfillCreditPackageOrder).not.toHaveBeenCalled();
    expect(routeMocks.fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(routeMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
  });

  it('safely ignores unknown Stripe events', async () => {
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_unknown',
      type: 'customer.created',
      data: { object: { id: 'cus_test_unknown' } },
    });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.reconcileStripeRefund).not.toHaveBeenCalled();
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
    routeMocks.reconcileStripeRefund.mockRejectedValue(new Error('rpc failure'));

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_webhook_handler_failed',
      { eventType: 'refund.created' },
    );
  });
});
