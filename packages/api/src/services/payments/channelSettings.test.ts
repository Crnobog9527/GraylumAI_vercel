/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect, vi } from 'vitest';
import { assertCheckoutChannel, readEffectiveLegacyChannel, readPaymentChannel, paymentChannelSettingSchema } from './channelSettings';
import type { SupabaseClient } from '@supabase/supabase-js';

function database(value: unknown, pending: unknown = null, error: unknown = null, routes: unknown = null) {
  const from = vi.fn((table: string) => {
    let key = '';
    const query = { select() { return query; }, eq(field: string, item: string) { if (field === 'key') key = item; return query; },
      is() { return query; }, order() { return query; }, limit() { return query; },
      maybeSingle: async () => ({ data: table !== 'system_settings' ? pending
        : key === 'payment_method_routes' ? routes : value, error }) };
    return query;
  });
  return { from } as unknown as Pick<SupabaseClient, 'from'>;
}
describe('payment channel selection', () => {
  it('defaults to unavailable Waffo with no implicit Stripe selection', async () => {
    const db = database(null);
    expect(await readPaymentChannel(db)).toEqual({ channel: 'waffo', version: 0 });
    await expect(assertCheckoutChannel(db, 'buyer', 'credit_package')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('allows explicit Stripe and preserves the original pending Stripe intent after switching', async () => {
    await expect(assertCheckoutChannel(database({ value: { channel: 'stripe', version: 1 } }), 'buyer', 'credit_package'))
      .resolves.toBeUndefined();
    const db = database({ value: { channel: 'waffo', version: 2 } }, { payment_channel: 'stripe' });
    await expect(assertCheckoutChannel(db, 'buyer', 'credit_package')).resolves.toBeUndefined();
    expect(db.from).not.toHaveBeenCalledWith('system_settings');
  });
  it.each([null, {}, 'stripe', { channel: 'other', version: 1 }, { channel: 'stripe', version: 0 },
    { channel: 'stripe', version: 1.5 }, { channel: 'stripe', version: 1, extra: true }])('rejects invalid saved values %j', async value => {
    expect(paymentChannelSettingSchema.safeParse(value).success).toBe(false);
    await expect(readPaymentChannel(database({ value }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('fails closed on reads and unknown pending channels', async () => {
    await expect(readPaymentChannel(database(null, null, { code: 'read_failed' }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(assertCheckoutChannel(database(null, { payment_channel: 'other' }), 'buyer', 'credit_package'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('follows the failover switch: emergency Waffo closes fresh legacy Stripe checkouts, Stripe reopens them', async () => {
    const legacy = { value: { channel: 'stripe', version: 3 } };
    const routes = (channel?: string) => ({ value: { version: 7, card: { enabled: true },
      wechat_pay: { enabled: false, annualVerified: false }, alipay: { enabled: false, annualVerified: false },
      ...(channel ? { newPurchaseChannel: channel } : {}) } });
    expect(await readEffectiveLegacyChannel(database(legacy, null, null, routes('waffo')))).toEqual({ channel: 'waffo', version: 3 });
    await expect(assertCheckoutChannel(database(legacy, null, null, routes('waffo')), 'buyer', 'credit_package'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    for (const db of [database(legacy, null, null, routes('stripe')), database(legacy, null, null, routes()), database(legacy)]) {
      await expect(assertCheckoutChannel(db, 'buyer', 'membership_plan')).resolves.toBeUndefined();
    }
    // An existing order keeps its original provider; the switch only governs fresh purchases.
    const pending = database(legacy, { payment_channel: 'stripe' }, null, routes('waffo'));
    await expect(assertCheckoutChannel(pending, 'buyer', 'credit_package')).resolves.toBeUndefined();
  });
  it('fails closed when the failover switch cannot be read or is invalid', async () => {
    const legacy = { value: { channel: 'stripe', version: 3 } };
    await expect(assertCheckoutChannel(database(legacy, null, null, { value: { newPurchaseChannel: 'paypal' } }),
      'buyer', 'credit_package')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
