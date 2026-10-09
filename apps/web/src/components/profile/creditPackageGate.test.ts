/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { creditPackBuyState, isPaidMember, packCheckoutRefusal } from './creditPackageGate';

const ready = (level: string | null) => ({ status: 'ready' as const, level });
const base = { price: 9.9, checkoutReady: true, pending: false };

describe('creditPackBuyState', () => {
  it('lets only Pro and Gold members buy', () => {
    expect(creditPackBuyState({ ...base, entitlement: ready('pro') })).toEqual({ disabled: false, label: '购买' });
    expect(creditPackBuyState({ ...base, entitlement: ready('gold') })).toEqual({ disabled: false, label: '购买' });
    expect(creditPackBuyState({ ...base, entitlement: ready('free') })).toEqual({ disabled: true, label: '开通会员后可购买' });
    expect(creditPackBuyState({ ...base, entitlement: ready(null) })).toEqual({ disabled: true, label: '开通会员后可购买' });
  });
  it('never enables while membership is unknown', () => {
    expect(creditPackBuyState({ ...base, entitlement: { status: 'loading' } }).disabled).toBe(true);
    expect(creditPackBuyState({ ...base, entitlement: { status: 'error' } })).toEqual({ disabled: true, label: '暂时无法确认会员状态' });
  });
  it('keeps store-level refusals and the pending state ahead of membership', () => {
    expect(creditPackBuyState({ ...base, checkoutReady: false, entitlement: ready('free') }).label).toBe('暂不可购买');
    expect(creditPackBuyState({ ...base, price: 0, entitlement: ready('pro') }).label).toBe('暂不可购买');
    expect(creditPackBuyState({ ...base, pending: true, entitlement: ready('pro') })).toEqual({ disabled: true, label: '跳转中...' });
  });
  it('treats only a ready pro or gold level as paid', () => {
    expect(isPaidMember(ready('gold'))).toBe(true);
    expect(isPaidMember({ status: 'loading' })).toBe(false);
  });
});

describe('packCheckoutRefusal', () => {
  it('turns the server membership refusals into plain Chinese and leaves other errors alone', () => {
    expect(packCheckoutRefusal(new Error('PAYWALL_MEMBERSHIP_REQUIRED'))).toContain('开通会员后就能购买');
    expect(packCheckoutRefusal({ message: 'PAYWALL_MEMBERSHIP_UNAVAILABLE' })).toContain('暂时无法确认会员状态');
    expect(packCheckoutRefusal(new Error('something else'))).toBeNull();
    expect(packCheckoutRefusal(null)).toBeNull();
  });
});
