/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteMonthlyRefund, type MonthlyDb } from './monthlyRefundService';
import type { MonthlyStripe } from './monthlyRefundProvider';
import { readSubscriptionRefundFacts } from './subscriptionRefundPreview';
import { subscriptionRefundPriorPro } from './subscriptionRefundPriorPro';
import { readSubscriptionRefundEvidence } from './subscriptionRefundEvidence';
import { fixture, actorId, request } from './__tests__/subscriptionRefundPreviewFixture';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') }));
afterEach(() => vi.useRealTimers());
function upgrade() {
  const f = fixture();
  Object.assign(f.order, { source_order_id: 'prior-order', method_transition: 'upgrade',
    method_prior_subscription: 'prior-sub', purchase_membership_level: 'gold', payment_method: 'card_cn', auto_renew: true });
  const oldSnapshot = { ...f.snapshot, item_id: '77777777-7777-4777-8777-777777777777', billing_cycle: 'yearly' };
  const oldOrder = { ...f.order, id: 'prior-order', item_id: oldSnapshot.item_id, subscription_id: 'prior-sub',
    source_order_id: null, method_transition: null, method_prior_subscription: null, purchase_membership_level: 'pro',
    purchase_snapshot: oldSnapshot, amount_total: 27900, billing_cycle: 'yearly' };
  f.tables.payment_orders.push(oldOrder);
  const oldSub = { ...f.tables.user_subscriptions[0], id: 'prior-sub', contract_snapshot: oldSnapshot,
    current_period_end: '2027-09-20T00:00:00.000Z', cancel_at_period_end: 'true' };
  f.tables.user_subscriptions.push(oldSub);
  f.tables.payment_provider_refs = f.tables.payment_provider_refs.filter(row => row.object_type === 'subscription')
    .concat({ ...f.tables.payment_provider_refs[0], id: 'gold-payment', object_type: 'payment', external_id: 'in_fixture' },
      { ...f.tables.payment_provider_refs[0], id: 'prior-payment', order_id: 'prior-order',
        object_type: 'payment', external_id: 'in_prior' },
      { ...f.tables.payment_provider_refs[2], id: 'prior-map', subscription_id: 'prior-sub', external_id: 'sub_prior' });
  f.invoices.push({ ...structuredClone(f.invoices[0]), id: 'in_prior', amount_paid: 27900,
    parent: { subscription_details: { subscription: 'sub_prior' } },
    status_transitions: { paid_at: Date.parse('2026-09-20T00:00:00Z') / 1000 } });
  f.stripe.invoices.list.mockImplementation(async (input?: { subscription?: string }) => ({ has_more: false,
    data: structuredClone(f.invoices.filter(row => !input?.subscription
      || row.parent.subscription_details.subscription === input.subscription)) }));
  return { ...f, oldOrder, oldSub };
}
describe('verified Pro -> Gold refund relationship', () => {
  it('recognizes the first Gold invoice despite an earlier paid Pro, binding its original term', async () => {
    const f = upgrade();
    const facts = await readSubscriptionRefundFacts(f.db, f.provider, actorId, request);
    expect(facts.policy.order.kind).toBe('pro_to_gold');
    expect(facts.priorPro).toEqual({ orderId: 'prior-order', subscriptionId: 'prior-sub',
      providerSubscriptionId: 'sub_prior', invoiceId: 'in_prior', autoRenew: true, periodEnd: '2027-09-20T00:00:00.000Z' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['wechat_pay', 'alipay'])('accepts a paid one-time %s Pro source without a provider subscription', async method => {
    const f = upgrade();
    Object.assign(f.oldOrder, { payment_method: method, auto_renew: false });
    f.tables.payment_provider_refs = f.tables.payment_provider_refs.filter(row => row.id !== 'prior-map');
    f.tables.payment_provider_refs.find(row => row.id === 'prior-payment')!.external_id = 'pi_prior';
    f.invoices.splice(1, 1);
    const pi = { ...await f.stripe.paymentIntents.retrieve(), customer: 'cus_fixture' };
    const charge = { ...await f.stripe.charges.retrieve(), customer: 'cus_fixture' };
    f.stripe.paymentIntents.retrieve.mockImplementation(async (id?: string) => id === 'pi_prior'
      ? { ...pi, id, latest_charge: 'ch_prior', amount_received: 27900 } : pi);
    f.stripe.charges.retrieve.mockImplementation(async (id?: string) => id === 'ch_prior'
      ? { ...charge, id, payment_intent: 'pi_prior', amount: 27900, amount_captured: 27900,
        balance_transaction: { created: Date.parse('2026-09-20T00:00:00Z') / 1000 } } : charge);
    const facts = await readSubscriptionRefundFacts(f.db, f.provider, actorId, request);
    expect(facts.policy.order.kind).toBe('pro_to_gold');
    expect(facts.priorPro).toMatchObject({ providerSubscriptionId: null, invoiceId: 'pi_prior', autoRenew: false });
    f.snapshot.billing_cycle = f.order.billing_cycle = 'yearly';
    f.snapshot.credits *= 12; f.snapshot.bonus_credits *= 12;
    const stripe = { ...f.stripe, invoiceItems: { list: vi.fn(async () => ({ data: [], has_more: false })) },
      subscriptions: { ...f.stripe.subscriptions, retrieve: vi.fn(async () => ({ id: 'sub_fixture', livemode: false,
        status: 'active', customer: 'cus_fixture', cancel_at_period_end: false, cancel_at: null, schedule: null,
        pending_update: null, pending_setup_intent: null, pause_collection: null, collection_method: 'charge_automatically',
        items: { has_more: false, data: [{ current_period_end: Date.parse('2027-10-01T00:00:00Z') / 1000,
          quantity: 1, price: { recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 } } }] } })) },
    } as unknown as MonthlyStripe;
    const db = { ...f.db, rpc: vi.fn(async () => ({ data: { localVersion: 'a'.repeat(32) }, error: null })) } as unknown as MonthlyDb;
    expect(await quoteMonthlyRefund(db, stripe, actorId, request)).toMatchObject({
      terms: { priorPro: { autoRenew: false, providerSubscriptionId: null }, snapshot: { billing_cycle: 'yearly' } } });
    expect(f.write).not.toHaveBeenCalled();
    // An unmapped cash payment or refund cannot silently count as the prior paid Pro term.
    f.stripe.paymentIntents.retrieve.mockResolvedValue(pi);
    await expect(readSubscriptionRefundFacts(f.db, f.provider, actorId, request)).rejects.toThrow('PAY_REFUND_PAYMENT_MISMATCH');
  });
  it.each(['level', 'unpaid', 'renewal', 'wrong-owner', 'wrong-contract', 'missing-map'])('refuses %s prior evidence', async kind => {
    const f = upgrade();
    if (kind === 'level') f.oldOrder.purchase_membership_level = 'gold';
    if (kind === 'unpaid') f.oldOrder.payment_status = 'unpaid';
    if (kind === 'renewal') f.oldSub.cancel_at_period_end = 'false';
    if (kind === 'wrong-owner') f.oldOrder.user_id = actorId;
    if (kind === 'wrong-contract') f.oldSub.contract_snapshot = { ...f.oldOrder.purchase_snapshot, price: '999' };
    if (kind === 'missing-map') f.tables.payment_provider_refs = f.tables.payment_provider_refs.filter(row => row.id !== 'prior-map');
    const order = { ...f.order, refund_status: null };
    const e = await readSubscriptionRefundEvidence(f.db, actorId, order, request.ticketId);
    expect(() => subscriptionRefundPriorPro(e, order)).toThrow('PAY_REFUND_UPGRADE_EVIDENCE');
    expect(f.write).not.toHaveBeenCalled();
  });
});
