/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertMethodCheckoutEnvironment, methodCardCheckoutReady, methodCheckoutEnvironmentOpen } from './methodCheckoutGate';

const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com' };
const routes = (card: boolean) => ({ version: 4, card: { enabled: card }, card_cn: { enabled: card },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });
const methods = ['card', 'card_cn', 'wechat_pay', 'alipay'] as const;

describe('PAY-STRIPE-MP checkout gate (PR-1: every new checkout closed in code)', () => {
  it('production stays closed whatever its configuration', () => {
    for (const host of ['app.graylum.com', 'graylum.com', 'www.graylum.com', 'evil-auth-staging.graylum.com', '']) {
      const env = { ...staging, VERCEL_PROJECT_PRODUCTION_URL: host, VERCEL_ENV: 'production' };
      for (const method of methods) {
        expect(methodCheckoutEnvironmentOpen(env, method)).toBe(false);
        expect(() => assertMethodCheckoutEnvironment(env, method)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
      }
      expect(methodCardCheckoutReady(env, routes(true))).toBe(false);
    }
  });
  it('staging card checkout stays closed until the Stripe card adapter and fulfillment land', () => {
    // The old Waffo test flag no longer opens anything: Waffo takes no new card purchases.
    for (const env of [staging, { ...staging, WAFFO_TEST_OPERATIONS_ENABLED: 'true' }]) {
      for (const method of methods) {
        expect(methodCheckoutEnvironmentOpen(env, method)).toBe(false);
        expect(() => assertMethodCheckoutEnvironment(env, method)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
      }
      expect(methodCardCheckoutReady(env, routes(true))).toBe(false);
    }
    expect(methodCardCheckoutReady(staging, null)).toBe(false);
  });
});
