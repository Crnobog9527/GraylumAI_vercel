/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { planCheckoutTarget } from './planCheckoutTarget';

const plan = { id: 'gold-current', name: 'Gold', level: 'gold' as const,
  price: { monthly: 99, yearly: 999 }, credits: { monthly: 100, monthlyBonus: 0 }, discount: 0,
  checkoutReady: { monthly: true, yearly: true } };

describe('founder wallet renewal checkout target', () => {
  it('builds the original-plan, one-time $496 renewal transition through the deadline', () => {
    const target = planCheckoutTarget({ plan, billing: 'yearly', action: { kind: 'founder_renewal', label: '续买创始会员一年',
      disabled: false, priorSubscriptionId: 'source-subscription' }, prior: null, goldFirstMonth: false, founderSeats: 0,
    founderRenewal: { itemId: 'original-gold-plan', subscriptionId: 'source-subscription', eligibleUntil: '2026-10-28T00:00:00Z' } });
    expect(target?.purchase).toEqual({ itemType: 'membership_plan', itemId: 'original-gold-plan', billingCycle: 'yearly',
      offer: 'founder_renewal', transition: 'founder_renewal', priorSubscriptionId: 'source-subscription' });
    expect(target).toMatchObject({ price: '$496 / 年', renewal: '一次性付款 $496，不自动续费。' });
    expect(target?.details?.join(' ')).toContain('2026/10/28');
  });

  it('never creates a renewal target without the server-projected source or on another plan/cycle', () => {
    const action = { kind: 'founder_renewal' as const, label: '续买创始会员一年', disabled: false as const };
    expect(planCheckoutTarget({ plan, billing: 'yearly', action, prior: null, goldFirstMonth: false, founderSeats: 0 })).toBeNull();
    expect(planCheckoutTarget({ plan, billing: 'monthly', action, prior: null, goldFirstMonth: false, founderSeats: 0,
      founderRenewal: { itemId: plan.id, subscriptionId: 'source', eligibleUntil: '2026-10-28T00:00:00Z' } })).toBeNull();
  });
});
