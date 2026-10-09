/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  formatUsd, monthlyCredits, packDiscountLabel, paywallQuote, pickPaywallPlans, yearlyBadge, yearlySavingPercent,
  type PaywallPlanSource,
} from './paywallPlans';

const plan = (level: string, monthly: number, yearly: number, extra: Partial<PaywallPlanSource> = {}): PaywallPlanSource => ({
  id: level + '-id', name: level, level, price: { monthly, yearly }, credits: { monthly: 3000, monthlyBonus: 480 },
  discount: 0.05, checkoutReady: { monthly: true, yearly: false }, ...extra,
});
const pro = plan('pro', 29, 279);
const gold = plan('gold', 69, 621, { discount: 0.1 });

describe('pickPaywallPlans', () => {
  it('keeps exactly one priced Pro and Gold, in that order, and drops free', () => {
    expect(pickPaywallPlans([gold, plan('free', 0, 0), pro]).map(item => item.level)).toEqual(['pro', 'gold']);
  });
  it('drops a level that is ambiguous or unpriced instead of guessing', () => {
    expect(pickPaywallPlans([pro, { ...pro, id: 'pro-2' }, gold]).map(item => item.level)).toEqual(['gold']);
    expect(pickPaywallPlans([plan('pro', 0, 0), gold]).map(item => item.level)).toEqual(['gold']);
    expect(pickPaywallPlans(undefined)).toEqual([]);
  });
});

describe('quotes', () => {
  it('monthly shows the server price and how renewal and cancellation work', () => {
    const quote = paywallQuote(pickPaywallPlans([pro])[0], 'monthly')!;
    expect(quote).toMatchObject({ amount: 29, perLabel: '/ 月', saving: null, checkoutReady: true });
    expect(quote.renewal).toBe('每月自动续费 $29，可随时在个人中心取消，取消后用到当期结束。');
  });
  it('yearly states the saving against 12 monthly payments and the monthly-release rule', () => {
    const quote = paywallQuote(pickPaywallPlans([gold])[0], 'yearly')!;
    expect(quote).toMatchObject({ amount: 621, saving: '比按月付 12 个月省 $207', monthlyEquivalent: '相当于 $51.75/月',
      checkoutReady: false });
    expect(quote.renewal).toContain('积分分 12 个月按月发放');
  });
  it('has no yearly quote without a yearly price', () => {
    expect(paywallQuote(pickPaywallPlans([plan('pro', 29, 0)])[0], 'yearly')).toBeNull();
  });
  it('rounds the saving percent down and badges the best real one', () => {
    expect(yearlySavingPercent(pro)).toBe(19);
    expect(yearlySavingPercent(gold)).toBe(25);
    expect(yearlyBadge(pickPaywallPlans([pro, gold]))).toBe('最高省 25%');
    expect(yearlyBadge(pickPaywallPlans([plan('pro', 29, 348)]))).toBeNull();
  });
});

describe('formatting', () => {
  it('formats dollars and pack discounts without inventing values', () => {
    expect(formatUsd(29)).toBe('$29');
    expect(formatUsd(2000)).toBe('$2,000');
    expect(formatUsd(51.75)).toBe('$51.75');
    expect(packDiscountLabel(0.05)).toBe('9.5 折');
    expect(packDiscountLabel(0.1)).toBe('9 折');
    expect(packDiscountLabel(0)).toBe('无折扣');
    expect(monthlyCredits(pro)).toBe(3480);
  });
});
