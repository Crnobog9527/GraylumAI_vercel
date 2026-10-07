/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { vi } from 'vitest';
import type { PreviewDb } from '../subscriptionRefundEvidence';
import type { SubscriptionRefundStripe } from '../subscriptionRefundPreview';

export const actorId = '33333333-3333-4333-8333-333333333333';
export const subjectId = '22222222-2222-4222-8222-222222222222';
export const orderId = '11111111-1111-4111-8111-111111111111';
export const ticketId = '44444444-4444-4444-8444-444444444444';
export const itemId = '55555555-5555-4555-8555-555555555555';
export const subscriptionId = '66666666-6666-4666-8666-666666666666';
export const paidAt = '2026-10-01T00:00:00.000Z';
export const request = { orderId, ticketId, feePermitted: 'confirmed' as const, feeEvidence: 'legal-fixture' };
export type Row = Record<string, unknown>;
export function fixture() {
  const snapshot = { version: 1, item_type: 'membership_plan', item_id: itemId, item_updated_at: paidAt,
    billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '69', discount: '0',
    tax_behavior: 'inclusive', credits: 1000, bonus_credits: 100 };
  const order = { id: orderId, user_id: subjectId, item_type: 'membership_plan', item_id: itemId, billing_cycle: 'monthly',
    status: 'completed', payment_status: 'paid', amount_total: 6900, currency: 'usd', payment_channel: 'stripe', payment_mode: 'test',
    merchant_namespace: 'acct_fixture', purchase_snapshot: snapshot, subscription_id: subscriptionId, source_order_id: null,
    fulfilled_at: paidAt, updated_at: paidAt, refund_approval: null };
  const tables: Record<string, Row[]> = {
    payment_orders: [order],
    profiles: [actorId, subjectId].map(id => ({ id, role: id === actorId ? 'admin' : 'user', status: 'active', is_deleted: 'false' })),
    tickets: [{ id: ticketId, user_id: subjectId, category: 'billing', is_deleted: 'false', created_at: '2026-10-02T00:00:00Z',
      updated_at: paidAt, description: 'PRIVATE_TEXT_CANARY' }],
    user_subscriptions: [{ id: subscriptionId, user_id: subjectId, status: 'active', payment_channel: 'stripe', payment_mode: 'test',
      merchant_namespace: 'acct_fixture', contract_snapshot: snapshot, updated_at: paidAt }],
    subscription_credit_grants: [{ id: 'grant_1', user_id: subjectId, subscription_id: subscriptionId, source_order_id: orderId,
      grant_snapshot: snapshot, status: 'granted', credits_granted: 1100, credit_transaction_id: 'tx_grant', updated_at: paidAt }],
    credit_transactions: [{ id: 'tx_grant', user_id: subjectId, created_at: paidAt, amount: 1100, type: 'purchase', ledger_type: 'grant',
      reason_code: 'monthly_invoice', source_type: 'stripe_invoice', idempotency_key: 'grant_1', source_order_id: orderId, counts_as_spend: false }],
    billing_history: [],
    payment_provider_refs: [
      { id: 'map_1', order_id: orderId, subscription_id: null, object_type: 'payment', external_id: 'pi_fixture' },
      { id: 'map_2', order_id: orderId, subscription_id: null, object_type: 'invoice', external_id: 'in_fixture' },
      { id: 'map_3', order_id: null, subscription_id: subscriptionId, object_type: 'subscription', external_id: 'sub_fixture' },
    ].map(row => ({ ...row, channel: 'stripe', mode: 'test', merchant_namespace: 'acct_fixture' })),
  };
  const reads: { table: string; select: string }[] = [];
  const write = vi.fn(() => { throw new Error('WRITE_FORBIDDEN'); });
  const hook = vi.fn((_table: string, rows: Row[]) => rows);
  const from = vi.fn((table: string) => {
    let selected = '', start = 0, end = Infinity;
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => {
      reads.push({ table, select: selected });
      const found = hook(table, tables[table].filter(row => filters.every(f => f(row))))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const data = found.slice(start, end + 1).map(row => Object.fromEntries(selected.split(',').map(field => {
        const [alias, path] = field.includes(':') ? field.split(':') : [field, field];
        const [key, child] = path.split('->>');
        const value = child ? (row[key] as Row | null)?.[child] ?? null : row[key];
        return [alias, value];
      })));
      return { data: structuredClone(data), count: found.length, error: null };
    };
    const query = { select(value: string) { selected = value; return query; },
      eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query; },
      in(key: string, values: unknown[]) { filters.push(row => values.includes(row[key])); return query; },
      order() { return query; }, range(a: number, b: number) { start = a; end = b; return Promise.resolve(run()); },
      single: async () => { const result = run(); return { ...result, data: result.data[0] }; },
      limit: async (limit: number) => { end = limit - 1; return run(); },
      insert: write, update: write, delete: write, upsert: write,
    };
    return query;
  });
  const stamp = Date.parse(paidAt) / 1000;
  const invoices = [{ id: 'in_fixture', object: 'invoice', livemode: false, status: 'paid', amount_paid: 6900, currency: 'usd',
    parent: { subscription_details: { subscription: 'sub_fixture' } }, status_transitions: { paid_at: stamp }, billing_reason: 'subscription_create' }];
  const stripe = {
    accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_fixture' })) },
    balance: { retrieve: vi.fn(async () => ({ livemode: false })) },
    paymentIntents: { retrieve: vi.fn(async () => ({ id: 'pi_fixture', livemode: false, status: 'succeeded',
      amount_received: 6900, currency: 'usd', latest_charge: 'ch_fixture' })), create: write },
    charges: { retrieve: vi.fn(async () => ({ id: 'ch_fixture', livemode: false, paid: true, captured: true,
      payment_intent: 'pi_fixture', amount: 6900, amount_captured: 6900, amount_refunded: 0, currency: 'usd',
      disputed: false, balance_transaction: { created: stamp } })) },
    refunds: { list: vi.fn(async () => ({ data: [] as Row[], has_more: false })), create: write },
    invoices: { list: vi.fn(async () => ({ data: structuredClone(invoices), has_more: false })), update: write },
    invoicePayments: { list: vi.fn(async () => ({ has_more: false, data: [{ id: 'ip_fixture', object: 'invoice_payment',
      invoice: 'in_fixture', status: 'paid', livemode: false, amount_paid: 6900, currency: 'usd',
      payment: { type: 'payment_intent', payment_intent: 'pi_fixture' }, status_transitions: { paid_at: stamp } }] })) },
    subscriptions: { update: write, cancel: write }, checkout: { sessions: { create: write } },
  };
  return { tables, order, snapshot, reads, write, hook, from, stripe, invoices,
    db: { from, rpc: write } as unknown as PreviewDb, provider: stripe as unknown as SubscriptionRefundStripe };
}
