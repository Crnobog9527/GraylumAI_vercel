/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertMethodCheckoutEnvironment, methodCardCheckoutReady, methodCheckoutEnvironmentOpen } from './methodCheckoutGate';

const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', WAFFO_TEST_OPERATIONS_ENABLED: 'true' };
const routes = (card: boolean) => ({ version: 4, card: { enabled: card },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });

describe('PAY-WAFFO test card checkout gate', () => {
  it('production stays closed whatever its configuration', () => {
    for (const host of ['app.graylum.com', 'graylum.com', 'www.graylum.com', 'evil-auth-staging.graylum.com', '']) {
      const env = { ...staging, VERCEL_PROJECT_PRODUCTION_URL: host, VERCEL_ENV: 'production' };
      expect(methodCheckoutEnvironmentOpen(env, 'card')).toBe(false);
      expect(methodCardCheckoutReady(env, routes(true))).toBe(false);
      expect(() => assertMethodCheckoutEnvironment(env, 'card')).toThrow('PAY_WAFFO_STEP2_NOT_READY');
    }
    // Local or other hosts without the Vercel marker are closed too.
    expect(methodCardCheckoutReady({ ...staging, VERCEL: undefined }, routes(true))).toBe(false);
  });
  it('staging stays closed while the test operations flag or the card route switch is off', () => {
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      const env = { ...staging, WAFFO_TEST_OPERATIONS_ENABLED: flag };
      expect(methodCardCheckoutReady(env, routes(true))).toBe(false);
      expect(() => assertMethodCheckoutEnvironment(env, 'card')).toThrow('PAY_WAFFO_STEP2_NOT_READY');
    }
    expect(methodCardCheckoutReady(staging, routes(false))).toBe(false);
    expect(methodCardCheckoutReady(staging, null)).toBe(false);
  });
  it('opens card only when staging test mode and the route switch are both on', () => {
    expect(methodCardCheckoutReady(staging, routes(true))).toBe(true);
    expect(() => assertMethodCheckoutEnvironment(staging, 'card')).not.toThrow();
  });
  it('never opens Stripe wallets through the card test switch', () => {
    for (const method of ['wechat_pay', 'alipay'] as const) {
      expect(methodCheckoutEnvironmentOpen(staging, method)).toBe(false);
      expect(() => assertMethodCheckoutEnvironment(staging, method)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
    }
  });
});
