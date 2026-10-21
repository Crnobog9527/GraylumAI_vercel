/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), recover: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
import { recoverWalletPaymentFailure } from './walletPaymentFailure';

const orderId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const order = { payment_method: 'alipay', payment_channel: 'stripe', merchant_namespace: 'fixture', payment_mode: 'test' };
  const ref = { external_id: 'cs_original' };
  const intent = { id: 'pi_failed', object: 'payment_intent', livemode: false, status: 'requires_payment_method',
    amount_received: 0, last_payment_error: { code: 'payment_intent_payment_attempt_failed' }, metadata: { orderId } };
  const session = { id: 'cs_original', object: 'checkout.session', payment_intent: 'pi_failed' };
  const stripe = { paymentIntents: { retrieve: vi.fn().mockResolvedValue(intent) },
    checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } } };
  const chains: Array<{ eq: ReturnType<typeof vi.fn> }> = [];
  const db = { from: vi.fn((table: string) => {
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
      maybeSingle: vi.fn().mockResolvedValue({ data: table === 'payment_orders' ? order : ref, error: null }) };
    chains.push(chain);
    return chain;
  }) };
  const run = () => recoverWalletPaymentFailure(db as unknown as SupabaseClient, stripe as unknown as Stripe, 'pi_failed');
  return { order, ref, intent, session, stripe, db, chains, run };
}
describe('signed wallet payment failure trigger', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ merchant: 'fixture', mode: 'test' });
    mocks.recover.mockReset().mockResolvedValue({ orderId });
  });
  it('locates the persisted checkout by original account/mode/order and revalidates it through recovery', async () => {
    const f = fixture(); await expect(f.run()).resolves.toBe(true);
    expect(f.chains[0]?.eq).toHaveBeenCalledWith('id', orderId);
    for (const entry of [['order_id', orderId], ['channel', 'stripe'], ['merchant_namespace', 'fixture'],
      ['mode', 'test'], ['object_type', 'checkout']]) expect(f.chains[1]?.eq).toHaveBeenCalledWith(...entry);
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_original', 'payment_intent.payment_failed', undefined);
  });
  it('ignores a late failure when the current PI was subsequently paid or is processing', async () => {
    for (const status of ['succeeded', 'processing', 'canceled']) {
      const f = fixture(); f.intent.status = status;
      await expect(f.run()).resolves.toBe(false); expect(f.db.from).not.toHaveBeenCalled();
    }
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('does not take a card order through the wallet failure path', async () => {
    const f = fixture(); f.order.payment_method = 'card';
    await expect(f.run()).resolves.toBe(false); expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('does not authorize from metadata when the original scoped checkout mapping is absent', async () => {
    const f = fixture(); f.ref.external_id = '';
    await expect(f.run()).resolves.toBe(false); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it.each(['piMode', 'orderMode', 'merchant', 'sessionIntent', 'sessionId'])('rejects %s mismatch', async reason => {
    const f = fixture();
    if (reason === 'piMode') f.intent.livemode = true;
    if (reason === 'orderMode') f.order.payment_mode = 'live';
    if (reason === 'merchant') f.order.merchant_namespace = 'other';
    if (reason === 'sessionIntent') f.session.payment_intent = 'pi_other';
    if (reason === 'sessionId') f.session.id = 'cs_other';
    await expect(f.run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT'); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('does not swallow current evidence or persistence errors', async () => {
    const f = fixture(); mocks.recover.mockRejectedValue(new Error('PAY_WAFFO_PAYMENT_CONFLICT'));
    await expect(f.run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
  });
});
