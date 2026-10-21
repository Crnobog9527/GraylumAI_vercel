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

describe('ordinary wallet renewal checkout target', () => {
  const prior = { subscription_id: 'wallet-source', purchase_membership_level: 'gold', payment_method: 'alipay',
    billing_cycle: 'monthly', offer_kind: 'gold_first30', entitlement_end: '2026-11-21T00:00:00Z',
    auto_renew: false, cancel_at_period_end: true };
  const action = { kind: 'wallet_renewal' as const, label: '改为年付', disabled: false as const, priorSubscriptionId: prior.subscription_id };
  it('explains preserved time and delayed monthly credits, and names the source term', () => {
    const target = planCheckoutTarget({ plan, billing: 'yearly', action, prior, goldFirstMonth: true, founderSeats: 0 });
    expect(target?.purchase).toEqual({ itemType: 'membership_plan', itemId: plan.id, billingCycle: 'yearly',
      offer: 'standard', transition: 'wallet_renewal', priorSubscriptionId: prior.subscription_id });
    expect(target?.description).toBe('一次性付款，会员新期限从原到期日接续。');
    expect(target?.details?.join(' ')).toContain('2026/11/21 接续');
    expect(target?.details?.join(' ')).toContain('不会提前发放新一期积分');
    expect(planCheckoutTarget({ plan, billing: 'monthly', action, prior, goldFirstMonth: true, founderSeats: 0 })?.purchase.offer)
      .toBe('standard');
  });
  it('keeps the existing first founder annual offer and requires the matching wallet source', () => {
    expect(planCheckoutTarget({ plan, billing: 'yearly', action, prior, goldFirstMonth: false, founderSeats: 10 })?.purchase.offer)
      .toBe('founder');
    expect(planCheckoutTarget({ plan, billing: 'yearly', action, prior: null, goldFirstMonth: false, founderSeats: 0 })).toBeNull();
    expect(planCheckoutTarget({ plan, billing: 'yearly', action, prior: { ...prior, payment_method: 'card' },
      goldFirstMonth: false, founderSeats: 0 })).toBeNull();
    expect(planCheckoutTarget({ plan, billing: 'yearly', action, prior: { ...prior, offer_kind: 'founder' },
      goldFirstMonth: false, founderSeats: 0 })).toBeNull();
  });
});
