/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertPaymentMethodRoute, paymentMethodRoutesSchema, paymentRoute } from './methodRouting';

const routes = { version: 3, card: { enabled: true }, card_cn: { enabled: true },
  wechat_pay: { enabled: true, annualVerified: false }, alipay: { enabled: true, annualVerified: true } };
const base = { routes, expectedVersion: 3, method: 'wechat_pay' as const, annual: false,
  itemType: 'membership_plan' as const, paymentMode: 'test' as const };
describe('PAY-STRIPE-MP fixed method routing', () => {
  it('missing and disabled switches fail closed', () => {
    expect(() => assertPaymentMethodRoute({ ...base, routes: null })).toThrow('SALES_DISABLED');
    expect(() => assertPaymentMethodRoute({ ...base,
      routes: { ...routes, wechat_pay: { enabled: false, annualVerified: true } } })).toThrow('SALES_DISABLED');
    expect(() => assertPaymentMethodRoute({ ...base, method: 'card', routes: { ...routes, card: { enabled: false } } }))
      .toThrow('SALES_DISABLED');
  });
  it('settings saved before card_cn existed stay valid and keep the mainland card closed', () => {
    const old = { version: routes.version, card: routes.card, wechat_pay: routes.wechat_pay, alipay: routes.alipay };
    expect(paymentMethodRoutesSchema.safeParse(old).success).toBe(true);
    expect(() => assertPaymentMethodRoute({ ...base, routes: old, method: 'card_cn' })).toThrow('SALES_DISABLED');
    expect(paymentMethodRoutesSchema.safeParse({ ...routes, card_cn: { enabled: true, annualVerified: true } }).success)
      .toBe(false);
  });
  it('sends every new purchase to Stripe; only the international card uses Managed Payments', () => {
    expect(paymentRoute('card')).toEqual({ channel: 'stripe', mode: 'subscription', managedPayments: true });
    expect(paymentRoute('card', 'credit_package')).toEqual({ channel: 'stripe', mode: 'payment', managedPayments: true });
    expect(paymentRoute('card_cn')).toEqual({ channel: 'stripe', mode: 'subscription', managedPayments: false });
    for (const method of ['wechat_pay', 'alipay'] as const) {
      expect(assertPaymentMethodRoute({ ...base, method })).toEqual({ channel: 'stripe', mode: 'payment', managedPayments: false });
      expect(assertPaymentMethodRoute({ ...base, method, itemType: 'credit_package' }).mode).toBe('payment');
    }
    expect(paymentMethodRoutesSchema.safeParse({ ...routes, channel: 'waffo' }).success).toBe(false);
  });
  it('rejects stale decisions, live sales and mainland card packs', () => {
    expect(() => assertPaymentMethodRoute({ ...base, expectedVersion: 2 })).toThrow('VERSION_CONFLICT');
    expect(() => assertPaymentMethodRoute({ ...base, paymentMode: 'live' })).toThrow('LIVE_DISABLED');
    expect(() => assertPaymentMethodRoute({ ...base, method: 'card_cn', itemType: 'credit_package' })).toThrow('METHOD_DENIED');
    expect(assertPaymentMethodRoute({ ...base, method: 'card', itemType: 'credit_package' }).managedPayments).toBe(true);
  });
  it('wallet annual capability is required per wallet; card subscriptions renew yearly without it', () => {
    expect(() => assertPaymentMethodRoute({ ...base, annual: true })).toThrow('ANNUAL_UNVERIFIED');
    expect(assertPaymentMethodRoute({ ...base, method: 'alipay', annual: true }).channel).toBe('stripe');
    for (const method of ['card', 'card_cn'] as const) {
      expect(assertPaymentMethodRoute({ ...base, method, annual: true }).mode).toBe('subscription');
    }
  });
});
