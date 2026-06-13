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
  shouldReleaseAnnualSubscriptionCredits,
} from '../subscriptionCreditGrants';

type TableName =
  | 'payment_orders'
  | 'membership_plans'
  | 'subscription_credit_grants'
  | 'credit_transactions'
  | 'user_subscriptions'
  | 'profiles';

type Row = Record<string, any>;

class MockQuery {
  private filters: Array<{ column: string; value: unknown; operator: 'eq' | 'neq' }> = [];
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
      this.filters.every(({ column, value, operator }) =>
        operator === 'eq'
          ? row[column] === value
          : row[column] !== value,
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
      tables.credit_transactions.push(transaction);

      return {
        data: [{
          transaction_id: transaction.id,
          balance_before: 0,
          balance_after: payload.p_amount,
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
          id: 'order-later-gold-invoice',
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
    expect(supabase.tables.payment_orders[1]).toMatchObject({
      id: 'order-later-gold-invoice',
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

  it('stops future annual release after full refund', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-refunded',
        stripe_subscription_id: 'sub_refunded',
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
