/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect, vi } from 'vitest';
import { assertCheckoutChannel, readPaymentChannel, paymentChannelSettingSchema } from './channelSettings';
import type { SupabaseClient } from '@supabase/supabase-js';

function database(value: unknown, pending: unknown = null, error: unknown = null) {
  const from = vi.fn((table: string) => {
    const query = { select() { return query; }, eq() { return query; }, is() { return query; },
      order() { return query; }, limit() { return query; },
      maybeSingle: async () => ({ data: table === 'system_settings' ? value : pending, error }) };
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
});
