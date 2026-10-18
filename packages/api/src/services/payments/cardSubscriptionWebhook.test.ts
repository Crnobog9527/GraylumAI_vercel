/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), recover: vi.fn(), conflict: vi.fn(), monthly: vi.fn(),
  resumeDisputes: vi.fn(async () => {}), refundDisputedRenewal: vi.fn(async () => 'succeeded') }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
vi.mock('./stripeConflictEvidence', () => ({ recordStripeInvoiceConflict: mocks.conflict }));
vi.mock('./monthlyRefundWebhook', () => ({ syncMonthlyRefundSubscription: mocks.monthly }));
vi.mock('./disputePayment', () => ({ readDisputePayment: vi.fn(async () => ({ paymentIntentId: 'pi_fixture',
 chargeId: 'ch_fixture', invoiceId: 'in_1', subscriptionId: 'sub_1', paymentAt: '2026-10-18T00:00:00Z' })) }));
vi.mock('./disputes', () => ({ resumeOrderDisputes: mocks.resumeDisputes }));
vi.mock('./disputeRenewalRefund', () => ({ refundDisputedRenewal: mocks.refundDisputedRenewal }));
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
    mocks.monthly.mockReset().mockResolvedValue(false);
    mocks.resumeDisputes.mockReset().mockResolvedValue(undefined);
    mocks.refundDisputedRenewal.mockReset().mockResolvedValue('succeeded');
  });
  it('leaves a subscription held by our approved monthly refund to that flow (step 4b-2)', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
    f.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false, status: 'canceled',
      cancel_at: null, cancel_at_period_end: false, cancellation_details: { comment: 'graylum_initiated' },
      items: { data: [{ current_period_end: 1794472954 }] } });
    mocks.monthly.mockResolvedValue(true);
    await expect(handleCardSubscriptionState(f.db, f.stripe, 'sub_1')).resolves.toBe(true);
    expect(mocks.monthly).toHaveBeenCalledWith(f.db, f.stripe, 'sub_1');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('confirms the first invoice through the same first-payment recovery (mapped checkout)', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder, checkoutRef: { external_id: 'cs_mapped' } });
    const disputeAlert = vi.fn();
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', type, undefined, undefined, disputeAlert)).resolves.toBe(true);
      expect(mocks.recover).toHaveBeenLastCalledWith(f.db, f.stripe, 'cs_mapped', type, disputeAlert);
    }
  });
  it('finds the order from the authenticated subscription when the first invoice arrives before checkout completion', async () => {
    const f = fixture({ order: cardOrder });
    const disputeAlert = vi.fn();
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid', undefined, undefined, disputeAlert)).resolves.toBe(true);
    expect(f.raw.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(f.raw.checkout.sessions.list).toHaveBeenCalledWith({ subscription: 'sub_1', limit: 10 });
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_found', 'invoice.paid', disputeAlert);
  });
  it('refuses a subscription whose metadata names another owner', async () => {
    const f = fixture({ order: cardOrder }, { orderId, userId: 'someone-else' });
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('renews a paid cycle invoice at the pre-tax amount for the invoice period, for both paid events', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(f.invoice, renewal({ amount_paid: 8280, amount_due: 8280, total_taxes: [{ amount: 1380 }] }));
    f.rpc.mockImplementation(async (name: string) => ({ error: null,
      data: name === 'pay_dispute_renew' ? { state: 'fulfilled', orderId: 'renewal_order' } : { duplicate: false } }));
    for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
      await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', type)).resolves.toBe(true);
    }
    expect(f.rpc).toHaveBeenCalledTimes(4);
    expect(f.rpc).toHaveBeenCalledWith('pay_dispute_renew', { p_facts: {
      subscription: 'local_sub', merchant: 'fixture', mode: 'test', invoiceId: 'in_1', subscriptionId: 'sub_1',
      paymentIntentId: 'pi_fixture', amount: 6900, currency: 'usd', paidAt: '2026-11-12T09:42:40.000Z',
      start: '2026-11-12T08:42:34.000Z', end: '2026-12-12T08:42:34.000Z' } });
    // The tax on top of the list price is recorded on the renewal order (the database dedupes the second event).
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', { p_order: 'renewal_order', p_merchant: 'fixture',
      p_payment: 'in_1', p_tax: 1380 });
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('passes structured dispute alerts through renewal freeze and refund recovery', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(f.invoice, renewal({}));
    f.rpc.mockImplementation(async (name: string) => ({ error: null,
      data: name === 'pay_dispute_renew' ? { state: 'fulfilled', orderId: 'renewal_order', disputeRefundRequired: true }
        : { duplicate: false } }));
    const genericAlert = vi.fn();
    const disputeAlert = vi.fn();
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid', undefined, genericAlert, disputeAlert)).resolves.toBe(true);
    expect(mocks.resumeDisputes).toHaveBeenCalledWith(f.db, f.stripe, 'renewal_order', disputeAlert);
    expect(mocks.refundDisputedRenewal).toHaveBeenCalledWith(f.db, f.stripe, 'renewal_order', 'in_1', disputeAlert);
    expect(genericAlert).not.toHaveBeenCalled();
  });
  it('stops renewal at Stripe and confirms it when a renewal is kept for review', async () => {
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(f.invoice, renewal({}));
    f.rpc.mockImplementation(async (name: string) => ({ error: null,
      data: name === 'pay_dispute_renew' ? { state: 'review', orderId: 'review_order' } : { status: 'active' } }));
    const active = { object: 'subscription', id: 'sub_1', livemode: false, status: 'active', cancel_at: null, cancel_at_period_end: false,
      items: { data: [{ current_period_end: 1797064954 }] } };
    f.raw.subscriptions.retrieve.mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, cancel_at_period_end: true });
    (f.raw.subscriptions as unknown as { update: ReturnType<typeof vi.fn> }).update = vi.fn(async () => ({}));
    const alert = vi.fn();
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid', undefined, alert)).resolves.toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect((f.raw.subscriptions as unknown as { update: ReturnType<typeof vi.fn> }).update)
      .toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true,
      cancellation_details: { comment: 'graylum_initiated' } });
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_sync_subscription', { p_subscription: 'local_sub', p_merchant: 'fixture',
      p_cancel_at_period_end: true, p_canceled: false, p_user_canceled: false });
    // If Stripe does not show the stop, the event fails so Stripe retries it (the renewal itself is deduplicated).
    const g = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: { ...cardOrder, purchase_snapshot: firstMonth } });
    Object.assign(g.invoice, renewal({}));
    g.rpc.mockImplementation(async (name: string) => ({ error: null,
      data: name === 'pay_dispute_renew' ? { state: 'review', orderId: 'review_order' } : { status: 'active' } }));
    g.raw.subscriptions.retrieve.mockResolvedValue(active);
    (g.raw.subscriptions as unknown as { update: ReturnType<typeof vi.fn> }).update = vi.fn(async () => ({}));
    await expect(handleCardSubscriptionInvoice(g.db, g.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('STOP_UNCONFIRMED');
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
    // Nothing charged (amount_paid 0 in this fixture): no stop and no alert.
    const quiet = vi.fn();
    await handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid', undefined, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });
  it('stops the subscription when such an invoice actually charged money', async () => {
    const active = { object: 'subscription', id: 'sub_1', livemode: false, status: 'active', cancel_at: null, cancel_at_period_end: false,
      metadata: { orderId, userId: 'user' }, items: { data: [{ current_period_end: 1797064954 }] } };
    const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
    Object.assign(f.invoice, { billing_reason: 'subscription_update', amount_paid: 2000 });
    f.raw.subscriptions.retrieve.mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, cancel_at_period_end: true });
    const update = vi.fn(async () => ({}));
    (f.raw.subscriptions as unknown as { update: typeof update }).update = update;
    const alert = vi.fn();
    await expect(handleCardSubscriptionInvoice(f.db, f.stripe, 'in_1', 'invoice.paid', undefined, alert)).resolves.toBe(true);
    expect(mocks.conflict).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true,
      cancellation_details: { comment: 'graylum_initiated' } });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_sync_subscription', { p_subscription: 'local_sub', p_merchant: 'fixture',
      p_cancel_at_period_end: true, p_canceled: false, p_user_canceled: false });
    // Before the first payment is mapped: Stripe retries until there is a local subscription to stop.
    const early = fixture({ order: cardOrder });
    Object.assign(early.invoice, { billing_reason: 'subscription_update', amount_paid: 2000 });
    await expect(handleCardSubscriptionInvoice(early.db, early.stripe, 'in_1', 'invoice.paid')).rejects.toThrow('FIRST_PAYMENT_PENDING');
  });
  it('copies only stop-at-period-end and the final cancellation; past_due changes nothing', async () => {
    for (const [patch, cancelAt, canceled, userCanceled] of [[{ status: 'active', cancel_at_period_end: true }, true, false, false],
      [{ status: 'past_due', cancel_at_period_end: false }, false, false, false],
      // Retry exhaustion vs a cancellation the buyer asked for (Link / portal): only the latter ends the founder window.
      [{ status: 'canceled', cancel_at_period_end: false, cancellation_details: { reason: 'payment_failed' } }, false, true, false],
      [{ status: 'canceled', cancel_at_period_end: false, cancellation_details: { reason: 'cancellation_requested' } }, false, true, true],
      // Our own stop (review, monthly refund) is marked, so the buyer keeps the founder window.
      [{ status: 'canceled', cancel_at_period_end: false,
        cancellation_details: { reason: 'cancellation_requested', comment: 'graylum_initiated' } }, false, true, false],
      [{ status: 'active', cancel_at_period_end: false, cancel_at: 1794472954 }, true, false, false],
      // A cancel_at later than the current period end still renews in between: not a stop.
      [{ status: 'active', cancel_at_period_end: false, cancel_at: 1797064954 }, false, false, false]] as const) {
      const f = fixture({ subscriptionRef: { subscription_id: 'local_sub' }, order: cardOrder });
      f.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false, cancel_at: null,
        items: { data: [{ current_period_end: 1794472954 }] }, ...patch });
      await expect(handleCardSubscriptionState(f.db, f.stripe, 'sub_1')).resolves.toBe(true);
      expect(f.rpc).toHaveBeenCalledWith('pay_stripe_mp_sync_subscription', { p_subscription: 'local_sub', p_merchant: 'fixture',
        p_cancel_at_period_end: cancelAt, p_canceled: canceled, p_user_canceled: userCanceled });
    }
    // Before the first payment is recorded: a plain state is acknowledged, a stop or cancellation is retried later.
    const early = fixture({ order: cardOrder });
    early.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false, status: 'active', metadata: { orderId, userId: 'user' },
      cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_end: 1794472954 }] } });
    await expect(handleCardSubscriptionState(early.db, early.stripe, 'sub_1')).resolves.toBe(true);
    for (const patch of [{ cancel_at_period_end: true }, { status: 'canceled' }]) {
      const stopped = fixture({ order: cardOrder });
      stopped.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false, status: 'active', metadata: { orderId, userId: 'user' },
        cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_end: 1794472954 }] }, ...patch });
      await expect(handleCardSubscriptionState(stopped.db, stopped.stripe, 'sub_1')).rejects.toThrow('FIRST_PAYMENT_PENDING');
      expect(stopped.rpc).not.toHaveBeenCalled();
    }
    expect(early.rpc).not.toHaveBeenCalled();
    // incomplete_expired: the first invoice was never paid, so there will never be a mapping; acknowledged, not retried.
    const abandoned = fixture({ order: cardOrder });
    abandoned.raw.subscriptions.retrieve.mockResolvedValue({ object: 'subscription', id: 'sub_1', livemode: false,
      status: 'incomplete_expired', metadata: { orderId, userId: 'user' }, cancel_at: null, cancel_at_period_end: false,
      items: { data: [{ current_period_end: 1794472954 }] } });
    await expect(handleCardSubscriptionState(abandoned.db, abandoned.stripe, 'sub_1')).resolves.toBe(true);
    expect(abandoned.rpc).not.toHaveBeenCalled();
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
