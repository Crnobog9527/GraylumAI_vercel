/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { closeExpiredStripeCheckout } from './stripePurchaseEvidence';

const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const snapshot = { version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd', unit: 'major',
  price: '1.00', discount: '0.10', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20 };
function fixture() {
  const order = { id: '22222222-2222-4222-8222-222222222222', user_id: 'fixture_user',
    payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: scope.mode, purchase_snapshot: snapshot };
  const metadata = { orderId: order.id, userId: order.user_id, itemId: snapshot.item_id,
    itemType: snapshot.item_type, billingCycle: snapshot.billing_cycle, priceId: 'price_fixture' };
  const session = { id: 'cs_fixture', object: 'checkout.session', status: 'expired', payment_status: 'unpaid',
    client_reference_id: order.user_id, metadata, payment_intent: 'pi_fixture', subscription: null,
    amount_total: 90, currency: 'usd', livemode: false, mode: 'payment', customer: null };
  const intent = { id: 'pi_fixture', object: 'payment_intent', status: 'canceled', amount: 90,
    amount_received: 0, amount_capturable: 0, currency: 'usd', livemode: false, metadata,
    customer: null, latest_charge: 'ch_fixture' };
  const charge = { id: 'ch_fixture', object: 'charge', payment_intent: intent.id, livemode: false,
    currency: 'usd', amount: 90, amount_captured: 0, status: 'failed', paid: false, customer: null };
  const retrieve = vi.fn().mockResolvedValue(session);
  const retrieveIntent = vi.fn().mockResolvedValue(intent);
  const listCharges = vi.fn().mockResolvedValue({ object: 'list', data: [charge], has_more: false });
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const stripe = { checkout: { sessions: { retrieve } }, paymentIntents: { retrieve: retrieveIntent },
    charges: { list: listCharges } } as unknown as Stripe;
  return { session, intent, charge, retrieve, retrieveIntent, listCharges, rpc,
    args: { stripe, supabase: { rpc }, order, mappedSessionId: session.id, scope } };
}

describe('declined purchase terminal evidence', () => {
  it.each(['canceled', 'requires_payment_method'])('closes expired unpaid checkout with %s and only failed charges', async status => {
    const t = fixture(); t.intent.status = status;
    await expect(closeExpiredStripeCheckout(t.args)).resolves.toBe(true);
    expect(t.retrieveIntent).toHaveBeenCalledExactlyOnceWith(t.intent.id);
    expect(t.listCharges).toHaveBeenCalledWith({ payment_intent: t.intent.id, limit: 100 });
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('pay_common_close_checkout', expect.objectContaining({
      p_order_id: t.args.order.id, p_checkout_status: 'expired', p_payment_status: 'unpaid',
    }));
  });
  it.each(['processing', 'succeeded', 'requires_capture', 'requires_action', 'requires_confirmation', 'unknown'])(
    'retains %s intents', async status => {
      const t = fixture(); t.intent.status = status;
      await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
      expect(t.rpc).not.toHaveBeenCalled();
    });
  it.each([{ amount_received: 1 }, { amount_received: undefined }, { amount_capturable: 1 },
    { id: 'pi_other' }, { object: 'unknown' }, { amount: 100 }, { currency: 'eur' }, { livemode: true },
    { metadata: {} }, { metadata: { orderId: 'other', userId: 'fixture_user' } }, { customer: 'cus_other' },
    { customer: undefined }, { latest_charge: undefined }])(
    'retains conflicting/unknown intent %j', async patch => {
      const t = fixture(); Object.assign(t.intent, patch);
      await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
      expect(t.rpc).not.toHaveBeenCalled();
    });
  it.each([{ status: 'succeeded' }, { status: 'pending' }, { paid: true }, { paid: undefined },
    { amount_captured: 1 }, { payment_intent: 'pi_other' }, { livemode: true }, { currency: 'eur' },
    { customer: 'cus_other' }, { customer: undefined }])('retains conflicting/paid charge %j', async patch => {
      const t = fixture(); Object.assign(t.charge, patch);
      await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
      expect(t.rpc).not.toHaveBeenCalled();
    });
  it('reads all charge pages and rejects an earlier success even if the latest attempt failed', async () => {
    const t = fixture();
    t.listCharges.mockResolvedValueOnce({ object: 'list', data: [t.charge], has_more: true })
      .mockResolvedValueOnce({ object: 'list', data: [{ ...t.charge, id: 'ch_earlier', status: 'succeeded', paid: true }], has_more: false });
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
    expect(t.listCharges).toHaveBeenLastCalledWith({ payment_intent: t.intent.id, limit: 100, starting_after: 'ch_fixture' });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('allows an explicitly empty charge history and null latest charge', async () => {
    const t = fixture(); Object.assign(t.intent, { latest_charge: null });
    t.listCharges.mockResolvedValue({ object: 'list', data: [], has_more: false });
    await expect(closeExpiredStripeCheckout(t.args)).resolves.toBe(true);
  });
  it('rejects a null latest charge when charge history is nonempty', async () => {
    const t = fixture(); Object.assign(t.intent, { latest_charge: null });
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('stops an incomplete scan without closing the purchase', async () => {
    const t = fixture(); let page = 0;
    t.listCharges.mockImplementation(async () => ({ object: 'list', has_more: true,
      data: [{ ...t.charge, id: `ch_page_${page++}` }] }));
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
    expect(t.listCharges).toHaveBeenCalledTimes(10);
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['intent-read', 'charge-read', 'incomplete', 'latest-missing'])('retains evidence on %s', async failure => {
    const t = fixture();
    if (failure === 'intent-read') t.retrieveIntent.mockRejectedValue(new Error('provider timeout'));
    if (failure === 'charge-read') t.listCharges.mockRejectedValue(new Error('provider timeout'));
    if (failure === 'incomplete') t.listCharges.mockResolvedValue({ data: [], has_more: true });
    if (failure === 'latest-missing') t.listCharges.mockResolvedValue({ data: [], has_more: false });
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('does not trust an expanded intent without an authoritative retrieve', async () => {
    const t = fixture(); Object.assign(t.session, { payment_intent: t.intent });
    t.retrieveIntent.mockResolvedValue({ ...t.intent, status: 'succeeded', amount_received: 90 });
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
    expect(t.retrieveIntent).toHaveBeenCalledWith(t.intent.id);
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it('requires the original session to be expired even when an intent looks canceled', async () => {
    const t = fixture(); t.session.status = 'open';
    await expect(closeExpiredStripeCheckout(t.args)).rejects.toThrow();
    expect(t.retrieveIntent).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
});
