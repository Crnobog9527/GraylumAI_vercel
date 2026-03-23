import { describe, expect, it } from 'vitest';
import {
  getAdminMembershipOverrideErrorMessage,
  isStripeManagedSubscriptionActive,
} from '../subscriptionOverrides';

describe('isStripeManagedSubscriptionActive', () => {
  it('returns true for active Stripe-managed subscriptions', () => {
    expect(
      isStripeManagedSubscriptionActive({
        stripeSubscriptionId: 'sub_123',
        status: 'active',
      })
    ).toBe(true);
  });

  it('returns true for past_due subscriptions because they are still Stripe-managed', () => {
    expect(
      isStripeManagedSubscriptionActive({
        stripeSubscriptionId: 'sub_123',
        status: 'past_due',
      })
    ).toBe(true);
  });

  it('returns false when there is no Stripe subscription id', () => {
    expect(
      isStripeManagedSubscriptionActive({
        stripeSubscriptionId: null,
        status: 'active',
      })
    ).toBe(false);
  });

  it('returns false for canceled subscriptions', () => {
    expect(
      isStripeManagedSubscriptionActive({
        stripeSubscriptionId: 'sub_123',
        status: 'canceled',
      })
    ).toBe(false);
  });
});

describe('getAdminMembershipOverrideErrorMessage', () => {
  it('returns a clear operator-facing error message', () => {
    expect(getAdminMembershipOverrideErrorMessage()).toContain('Stripe 订阅');
  });
});
