/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CHANNEL_OPTIONS, buildPaymentChannelSave, classifyPaymentChannelSaveError, readPaymentChannelSetting,
  summarizePurchaseReadiness,
} from './paymentChannelDraft';

describe('payment channel setting', () => {
  it('saves the selected channel with the next version of what was read', () => {
    expect(buildPaymentChannelSave({ channel: 'waffo', version: 0 }, 'stripe')).toEqual({
      key: 'payment_new_purchase_channel', value: { channel: 'stripe', version: 1 },
    });
    expect(buildPaymentChannelSave({ channel: 'stripe', version: 7 }, 'waffo').value).toEqual({ channel: 'waffo', version: 8 });
  });

  it('rejects malformed reads instead of assuming a default', () => {
    expect(readPaymentChannelSetting({ channel: 'waffo', version: 0 })).toEqual({ channel: 'waffo', version: 0 });
    for (const value of [undefined, null, {}, { channel: 'paypal', version: 1 }, { channel: 'stripe' },
      { channel: 'stripe', version: -1 }, { channel: 'stripe', version: 1.5 }, { channel: 'stripe', version: '2' }]) {
      expect(readPaymentChannelSetting(value)).toBeNull();
    }
  });

  it('classifies a stale version as a conflict that needs a re-read', () => {
    expect(classifyPaymentChannelSaveError({ data: { code: 'CONFLICT' } })).toBe('conflict');
    expect(classifyPaymentChannelSaveError({ data: { code: 'BAD_REQUEST' } })).toBe('rejected');
    expect(classifyPaymentChannelSaveError({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe('failed');
    expect(classifyPaymentChannelSaveError(null)).toBe('failed');
  });

  it('marks Waffo as not connected', () => {
    expect(PAYMENT_CHANNEL_OPTIONS.find(option => option.channel === 'waffo')?.note).toContain('未接入');
  });
});

describe('purchase readiness', () => {
  it('counts purchasable items separately from the saved selection', () => {
    expect(summarizePurchaseReadiness({
      packages: [{ checkout_ready: true }, { checkout_ready: false }, {}],
      plans: [{ level: 'free', checkoutReady: { monthly: false, yearly: false } },
        { level: 'pro', checkoutReady: { monthly: true, yearly: false } },
        { level: 'gold', checkoutReady: { monthly: false, yearly: false } }],
      loading: false, failed: false,
    })).toEqual({ state: 'ready', packagesReady: 1, packagesTotal: 3, plansReady: 1, plansTotal: 2 });
  });

  it('reports loading and failure without counting', () => {
    expect(summarizePurchaseReadiness({ packages: undefined, plans: [], loading: true, failed: false })).toEqual({ state: 'loading' });
    expect(summarizePurchaseReadiness({ packages: [], plans: [], loading: false, failed: true })).toEqual({ state: 'error' });
  });
});
