/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { currentMethodMembership, describeMethodMembership, methodPlanAction, parseBuyDeepLink, walletRenewalSource,
  type MethodMembershipRow } from './methodPlanAction';

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
    // A paid entitlement without a paid order row here (renewal grace, older subscription): no second purchase.
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: null, entitlementLevel: 'pro' }))
      .toMatchObject({ kind: 'none', label: '会员仍在有效期内', disabled: true });
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: null, entitlementLevel: 'free' })).toMatchObject({ kind: 'buy' });
  });
  it('turns Gold into an upgrade of the Pro subscription, and never sells a second same or lower plan', () => {
    const pro = row();
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: pro }))
      .toEqual({ kind: 'upgrade', label: '升级到 Gold', disabled: false, priorSubscriptionId: pro.subscription_id });
    expect(methodPlanAction({ level: 'pro', ...ready, current: pro })).toMatchObject({ label: '当前方案', disabled: true });
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: row({ auto_renew: false, cancel_at_period_end: true }) }))
      .toMatchObject({ kind: 'none', label: 'Pro 已停止续费，到期后可开通 Gold', disabled: true });
    // A one-time (wallet) Pro never renewed in the first place; the server allows its upgrade. 0211 stores it with
    // cancel_at_period_end=true, which methodMembership reports as is.
    for (const payment_method of ['wechat_pay', 'alipay']) {
      const wallet = row({ auto_renew: false, cancel_at_period_end: true, payment_method, payment_channel: 'stripe' });
      expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: wallet }))
        .toEqual({ kind: 'upgrade', label: '升级到 Gold', disabled: false, priorSubscriptionId: wallet.subscription_id });
    }
    expect(methodPlanAction({ level: 'pro', ...ready, current: row({ purchase_membership_level: 'gold' }) }))
      .toMatchObject({ label: '已是更高等级会员', disabled: true });
  });
  it('reads the highest live membership', () => {
    const gold = row({ purchase_membership_level: 'gold', subscription_id: 'g' });
    expect(currentMethodMembership([row(), gold], NOW)).toBe(gold);
    expect(currentMethodMembership([row({ entitlement_end: '2026-10-01T00:00:00Z' })], NOW)).toBeNull();
    expect(currentMethodMembership(undefined, NOW)).toBeNull();
  });

  it.each(['wechat_pay', 'alipay'])('allows %s same-level annual switch and advance repurchase after the last paid term', payment_method => {
    const current = row({ payment_method, payment_channel: 'stripe', auto_renew: false, cancel_at_period_end: true });
    const source = walletRenewalSource([current], current);
    expect(methodPlanAction({ level: 'pro', ...ready, current, billingCycle: 'yearly', walletRenewal: source, walletCheckoutReady: true }))
      .toMatchObject({ kind: 'wallet_renewal', label: '改为年付', priorSubscriptionId: current.subscription_id });
    expect(methodPlanAction({ level: 'pro', ...ready, current, billingCycle: 'monthly', walletRenewal: source, walletCheckoutReady: true }))
      .toMatchObject({ kind: 'wallet_renewal', label: '提前续买一个月' });
    const queued = row({ ...current, subscription_id: 'queued', entitlement_start: current.entitlement_end,
      entitlement_end: '2027-11-14T12:00:00Z', billing_cycle: 'yearly' });
    expect(currentMethodMembership([queued, current], NOW)).toBe(current);
    expect(walletRenewalSource([queued, current], current)).toBe(queued);
    expect(methodPlanAction({ level: 'pro', ...ready, current, billingCycle: 'yearly',
      walletRenewal: queued, walletCheckoutReady: true })).toMatchObject({ label: '提前续买一年', priorSubscriptionId: 'queued' });
    expect(methodPlanAction({ level: 'pro', ...ready, current, billingCycle: 'yearly',
      walletRenewal: queued, walletCheckoutReady: false })).toMatchObject({ kind: 'none', disabled: true });
  });

  it('keeps cards and founder sources on their existing renewal paths', () => {
    const card = row();
    expect(walletRenewalSource([card], card)).toBeNull();
    const founder = row({ payment_method: 'alipay', payment_channel: 'stripe', offer_kind: 'founder', auto_renew: false });
    expect(walletRenewalSource([founder], founder)).toBeNull();
    const ordinary = row({ ...founder, offer_kind: 'standard' });
    const queuedFounder = row({ ...founder, entitlement_start: ordinary.entitlement_end, entitlement_end: '2027-11-14T12:00:00Z' });
    expect(walletRenewalSource([ordinary, queuedFounder], ordinary)).toBeNull();
    expect(methodPlanAction({ level: 'pro', ...ready, current: card, billingCycle: 'yearly',
      walletRenewal: ordinary, walletCheckoutReady: true })).toMatchObject({ kind: 'none', label: '当前方案' });
  });
});

describe('membership summary', () => {
  it('says how it was paid and whether it renews', () => {
    expect(describeMethodMembership(row())).toEqual({ title: 'Pro · 月付', method: '国际银行卡', status: '自动续费中，本期到 2026-11-14' });
    expect(describeMethodMembership(row({ auto_renew: false, cancel_at_period_end: true, payment_method: 'card_cn' })))
      .toMatchObject({ method: '中国大陆银行卡', status: '已停止续费，会员权益用到 2026-11-14' });
    expect(describeMethodMembership(row({ purchase_membership_level: 'gold', offer_kind: 'founder', billing_cycle: 'yearly',
      auto_renew: false, cancel_at_period_end: true, payment_method: 'wechat_pay' }))).toEqual({ title: 'Gold · 创始会员 · 年付', method: '微信支付',
      status: '不自动续费，会员权益用到 2026-11-14' });
    expect(describeMethodMembership(row({ auto_renew: false, cancel_at_period_end: true, payment_method: 'alipay' })).status)
      .toBe('不自动续费，会员权益用到 2026-11-14');
  });
  it('keeps the founder label after a founder renewal (0238 offer_kind founder_renewal)', () => {
    expect(describeMethodMembership(row({ purchase_membership_level: 'gold', offer_kind: 'founder_renewal', billing_cycle: 'yearly' })).title)
      .toBe('Gold · 创始会员 · 年付');
  });
});

it('reads only well-formed landing-page buy links', () => {
  const read = (query: string) => parseBuyDeepLink(new URLSearchParams(query));
  expect(read('buy=gold&cycle=yearly')).toEqual({ level: 'gold', cycle: 'yearly' });
  expect(read('buy=pro&cycle=monthly')).toEqual({ level: 'pro', cycle: 'monthly' });
  for (const query of ['', 'buy=gold', 'buy=free&cycle=monthly', 'buy=gold&cycle=weekly', 'cycle=yearly']) expect(read(query)).toBeNull();
});

describe('renewal states (backend inGrace, payment_channel)', () => {
  const later = '2026-12-14T12:00:00Z';
  it('treats a grace-period subscription as the current membership and waits for the renewal', () => {
    const grace = row({ entitlement_end: '2026-10-13T20:00:00Z', inGrace: true });
    expect(currentMethodMembership([grace], NOW)).toBe(grace);
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: grace })).toMatchObject({ label: '续费处理中，请稍后再看', disabled: true });
    expect(describeMethodMembership(grace).status).toContain('正在等待续费扣款，24 小时内会员权益保留');
  });
  it('sends a renewing Waffo Pro to a ticket instead of a card upgrade', () => {
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: row({ entitlement_end: later, payment_channel: 'waffo' }) }))
      .toMatchObject({ label: '旧订阅升级请提交工单', disabled: true });
  });
  it('waits for the renewal in the last 48 h 31 min of a renewing Pro', () => {
    const soon = row({ entitlement_end: new Date(NOW + 47 * 3600_000).toISOString() });
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: soon }))
      .toMatchObject({ label: '临近续费日，续费完成后可升级', disabled: true });
    expect(methodPlanAction({ level: 'gold', ...ready, now: NOW, current: row({ entitlement_end: later, payment_channel: 'stripe' }) }))
      .toMatchObject({ kind: 'upgrade' });
  });
});
