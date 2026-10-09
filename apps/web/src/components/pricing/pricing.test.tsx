/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { faqItems } from '@/lib/landing-content';
import { PricingPlans } from './PricingPlans';
import { PricingCreditPacks, PricingFaq, PricingStudio } from './PricingExtras';
import { pricingFaqItems, refundFaqItem } from './pricingContent';

const plan = (level: string, monthly: number, yearly: number, ready = true) => ({
  id: level + '-id', name: level, level, price: { monthly, yearly }, credits: { monthly: level === 'pro' ? 3480 : 8970, monthlyBonus: 0 },
  discount: level === 'pro' ? 0.05 : 0.1, checkoutReady: { monthly: ready, yearly: ready },
});
const PLANS = [plan('free', 0, 0), plan('pro', 29, 279), plan('gold', 69, 621)];
const LINKS = { signup: '/login?action=signup', membership: '/profile?tab=subscription' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('pricing FAQ', () => {
  it('reuses the one shared refund answer from /faq instead of a second copy', () => {
    const shared = faqItems.find(item => item.question === '可以退款吗？');
    expect(refundFaqItem).toBe(shared);
    expect(pricingFaqItems).toContain(shared);
    const html = renderToStaticMarkup(createElement(PricingFaq));
    expect(html).toContain('可以退款吗？');
    expect(html).toContain('6% 手续费');
    expect(html).toContain('积分永不过期');
  });
});

describe('pricing plans', () => {
  it('shows server prices with monthly as the default and the yearly saving badge', () => {
    const html = renderToStaticMarkup(createElement(PricingPlans, { plans: PLANS, links: LINKS }));
    expect(html).toContain('data-testid="pricing-plan-free"');
    expect(html).toContain('$29');
    expect(html).toContain('$69');
    expect(html).toContain('每月自动续费 $29');
    expect(html).toContain('最高省 25%');
    const inputs = html.match(/<input[^>]*name="pricing-billing"[^>]*>/g) ?? [];
    expect(inputs.find(input => input.includes('checked'))).toContain('value="monthly"');
    expect(html).toContain('/profile?tab=subscription');
  });

  it('points to contact instead of a buy link when checkout is not ready', () => {
    const html = renderToStaticMarkup(createElement(PricingPlans, { plans: [plan('pro', 29, 279, false)], links: LINKS }));
    expect(html).toContain('href="/contact"');
    expect(html).not.toContain('/profile?tab=subscription');
  });

  it('says the catalog is unavailable instead of inventing prices', () => {
    expect(renderToStaticMarkup(createElement(PricingPlans, { plans: [], links: LINKS }))).toContain('会员方案暂时读不到');
  });
});

describe('credit packs and studio', () => {
  it('lists packs as members-only with the member discounts and no buy button', () => {
    const html = renderToStaticMarkup(createElement(PricingCreditPacks, { plans: PLANS, failed: false,
      packages: [{ id: 'a', name: 'S', credits: 990, bonus_credits: 0, price: 9.9 }, { id: 'b', credits: 0, bonus_credits: 0, price: 0 }] }));
    expect(html).toContain('只对付费会员开放');
    expect(html).toContain('Pro 9.5 折 · Gold 9 折');
    expect(html).toContain('990 积分');
    expect(html).toContain('$9.90');
    expect(html).not.toContain('<button');
    expect(html.match(/积分<\/b>/g)).toHaveLength(1);
  });

  it('keeps studio to a contact entry without promising team features', () => {
    const html = renderToStaticMarkup(createElement(PricingStudio));
    expect(html).toContain('href="/contact"');
    expect(html).not.toMatch(/共享工作空间|成员分权限|评审团/);
  });
});

it('follows the Owner copy rules across the whole page', () => {
  const page = text([
    renderToStaticMarkup(createElement(PricingPlans, { plans: PLANS, links: LINKS })),
    renderToStaticMarkup(createElement(PricingCreditPacks, { plans: PLANS, failed: false,
      packages: [{ id: 'a', credits: 990, bonus_credits: 0, price: 9.9 }] })),
    renderToStaticMarkup(createElement(PricingStudio)),
  ].join(' '));
  // No credit-cost estimate, no model names, no 7-day refund on the cards, no founder/first-month
  // offers, no unlaunched features, no upsell from packs to Gold.
  expect(page).not.toMatch(/预计|消耗|模型|7 天|退款|创始|首月|倒计时|评审团|即将上线|更划算/);
});
