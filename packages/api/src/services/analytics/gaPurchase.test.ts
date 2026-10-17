/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkoutValue, gaServerConfig, parseGaCheckoutIds, purchaseEvent, reportGaPurchase, storeGaCheckoutIds, withdrawGaConsent } from './gaPurchase';

const env = { NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-TEST1234', GA4_API_SECRET: 'secret-value-123' };
const ids = { clientId: '123456789.1700000000', sessionId: '1700000000' };
const order = { id: '00000000-0000-4000-8000-0000000000aa', item_id: 'plan-1', item_type: 'credit_package',
  billing_cycle: 'one_time', amount_total: 1799, offer_kind: 'standard', method_transition: null };

function db(taken: unknown = ids, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: taken, error });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 204 });
beforeEach(() => vi.restoreAllMocks());

describe('parseGaCheckoutIds', () => {
  it('accepts only GA formats', () => {
    expect(parseGaCheckoutIds(ids)).toEqual(ids);
    for (const bad of [null, 'x', { clientId: 'someone@example.com', sessionId: '1' }, { clientId: '1.2', sessionId: 'abc' },
      { clientId: `${'1'.repeat(21)}.1`, sessionId: '1' }, { clientId: '1.1', sessionId: 1 }, { clientId: 'Alice.Smith', sessionId: '1' }]) {
      expect(parseGaCheckoutIds(bad)).toBeNull();
    }
  });
});

describe('gaServerConfig', () => {
  it('needs both a measurement ID and an API secret', () => {
    expect(gaServerConfig(env)).toEqual({ measurementId: 'G-TEST1234', apiSecret: 'secret-value-123' });
    expect(gaServerConfig({ NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-TEST1234' })).toBeNull();
    expect(gaServerConfig({ GA4_API_SECRET: 'secret-value-123' })).toBeNull();
  });
});

describe('purchaseEvent', () => {
  it('reports the exact pre-tax amount and never the order, user or email', () => {
    const event = purchaseEvent(order, ids, 'random-tx');
    expect(event.events[0]!.params.value).toBe(17.99);
    expect(event.events[0]!.params).toMatchObject({ transaction_id: 'random-tx', currency: 'USD', session_id: '1700000000',
      engagement_time_msec: 1, items: [{ item_id: 'plan-1' }] });
    expect(JSON.stringify(event)).not.toContain(order.id);
    expect(purchaseEvent({ ...order, amount_total: 49600 }, ids, 't').events[0]!.params.value).toBe(496);
    expect(purchaseEvent({ ...order, amount_total: 5 }, ids, 't').events[0]!.params.value).toBe(0.05);
  });
});

describe('reportGaPurchase', () => {
  it('takes the ids once and sends one event with a fresh transaction ID', async () => {
    const d = db(), fetch = ok();
    expect(await reportGaPurchase(d.client, order, { fetch, env, newId: () => 'tx-1' })).toBe(true);
    expect(d.rpc).toHaveBeenCalledWith('analytics_take_checkout_ids', { p_order: order.id });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST1234&api_secret=secret-value-123');
    expect(JSON.parse(init.body).events[0].params.transaction_id).toBe('tx-1');
  });

  it('still clears the ids but sends nothing without consent ids, configuration, or for a founder renewal', async () => {
    for (const [taken, config, extra] of [[null, env, {}], [ids, {}, {}], [ids, env, { method_transition: 'founder_renewal' }]] as const) {
      const d = db(taken), fetch = ok();
      expect(await reportGaPurchase(d.client, { ...order, ...extra }, { fetch, env: config })).toBe(false);
      expect(d.rpc).toHaveBeenCalledWith('analytics_take_checkout_ids', { p_order: order.id });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('never throws: database, network and HTTP failures are swallowed', async () => {
    expect(await reportGaPurchase(db(null, { message: 'down' }).client, order, { fetch: ok(), env })).toBe(false);
    expect(await reportGaPurchase(db().client, order, { fetch: vi.fn().mockRejectedValue(new Error('net')), env })).toBe(false);
    expect(await reportGaPurchase(db().client, order, { fetch: vi.fn().mockResolvedValue({ ok: false, status: 400 }), env }))
      .toBe(false);
  });
});

describe('store and withdraw', () => {
  it('stores only well-formed ids and never throws', async () => {
    const d = db(true);
    expect(await storeGaCheckoutIds(d.client, 'user', 'order', ids)).toBe(true);
    expect(d.rpc).toHaveBeenCalledWith('analytics_store_checkout_ids', { p_user: 'user', p_order: 'order',
      p_client: ids.clientId, p_session: ids.sessionId });
    const forged = db(true);
    expect(await storeGaCheckoutIds(forged.client, 'user', 'order', { clientId: 'a@b.c', sessionId: '1' })).toBe(false);
    expect(forged.rpc).not.toHaveBeenCalled();
    expect(await storeGaCheckoutIds(db(null, { message: 'x' }).client, 'user', 'order', ids)).toBe(false);
  });

  it('withdrawal surfaces a failure so the browser retries', async () => {
    await expect(withdrawGaConsent(db(null).client, 'user')).resolves.toBeUndefined();
    await expect(withdrawGaConsent(db(null, { message: 'x' }).client, 'user')).rejects.toThrow('ANALYTICS_WITHDRAW_UNAVAILABLE');
  });
});

describe('checkoutValue', () => {
  const read = (data: unknown, error: unknown = null) => {
    const chain = { select: () => chain, eq: vi.fn(() => chain), maybeSingle: async () => ({ data, error }) };
    return { from: vi.fn(() => chain), chain } as unknown as SupabaseClient & { chain: typeof chain };
  };
  it('reads the buyer\'s own order amount before tax, in dollars', async () => {
    const db = read({ amount_total: 4900 });
    expect(await checkoutValue(db, 'user', 'order')).toBe(49);
    expect((db as unknown as { chain: { eq: ReturnType<typeof vi.fn> } }).chain.eq).toHaveBeenCalledWith('user_id', 'user');
    expect(await checkoutValue(read(null), 'user', 'order')).toBeNull();
    expect(await checkoutValue(read(null, { message: 'x' }), 'user', 'order')).toBeNull();
  });
});
