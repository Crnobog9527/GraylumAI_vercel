/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { buildStripeCheckoutRequest, dispatchStripeCheckoutIntent, type StripeCheckoutIntent } from './stripeCheckoutIntent';

const scope = { merchant: 'fixture_merchant', mode: 'test' as const };
const snapshot = { version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd', unit: 'major',
  price: '19.99', discount: '2.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20 };
const orderId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const request = buildStripeCheckoutRequest({ orderId, userId: 'fixture_user', snapshot,
    priceId: 'price_fixture', productName: 'Fixture product', appUrl: 'https://example.test', expiresAt: 5000 });
  const intent: StripeCheckoutIntent = { id: orderId, userId: 'fixture_user', scope, snapshot,
    priceId: 'price_fixture', request, sessionId: null };
  const session = { id: 'cs_fixture', object: 'checkout.session', livemode: false, client_reference_id: intent.userId,
    metadata: request.metadata, amount_total: 1799, currency: 'usd', mode: 'payment' };
  const prices = { retrieve: vi.fn().mockResolvedValue({ id: 'price_fixture', object: 'price', active: true,
    livemode: false, currency: 'usd', unit_amount: 1999, billing_scheme: 'per_unit',
    tax_behavior: 'unspecified', type: 'one_time', recurring: null }) };
  const sessions = { list: vi.fn().mockResolvedValue({ data: [], has_more: false }), retrieve: vi.fn().mockResolvedValue(session), create: vi.fn().mockResolvedValue(session) };
  const persistSession = vi.fn().mockResolvedValue(undefined);
  const args = { stripe: { prices, checkout: { sessions } } as unknown as Pick<Stripe, 'prices' | 'checkout'>,
    intent, scope, persistSession, now: 1000 };
  return { args, prices, sessions, persistSession, session };
}

describe('durable Stripe checkout dispatch', () => {
  it('checks provider list price before dispatch and reuses the exact persisted request/key after a write failure', async () => {
    const t = fixture();
    t.persistSession.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('database unavailable');
    await expect(dispatchStripeCheckoutIntent(t.args)).resolves.toEqual(t.session);
    expect(t.sessions.create.mock.calls[0]).toEqual(t.sessions.create.mock.calls[1]);
    expect(t.sessions.create).toHaveBeenCalledWith(t.args.intent.request,
      { idempotencyKey: `pay-common:checkout:${orderId}` });
    expect(t.prices.retrieve.mock.invocationCallOrder[0]).toBeLessThan(t.sessions.create.mock.invocationCallOrder[0]);
  });
  it('a timeout keeps the same identity and makes no local success write', async () => {
    const t = fixture(); t.sessions.create.mockRejectedValueOnce(new Error('timeout'));
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('timeout');
    expect(t.persistSession).not.toHaveBeenCalled();
    await dispatchStripeCheckoutIntent(t.args);
    expect(t.sessions.create.mock.calls[0]).toEqual(t.sessions.create.mock.calls[1]);
  });
  it('recovers a mapped session without another creation or current-price dependency', async () => {
    const t = fixture(); t.args.intent.sessionId = t.session.id;
    await dispatchStripeCheckoutIntent(t.args);
    expect(t.sessions.retrieve).toHaveBeenCalledWith(t.session.id);
    expect(t.sessions.create).not.toHaveBeenCalled();
    expect(t.prices.retrieve).not.toHaveBeenCalled();
  });
  it('never retries creation once the frozen expiry has passed, including after key retention', async () => {
    const t = fixture(); t.args.now = 100000;
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED');
    expect(t.sessions.create).not.toHaveBeenCalled(); expect(t.persistSession).not.toHaveBeenCalled();
  });
  it('finds a lost response after expiry without dispatching again', async () => {
    const t = fixture(); t.args.now = 100000;
    t.sessions.list.mockResolvedValue({ data: [t.session], has_more: false });
    await expect(dispatchStripeCheckoutIntent(t.args)).resolves.toEqual(t.session);
    expect(t.sessions.create).not.toHaveBeenCalled();
    expect(t.sessions.retrieve).toHaveBeenCalledWith(t.session.id);
    expect(t.persistSession).toHaveBeenCalledOnce();
  });
  it('inspects the original attempt before retrying an uncertain result with the same key', async () => {
    const t = fixture(); t.args.intent.recover = true;
    await dispatchStripeCheckoutIntent(t.args);
    expect(t.sessions.list.mock.invocationCallOrder[0]).toBeLessThan(t.sessions.create.mock.invocationCallOrder[0]);
  });
  it('refuses duplicate or incomplete lookup results without dispatch', async () => {
    for (const duplicate of [true, false]) {
      const t = fixture(); t.args.intent.recover = true;
      t.sessions.list.mockResolvedValue({ data: duplicate ? [t.session, { ...t.session, id: 'cs_other' }] : [],
        has_more: !duplicate });
      await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_');
      expect(t.sessions.create).not.toHaveBeenCalled(); expect(t.persistSession).not.toHaveBeenCalled();
    }
  });
  it('does not retry when the provider lookup fails', async () => {
    const t = fixture(); t.args.intent.recover = true;
    t.sessions.list.mockRejectedValue(new Error('provider unavailable'));
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('provider unavailable');
    expect(t.sessions.create).not.toHaveBeenCalled();
  });
  it('refuses incorrect provider amounts before any checkout side effect', async () => {
    const t = fixture(); t.prices.retrieve.mockResolvedValue({ ...await t.prices.retrieve(), unit_amount: 1799 });
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_PRICE_MISMATCH');
    expect(t.sessions.create).not.toHaveBeenCalled();
  });
  it('refuses changed request totals and a different merchant before dispatch', async () => {
    const t = fixture(); t.args.intent.request.line_items![0].price_data!.unit_amount = 1;
    await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow('PAY_COMMON_CHECKOUT_REQUEST_INVALID');
    const other = fixture(); other.args.scope = { ...scope, merchant: 'other' };
    await expect(dispatchStripeCheckoutIntent(other.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
    expect(t.sessions.create).not.toHaveBeenCalled(); expect(other.sessions.create).not.toHaveBeenCalled();
  });
  it('does not persist a wrong-owner or wrong-amount provider result', async () => {
    for (const patch of [{ client_reference_id: 'other' }, { amount_total: 1 }, { livemode: true }]) {
      const t = fixture(); t.sessions.create.mockResolvedValue({ ...t.session, ...patch });
      await expect(dispatchStripeCheckoutIntent(t.args)).rejects.toThrow();
      expect(t.persistSession).not.toHaveBeenCalled();
    }
  });
});
