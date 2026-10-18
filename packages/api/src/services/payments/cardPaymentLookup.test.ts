/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findCardOrderForPayment } from './cardPaymentLookup';

const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const base = { user_id: 'user', payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test',
  subscription_id: null, source_order_id: null, amount_total: 4900, currency: 'usd', fulfilled_at: '2026-10-13T00:00:00.000Z' };

function fixture(refs: Record<string, string>, orders: Record<string, Record<string, unknown>>, invoices: string[] = []) {
  const db = { from: vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = { select: vi.fn(() => chain), eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return chain; }),
      limit: vi.fn(async () => {
        const orderId = refs[String(filters.external_id)];
        return { error: null, data: filters.object_type === 'payment' && orderId ? [{ order_id: orderId }] : [] };
      }),
      maybeSingle: vi.fn(async () => ({ error: null, data: table === 'payment_orders' ? orders[String(filters.id)] ?? null : null })) };
    return chain;
  }) };
  const stripe = {
    charges: { retrieve: vi.fn(async () => ({ object: 'charge', id: 'ch_1', livemode: false, payment_intent: 'pi_1' })) },
    invoicePayments: { list: vi.fn(async () => ({ data: invoices.map(invoice => ({ invoice })) })) },
  };
  const find = (input: Parameters<typeof findCardOrderForPayment>[3], options = {}) =>
    findCardOrderForPayment(db as unknown as SupabaseClient, stripe as unknown as Stripe, scope, input, options);
  return { find, stripe };
}

describe('PAY-STRIPE-MP shared lookup from a Stripe payment to the card order', () => {
  it('finds a one-time card pack by its PaymentIntent', async () => {
    const f = fixture({ pi_1: 'pack' }, { pack: { ...base, id: 'pack', item_type: 'credit_package', payment_method: 'card' } });
    await expect(f.find({ chargeId: 'ch_1' })).resolves.toMatchObject({ kind: 'pack', paymentId: 'pi_1', paymentIntentId: 'pi_1',
      order: { id: 'pack' } });
    expect(f.stripe.invoicePayments.list).not.toHaveBeenCalled();
  });
  it('finds a subscription period through the invoice its PaymentIntent paid (first payment and renewal)', async () => {
    const f = fixture({ in_first: 'first' }, { first: { ...base, id: 'first', item_type: 'membership_plan', payment_method: 'card' } },
      ['in_first']);
    await expect(f.find({ paymentIntentId: 'pi_1' })).resolves.toMatchObject({ kind: 'subscription_first', paymentId: 'in_first' });
    expect(f.stripe.invoicePayments.list).toHaveBeenCalledWith({ payment: { type: 'payment_intent', payment_intent: 'pi_1' },
      status: 'paid', limit: 10 });
    const r = fixture({ in_renew: 'renew' }, { renew: { ...base, id: 'renew', item_type: 'membership_plan', payment_method: 'card_cn',
      source_order_id: 'first' } }, ['in_renew']);
    await expect(r.find({ chargeId: 'ch_1' })).resolves.toMatchObject({ kind: 'subscription_renewal', paymentId: 'in_renew' });
  });
  it('leaves wallet orders and unknown payments to other paths', async () => {
    const wallet = fixture({ pi_1: 'wallet' }, { wallet: { ...base, id: 'wallet', item_type: 'membership_plan', payment_method: 'alipay' } });
    await expect(wallet.find({ chargeId: 'ch_1' })).resolves.toBeNull();
    await expect(fixture({}, {}).find({ chargeId: 'ch_1' })).resolves.toBeNull();
  });
  it.each(['wechat_pay', 'alipay'])('keeps explicitly included %s credit packages classified as packs', async method => {
    const f = fixture({ pi_1: 'pack' }, { pack: { ...base, id: 'pack', item_type: 'credit_package', payment_method: method } });
    await expect(f.find({ paymentIntentId: 'pi_1' })).resolves.toBeNull();
    await expect(f.find({ paymentIntentId: 'pi_1' }, { includeWalletPacks: true }))
      .resolves.toMatchObject({ kind: 'pack', paymentId: 'pi_1' });
  });
  it('refuses a card order of another merchant and a live charge in test mode', async () => {
    const other = fixture({ pi_1: 'pack' }, { pack: { ...base, id: 'pack', item_type: 'credit_package', payment_method: 'card',
      merchant_namespace: 'acct_other' } });
    await expect(other.find({ paymentIntentId: 'pi_1' })).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    const live = fixture({}, {});
    live.stripe.charges.retrieve.mockResolvedValue({ object: 'charge', id: 'ch_1', livemode: true, payment_intent: 'pi_1' });
    await expect(live.find({ chargeId: 'ch_1' })).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
  });
});
