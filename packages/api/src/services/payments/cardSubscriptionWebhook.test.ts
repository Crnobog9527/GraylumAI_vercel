/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), recover: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
import { handleCardSubscriptionInvoice, handleCardSubscriptionState } from './cardSubscriptionWebhook';

const orderId = '00000000-0000-4000-8000-000000000001';
type Rows = { subscriptionRef?: unknown; order?: unknown; checkoutRef?: unknown };
function fixture(rows: Rows, subscriptionMetadata: Record<string, string> = { orderId, userId: 'user' }) {
  const db = { from: vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = { select: vi.fn(() => chain), in: vi.fn(() => chain), order: vi.fn(() => chain), limit: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return chain; }),
      maybeSingle: vi.fn(async () => ({ error: null, data: table === 'payment_orders' ? rows.order ?? null
        : filters.object_type === 'subscription' ? rows.subscriptionRef ?? null : rows.checkoutRef ?? null })) };
    return chain;
  }) };
  const invoice = { object: 'invoice', id: 'in_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } } };
  const stripe = { invoices: { retrieve: vi.fn(async () => invoice) },
    subscriptions: { retrieve: vi.fn(async () => ({ object: 'subscription', id: 'sub_1', metadata: subscriptionMetadata })) },
    checkout: { sessions: { list: vi.fn(async () => ({ has_more: false, data: [{ id: 'cs_found', metadata: { orderId } }] })) } } };
  return { db: db as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, invoice, raw: stripe };
}
const cardOrder = { id: orderId, user_id: 'user', payment_method: 'card' };

describe('PAY-STRIPE-MP card subscription webhooks', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.recover.mockReset().mockResolvedValue({ orderId });
  });
  it('confirms the first invoice through the same first-payment recovery (mapped checkout)', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder, checkoutRef: { external_id: 'cs_mapped' } });
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', type)).resolves.toBe(true);
      expect(mocks.recover).toHaveBeenLastCalledWith(f.db, f.stripe, 'cs_mapped', type);
    }
  });
  it('finds the order from the authenticated subscription when the first invoice arrives before checkout completion', async () => {
    const f = fixture({ order: cardOrder });
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).resolves.toBe(true);
    expect(f.raw.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(f.raw.checkout.sessions.list).toHaveBeenCalledWith({ subscription: 'sub_1', limit: 10 });
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_found', 'invoice.paid');
  });
  it('refuses a subscription whose metadata names another owner', async () => {
    const f = fixture({ order: cardOrder }, { orderId, userId: 'someone-else' });
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('refuses renewals, failures and state changes of card subscriptions until they are handled (gate closed)', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
    f.invoice.billing_reason = 'subscription_cycle';
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('NOT_READY');
    f.invoice.billing_reason = 'subscription_create';
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.payment_failed')).rejects.toThrow('NOT_READY');
    await expect(handleCardSubscriptionState(f.db, f.stripe, 'sub_1')).rejects.toThrow('NOT_READY');
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('leaves legacy subscriptions and invoices without a subscription to the legacy path', async () => {
    const legacy = fixture({}, {});
    await expect(handleCardSubscriptionInvoice(legacy.db, legacy.stripe, 'in_1', 'invoice.paid')).resolves.toBe(false);
    await expect(handleCardSubscriptionState(legacy.db, legacy.stripe, 'sub_1')).resolves.toBe(false);
    const oneOff = fixture({});
    (oneOff.invoice as { parent: unknown }).parent = null;
    await expect(handleCardSubscriptionInvoice(oneOff.db, oneOff.stripe, 'in_1', 'invoice.paid')).resolves.toBe(false);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});
