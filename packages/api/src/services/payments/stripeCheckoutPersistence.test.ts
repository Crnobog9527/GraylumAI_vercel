/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createDurableStripeCheckout, resolveStripeScope } from './stripeCheckoutPersistence';
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const snapshot = { version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd', unit: 'major',
  price: '19.99', discount: '2.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20 };
function fixture() {
  const operations: string[] = [];
  const order = { id: '22222222-2222-4222-8222-222222222222', user_id: 'fixture_user',
    payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: scope.mode,
    purchase_snapshot: snapshot, checkout_request: null, price_ref_id: 'fixture_price_ref',
    metadata: { productName: 'Fixture' } };
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
  it('obtains original merchant and mode from the authenticated provider connection', async () => {
    const retrieveCurrent = vi.fn().mockResolvedValue({ id: 'acct_fixture' });
    const retrieve = vi.fn().mockResolvedValue({ livemode: false });
    await expect(resolveStripeScope({ accounts: { retrieveCurrent }, balance: { retrieve } } as unknown as Stripe)).resolves.toEqual(scope);
    expect(retrieveCurrent).toHaveBeenCalledWith();
  });
});
