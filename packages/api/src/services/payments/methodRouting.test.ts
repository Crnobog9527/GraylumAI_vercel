/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertPaymentMethodRoute, paymentMethodRoutesSchema, paymentRoute } from './methodRouting';

const routes = { version: 3, card: { enabled: true },
  wechat_pay: { enabled: true, annualVerified: false }, alipay: { enabled: true, annualVerified: true } };
const base = { routes, expectedVersion: 3, method: 'wechat_pay' as const, annual: false,
  itemType: 'membership_plan' as const, paymentMode: 'test' as const };
describe('PAY-WAFFO fixed method routing', () => {
  it('missing and disabled switches fail closed', () => {
    expect(() => assertPaymentMethodRoute({ ...base, routes: null })).toThrow('SALES_DISABLED');
    expect(() => assertPaymentMethodRoute({ ...base,
      routes: { ...routes, wechat_pay: { enabled: false, annualVerified: true } } })).toThrow('SALES_DISABLED');
  });
  it('cannot route a wallet to card or a card subscription to Stripe', () => {
    expect(paymentRoute('card')).toEqual({ channel: 'waffo', mode: 'subscription' });
    for (const method of ['wechat_pay', 'alipay'] as const) {
      expect(assertPaymentMethodRoute({ ...base, method })).toEqual({ channel: 'stripe', mode: 'payment' });
    }
    expect(paymentMethodRoutesSchema.safeParse({ ...routes, channel: 'stripe' }).success).toBe(false);
  });
  it('rejects stale decisions, live sales and unsupported card packs', () => {
    expect(() => assertPaymentMethodRoute({ ...base, expectedVersion: 2 })).toThrow('VERSION_CONFLICT');
    expect(() => assertPaymentMethodRoute({ ...base, paymentMode: 'live' })).toThrow('LIVE_DISABLED');
    expect(() => assertPaymentMethodRoute({ ...base, method: 'card', itemType: 'credit_package' })).toThrow('METHOD_DENIED');
  });
  it('each wallet annual capability is independently required', () => {
    expect(() => assertPaymentMethodRoute({ ...base, annual: true })).toThrow('ANNUAL_UNVERIFIED');
    expect(assertPaymentMethodRoute({ ...base, method: 'alipay', annual: true }).channel).toBe('stripe');
  });
});
