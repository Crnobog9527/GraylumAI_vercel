/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), recover: vi.fn(), conflict: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
vi.mock('./stripeConflictEvidence', () => ({ recordStripeInvoiceConflict: mocks.conflict }));
import { handleCardSubscriptionInvoice, handleCardSubscriptionState } from './cardSubscriptionWebhook';

const orderId = '00000000-0000-4000-8000-000000000001';
const firstMonth = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000002',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '69.00',
  discount: '20.00', tax_behavior: 'exclusive', credits: 8970, bonus_credits: 0 };
const line = { period: { start: 1794472954, end: 1797064954 } };
const renewal = (patch: Record<string, unknown>) => ({ billing_reason: 'subscription_cycle', livemode: false, status: 'paid',
  currency: 'usd', amount_paid: 6900, amount_due: 6900, total_taxes: [], status_transitions: { paid_at: 1794476560 },
  lines: { has_more: false, data: [line] }, ...patch });
type Rows = { subscriptionRef?: unknown; order?: unknown; checkoutRef?: unknown };
function fixture(rows: Rows, subscriptionMetadata: Record<string, string> = { orderId, userId: 'user' }) {
  const db = { rpc: vi.fn().mockResolvedValue({ data: { state: 'fulfilled' }, error: null }), from: vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = { select: vi.fn(() => chain), in: vi.fn(() => chain), order: vi.fn(() => chain), limit: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return chain; }),
      maybeSingle: vi.fn(async () => ({ error: null, data: table === 'payment_orders' ? rows.order ?? null
        : filters.object_type === 'subscription' ? rows.subscriptionRef ?? null : rows.checkoutRef ?? null })) };
    return chain;
  }) };
  const invoice = { object: 'invoice', id: 'in_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } } };
  const stripe = { invoices: { retrieve: vi.fn(async () => invoice) },
    subscriptions: { retrieve: vi.fn(async (): Promise<Record<string, unknown>> => ({ object: 'subscription', id: 'sub_1',
      metadata: subscriptionMetadata })) },
    checkout: { sessions: { list: vi.fn(async () => ({ has_more: false, data: [{ id: 'cs_found', metadata: { orderId } }] })) } } };
  return { db: db as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, invoice, raw: stripe, rpc: db.rpc };
}
const cardOrder = { id: orderId, user_id: 'user', payment_method: 'card' };

describe('PAY-STRIPE-MP card subscription webhooks', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.recover.mockReset().mockResolvedValue({ orderId }); mocks.conflict.mockReset().mockResolvedValue(undefined);
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
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('renews a paid cycle invoice at the pre-tax amount for the invoice period, for both paid events', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(f.invoice, renewal({ amount_paid: 8280, amount_due: 8280, total_taxes: [{ amount: 1380 }] }));
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', type)).resolves.toBe(true);
    }
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_renew_subscription', { p_subscription: 'local_sub', p_merchant: 'fixture',
      p_invoice: 'in_1', p_amount: 6900, p_currency: 'usd', p_paid: '2026-11-12T09:42:40.000Z',
      p_start: '2026-11-12T08:42:34.000Z', p_end: '2026-12-12T08:42:34.000Z' });
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it.each([
    ['two lines (proration)', { lines: { has_more: false, data: [line, line] } }],
    ['unpaid', { status: 'open' }],
    ['amount still due', { amount_paid: 0 }],
  ])('refuses a renewal invoice with %s', async (_name, patch) => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(f.invoice, renewal(patch));
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).rejects.toThrow(/CONFLICT|MISMATCH/);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('records a renewal failure at the signed event time and waits for a first payment before any renewal', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
    Object.assign(f.invoice, renewal({ status: 'open' }));
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.payment_failed', 1794476000)).resolves.toBe(true);
    expect(f.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_renewal_failure', { p_subscription: 'local_sub', p_merchant: 'fixture',
      p_invoice: 'in_1', p_failed_at: '2026-11-12T09:33:20.000Z' });
    const unmapped = fixture({ order: cardOrder });
    Object.assign(unmapped.invoice, renewal({}));
    await expect(handleCardSubscriptionInvoice(unmapped.db, unmapped.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('FIRST_PAYMENT_PENDING');
  });
  it('sends any other card-subscription invoice to manual review without granting', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
    f.invoice.billing_reason = 'subscription_update';
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).resolves.toBe(true);
    expect(f.rpc).not.toHaveBeenCalled(); expect(mocks.conflict).toHaveBeenCalled();
  });
  it('copies only stop-at-period-end and the final cancellation; past_due changes nothing', async () => {
    for (const [patch, cancelAt, canceled] of [[{ status: 'active', cancel_at_period_end: true }, true, false],
      [{ status: 'past_due', cancel_at_period_end: false }, false, false], [{ status: 'canceled', cancel_at_period_end: false }, false, true],
      [{ status: 'active', cancel_at_period_end: false, cancel_at: 1794472954 }, true, false]] as const) {
      const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
      f.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false, cancel_at: null, ...patch });
      await expect(handleCardSubscriptionState(f.db, f.stripe, 'sub_1')).resolves.toBe(true);
      expect(f.rpc).toHaveBeenCalledWith('pay_stripe_mp_sync_subscription', { p_subscription: 'local_sub', p_merchant: 'fixture',
        p_cancel_at_period_end: cancelAt, p_canceled: canceled });
    }
    const early = fixture({ order: cardOrder });
    await expect(handleCardSubscriptionState(early.db, early.stripe, 'sub_1')).resolves.toBe(true);
    expect(early.rpc).not.toHaveBeenCalled();
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
