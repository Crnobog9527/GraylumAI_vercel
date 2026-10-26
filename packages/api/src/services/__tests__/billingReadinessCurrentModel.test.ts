/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REL-1 2026-10-26: the daily readiness audit failed every day on staging because it only understood the legacy Stripe
// model. These cases are the current model's normal records (shapes taken from staging rows) and the ways they can
// still go wrong.
import { describe, expect, it } from 'vitest';
import { buildBillingEngineV15ReadinessAudit, runBillingEngineV15ReadinessAudit } from '../billingReconciliation';

const now = new Date('2026-10-26T04:00:00.000Z');
const options = { now, launchBaselineAt: new Date('2026-09-04T00:00:00.000Z') };
const user = '7d3bdb16-0a9e-415f-9940-9cc46503dfcb';
const order = '2c504610-a30a-43b4-9ccf-1e9e7465a8f1';
const at = (minute: number) => new Date(Date.parse('2026-10-21T18:00:00.000Z') + minute * 60_000).toISOString();

type Rows = Parameters<typeof buildBillingEngineV15ReadinessAudit>[0];
const purchase = (extra: Record<string, unknown> = {}) => ({ id: 'txn-grant', user_id: user, amount: 3480, type: 'purchase',
  ledger_type: 'grant', reason_code: 'topup_purchase', counts_as_spend: false, source_order_id: order, grant_period_key: null,
  idempotency_key: `method-package:${order}`, balance_before: 0, balance_after: 3480, created_at: at(0), ...extra });
const clawback = { id: 'txn-clawback', user_id: user, amount: -3480, type: 'deduction', ledger_type: 'refund_clawback',
  reason_code: 'refund_clawback', counts_as_spend: false, source_order_id: order, idempotency_key: `pay-common:monthly-refund:${order}`,
  balance_before: 3480, balance_after: 0, created_at: at(5) };
const grant = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'grant-1', user_id: user, billing_cycle: 'monthly',
  grant_type: 'monthly_invoice', grant_period_key: `payment:${order}:01`, period_index: 1, total_periods: 1, credits_granted: 3480,
  consumed_amount: 0, accounting_state: 'clean', status, idempotency_key: `grant:${order}:01`, credit_transaction_id: 'txn-grant',
  created_at: at(0), updated_at: at(5), ...extra });
const refundedOrder = (extra: Record<string, unknown> = {}) => ({ id: order, user_id: user, item_type: 'membership_plan',
  mode: 'subscription', status: 'refunded', payment_status: 'refunded', amount_total: 3045, fulfilled_at: at(0), created_at: at(0),
  updated_at: at(5), stripe_subscription_id: null, stripe_invoice_id: null, subscription_id: 'sub-1', metadata: null,
  refund_approval: { status: 'succeeded', kind: 'monthly_first_purchase', hold: 'terminated' }, ...extra });
const rows = (patch: Partial<Rows> = {}): Rows => ({
  profiles: [{ id: user, credits: 0, created_at: at(-60) }],
  creditTransactions: [purchase(), clawback],
  paymentOrders: [refundedOrder()],
  subscriptionCreditGrants: [grant('reversed')],
  subscriptions: [{ id: 'sub-1', user_id: user, status: 'canceled', cancel_at_period_end: true, current_period_end: '2026-11-21T00:00:00.000Z' }],
  membershipPlans: [], billingHistory: [], ...patch,
});
const codes = (patch: Partial<Rows> = {}) => buildBillingEngineV15ReadinessAudit(rows(patch), options).findings.map(finding => finding.code);

describe('current-model refunds', () => {
  it('an approved refund with reversed grants and a clawback is clean', () => {
    const result = buildBillingEngineV15ReadinessAudit(rows(), options);
    expect(result.findings).toEqual([]);
    expect(result.success).toBe(true);
  });
  it('a refund made outside Graylum (stripeExternalRefund) is a recorded refund too', () => {
    const external = refundedOrder({ refund_approval: null,
      metadata: { stripeExternalRefund: { state: 'refunded', lastRefundId: 're_1', refundedAt: at(5) } } });
    expect(codes({ paymentOrders: [external] })).toEqual([]);
  });
  it('a refunded order without any refund record is still reported', () => {
    expect(codes({ paymentOrders: [refundedOrder({ refund_approval: null })] })).toContain('subscription_refund_audit_metadata_missing');
  });
  it('a refunded order whose grant is still live, or that was granted again after the refund, is a termination gap', () => {
    expect(codes({ subscriptionCreditGrants: [grant('granted')] })).toContain('refund_termination_gap');
    const regranted = purchase({ id: 'txn-late', created_at: at(30), balance_before: 0, balance_after: 3480 });
    expect(codes({ creditTransactions: [purchase(), clawback, regranted], profiles: [{ id: user, credits: 3480 }] }))
      .toContain('refund_termination_gap');
  });
  it('a refund that never delivered anything (test-clock close) needs no reversal', () => {
    const closed = refundedOrder({ refund_approval: null, subscription_id: null,
      metadata: { stripeExternalRefund: { state: 'refunded', neverFulfilled: true, creditsTakenBack: 0 },
        stripeTestClockClose: { clock: 'c', refunds: [{ id: 're_2', amount: 2900 }] } } });
    expect(codes({ paymentOrders: [closed], creditTransactions: [], subscriptionCreditGrants: [] })).toEqual([]);
  });
  it('a test-clock close without its provider refunds is not a refund record', () => {
    const unproven = refundedOrder({ refund_approval: null, subscription_id: null,
      metadata: { stripeExternalRefund: { state: 'refunded', neverFulfilled: true }, stripeTestClockClose: { clock: 'c', refunds: [] } } });
    expect(codes({ paymentOrders: [unproven], creditTransactions: [], subscriptionCreditGrants: [] }))
      .toContain('subscription_refund_audit_metadata_missing');
  });
  it('legacy Stripe orders keep the legacy termination rule', () => {
    const legacy = refundedOrder({ stripe_subscription_id: 'sub_legacy', subscription_id: null });
    expect(codes({ paymentOrders: [legacy] })).toContain('refund_termination_gap');
  });
});

describe('current-model grants', () => {
  const active = { paymentOrders: [], creditTransactions: [purchase()], profiles: [{ id: user, credits: 3480 }] };
  it('a grant written as a topup_purchase of the same order matches its ledger row', () => {
    expect(codes({ ...active, subscriptionCreditGrants: [grant('granted')] })).toEqual([]);
  });
  it('a different amount or another order still mismatches', () => {
    expect(codes({ ...active, subscriptionCreditGrants: [grant('granted', { credits_granted: 3000 })] }))
      .toContain('subscription_grant_credit_transaction_mismatch');
    expect(codes({ ...active, creditTransactions: [purchase({ source_order_id: '94caa8c5-8ec6-44c7-8d84-1e304ca5ba8c' })],
      subscriptionCreditGrants: [grant('granted')] })).toContain('subscription_grant_credit_transaction_mismatch');
  });
});

describe('renewing subscriptions', () => {
  const sub = (id: string, extra: Record<string, unknown>) => ({ id, user_id: user, status: 'active', cancel_at_period_end: false,
    current_period_end: '2026-11-19T00:00:00.000Z', ...extra });
  const base = { paymentOrders: [], creditTransactions: [], subscriptionCreditGrants: [], profiles: [{ id: user, credits: 0 }] };
  it('a stopping subscription next to its replacement (upgrade overlap, repurchase after refund) is not a duplicate', () => {
    expect(codes({ ...base, subscriptions: [sub('pro', { cancel_at_period_end: true }), sub('gold', {})] })).toEqual([]);
    expect(codes({ ...base, subscriptions: [sub('old', { status: 'canceled', cancel_at_period_end: true,
      credit_release_terminated_at: at(5) }), sub('new', {})] })).toEqual([]);
  });
  it('two subscriptions that will both charge again are a duplicate', () => {
    expect(codes({ ...base, subscriptions: [sub('a', {}), sub('b', { status: 'past_due' })] })).toContain('duplicate_active_subscription');
  });
});

describe('table scans', () => {
  it('reads past 5000 rows in pages instead of reporting billing_history as truncated', async () => {
    const history = Array.from({ length: 3200 }, (_, index) => {
      const hold = `h-${String(index).padStart(5, '0')}`;
      return [{ id: hold, user_id: user, operation_type: 'pre_deduct', amount: -1, created_at: at(0) },
        { id: `s-${hold}`, user_id: user, operation_type: 'settle', amount: 0, metadata: { preDeductId: hold }, created_at: at(1) }];
    }).flat();
    const tables: Record<string, Array<Record<string, unknown>>> = { billing_history: history,
      profiles: [{ id: user, credits: 0 }], credit_transactions: [], payment_orders: [], subscription_credit_grants: [],
      user_subscriptions: [], membership_plans: [] };
    const supabase = { from: (table: string) => {
      if (table === 'system_settings') {
        const settings = { select: () => settings, eq: () => settings,
          maybeSingle: async () => ({ data: { value: '2026-09-04T00:00:00.000Z' }, error: null }) };
        return settings;
      }
      let after: string | null = null;
      const page = { select: () => page, order: () => page, gt: (_: string, value: string) => { after = value; return page; },
        limit: async (limit: number) => {
          const sorted = [...tables[table]!].sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const rest = after === null ? sorted : sorted.filter(row => String(row.id) > (after as string));
          return { data: rest.slice(0, Math.min(limit, 1000)), count: sorted.length, error: null };
        } };
      return page;
    } } as never;
    const result = await runBillingEngineV15ReadinessAudit(supabase, { now });
    expect(result.summary.truncatedTables).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
