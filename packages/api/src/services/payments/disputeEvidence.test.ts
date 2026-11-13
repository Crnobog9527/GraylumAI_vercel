/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { readDisputeEvidence } from './disputeEvidence';

const tables: Record<string, unknown> = {
  payment_disputes: { provider: 'stripe', provider_dispute_id: 'du_1', amount: 2900, currency: 'usd', reason: 'fraudulent',
    status: 'needs_response', opened_at: '2026-11-10T00:00:00Z', evidence_due_by: '2026-11-20T00:00:00Z', order_id: 'order-1' },
  payment_orders: { id: 'order-1', user_id: 'user-1', item_type: 'membership_plan', purchase_membership_level: 'gold',
    billing_cycle: 'monthly', amount_total: 2900, currency: 'usd', payment_method: 'card_cn', qualified_paid_at: '2026-11-01T00:00:00Z',
    fulfilled_at: '2026-11-01T00:00:05Z', entitlement_start: '2026-11-01T00:00:00Z', entitlement_end: '2026-12-01T00:00:00Z',
    purchase_snapshot: { credits: 8970 }, terms_version: 'terms-v3', terms_accepted_at: '2026-11-01T00:00:00Z', auto_renew: true },
  profiles: { email: 'buyer@example.test', created_at: '2026-10-01T00:00:00Z' },
  credit_transactions: [{ amount: -30, created_at: '2026-11-02T00:00:00Z' }, { amount: -70, created_at: '2026-11-05T00:00:00Z' }],
};
function db(override: Record<string, unknown> = {}) {
  const seen: unknown[] = [];
  return { seen, client: { from: (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'order']) q[m] = (...a: unknown[]) => { seen.push([table, m, ...a]); return q; };
    const value = table in override ? override[table] : tables[table];
    q.maybeSingle = async () => ({ data: value, error: null });
    q.limit = async () => ({ data: value, error: null });
    return q;
  } } as never };
}
it('summarises the order, accepted terms and usage after payment for the Stripe form', async () => {
  const t = db();
  const e = await readDisputeEvidence(t.client, 'dispute-1');
  expect(e.order).toMatchObject({ id: 'order-1', membershipLevel: 'gold', credits: 8970, termsVersion: 'terms-v3', autoRenew: true });
  expect(e.customer.email).toBe('buyer@example.test');
  expect(e.usage).toEqual({ spendCount: 2, creditsSpent: 100, firstUseAt: '2026-11-02T00:00:00Z', lastUseAt: '2026-11-05T00:00:00Z' });
  // Only this buyer's spend ledger, only after the payment; no IP or device fields are read anywhere.
  expect(t.seen).toContainEqual(['credit_transactions', 'eq', 'user_id', 'user-1']);
  expect(t.seen).toContainEqual(['credit_transactions', 'eq', 'ledger_type', 'spend']);
  expect(t.seen).toContainEqual(['credit_transactions', 'gte', 'created_at', '2026-11-01T00:00:00Z']);
  expect(JSON.stringify(t.seen)).not.toMatch(/ip_address|user_agent|device/);
});
it('refuses a dispute that is not matched to an order', async () => {
  await expect(readDisputeEvidence(db({ payment_disputes: { ...(tables.payment_disputes as object), order_id: null } }).client, 'd'))
    .rejects.toThrow('PAY_DISPUTE_EVIDENCE_NO_ORDER');
});
