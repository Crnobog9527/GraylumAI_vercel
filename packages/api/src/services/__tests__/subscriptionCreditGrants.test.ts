/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateAnnualMonthlyGrantSchedule,
  fulfillMembershipInvoiceWithSubscriptionCreditGrants,
  grantSubscriptionCredits,
  releaseDueAnnualSubscriptionCredits,
  reconcileSubscriptionRefundCreditGrants,
  shouldReleaseAnnualSubscriptionCredits,
} from '../subscriptionCreditGrants';
import { countsAsCreditSpend } from '../creditLedger';

type TableName =
  | 'payment_orders'
  | 'membership_plans'
  | 'subscription_credit_grants'
  | 'credit_transactions'
  | 'user_subscriptions'
  | 'profiles';

type Row = Record<string, any>;

class MockQuery {
  private filters: Array<{ column: string; value: unknown; operator: 'eq' | 'neq' | 'lte' }> = [];
  private containsFilters: Array<{ column: string; value: unknown }> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private limitValue: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly tables: Record<TableName, Row[]>,
    private readonly table: TableName,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value, operator: 'eq' });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, value, operator: 'neq' });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ column, value, operator: 'lte' });
    return this;
  }

  contains(column: string, value: unknown) {
    this.containsFilters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderBy = { column, ascending: options.ascending ?? true };
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  update(payload: Row) {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  insert(payload: Row) {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  async maybeSingle() {
    if (this.mode === 'insert') {
      const inserted = {
        id: this.payload?.id ?? `${this.table}-${this.tables[this.table].length + 1}`,
        ...this.payload,
      };
      this.tables[this.table].push(inserted);
      return { data: inserted, error: null };
    }

    if (this.mode === 'update') {
      const rows = this.matchingRows();
      rows.forEach((row) => Object.assign(row, this.payload));
      return { data: rows[0] ? { id: rows[0].id } : null, error: null };
    }

    const rows = this.matchingRows();
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute() {
    if (this.mode === 'insert') {
      const inserted = {
        id: this.payload?.id ?? `${this.table}-${this.tables[this.table].length + 1}`,
        ...this.payload,
      };
      this.tables[this.table].push(inserted);
      return { data: [inserted], error: null };
    }

    if (this.mode === 'update') {
      const rows = this.matchingRows();
      rows.forEach((row) => Object.assign(row, this.payload));
      return { data: rows, error: null };
    }

    return {
      data: this.limitValue === null
        ? this.matchingRows()
        : this.matchingRows().slice(0, this.limitValue),
      error: null,
    };
  }

  private matchingRows() {
    const rows = this.tables[this.table].filter((row) =>
      this.filters.every(({ column, value, operator }) => {
        if (operator === 'eq') {
          return row[column] === value;
        }

        if (operator === 'neq') {
          return row[column] !== value;
        }

        return row[column] <= value;
      })
      && this.containsFilters.every(({ column, value }) =>
        containsValue(row[column], value),
      ),
    );

    if (!this.orderBy) {
      return rows;
    }

    const { column, ascending } = this.orderBy;
    return [...rows].sort((left, right) => {
      const leftValue = left[column] ?? '';
      const rightValue = right[column] ?? '';

      if (leftValue === rightValue) {
        return 0;
      }

      const comparison = leftValue > rightValue ? 1 : -1;
      return ascending ? comparison : -comparison;
    });
  }
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return false;
    }

    return Object.entries(expected as Row).every(([key, value]) =>
      containsValue((actual as Row)[key], value),
    );
  }

  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.every((value) => (actual as unknown[]).some((item) => containsValue(item, value)));
  }

  return actual === expected;
}

function createMockSupabase(seed: Partial<Record<TableName, Row[]>> = {}) {
  const tables: Record<TableName, Row[]> = {
    payment_orders: seed.payment_orders ?? [],
    membership_plans: seed.membership_plans ?? [],
    subscription_credit_grants: seed.subscription_credit_grants ?? [],
    credit_transactions: seed.credit_transactions ?? [],
    user_subscriptions: seed.user_subscriptions ?? [],
    profiles: seed.profiles ?? [],
  };

  const supabase = {
    tables,
    from(table: TableName) {
      return new MockQuery(tables, table);
    },
    async rpc(name: string, payload: Row) {
      expect(name).toBe('atomic_apply_credit_ledger_entry');
      const existing = tables.credit_transactions.find((row) =>
        row.user_id === payload.p_user_id
        && row.idempotency_key === payload.p_idempotency_key,
      );

      if (existing) {
        return {
          data: [{
            transaction_id: existing.id,
            balance_before: existing.balance_before ?? 0,
            balance_after: existing.balance_after ?? 0,
            amount: existing.amount,
            is_idempotent: true,
          }],
          error: null,
        };
      }

      const transaction = {
        id: `txn-${tables.credit_transactions.length + 1}`,
        user_id: payload.p_user_id,
        amount: payload.p_amount,
        type: payload.p_type,
        description: payload.p_description,
        idempotency_key: payload.p_idempotency_key,
        balance_before: 0,
        balance_after: payload.p_amount,
      };
      const profile = tables.profiles.find((row) => row.id === payload.p_user_id);
      if (profile) {
        const balanceBefore = typeof profile.credits === 'number' ? profile.credits : Number(profile.credits ?? 0);
        const balanceAfter = balanceBefore + payload.p_amount;
        if (balanceAfter < 0) {
          return {
            data: null,
            error: { message: 'insufficient credits' },
          };
        }

        profile.credits = balanceAfter;
        transaction.balance_before = balanceBefore;
        transaction.balance_after = balanceAfter;
      }
      tables.credit_transactions.push(transaction);

      return {
        data: [{
          transaction_id: transaction.id,
          balance_before: transaction.balance_before,
          balance_after: transaction.balance_after,
          amount: payload.p_amount,
          is_idempotent: false,
        }],
        error: null,
      };
    },
  };

  return supabase;
}

describe('subscription credit grants', () => {
  it('splits yearly credits into 12 predictable periods that sum to yearly_credits', () => {
    const schedule = calculateAnnualMonthlyGrantSchedule(20_000);

    expect(schedule).toHaveLength(12);
    expect(schedule.slice(0, 8)).toEqual(Array(8).fill(1667));
    expect(schedule.slice(8)).toEqual(Array(4).fill(1666));
    expect(schedule.reduce((sum, value) => sum + value, 0)).toBe(20_000);
  });

  it('grants only the first annual month for a paid yearly invoice', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-yearly',
        user_id: 'user-yearly',
        item_id: 'plan-gold-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_yearly',
        stripe_checkout_session_id: 'change_subscription_plan_lock:sub_yearly',
        stripe_customer_id: 'cus_yearly',
        stripe_price_id: 'price_yearly',
        created_at: '2026-06-01T00:00:00.500Z',
        metadata: {
          source: 'changeSubscriptionPlan',
        },
      }],
      membership_plans: [{
        id: 'plan-gold-yearly',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 20_000,
        monthly_credits: 2000,
        monthly_bonus_credits: 100,
      }],
      profiles: [{
        id: 'user-yearly',
        membership_level: 'free',
      }],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_yearly_1',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2027-06-01T00:00:00.000Z',
      stripeCustomerId: 'cus_yearly',
      subscriptionId: 'sub_yearly',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(result.grantedCredits).toBe(1667);
    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-yearly',
      membership_level: 'gold',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      billing_cycle: 'yearly',
      grant_type: 'annual_monthly_release',
      period_index: 1,
      total_periods: 12,
      credits_granted: 1667,
      idempotency_key: expect.stringContaining('subscription_grant:annual_monthly_release:sub_yearly:'),
    });
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      ledger_type: 'grant',
      reason_code: 'annual_monthly_release',
      counts_as_spend: false,
      source_type: 'stripe_invoice',
      source_id: 'in_yearly_1',
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-yearly',
      stripe_checkout_session_id: null,
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: '2026-06-01T00:00:01.000Z',
    });
  });

  it('does not grant credits or complete an invoice order after full refund reconciliation wins the replay race', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-invoice-refund-race',
        user_id: 'user-invoice-refund-race',
        item_id: 'plan-invoice-refund-race',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_invoice_refund_race',
        stripe_subscription_id: 'sub_invoice_refund_race',
        stripe_customer_id: 'cus_invoice_refund_race',
        stripe_price_id: 'price_invoice_refund_race',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      membership_plans: [{
        id: 'plan-invoice-refund-race',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-invoice-refund-race',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const reconciliation = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-invoice-refund-race',
      subscriptionId: 'sub_invoice_refund_race',
      refundId: 're_invoice_refund_race_full',
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_invoice_refund_race',
      isFullRefund: true,
      now: '2026-06-01T00:00:02.000Z',
    });

    expect(reconciliation).toMatchObject({
      fullRefund: true,
      reviewRequired: false,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reversalStatus: 'complete',
        }),
      },
    });

    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_invoice_refund_race',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2027-06-01T00:00:00.000Z',
      stripeCustomerId: 'cus_invoice_refund_race',
      subscriptionId: 'sub_invoice_refund_race',
      now: '2026-06-01T00:00:03.000Z',
    });

    expect(replay).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: 'order-invoice-refund-race',
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason: 'refunded_status',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'free',
      credits: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_invoice_refund_race_full',
          fullRefund: true,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
  });

  it('does not grant credits when a pending full-refund shortfall marker exists on the invoice order', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-invoice-refund-shortfall-block',
        user_id: 'user-invoice-refund-shortfall-block',
        item_id: 'plan-invoice-refund-shortfall-block',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_invoice_refund_shortfall_block',
        stripe_subscription_id: 'sub_invoice_refund_shortfall_block',
        stripe_customer_id: 'cus_invoice_refund_shortfall_block',
        stripe_price_id: 'price_invoice_refund_shortfall_block',
        status: 'partially_refunded',
        payment_status: 'partially_refunded',
        metadata: {
          subscriptionCreditGrantReversal: {
            refundId: 're_invoice_refund_shortfall_block',
            fullRefund: true,
            reviewRequired: true,
            clawbackAmount: 30,
            appliedClawbackAmount: 5,
            shortfallAmount: 25,
            shortfallReason: 'insufficient_balance',
            reversalStatus: 'shortfall_review_required',
          },
        },
      }],
      membership_plans: [{
        id: 'plan-invoice-refund-shortfall-block',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-invoice-refund-shortfall-block',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_invoice_refund_shortfall_block',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2027-06-01T00:00:00.000Z',
      stripeCustomerId: 'cus_invoice_refund_shortfall_block',
      subscriptionId: 'sub_invoice_refund_shortfall_block',
      now: '2026-06-01T00:00:03.000Z',
    });

    expect(replay).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: 'order-invoice-refund-shortfall-block',
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason: 'grant_reversal_shortfall',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reviewRequired: true,
          shortfallAmount: 25,
          shortfallReason: 'insufficient_balance',
          reversalStatus: 'shortfall_review_required',
        }),
      },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
  });

  it('does not grant credits or complete an invoice order under partial refund review', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-invoice-partial-review-block',
        user_id: 'user-invoice-partial-review-block',
        item_id: 'plan-invoice-partial-review-block',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_invoice_partial_review_block',
        stripe_subscription_id: 'sub_invoice_partial_review_block',
        stripe_customer_id: 'cus_invoice_partial_review_block',
        stripe_price_id: 'price_invoice_partial_review_block',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      membership_plans: [{
        id: 'plan-invoice-partial-review-block',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-invoice-partial-review-block',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const partialRefund = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-invoice-partial-review-block',
      subscriptionId: 'sub_invoice_partial_review_block',
      refundId: 're_invoice_partial_review_block',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 2500,
      refundCurrency: 'usd',
      invoiceId: 'in_invoice_partial_review_block',
      isFullRefund: false,
      now: '2026-06-01T00:00:02.000Z',
    });

    expect(partialRefund).toMatchObject({
      fullRefund: false,
      reviewRequired: true,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_invoice_partial_review_block',
          fullRefund: false,
          reviewRequired: true,
          reversalStatus: 'partial_refund_review_required',
        }),
      },
    });

    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_invoice_partial_review_block',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2027-06-01T00:00:00.000Z',
      stripeCustomerId: 'cus_invoice_partial_review_block',
      subscriptionId: 'sub_invoice_partial_review_block',
      now: '2026-06-01T00:00:03.000Z',
    });

    expect(replay).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: 'order-invoice-partial-review-block',
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason: 'grant_reversal_partial_review_required',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'free',
      credits: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: false,
          reviewRequired: true,
          clawbackAmount: 0,
          appliedClawbackAmount: 0,
          shortfallAmount: 0,
          reversalStatus: 'partial_refund_review_required',
        }),
      },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
  });

  it('does not grant credits or complete a legacy partial_refunded invoice order', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-invoice-legacy-partial-review-block',
        user_id: 'user-invoice-legacy-partial-review-block',
        item_id: 'plan-invoice-legacy-partial-review-block',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_invoice_legacy_partial_review_block',
        stripe_subscription_id: 'sub_invoice_legacy_partial_review_block',
        stripe_customer_id: 'cus_invoice_legacy_partial_review_block',
        stripe_price_id: 'price_invoice_legacy_partial_review_block',
        status: 'partial_refunded',
        payment_status: 'partial_refunded',
        metadata: { source: 'legacy_refund_marker' },
      }],
      membership_plans: [{
        id: 'plan-invoice-legacy-partial-review-block',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-invoice-legacy-partial-review-block',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_invoice_legacy_partial_review_block',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2027-06-01T00:00:00.000Z',
      stripeCustomerId: 'cus_invoice_legacy_partial_review_block',
      subscriptionId: 'sub_invoice_legacy_partial_review_block',
      now: '2026-06-01T00:00:03.000Z',
    });

    expect(replay).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: 'order-invoice-legacy-partial-review-block',
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason: 'partial_refund_status',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'free',
      credits: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partial_refunded',
      payment_status: 'partial_refunded',
      metadata: { source: 'legacy_refund_marker' },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
  });

  it('skips refund-review invoice source orders and falls back to a paid source order', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-partial-review-newer',
          user_id: 'user-source-refund-review',
          item_id: 'plan-source-gold-yearly',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_source_partial_review',
          stripe_subscription_id: 'sub_source_refund_review',
          stripe_customer_id: 'cus_source_refund_review',
          stripe_price_id: 'price_source_gold_yearly',
          status: 'partial_refunded',
          payment_status: 'partial_refunded',
          created_at: '2026-06-01T00:00:02.000Z',
          metadata: { source: 'legacy_refund_marker' },
        },
        {
          id: 'order-source-paid-older',
          user_id: 'user-source-refund-review',
          item_id: 'plan-source-pro-yearly',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_source_refund_review',
          stripe_customer_id: 'cus_source_refund_review',
          stripe_price_id: 'price_source_pro_yearly',
          status: 'completed',
          payment_status: 'paid',
          created_at: '2026-06-01T00:00:00.000Z',
          metadata: { source: 'checkout.session.completed' },
        },
      ],
      membership_plans: [
        {
          id: 'plan-source-pro-yearly',
          name: 'Pro',
          level: 'pro',
          yearly_credits: 120,
        },
        {
          id: 'plan-source-gold-yearly',
          name: 'Gold',
          level: 'gold',
          yearly_credits: 240,
        },
      ],
      profiles: [{
        id: 'user-source-refund-review',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_source_paid_replay',
      invoiceCreatedAt: '2026-06-01T00:00:03.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:03.000Z',
      periodEnd: '2027-06-01T00:00:03.000Z',
      stripeCustomerId: 'cus_source_refund_review',
      subscriptionId: 'sub_source_refund_review',
      now: '2026-06-01T00:00:04.000Z',
    });

    expect(result).toMatchObject({
      alreadyFulfilled: false,
      grantedCredits: 10,
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      membership_plan_id: 'plan-source-pro-yearly',
      credits_granted: 10,
      grant_type: 'annual_monthly_release',
    });
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: 10,
      ledger_type: 'grant',
      reason_code: 'annual_monthly_release',
      counts_as_spend: false,
    });
    expect(supabase.tables.payment_orders.find((row) => row.id === 'order-source-partial-review-newer')).toMatchObject({
      status: 'partial_refunded',
      payment_status: 'partial_refunded',
      metadata: { source: 'legacy_refund_marker' },
    });
    expect(supabase.tables.payment_orders.find((row) => row.stripe_invoice_id === 'in_source_paid_replay')).toMatchObject({
      user_id: 'user-source-refund-review',
      item_id: 'plan-source-pro-yearly',
      status: 'completed',
      payment_status: 'paid',
      metadata: expect.objectContaining({
        source: 'invoice.payment_succeeded',
      }),
    });
    expect(supabase.tables.payment_orders.find((row) => row.stripe_invoice_id === 'in_source_paid_replay')).not.toMatchObject({
      item_id: 'plan-source-gold-yearly',
    });
  });

  it('does not grant credits when only refunded or shortfall invoice source orders exist', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-refunded-only',
          user_id: 'user-source-refunded-only',
          item_id: 'plan-source-refunded-only',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_source_refunded_only',
          stripe_subscription_id: 'sub_source_refunded_only',
          stripe_customer_id: 'cus_source_refunded_only',
          stripe_price_id: 'price_source_refunded_only',
          status: 'refunded',
          payment_status: 'refunded',
          created_at: '2026-06-01T00:00:02.000Z',
          metadata: {
            subscriptionCreditGrantReversal: {
              refundId: 're_source_refunded_only',
              fullRefund: true,
              reviewRequired: false,
              reversalStatus: 'complete',
            },
          },
        },
        {
          id: 'order-source-shortfall-only',
          user_id: 'user-source-refunded-only',
          item_id: 'plan-source-refunded-only',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_source_shortfall_only',
          stripe_subscription_id: 'sub_source_refunded_only',
          stripe_customer_id: 'cus_source_refunded_only',
          stripe_price_id: 'price_source_refunded_only',
          status: 'partially_refunded',
          payment_status: 'partially_refunded',
          created_at: '2026-06-01T00:00:01.000Z',
          metadata: {
            subscriptionCreditGrantReversal: {
              refundId: 're_source_shortfall_only',
              fullRefund: true,
              reviewRequired: true,
              shortfallAmount: 25,
              shortfallReason: 'insufficient_balance',
              reversalStatus: 'shortfall_review_required',
            },
          },
        },
      ],
      membership_plans: [{
        id: 'plan-source-refunded-only',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-source-refunded-only',
        membership_level: 'free',
        credits: 0,
      }],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_source_refunded_only_replay',
      invoiceCreatedAt: '2026-06-01T00:00:03.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-06-01T00:00:03.000Z',
      periodEnd: '2027-06-01T00:00:03.000Z',
      stripeCustomerId: 'cus_source_refunded_only',
      subscriptionId: 'sub_source_refunded_only',
      now: '2026-06-01T00:00:04.000Z',
    });

    expect(result).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: null,
      blockedSourceOrderId: 'order-source-refunded-only',
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason: 'refunded_status',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(2);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
    });
    expect(supabase.tables.payment_orders[1]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reviewRequired: true,
          reversalStatus: 'shortfall_review_required',
        }),
      },
    });
  });

  it('grants monthly credits plus monthly bonus for a paid monthly invoice', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-monthly',
        user_id: 'user-monthly',
        item_id: 'plan-pro-monthly',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_monthly',
        created_at: '2026-06-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-pro-monthly',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1500,
        monthly_bonus_credits: 250,
        yearly_credits: 18_000,
      }],
      profiles: [{
        id: 'user-monthly',
        membership_level: 'free',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_monthly_1',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_monthly',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-monthly',
      membership_level: 'pro',
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      billing_cycle: 'monthly',
      grant_type: 'monthly_invoice',
      grant_period_key: 'invoice:in_monthly_1',
      credits_granted: 1750,
    });
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: 1750,
      ledger_type: 'grant',
      reason_code: 'subscription_grant',
      counts_as_spend: false,
    });
  });

  it('does not use a newer pending plan-change lock for a stale successful invoice replay', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-new-upgrade-lock',
          user_id: 'user-stale-success',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_stale_success',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_stale_success',
          stripe_customer_id: 'cus_stale_success',
          stripe_price_id: 'price_gold_monthly',
          status: 'pending',
          payment_status: 'active',
          created_at: '2026-06-01T00:05:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-later-gold-invoice-0',
          user_id: 'user-stale-success',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_later_upgrade_success',
          stripe_subscription_id: 'sub_stale_success',
          stripe_customer_id: 'cus_stale_success',
          stripe_price_id: 'price_gold_monthly',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-01T00:10:01.000Z',
          created_at: '2026-06-01T00:10:01.000Z',
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `order-later-gold-invoice-${index + 1}`,
          user_id: 'user-stale-success',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: `in_later_upgrade_success_${index + 1}`,
          stripe_subscription_id: 'sub_stale_success',
          stripe_customer_id: 'cus_stale_success',
          stripe_price_id: 'price_gold_monthly',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: `2026-06-01T00:${String(11 + index).padStart(2, '0')}:01.000Z`,
          created_at: `2026-06-01T00:${String(11 + index).padStart(2, '0')}:01.000Z`,
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        })),
        {
          id: 'order-source-previous-pro',
          user_id: 'user-stale-success',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_stale_success',
          stripe_checkout_session_id: 'cs_test_previous_pro',
          stripe_customer_id: 'cus_stale_success',
          stripe_price_id: 'price_pro_monthly',
          status: 'completed',
          payment_status: 'paid',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      membership_plans: [
        {
          id: 'plan-pro-monthly',
          name: 'Pro',
          level: 'pro',
          monthly_credits: 1500,
          monthly_bonus_credits: 250,
        },
        {
          id: 'plan-gold-monthly',
          name: 'Gold',
          level: 'gold',
          monthly_credits: 3000,
          monthly_bonus_credits: 500,
        },
      ],
      profiles: [{
        id: 'user-stale-success',
        membership_level: 'pro',
      }],
      user_subscriptions: [{
        id: 'subscription-stale-success',
        user_id: 'user-stale-success',
        membership_plan_id: 'plan-pro-monthly',
        stripe_subscription_id: 'sub_stale_success',
        stripe_customer_id: 'cus_stale_success',
        stripe_price_id: 'price_pro_monthly',
        billing_cycle: 'monthly',
        status: 'active',
        cancel_at_period_end: 'false',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      invoiceId: 'in_stale_success_replay',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      paymentStatus: 'paid',
      stripeCustomerId: 'cus_stale_success',
      subscriptionId: 'sub_stale_success',
      now: '2026-06-01T00:05:01.000Z',
    });

    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-new-upgrade-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_stale_success',
      status: 'pending',
      payment_status: 'active',
    });
    expect(supabase.tables.payment_orders[0].fulfilled_at).toBeUndefined();
    expect(supabase.tables.payment_orders.find((row) => row.id === 'order-later-gold-invoice-0')).toMatchObject({
      id: 'order-later-gold-invoice-0',
      item_id: 'plan-gold-monthly',
      status: 'completed',
      payment_status: 'paid',
    });
    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-stale-success',
      membership_level: 'pro',
    });
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      id: 'subscription-stale-success',
      membership_plan_id: 'plan-pro-monthly',
      stripe_price_id: 'price_pro_monthly',
      billing_cycle: 'monthly',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      membership_plan_id: 'plan-pro-monthly',
      credits_granted: 1750,
    });
    expect(supabase.tables.subscription_credit_grants[0]).not.toMatchObject({
      membership_plan_id: 'plan-gold-monthly',
      credits_granted: 3500,
    });
  });

  it('ignores failed plan-change source rows when resolving the subscription source order', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `order-failed-upgrade-${index + 1}`,
          user_id: 'user-monthly',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_monthly',
          status: 'failed',
        })),
        {
          id: 'order-source-monthly',
          user_id: 'user-monthly',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_monthly',
          status: 'completed',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      membership_plans: [
        {
          id: 'plan-pro-monthly',
          name: 'Pro',
          level: 'pro',
          monthly_credits: 1500,
          monthly_bonus_credits: 250,
          yearly_credits: 18_000,
        },
        {
          id: 'plan-gold-monthly',
          name: 'Gold',
          level: 'gold',
          monthly_credits: 3000,
          monthly_bonus_credits: 500,
          yearly_credits: 36_000,
        },
      ],
      profiles: [{
        id: 'user-monthly',
        membership_level: 'free',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_monthly_failed_source_guard',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_monthly',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-monthly',
      membership_level: 'pro',
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      membership_plan_id: 'plan-pro-monthly',
      credits_granted: 1750,
    });
  });

  it('uses a failed same-invoice upgrade row as the source when the invoice is later paid', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-failed-upgrade-invoice',
          user_id: 'user-retry',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_retry_paid',
          stripe_subscription_id: 'sub_retry',
          stripe_customer_id: 'cus_retry',
          stripe_price_id: 'price_gold_monthly',
          status: 'failed',
          payment_status: 'open',
        },
        {
          id: 'order-source-previous',
          user_id: 'user-retry',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_retry',
          stripe_customer_id: 'cus_retry',
          stripe_price_id: 'price_pro_monthly',
          status: 'completed',
        },
      ],
      membership_plans: [
        {
          id: 'plan-pro-monthly',
          name: 'Pro',
          level: 'pro',
          monthly_credits: 1500,
          monthly_bonus_credits: 250,
        },
        {
          id: 'plan-gold-monthly',
          name: 'Gold',
          level: 'gold',
          monthly_credits: 3000,
          monthly_bonus_credits: 500,
        },
      ],
      profiles: [{
        id: 'user-retry',
        membership_level: 'pro',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 1990,
      invoiceId: 'in_retry_paid',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      paymentStatus: 'paid',
      stripeCustomerId: 'cus_retry',
      subscriptionId: 'sub_retry',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-retry',
      membership_level: 'gold',
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      membership_plan_id: 'plan-gold-monthly',
      credits_granted: 3500,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-failed-upgrade-invoice',
      item_id: 'plan-gold-monthly',
      status: 'completed',
      payment_status: 'paid',
    });
  });

  it('does not duplicate grants for repeated invoice fulfillment', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-repeat',
        user_id: 'user-repeat',
        item_id: 'plan-repeat',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_repeat',
        created_at: '2026-06-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-repeat',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1000,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-repeat',
        membership_level: 'free',
      }],
    });

    const input = {
      amountTotal: 990,
      invoiceId: 'in_repeat',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_repeat',
      now: '2026-06-01T00:00:01.000Z',
    };

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);
    supabase.tables.profiles[0].membership_level = 'free';
    const replayResult = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);

    expect(replayResult.alreadyFulfilled).toBe(true);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-repeat',
      membership_level: 'free',
    });
  });

  it('converges webhook and return-sync replays onto one invoice-backed checkout order', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-checkout-once',
        user_id: 'user-checkout-once',
        item_id: 'plan-gold-yearly-once',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_checkout_once',
        stripe_checkout_session_id: 'cs_test_checkout_once',
        stripe_customer_id: 'cus_checkout_once',
        stripe_price_id: 'price_gold_yearly_once',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-gold-yearly-once',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-checkout-once',
        membership_level: 'free',
        credits: 100,
      }],
    });

    const input = {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_checkout_once',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2027-07-04T00:00:00.000Z',
      stripeCustomerId: 'cus_checkout_once',
      subscriptionId: 'sub_checkout_once',
      now: '2026-07-04T00:00:02.000Z',
    };

    const first = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);
    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      ...input,
      now: '2026-07-04T00:00:03.000Z',
    });

    expect(first).toMatchObject({
      alreadyFulfilled: false,
      invoiceOrderId: 'order-checkout-once',
      grantedCredits: 10,
    });
    expect(replay).toMatchObject({
      alreadyFulfilled: true,
      invoiceOrderId: 'order-checkout-once',
      grantedCredits: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.payment_orders).toHaveLength(1);
    expect(supabase.tables.payment_orders.filter((order) => order.stripe_invoice_id === 'in_checkout_once')).toHaveLength(1);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-checkout-once',
      stripe_checkout_session_id: 'cs_test_checkout_once',
      stripe_invoice_id: 'in_checkout_once',
      stripe_subscription_id: 'sub_checkout_once',
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: '2026-07-04T00:00:02.000Z',
    });
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      stripe_subscription_id: 'sub_checkout_once',
      status: 'active',
      billing_cycle: 'yearly',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    const ledgerDelta = supabase.tables.credit_transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    expect(ledgerDelta).toBe(10);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'gold',
      credits: 110,
    });
    expect(supabase.tables.profiles[0].credits - 100).toBe(ledgerDelta);
  });

  it('updates one subscription mirror across invoices for the same Stripe subscription', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-checkout-subscription-once',
        user_id: 'user-subscription-once',
        item_id: 'plan-pro-monthly-once',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_subscription_once',
        stripe_checkout_session_id: 'cs_test_subscription_once',
        stripe_customer_id: 'cus_subscription_once',
        stripe_price_id: 'price_pro_monthly_once',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-pro-monthly-once',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-subscription-once',
        membership_level: 'free',
        credits: 0,
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_subscription_once_1',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2026-08-04T00:00:00.000Z',
      stripeCustomerId: 'cus_subscription_once',
      subscriptionId: 'sub_subscription_once',
      now: '2026-07-04T00:00:02.000Z',
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_subscription_once_2',
      invoiceCreatedAt: '2026-08-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-08-04T00:00:00.000Z',
      periodEnd: '2026-09-04T00:00:00.000Z',
      stripeCustomerId: 'cus_subscription_once',
      subscriptionId: 'sub_subscription_once',
      now: '2026-08-04T00:00:02.000Z',
    });

    expect(supabase.tables.payment_orders.filter((order) => order.stripe_invoice_id)).toHaveLength(2);
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      stripe_subscription_id: 'sub_subscription_once',
      status: 'active',
      metadata: expect.objectContaining({
        lastInvoiceId: 'in_subscription_once_2',
      }),
    });
  });

  it('does not expand existing duplicate invoice or subscription mirror state', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-checkout-duplicate-state',
          user_id: 'user-duplicate-state',
          item_id: 'plan-gold-duplicate-state',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_duplicate_state',
          stripe_checkout_session_id: 'cs_test_duplicate_state',
          stripe_customer_id: 'cus_duplicate_state',
          stripe_price_id: 'price_gold_duplicate_state',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-07-04T00:00:02.000Z',
          created_at: '2026-07-04T00:00:00.000Z',
        },
        {
          id: 'order-invoice-duplicate-state-a',
          user_id: 'user-duplicate-state',
          item_id: 'plan-gold-duplicate-state',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_duplicate_state',
          stripe_subscription_id: 'sub_duplicate_state',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-07-04T00:00:02.000Z',
          created_at: '2026-07-04T00:00:01.000Z',
        },
        {
          id: 'order-invoice-duplicate-state-b',
          user_id: 'user-duplicate-state',
          item_id: 'plan-gold-duplicate-state',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_duplicate_state',
          stripe_subscription_id: 'sub_duplicate_state',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-07-04T00:00:02.500Z',
          created_at: '2026-07-04T00:00:01.500Z',
        },
      ],
      user_subscriptions: [
        {
          id: 'subscription-duplicate-state-a',
          user_id: 'user-duplicate-state',
          membership_plan_id: 'plan-gold-duplicate-state',
          stripe_subscription_id: 'sub_duplicate_state',
          billing_cycle: 'yearly',
          status: 'active',
          created_at: '2026-07-04T00:00:02.000Z',
        },
        {
          id: 'subscription-duplicate-state-b',
          user_id: 'user-duplicate-state',
          membership_plan_id: 'plan-gold-duplicate-state',
          stripe_subscription_id: 'sub_duplicate_state',
          billing_cycle: 'yearly',
          status: 'active',
          created_at: '2026-07-04T00:00:02.500Z',
        },
      ],
      subscription_credit_grants: [{
        id: 'grant-duplicate-state',
        user_id: 'user-duplicate-state',
        membership_plan_id: 'plan-gold-duplicate-state',
        stripe_subscription_id: 'sub_duplicate_state',
        stripe_invoice_id: 'in_duplicate_state',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        period_index: 1,
        credits_granted: 10,
        credit_transaction_id: 'txn-duplicate-state',
        status: 'granted',
      }],
      credit_transactions: [{
        id: 'txn-duplicate-state',
        user_id: 'user-duplicate-state',
        amount: 10,
      }],
      membership_plans: [{
        id: 'plan-gold-duplicate-state',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-duplicate-state',
        membership_level: 'gold',
        credits: 110,
      }],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_duplicate_state',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2027-07-04T00:00:00.000Z',
      stripeCustomerId: 'cus_duplicate_state',
      subscriptionId: 'sub_duplicate_state',
      now: '2026-07-04T00:00:04.000Z',
    });

    expect(result).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: 'order-invoice-duplicate-state-a',
    });
    expect(supabase.tables.payment_orders).toHaveLength(3);
    expect(supabase.tables.payment_orders.filter((order) => order.stripe_invoice_id === 'in_duplicate_state')).toHaveLength(2);
    expect(supabase.tables.user_subscriptions).toHaveLength(2);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'gold',
      credits: 110,
    });
  });

  it('releases a residual plan-change lock on already fulfilled invoice replay', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-replay-lock',
          user_id: 'user-replay-lock',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_replay_lock',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_replay_lock',
          stripe_customer_id: 'cus_replay_lock',
          stripe_price_id: 'price_gold_monthly',
          status: 'pending',
          payment_status: 'active',
          created_at: '2026-06-01T00:00:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-invoice-replay-lock',
          user_id: 'user-replay-lock',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_replay_lock',
          stripe_subscription_id: 'sub_replay_lock',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-01T00:00:01.000Z',
          created_at: '2026-06-01T00:00:01.000Z',
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        },
      ],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 1990,
      invoiceId: 'in_replay_lock',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      subscriptionId: 'sub_replay_lock',
      now: '2026-06-01T00:00:02.000Z',
    });

    expect(result).toMatchObject({
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-replay-lock',
      stripe_checkout_session_id: null,
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: '2026-06-01T00:00:01.000Z',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('does not release a newer plan-change lock when replaying an older fulfilled invoice', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-newer-lock',
          user_id: 'user-newer-lock',
          item_id: 'plan-gold-yearly',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_newer_lock',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_newer_lock',
          status: 'pending',
          payment_status: 'active',
          created_at: '2026-06-01T00:05:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-invoice-newer-lock',
          user_id: 'user-newer-lock',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_newer_lock_replay',
          stripe_subscription_id: 'sub_newer_lock',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-01T00:05:30.000Z',
          created_at: '2026-06-01T00:05:30.000Z',
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        },
      ],
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_newer_lock_replay',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      subscriptionId: 'sub_newer_lock',
      now: '2026-06-01T00:05:31.000Z',
    });

    expect(result.alreadyFulfilled).toBe(true);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-newer-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_newer_lock',
      status: 'pending',
      payment_status: 'active',
    });
  });

  it('fails safely before grant/order/subscription writes when the profile is missing', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-missing-profile',
        user_id: 'user-missing-profile',
        item_id: 'plan-missing-profile',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_missing_profile',
        created_at: '2026-06-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-missing-profile',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1000,
        monthly_bonus_credits: 0,
      }],
    });

    await expect(
      fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
        amountTotal: 990,
        invoiceId: 'in_missing_profile',
        periodStart: '2026-06-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
        subscriptionId: 'sub_missing_profile',
        now: '2026-06-01T00:00:01.000Z',
      }),
    ).rejects.toMatchObject({
      name: 'SubscriptionCreditGrantError',
      stage: 'subscription_profile_missing',
    });

    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.user_subscriptions).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(1);
  });

  it('preserves existing cancel_at_period_end during invoice fulfillment', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-canceling',
        user_id: 'user-canceling',
        item_id: 'plan-canceling',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_canceling',
        created_at: '2026-06-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-canceling',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1000,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-canceling',
        membership_level: 'free',
      }],
      user_subscriptions: [{
        id: 'subscription-canceling',
        user_id: 'user-canceling',
        membership_plan_id: 'plan-canceling',
        stripe_subscription_id: 'sub_canceling',
        billing_cycle: 'monthly',
        status: 'active',
        cancel_at_period_end: 'true',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_canceling',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_canceling',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      id: 'subscription-canceling',
      cancel_at_period_end: 'true',
    });
  });

  it('preserves existing subscription lifecycle status during invoice fulfillment', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-source-lifecycle',
        user_id: 'user-lifecycle',
        item_id: 'plan-lifecycle',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_lifecycle',
        created_at: '2026-06-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-lifecycle',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1000,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-lifecycle',
        membership_level: 'free',
      }],
      user_subscriptions: [{
        id: 'subscription-lifecycle',
        user_id: 'user-lifecycle',
        membership_plan_id: 'plan-lifecycle',
        stripe_subscription_id: 'sub_lifecycle',
        billing_cycle: 'monthly',
        status: 'past_due',
        cancel_at_period_end: 'false',
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_lifecycle',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      subscriptionId: 'sub_lifecycle',
      now: '2026-06-01T00:00:01.000Z',
    });

    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      id: 'subscription-lifecycle',
      status: 'past_due',
    });
  });

  it('lets cron catch up missing annual release months', async () => {
    const supabase = createMockSupabase({
      user_subscriptions: [{
        id: 'subscription-row-1',
        user_id: 'user-catchup',
        membership_plan_id: 'plan-catchup',
        stripe_subscription_id: 'sub_catchup',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_catchup' },
      }],
      membership_plans: [{
        id: 'plan-catchup',
        name: 'Gold',
        yearly_credits: 120,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(result.releasedGrantCount).toBe(3);
    expect(result.releasedCredits).toBe(30);
    expect(supabase.tables.subscription_credit_grants.map((row) => row.period_index)).toEqual([1, 2, 3]);
  });

  it('releases only the currently due annual month for a normal paid active subscription', async () => {
    const supabase = createMockSupabase({
      user_subscriptions: [{
        id: 'subscription-active-paid',
        user_id: 'user-active-paid',
        membership_plan_id: 'plan-active-paid',
        stripe_subscription_id: 'sub_active_paid',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_active_paid' },
      }],
      membership_plans: [{
        id: 'plan-active-paid',
        name: 'Gold',
        yearly_credits: 120,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-01-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      scannedSubscriptions: 1,
      releasedGrantCount: 1,
      releasedCredits: 10,
      skippedSubscriptions: 0,
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      period_index: 1,
      total_periods: 12,
      credits_granted: 10,
      status: 'granted',
    });
  });

  it('continues annual release before current_period_end when cancel_at_period_end is true', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      cancelAtPeriodEnd: 'true',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      now: new Date('2026-08-01T00:00:00.000Z'),
    })).toBe(true);
  });

  it('stops annual release after canceled subscription passes current_period_end', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'canceled',
      cancelAtPeriodEnd: 'false',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-08-01T00:00:00.000Z'),
    })).toBe(false);
  });

  it('does not release annual credits for canceled, refunded, or invalid subscription states', () => {
    for (const status of ['canceled', 'cancelled', 'refunded', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
      expect(shouldReleaseAnnualSubscriptionCredits({
        billingCycle: 'yearly',
        status,
        cancelAtPeriodEnd: 'true',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
        now: new Date('2026-03-01T00:00:00.000Z'),
      })).toBe(false);
    }
  });

  it('stops future annual release after full refund', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-refunded',
        stripe_subscription_id: 'sub_refunded',
        stripe_invoice_id: 'in_refunded',
        status: 'refunded',
      }],
      user_subscriptions: [{
        id: 'subscription-refunded',
        user_id: 'user-refunded',
        membership_plan_id: 'plan-refunded',
        stripe_subscription_id: 'sub_refunded',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_refunded' },
      }],
      membership_plans: [{
        id: 'plan-refunded',
        name: 'Gold',
        yearly_credits: 120,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(result.releasedGrantCount).toBe(0);
    expect(result.skippedSubscriptions).toBe(1);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
  });

  it('stops future annual release for legacy partial-refund invoice status', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-legacy-partial-refunded',
        stripe_subscription_id: 'sub_legacy_partial_refunded',
        stripe_invoice_id: 'in_legacy_partial_refunded',
        status: 'partial_refunded',
        payment_status: 'partial_refunded',
      }],
      user_subscriptions: [{
        id: 'subscription-legacy-partial-refunded',
        user_id: 'user-legacy-partial-refunded',
        membership_plan_id: 'plan-legacy-partial-refunded',
        stripe_subscription_id: 'sub_legacy_partial_refunded',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_legacy_partial_refunded' },
      }],
      membership_plans: [{
        id: 'plan-legacy-partial-refunded',
        name: 'Gold',
        yearly_credits: 120,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      scannedSubscriptions: 1,
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
  });

  it('finds full-refund markers beyond the first payment order page before annual release', async () => {
    const historicalOrders = Array.from({ length: 35 }, (_, index) => ({
      id: `order-history-${index + 1}`,
      stripe_subscription_id: 'sub_refund_marker_many_rows',
      status: 'completed',
      payment_status: 'paid',
      metadata: { sequence: index + 1 },
    }));
    const supabase = createMockSupabase({
      payment_orders: [
        ...historicalOrders,
        {
          id: 'order-refund-marker-many-rows',
          stripe_subscription_id: 'sub_refund_marker_many_rows',
          stripe_invoice_id: 'in_refund_marker_many_rows',
          status: 'partially_refunded',
          payment_status: 'partially_refunded',
          metadata: {
            subscriptionCreditGrantReversal: {
              invoiceId: 'in_refund_marker_many_rows',
              fullRefund: true,
              reviewRequired: true,
              shortfallAmount: 15,
              reversalStatus: 'shortfall_review_required',
            },
          },
        },
      ],
      user_subscriptions: [{
        id: 'subscription-refund-marker-many-rows',
        user_id: 'user-refund-marker-many-rows',
        membership_plan_id: 'plan-refund-marker-many-rows',
        stripe_subscription_id: 'sub_refund_marker_many_rows',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_refund_marker_many_rows' },
      }],
      membership_plans: [{
        id: 'plan-refund-marker-many-rows',
        name: 'Gold',
        yearly_credits: 120,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      scannedSubscriptions: 1,
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
  });

  it('does not let an old refunded annual invoice block a later paid renewal invoice', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-old-refunded-renewal',
          stripe_subscription_id: 'sub_refund_scope_renewal',
          stripe_invoice_id: 'in_refund_scope_2026',
          status: 'refunded',
          payment_status: 'refunded',
          metadata: {
            subscriptionCreditGrantReversal: {
              invoiceId: 'in_refund_scope_2026',
              fullRefund: true,
              reversalStatus: 'complete',
            },
          },
        },
        {
          id: 'order-new-paid-renewal',
          user_id: 'user-refund-scope-renewal',
          item_type: 'membership_plan',
          item_id: 'plan-refund-scope-renewal',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_refund_scope_renewal',
          stripe_invoice_id: 'in_refund_scope_2027',
          status: 'completed',
          payment_status: 'paid',
        },
      ],
      user_subscriptions: [{
        id: 'subscription-refund-scope-renewal',
        user_id: 'user-refund-scope-renewal',
        membership_plan_id: 'plan-refund-scope-renewal',
        stripe_subscription_id: 'sub_refund_scope_renewal',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2027-01-01T00:00:00.000Z',
        current_period_end: '2028-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_refund_scope_2027' },
      }],
      membership_plans: [{
        id: 'plan-refund-scope-renewal',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-refund-scope-renewal',
        credits: 0,
      }],
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2027-01-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      scannedSubscriptions: 1,
      releasedGrantCount: 1,
      releasedCredits: 10,
      skippedSubscriptions: 0,
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      user_id: 'user-refund-scope-renewal',
      stripe_subscription_id: 'sub_refund_scope_renewal',
      stripe_invoice_id: 'in_refund_scope_2027',
      grant_type: 'annual_monthly_release',
      period_index: 1,
      credits_granted: 10,
    });
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: 10,
      source_type: 'stripe_invoice',
      source_id: 'in_refund_scope_2027',
      reason_code: 'annual_monthly_release',
      counts_as_spend: false,
    });
    expect(supabase.tables.profiles[0].credits).toBe(10);
  });

  it('claws back released annual grants on full refund and keeps the clawback out of spend', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-refund',
        user_id: 'user-subscription-refund',
        stripe_subscription_id: 'sub_subscription_refund',
        stripe_invoice_id: 'in_subscription_refund',
        status: 'completed',
        payment_status: 'paid',
        metadata: { grantedCredits: 10 },
      }],
      user_subscriptions: [{
        id: 'subscription-refund-reversal',
        user_id: 'user-subscription-refund',
        membership_plan_id: 'plan-subscription-refund',
        stripe_subscription_id: 'sub_subscription_refund',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_subscription_refund' },
      }],
      membership_plans: [{
        id: 'plan-subscription-refund',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-subscription-refund',
        credits: 100,
      }],
      subscription_credit_grants: [1, 2, 3].map((periodIndex) => ({
        id: `grant-refund-${periodIndex}`,
        user_id: 'user-subscription-refund',
        membership_plan_id: 'plan-subscription-refund',
        stripe_subscription_id: 'sub_subscription_refund',
        stripe_invoice_id: 'in_subscription_refund',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `sub_subscription_refund:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      })),
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund',
      subscriptionId: 'sub_subscription_refund',
      refundId: 're_subscription_full',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_refund',
      isFullRefund: true,
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: false,
      reversedGrantCount: 3,
      clawbackAmount: 30,
      creditTransactionId: 'txn-1',
      alreadyReconciled: false,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-subscription-refund',
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reviewRequired: false,
          clawbackAmount: 30,
          reversedGrantCount: 3,
          creditTransactionId: 'txn-1',
          idempotencyKey: 'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
        }),
      },
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -30,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_type: 'stripe_refund',
      source_id: 're_subscription_full',
      source_refund_id: 're_subscription_full',
      source_order_id: 'order-subscription-refund',
      idempotency_key: 'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
    });
    expect(countsAsCreditSpend(supabase.tables.credit_transactions[0])).toBe(false);
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
      'reversed',
    ]);
    expect(supabase.tables.subscription_credit_grants[0].metadata.reversal).toMatchObject({
      refundId: 're_subscription_full',
      creditTransactionId: 'txn-1',
      source: 'subscription_refund',
    });

    const releaseAfterRefund = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-04-15T00:00:00.000Z'),
    });
    expect(releaseAfterRefund).toMatchObject({
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund',
      subscriptionId: 'sub_subscription_refund',
      refundId: 're_subscription_full_later_event',
      refundEventType: 'refund.updated',
      refundStatus: 'succeeded',
      isFullRefund: true,
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      clawbackAmount: 30,
      creditTransactionId: 'txn-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_subscription_full',
      eventType: 'refund.created',
      reversedGrantCount: 3,
      clawbackAmount: 30,
      reviewRequired: false,
      idempotencyKey: 'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) =>
      grant.metadata.reversal.idempotencyKey,
    )).toEqual([
      'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
      'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
      'stripe_refund:subscription_grants:invoice:in_subscription_refund:sub_subscription_refund',
    ]);
  });

  it('records an auditable full-refund shortfall when the current balance cannot cover clawback', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-refund-shortfall',
        user_id: 'user-subscription-refund-shortfall',
        stripe_subscription_id: 'sub_subscription_refund_shortfall',
        stripe_invoice_id: 'in_subscription_refund_shortfall',
        status: 'completed',
        payment_status: 'paid',
        metadata: { grantedCredits: 20 },
      }],
      user_subscriptions: [{
        id: 'subscription-refund-shortfall',
        user_id: 'user-subscription-refund-shortfall',
        membership_plan_id: 'plan-subscription-refund-shortfall',
        stripe_subscription_id: 'sub_subscription_refund_shortfall',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_subscription_refund_shortfall' },
      }],
      membership_plans: [{
        id: 'plan-subscription-refund-shortfall',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-subscription-refund-shortfall',
        credits: 5,
      }],
      subscription_credit_grants: [1, 2, 3].map((periodIndex) => ({
        id: `grant-refund-shortfall-${periodIndex}`,
        user_id: 'user-subscription-refund-shortfall',
        membership_plan_id: 'plan-subscription-refund-shortfall',
        stripe_subscription_id: 'sub_subscription_refund_shortfall',
        stripe_invoice_id: 'in_subscription_refund_shortfall',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `sub_subscription_refund_shortfall:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      })),
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund-shortfall',
      subscriptionId: 'sub_subscription_refund_shortfall',
      refundId: 're_subscription_shortfall',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_refund_shortfall',
      isFullRefund: true,
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: true,
      reversedGrantCount: 3,
      clawbackAmount: 30,
      appliedClawbackAmount: 5,
      shortfallAmount: 25,
      creditTransactionId: 'txn-1',
      alreadyReconciled: false,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reviewRequired: true,
          clawbackAmount: 30,
          appliedClawbackAmount: 5,
          shortfallAmount: 25,
          shortfallReason: 'insufficient_balance',
          reversedGrantCount: 3,
          creditTransactionId: 'txn-1',
          reversalStatus: 'shortfall_review_required',
        }),
      },
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -5,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_type: 'stripe_refund',
      source_refund_id: 're_subscription_shortfall',
      source_order_id: 'order-subscription-refund-shortfall',
      metadata: expect.objectContaining({
        requiredClawbackAmount: 30,
        shortfallAmount: 25,
      }),
    });
    expect(countsAsCreditSpend(supabase.tables.credit_transactions[0])).toBe(false);
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
      'reversed',
    ]);
    expect(supabase.tables.subscription_credit_grants[0].metadata.reversal).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 30,
      appliedClawbackAmount: 5,
      shortfallAmount: 25,
      shortfallReason: 'insufficient_balance',
      source: 'subscription_refund',
    });

    const releaseAfterShortfall = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-04-15T00:00:00.000Z'),
    });
    expect(releaseAfterShortfall).toMatchObject({
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund-shortfall',
      subscriptionId: 'sub_subscription_refund_shortfall',
      refundId: 're_subscription_shortfall_later_event',
      refundEventType: 'refund.updated',
      refundStatus: 'succeeded',
      isFullRefund: true,
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: true,
      clawbackAmount: 30,
      appliedClawbackAmount: 5,
      shortfallAmount: 25,
      creditTransactionId: 'txn-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_subscription_shortfall',
      reversedGrantCount: 3,
      shortfallAmount: 25,
      reversalStatus: 'shortfall_review_required',
      idempotencyKey: 'stripe_refund:subscription_grants:invoice:in_subscription_refund_shortfall:sub_subscription_refund_shortfall',
    });
  });

  it('includes already reversed invoice grants when completing a later full-refund event', async () => {
    const invoiceScopedKey = 'stripe_refund:subscription_grants:invoice:in_subscription_refund_pending:sub_subscription_refund_pending';
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-refund-pending',
        user_id: 'user-subscription-refund-pending',
        stripe_subscription_id: 'sub_subscription_refund_pending',
        stripe_invoice_id: 'in_subscription_refund_pending',
        status: 'partially_refunded',
        payment_status: 'partially_refunded',
        metadata: {
          subscriptionCreditGrantReversal: {
            fullRefund: true,
            invoiceId: 'in_subscription_refund_pending',
            idempotencyKey: invoiceScopedKey,
            reversalStatus: 'pending',
          },
        },
      }],
      profiles: [{
        id: 'user-subscription-refund-pending',
        credits: 80,
      }],
      credit_transactions: [{
        id: 'txn-existing-invoice-refund',
        user_id: 'user-subscription-refund-pending',
        amount: -20,
        idempotency_key: invoiceScopedKey,
        ledger_type: 'refund_clawback',
        reason_code: 'refund_clawback',
        counts_as_spend: false,
      }],
      subscription_credit_grants: [1, 2].map((periodIndex) => ({
        id: `grant-refund-pending-${periodIndex}`,
        user_id: 'user-subscription-refund-pending',
        membership_plan_id: 'plan-subscription-refund-pending',
        stripe_subscription_id: 'sub_subscription_refund_pending',
        stripe_invoice_id: 'in_subscription_refund_pending',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `sub_subscription_refund_pending:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
        status: 'reversed',
        metadata: {
          sourceType: 'stripe_invoice',
          reversal: {
            invoiceId: 'in_subscription_refund_pending',
            idempotencyKey: invoiceScopedKey,
            creditTransactionId: 'txn-existing-invoice-refund',
            source: 'subscription_refund',
          },
        },
      })),
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund-pending',
      subscriptionId: 'sub_subscription_refund_pending',
      refundId: 're_subscription_refund_pending_later_event',
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_refund_pending',
      isFullRefund: true,
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: false,
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 20,
      shortfallAmount: 0,
      creditTransactionId: 'txn-existing-invoice-refund',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_subscription_refund_pending_later_event',
          eventType: 'charge.refunded',
          fullRefund: true,
          reviewRequired: false,
          reversedGrantCount: 2,
          clawbackAmount: 20,
          appliedClawbackAmount: 20,
          shortfallAmount: 0,
          creditTransactionId: 'txn-existing-invoice-refund',
          idempotencyKey: invoiceScopedKey,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
    ]);
  });

  it('reuses legacy refund-id keyed clawback when invoice-scoped replay completes a pending full refund', async () => {
    const invoiceScopedKey = 'stripe_refund:subscription_grants:invoice:in_subscription_refund_legacy:sub_subscription_refund_legacy';
    const legacyRefundKey = 'stripe_refund:subscription_grants:re_subscription_refund_legacy_original:sub_subscription_refund_legacy';
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-refund-legacy',
        user_id: 'user-subscription-refund-legacy',
        stripe_subscription_id: 'sub_subscription_refund_legacy',
        stripe_invoice_id: 'in_subscription_refund_legacy',
        status: 'partially_refunded',
        payment_status: 'partially_refunded',
        metadata: {
          subscriptionCreditGrantReversal: {
            refundId: 're_subscription_refund_legacy_original',
            eventType: 'refund.created',
            fullRefund: true,
            invoiceId: 'in_subscription_refund_legacy',
            reviewRequired: true,
            clawbackAmount: 20,
            appliedClawbackAmount: 5,
            shortfallAmount: 15,
            shortfallReason: 'insufficient_balance',
            creditTransactionId: 'txn-existing-legacy-refund',
            idempotencyKey: legacyRefundKey,
            reversalStatus: 'pending',
          },
        },
      }],
      profiles: [{
        id: 'user-subscription-refund-legacy',
        credits: 80,
      }],
      credit_transactions: [{
        id: 'txn-existing-legacy-refund',
        user_id: 'user-subscription-refund-legacy',
        amount: -5,
        idempotency_key: legacyRefundKey,
        ledger_type: 'refund_clawback',
        reason_code: 'refund_clawback',
        counts_as_spend: false,
        source_type: 'stripe_refund',
        source_refund_id: 're_subscription_refund_legacy_original',
        metadata: {
          idempotencyKey: legacyRefundKey,
          refundId: 're_subscription_refund_legacy_original',
          requiredClawbackAmount: 20,
          shortfallAmount: 15,
          reviewRequired: true,
        },
      }],
      subscription_credit_grants: [1, 2].map((periodIndex) => ({
        id: `grant-refund-legacy-${periodIndex}`,
        user_id: 'user-subscription-refund-legacy',
        membership_plan_id: 'plan-subscription-refund-legacy',
        stripe_subscription_id: 'sub_subscription_refund_legacy',
        stripe_invoice_id: 'in_subscription_refund_legacy',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `sub_subscription_refund_legacy:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
        status: 'reversed',
        metadata: {
          sourceType: 'stripe_invoice',
          reversal: {
            invoiceId: 'in_subscription_refund_legacy',
            idempotencyKey: legacyRefundKey,
            creditTransactionId: 'txn-existing-legacy-refund',
            reviewRequired: true,
            shortfallAmount: 15,
            shortfallReason: 'insufficient_balance',
            source: 'subscription_refund',
          },
        },
      })),
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund-legacy',
      subscriptionId: 'sub_subscription_refund_legacy',
      refundId: 're_subscription_refund_legacy_later_event',
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_refund_legacy',
      isFullRefund: true,
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: true,
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 5,
      shortfallAmount: 15,
      creditTransactionId: 'txn-existing-legacy-refund',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      id: 'txn-existing-legacy-refund',
      amount: -5,
      idempotency_key: legacyRefundKey,
      source_refund_id: 're_subscription_refund_legacy_original',
      metadata: expect.objectContaining({
        idempotencyKey: legacyRefundKey,
        refundId: 're_subscription_refund_legacy_original',
        shortfallAmount: 15,
        reviewRequired: true,
      }),
    });
    expect(supabase.tables.profiles[0].credits).toBe(80);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_subscription_refund_legacy_later_event',
          eventType: 'charge.refunded',
          fullRefund: true,
          reviewRequired: true,
          clawbackAmount: 20,
          appliedClawbackAmount: 5,
          shortfallAmount: 15,
          shortfallReason: 'insufficient_balance',
          creditTransactionId: 'txn-existing-legacy-refund',
          idempotencyKey: invoiceScopedKey,
          alreadyReconciled: true,
          reversalStatus: 'shortfall_review_required',
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) =>
      grant.metadata.reversal.idempotencyKey,
    )).toEqual([legacyRefundKey, legacyRefundKey]);
  });

  it('limits full-refund reversal to grants from the refunded invoice', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-refund-renewal',
        user_id: 'user-subscription-refund-renewal',
        stripe_subscription_id: 'sub_subscription_refund_renewal',
        stripe_invoice_id: 'in_subscription_refund_2027',
        status: 'completed',
        payment_status: 'paid',
        metadata: { grantedCredits: 20 },
      }],
      user_subscriptions: [{
        id: 'subscription-refund-renewal',
        user_id: 'user-subscription-refund-renewal',
        membership_plan_id: 'plan-subscription-refund-renewal',
        stripe_subscription_id: 'sub_subscription_refund_renewal',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2027-01-01T00:00:00.000Z',
        current_period_end: '2028-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_subscription_refund_2027' },
      }],
      membership_plans: [{
        id: 'plan-subscription-refund-renewal',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-subscription-refund-renewal',
        credits: 100,
      }],
      subscription_credit_grants: [
        ...[1, 2, 3].map((periodIndex) => ({
          id: `grant-refund-2026-${periodIndex}`,
          user_id: 'user-subscription-refund-renewal',
          membership_plan_id: 'plan-subscription-refund-renewal',
          stripe_subscription_id: 'sub_subscription_refund_renewal',
          stripe_invoice_id: 'in_subscription_refund_2026',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: `sub_subscription_refund_renewal:2026-0${periodIndex}:0${periodIndex}`,
          period_index: periodIndex,
          credits_granted: 10,
          status: 'granted',
          metadata: { sourceType: 'stripe_invoice', sourceId: 'in_subscription_refund_2026' },
        })),
        ...[1, 2].map((periodIndex) => ({
          id: `grant-refund-2027-${periodIndex}`,
          user_id: 'user-subscription-refund-renewal',
          membership_plan_id: 'plan-subscription-refund-renewal',
          stripe_subscription_id: 'sub_subscription_refund_renewal',
          stripe_invoice_id: 'in_subscription_refund_2027',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: `sub_subscription_refund_renewal:2027-0${periodIndex}:0${periodIndex}`,
          period_index: periodIndex,
          credits_granted: 10,
          status: 'granted',
          metadata: { sourceType: 'stripe_invoice', sourceId: 'in_subscription_refund_2027' },
        })),
      ],
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-refund-renewal',
      subscriptionId: 'sub_subscription_refund_renewal',
      refundId: 're_subscription_renewal_full',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_refund_2027',
      isFullRefund: true,
      now: '2027-03-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: false,
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 20,
      shortfallAmount: 0,
      creditTransactionId: 'txn-1',
    });
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_subscription_refund_2026')
      .map((grant) => grant.status)).toEqual(['granted', 'granted', 'granted']);
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_subscription_refund_2027')
      .map((grant) => grant.status)).toEqual(['reversed', 'reversed']);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -20,
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
      metadata: expect.objectContaining({
        invoiceId: 'in_subscription_refund_2027',
        requiredClawbackAmount: 20,
        reversedGrantCount: 2,
        reversedGrantPeriodKeys: [
          'sub_subscription_refund_renewal:2027-01:01',
          'sub_subscription_refund_renewal:2027-02:02',
        ],
      }),
    });
    expect(supabase.tables.subscription_credit_grants
      .find((grant) => grant.id === 'grant-refund-2026-1')?.metadata.reversal).toBeUndefined();
    expect(supabase.tables.subscription_credit_grants
      .find((grant) => grant.id === 'grant-refund-2027-1')?.metadata.reversal).toMatchObject({
        invoiceId: 'in_subscription_refund_2027',
        source: 'subscription_refund',
      });
  });

  it('marks partial subscription refunds for review without clawing back released grants', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-subscription-partial-refund',
        user_id: 'user-subscription-partial-refund',
        stripe_subscription_id: 'sub_subscription_partial_refund',
        stripe_invoice_id: 'in_subscription_partial_refund',
        status: 'completed',
        payment_status: 'paid',
        metadata: { grantedCredits: 10 },
      }],
      subscription_credit_grants: [{
        id: 'grant-partial-refund-1',
        user_id: 'user-subscription-partial-refund',
        membership_plan_id: 'plan-subscription-partial-refund',
        stripe_subscription_id: 'sub_subscription_partial_refund',
        stripe_invoice_id: 'in_subscription_partial_refund',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: 'sub_subscription_partial_refund:2026-01:01',
        period_index: 1,
        credits_granted: 10,
        status: 'granted',
      }],
    });

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-subscription-partial-refund',
      subscriptionId: 'sub_subscription_partial_refund',
      refundId: 're_subscription_partial',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 1000,
      refundCurrency: 'usd',
      invoiceId: 'in_subscription_partial_refund',
      isFullRefund: false,
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: false,
      reviewRequired: true,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: false,
          reviewRequired: true,
          clawbackAmount: 0,
          reversedGrantCount: 0,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      id: 'grant-partial-refund-1',
      status: 'granted',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('uses subscription_credit_grants idempotency keys to prevent duplicate direct grants', async () => {
    const supabase = createMockSupabase();
    const input = {
      userId: 'user-direct',
      membershipPlanId: 'plan-direct',
      stripeSubscriptionId: 'sub_direct',
      stripeInvoiceId: 'in_direct',
      billingCycle: 'yearly' as const,
      grantType: 'annual_monthly_release' as const,
      sourceType: 'stripe_invoice' as const,
      sourceId: 'in_direct',
      grantPeriodKey: 'sub_direct:2026-06:01',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      periodIndex: 1,
      totalPeriods: 12,
      creditsGranted: 99,
    };

    const first = await grantSubscriptionCredits(supabase, input);
    const second = await grantSubscriptionCredits(supabase, input);

    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      ledger_type: 'grant',
      counts_as_spend: false,
      grant_period_key: 'sub_direct:2026-06:01',
    });
  });
});
