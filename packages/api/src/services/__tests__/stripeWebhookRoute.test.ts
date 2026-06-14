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

  it.each(['refund.created', 'refund.updated', 'charge.refunded'])(
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
      expect(stripeFulfillmentMocks.markMembershipInvoicePaymentFailed).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.syncSubscriptionState).not.toHaveBeenCalled();
      expect(stripeFulfillmentMocks.upsertPaymentOrderBySession).not.toHaveBeenCalled();
    },
  );
});
