/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { buildStripeCheckoutRequest } from './stripeCheckoutIntent';
import { createDurableStripeCheckout, resolveStripeScope } from './stripeCheckoutPersistence';
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const snapshot = { version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd', unit: 'major',
  price: '19.99', discount: '2.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20 };
function fixture() {
  const operations: string[] = [];
  const order = { id: '22222222-2222-4222-8222-222222222222', user_id: 'fixture_user',
    payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: scope.mode,
    purchase_snapshot: snapshot, checkout_request: null as Stripe.Checkout.SessionCreateParams | null, price_ref_id: 'fixture_price_ref',
    metadata: { productName: 'Fixture', requoteRequired: false } };
  const mapping = { external_id: 'price_fixture', channel: 'stripe', merchant_namespace: scope.merchant, mode: scope.mode };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    operations.push(name);
    if (name === 'pay_common_create_purchase') return { data: order, error: null };
    if (name === 'pay_common_prepare_checkout') return { data: args.p_request, error: null };
    if (name === 'pay_common_record_checkout') return { data: { ok: true }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const from = vi.fn((table: string) => {
    if (table !== 'payment_provider_refs') throw new Error('Legacy identity read');
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: mapping, error: null }),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
    return query;
  });
  const create = vi.fn(async (request: Stripe.Checkout.SessionCreateParams) => {
    operations.push('provider_create');
    return { id: 'cs_fixture', object: 'checkout.session', status: 'open', payment_status: 'unpaid',
      client_reference_id: request.client_reference_id, metadata: request.metadata,
      currency: 'usd', amount_total: 1799, livemode: false, mode: request.mode, url: 'https://checkout.stripe.test/fixture' };
  });
  const stripe = { prices: { retrieve: vi.fn().mockResolvedValue({ id: 'price_fixture', object: 'price', active: true,
    livemode: false, currency: 'usd', unit_amount: 1999, type: 'one_time', recurring: null,
    billing_scheme: 'per_unit', tax_behavior: 'unspecified' }) }, checkout: { sessions: { create } } } as unknown as Stripe;
  return { operations, rpc, from, create, order, args: { db: { from, rpc } as unknown as Pick<SupabaseClient, 'from' | 'rpc'>, stripe, scope, userId: order.user_id,
    expectedLevel: 'free', action: { itemType: 'credit_package' as const, itemId: snapshot.item_id, billingCycle: 'one_time' as const },
    appUrl: 'https://example.test' } };
}

describe('Stripe checkout persistence boundary', () => {
  it('admits and freezes a durable order before provider creation, then records its mapping', async () => {
    const t = fixture();
    await expect(createDurableStripeCheckout(t.args)).resolves.toMatchObject({ id: 'cs_fixture' });
    expect(t.operations).toEqual(['pay_common_create_purchase', 'pay_common_prepare_checkout', 'provider_create', 'pay_common_record_checkout']);
    expect(t.rpc).toHaveBeenCalledWith('pay_common_create_purchase', expect.objectContaining({ p_expected_level: 'free' }));
    expect(t.rpc).toHaveBeenCalledWith('pay_common_record_checkout', expect.objectContaining({ p_order_id: t.order.id,
      p_session: expect.objectContaining({ id: 'cs_fixture', customer: null, subscription: null }) }));
  });
  it('does not dispatch when durable admission or envelope persistence fails', async () => {
    for (const failure of ['pay_common_create_purchase', 'pay_common_prepare_checkout']) {
      const t = fixture(); const original = t.rpc.getMockImplementation()!;
      t.rpc.mockImplementation(async (name, args) => name === failure ? { data: null, error: { code: 'fixture' } } : original(name, args));
      await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
      expect(t.create).not.toHaveBeenCalled();
    }
  });
  it('does not dispatch under mismatched scope or owner', async () => {
    for (const patch of [{ user_id: 'other' }, { merchant_namespace: 'other' }, { payment_channel: 'unknown' }]) {
      const t = fixture(); Object.assign(t.order, patch);
      t.args.userId = 'fixture_user';
      await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
      expect(t.create).not.toHaveBeenCalled();
    }
  });
  it('surfaces a persisted conflict instead of reporting checkout success', async () => {
    const t = fixture(); const original = t.rpc.getMockImplementation()!;
    t.rpc.mockImplementation(async (name, args) => name === 'pay_common_record_checkout'
      ? { data: { ok: false, reason: 'PAY_COMMON_RECEIPT_MISMATCH' }, error: null } : original(name, args));
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_RECEIPT_MISMATCH');
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  function replacementFixture() {
    const t = fixture();
    const oldId = t.order.id;
    t.order.checkout_request = buildStripeCheckoutRequest({ orderId: oldId, userId: t.order.user_id, snapshot,
      priceId: 'price_fixture', productName: 'Old', appUrl: t.args.appUrl, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    t.args.action.itemId = '33333333-3333-4333-8333-333333333333';
    const oldSession = { id: 'cs_old', object: 'checkout.session', livemode: false, mode: 'payment',
      status: 'open', payment_status: 'unpaid', amount_total: 1799, currency: 'usd',
      client_reference_id: t.order.user_id, metadata: t.order.checkout_request.metadata };
    const retrieve = vi.fn(async () => ({ ...oldSession }));
    const expire = vi.fn(async () => { oldSession.status = 'expired'; return oldSession; });
    const list = vi.fn().mockResolvedValue({ data: [oldSession], has_more: false });
    Object.assign(t.args.stripe.checkout.sessions, { retrieve, expire, list });
    const original = t.rpc.getMockImplementation()!;
    t.rpc.mockImplementation(async (name, args) => {
      if (name === 'pay_common_close_checkout') {
        t.operations.push(name);
        t.order.id = '44444444-4444-4444-8444-444444444444';
        t.order.purchase_snapshot = { ...snapshot, item_id: t.args.action.itemId };
        t.order.checkout_request = null;
        t.order.metadata.requoteRequired = false;
        return { data: true, error: null };
      }
      return original(name, args);
    });
    return { ...t, retrieve, expire, list, oldSession, oldId };
  }
  it('retires the same item when admission detects changed pricing inputs', async () => {
    const t = replacementFixture();
    t.args.action.itemId = snapshot.item_id;
    t.order.metadata.requoteRequired = true;
    await expect(createDurableStripeCheckout(t.args)).resolves.toMatchObject({ id: 'cs_fixture' });
    expect(t.expire).toHaveBeenCalledExactlyOnceWith('cs_old');
    expect(t.create).toHaveBeenCalledOnce();
  });
  it('fails closed when pricing comparison is unavailable from an older database', async () => {
    const t = fixture();
    Reflect.deleteProperty(t.order.metadata, 'requoteRequired');
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_REQUOTE_CHECK_REQUIRED');
    expect(t.create).not.toHaveBeenCalled();
  });
  it('expires and re-reads the old unpaid session before admitting the explicitly selected replacement', async () => {
    const t = replacementFixture();
    await expect(createDurableStripeCheckout(t.args)).resolves.toMatchObject({ id: 'cs_fixture' });
    expect(t.expire).toHaveBeenCalledExactlyOnceWith('cs_old');
    expect(t.retrieve).toHaveBeenCalledTimes(2);
    expect(t.rpc).toHaveBeenCalledWith('pay_common_close_checkout', expect.objectContaining({
      p_order_id: t.oldId, p_session_id: 'cs_old', p_checkout_status: 'expired', p_payment_status: 'unpaid',
    }));
    expect(t.create).toHaveBeenCalledOnce();
    expect(t.create.mock.calls[0][0].metadata).toMatchObject({ itemId: t.args.action.itemId });
    expect(t.operations.indexOf('pay_common_close_checkout')).toBeLessThan(t.operations.indexOf('provider_create'));
  });
  it.each(['paid', 'complete-unpaid', 'expire-error', 'retrieve-error', 'paid-race', 'close-race'] as const)(
    'does not create or return a replacement when original retirement is unsafe: %s', async reason => {
      const t = replacementFixture();
      if (reason === 'paid') t.oldSession.payment_status = 'paid';
      if (reason === 'complete-unpaid') t.oldSession.status = 'complete';
      if (reason === 'expire-error') t.expire.mockRejectedValue(new Error('network'));
      if (reason === 'retrieve-error') t.retrieve.mockRejectedValueOnce(new Error('network'));
      if (reason === 'paid-race') t.expire.mockImplementation(async () => {
        t.oldSession.status = 'complete'; t.oldSession.payment_status = 'paid'; return t.oldSession;
      });
      if (reason === 'close-race') {
        const original = t.rpc.getMockImplementation()!;
        t.rpc.mockImplementation((name, args) => name === 'pay_common_close_checkout'
          ? Promise.resolve({ data: false, error: null }) : original(name, args));
      }
      await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
      expect(t.create).not.toHaveBeenCalled();
      expect(t.rpc.mock.calls.filter(([name]) => name === 'pay_common_create_purchase')).toHaveLength(1);
      if (['paid', 'complete-unpaid', 'retrieve-error'].includes(reason)) expect(t.expire).not.toHaveBeenCalled();
    });
  it('concurrent replacement requests cannot create twice when one original expiration loses the race', async () => {
    const t = replacementFixture(); let expirationStarted = false;
    t.expire.mockImplementation(async () => {
      if (expirationStarted) throw new Error('session is no longer open');
      expirationStarted = true;
      t.oldSession.status = 'expired';
      return t.oldSession;
    });
    const results = await Promise.allSettled([createDurableStripeCheckout(t.args), createDurableStripeCheckout(t.args)]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(t.create).toHaveBeenCalledOnce();
    expect(t.rpc.mock.calls.filter(([name]) => name === 'pay_common_close_checkout')).toHaveLength(1);
  });
  it('closes an unprepared old item before admitting a replacement without touching its provider state', async () => {
    const t = replacementFixture(); t.order.checkout_request = null;
    await expect(createDurableStripeCheckout(t.args)).resolves.toMatchObject({ id: 'cs_fixture' });
    expect(t.rpc).toHaveBeenCalledWith('pay_common_close_checkout', {
      p_user_id: t.args.userId, p_order_id: t.oldId, p_session_id: null,
      p_merchant_namespace: scope.merchant, p_payment_mode: scope.mode,
      p_checkout_status: 'not_prepared', p_payment_status: 'unpaid',
    });
    expect(t.rpc.mock.calls.filter(([name]) => name === 'pay_common_prepare_checkout')).toHaveLength(1);
    expect(t.rpc).toHaveBeenCalledWith('pay_common_prepare_checkout', expect.objectContaining({ p_order_id: t.order.id }));
    expect(t.create).toHaveBeenCalledOnce();
    expect(t.create.mock.calls[0][0].metadata?.itemId).toBe(t.args.action.itemId);
    expect(t.list).not.toHaveBeenCalled();
    expect(t.retrieve).not.toHaveBeenCalled();
    expect(t.expire).not.toHaveBeenCalled();
    expect(t.operations.slice(0, 3)).toEqual(['pay_common_create_purchase', 'pay_common_close_checkout', 'pay_common_create_purchase']);
  });
  it.each(['error', 'already-closed', 'concurrent-prepare', 'paid'] as const)(
    'does not admit or dispatch a replacement when unprepared closure is rejected: %s', async reason => {
      const t = replacementFixture();
      const frozenRequest = t.order.checkout_request;
      t.order.checkout_request = null;
      const original = t.rpc.getMockImplementation()!;
      t.rpc.mockImplementation(async (name, args) => {
        if (name !== 'pay_common_close_checkout') return original(name, args);
        expect(args.p_checkout_status).toBe('not_prepared');
        // Model the protected RPC's refusal after a competing transaction committed.
        if (reason === 'concurrent-prepare') t.order.checkout_request = frozenRequest;
        return { data: reason === 'already-closed' ? false : null,
          error: reason === 'already-closed' ? null : { message: reason } };
      });
      await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_CLOSE_FAILED');
      expect(t.rpc.mock.calls.map(([name]) => name)).toEqual(['pay_common_create_purchase', 'pay_common_close_checkout']);
      expect(t.from).not.toHaveBeenCalled();
      expect(t.create).not.toHaveBeenCalled();
      expect(t.list).not.toHaveBeenCalled();
      expect(t.retrieve).not.toHaveBeenCalled();
      expect(t.expire).not.toHaveBeenCalled();
    });
  it('keeps the absence grace for a frozen old request when switching products', async () => {
    const t = replacementFixture();
    t.order.checkout_request!.expires_at = Math.floor(Date.now() / 1000) - 100;
    t.list.mockResolvedValue({ data: [], has_more: false });
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual(['pay_common_create_purchase']);
    expect(t.create).not.toHaveBeenCalled();
  });
  it('releases a never-created original after grace using the existing protected closure RPC', async () => {
    const t = replacementFixture();
    t.order.checkout_request!.expires_at = Math.floor(Date.now() / 1000) - 3600;
    t.list.mockResolvedValue({ data: [], has_more: false });
    await expect(createDurableStripeCheckout(t.args)).resolves.toMatchObject({ id: 'cs_fixture' });
    expect(t.rpc).toHaveBeenCalledWith('pay_common_close_checkout', expect.objectContaining({
      p_order_id: t.oldId, p_session_id: null, p_checkout_status: 'never_created', p_payment_status: 'unpaid',
    }));
    expect(t.expire).not.toHaveBeenCalled();
  });
  it('obtains original merchant and mode from the authenticated provider connection', async () => {
    const retrieveCurrent = vi.fn().mockResolvedValue({ id: 'acct_fixture' });
    const retrieve = vi.fn().mockResolvedValue({ livemode: false });
    await expect(resolveStripeScope({ accounts: { retrieveCurrent }, balance: { retrieve } } as unknown as Stripe)).resolves.toEqual(scope);
    expect(retrieveCurrent).toHaveBeenCalledWith();
  });
});
