/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { currentMethodMembership, describeMethodMembership, methodPlanAction, type MethodMembershipRow } from './methodPlanAction';

const NOW = Date.parse('2026-10-14T00:00:00Z');
const row = (patch: Partial<MethodMembershipRow> = {}): MethodMembershipRow => ({
  subscription_id: '00000000-0000-4000-8000-000000000001', purchase_membership_level: 'pro', payment_method: 'card',
  billing_cycle: 'monthly', offer_kind: 'standard', entitlement_end: '2026-11-14T12:00:00Z', auto_renew: true,
  cancel_at_period_end: false, ...patch,
});
const ready = { price: 29, checkoutReady: true };

describe('plan buttons', () => {
  it('lets a non-member buy, and keeps free, unready and unpriced plans without a purchase', () => {
    expect(methodPlanAction({ level: 'pro', ...ready, current: null })).toMatchObject({ kind: 'buy', disabled: false });
    expect(methodPlanAction({ level: 'free', ...ready, current: null })).toMatchObject({ kind: 'none', disabled: true });
    expect(methodPlanAction({ level: 'pro', price: 29, checkoutReady: false, current: null })).toMatchObject({ label: '暂不可购买' });
    expect(methodPlanAction({ level: 'pro', price: 0, checkoutReady: true, current: null })).toMatchObject({ disabled: true });
  });
  it('turns Gold into an upgrade of the Pro subscription, and never sells a second same or lower plan', () => {
    const pro = row();
    expect(methodPlanAction({ level: 'gold', ...ready, current: pro }))
      .toEqual({ kind: 'upgrade', label: '升级到 Gold', disabled: false, priorSubscriptionId: pro.subscription_id });
    expect(methodPlanAction({ level: 'pro', ...ready, current: pro })).toMatchObject({ label: '当前方案', disabled: true });
    expect(methodPlanAction({ level: 'pro', ...ready, current: row({ purchase_membership_level: 'gold' }) }))
      .toMatchObject({ label: '已是更高等级会员', disabled: true });
  });
  it('reads the highest live membership', () => {
    const gold = row({ purchase_membership_level: 'gold', subscription_id: 'g' });
    expect(currentMethodMembership([row(), gold], NOW)).toBe(gold);
    expect(currentMethodMembership([row({ entitlement_end: '2026-10-01T00:00:00Z' })], NOW)).toBeNull();
    expect(currentMethodMembership(undefined, NOW)).toBeNull();
  });
});

describe('membership summary', () => {
  it('says how it was paid and whether it renews', () => {
    expect(describeMethodMembership(row())).toEqual({ title: 'Pro · 月付', method: '国际银行卡', status: '自动续费中，本期到 2026-11-14' });
    expect(describeMethodMembership(row({ auto_renew: false, cancel_at_period_end: true, payment_method: 'card_cn' })))
      .toMatchObject({ method: '中国大陆银行卡', status: '已停止续费，会员权益用到 2026-11-14' });
    expect(describeMethodMembership(row({ purchase_membership_level: 'gold', offer_kind: 'founder', billing_cycle: 'yearly',
      auto_renew: false, payment_method: 'wechat_pay' }))).toEqual({ title: 'Gold · 创始会员 · 年付', method: '微信支付',
      status: '不自动续费，会员权益用到 2026-11-14' });
  });
});
