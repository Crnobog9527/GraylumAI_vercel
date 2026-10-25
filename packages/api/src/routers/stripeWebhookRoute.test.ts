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
    logServerWarn: vi.fn(),
    handleCardRefund: vi.fn(),
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

// Card / wallet method orders are covered in services/__tests__/stripeWebhookRoute.test.ts.
vi.mock('@repo/api/src/services/payments/walletWebhook', () => ({ recoverMethodCheckout: vi.fn().mockResolvedValue(null) }));
vi.mock('@repo/api/src/services/payments/cardSubscriptionWebhook', () => ({
  handleCardSubscriptionInvoice: vi.fn().mockResolvedValue(false), handleCardSubscriptionState: vi.fn().mockResolvedValue(false) }));
vi.mock('@repo/api/src/services/payments/cardRefundWebhook', () => ({ handleCardRefund: routeMocks.handleCardRefund }));
vi.mock('@/lib/server-log', () => ({
  logServerError: routeMocks.logServerError,
  logServerWarn: routeMocks.logServerWarn,
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

describe('stripe webhook route with the legacy fallback closed (ARCH-FIX F2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.listInvoicePayments.mockReset();
    routeMocks.retrieveCharge.mockReset();
    routeMocks.retrieveRefund.mockReset();
    routeMocks.retrieveInvoice.mockReset();
    routeMocks.handleCardRefund.mockReset().mockResolvedValue(false);
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

  const legacyFulfillment = () => [routeMocks.fulfillCreditPackageOrder, routeMocks.fulfillMembershipInvoice,
    routeMocks.markMembershipInvoicePaymentFailed, routeMocks.reconcileSubscriptionRefundFromStripeWebhook,
    routeMocks.syncSubscriptionState, routeMocks.upsertPaymentOrderBySession];

  it.each([
    ['charge.refunded', { id: 'ch_test_refunded', object: 'charge' }],
    ['refund.created', { id: 're_test_created', object: 'refund' }],
    ['invoice.payment_succeeded', { id: 'in_test_legacy', object: 'invoice' }],
    ['invoice.payment_failed', { id: 'in_test_legacy_failed', object: 'invoice' }],
    ['customer.subscription.updated', { id: 'sub_test_legacy', object: 'subscription', status: 'active' }],
    ['customer.subscription.deleted', { id: 'sub_test_legacy', object: 'subscription', status: 'canceled' }],
    ['customer.created', { id: 'cus_test_unknown' }],
  ] as const)('acknowledges an unclaimed legacy %s with 200, logs it, and changes no credits', async (eventType, object) => {
    routeMocks.constructEvent.mockReturnValue({ id: `evt_test_${eventType.replaceAll('.', '_')}`, type: eventType, data: { object } });

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(200);
    legacyFulfillment().forEach(mock => expect(mock).not.toHaveBeenCalled());
    expect(routeMocks.logServerWarn).toHaveBeenCalledWith('billing', 'stripe_webhook_unclaimed', { eventType });
    expect(routeMocks.logServerError).not.toHaveBeenCalled();
  });

  it('still returns 500 and logs when a current handler fails, so Stripe retries', async () => {
    routeMocks.constructEvent.mockReturnValue({
      id: 'evt_test_refund_handler_failure',
      type: 'refund.created',
      data: { object: { id: 're_test_handler_failure' } },
    });
    routeMocks.handleCardRefund.mockRejectedValue(new Error('rpc failure'));

    const response = await POST(makeWebhookRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.logServerError).toHaveBeenCalledWith(
      'billing',
      'stripe_webhook_handler_failed',
      { eventType: 'refund.created', code: 'PAY_COMMON_WEBHOOK_HANDLER_FAILED' },
    );
    legacyFulfillment().forEach(mock => expect(mock).not.toHaveBeenCalled());
  });
});
