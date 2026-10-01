/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertFusionEntitlement, readMembershipEntitlements } from './membershipEntitlements';
import { actorId, fixture, subscription } from './__tests__/entitlementsFixture';

// Values copied from the persistence boundaries, not from the entitlement classifier.
// payments.ts:691 (upgrade) persists the provider subscription status with pending.
const upgrade = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'canceled', 'incomplete_expired', 'paused']
  .map(payment => ({ source: 'upgrade', status: 'pending', payment, blocked: false }));
// payments.ts:1662 / stripeFulfillment.ts:1721 + mergePaymentOrderStatus preserve
// terminal order states while refreshing Checkout's paid/unpaid/no_payment_required.
const checkout = ['pending', 'completed', 'failed', 'canceled', 'expired', 'refunded', 'partially_refunded']
  .flatMap(status => ['paid', 'unpaid', 'no_payment_required', null].map(payment => ({
    source: 'checkout', status, payment, blocked: status === 'refunded' || status === 'partially_refunded',
  })));
// stripeFulfillment.ts:1992/2165 failure and subscriptionCreditGrants.ts:2716/2911
// success persist invoice.status (including fallback strings at their call boundary).
const invoice = ['failed', 'completed'].flatMap(status =>
  ['draft', 'open', 'paid', 'void', 'uncollectible', 'payment_failed'].map(payment => ({
    source: 'invoice', status, payment, blocked: false,
  })));
// subscriptionCreditGrants.ts:1576 and legacy refund aliases consumed by paymentOrderStatus.
const refund = [
  ['refunded', 'refunded'], ['partially_refunded', 'partially_refunded'], ['partial_refunded', 'partial_refunded'],
  ['completed', 'refunded'], ['completed', 'partially_refunded'], ['completed', 'partial_refunded'],
].map(([status, payment]) => ({ source: 'refund', status, payment, blocked: true }));
const other = [
  { source: 'retired upgrade', status: 'failed', payment: 'failed', blocked: false },
  { source: 'legacy cancel', status: 'cancelled', payment: 'unpaid', blocked: false },
];

describe('persisted order combinations do not replace current membership state', () => {
  it.each([...upgrade, ...checkout, ...invoice, ...refund, ...other])(
    '$source status=$status payment_status=$payment', async ({ status, payment, blocked }) => {
      const f = fixture();
      f.rows.user_subscriptions = [subscription()];
      f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status, payment_status: payment, metadata: {} }];
      const result = await readMembershipEntitlements(f.client, actorId);
      expect(result).toMatchObject(blocked
        ? { level: 'free', state: 'refunded_requires_policy', reasonCode: 'REFUNDED_ORDER_REQUIRES_POLICY' }
        : { level: 'pro', state: 'active', libraryStorageBytes: 500_000_000 });
      for (const mode of ['review', 'compare'] as const) {
        const action = () => assertFusionEntitlement(result, mode, 2);
        if (blocked) expect(action).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
        else expect(action).not.toThrow();
      }
      expect(f.writes).toEqual([]);
    },
  );
});
