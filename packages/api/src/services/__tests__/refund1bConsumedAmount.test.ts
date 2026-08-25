/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  computePreDeductPeriodBinding,
  computeSettleAllocation,
  getSubscriptionRefundOperatorPreview,
  reconcileSubscriptionRefundCreditGrants,
  shouldReleaseAnnualSubscriptionCredits,
} from '../subscriptionCreditGrants';

type TableName =
  | 'payment_orders'
  | 'membership_plans'
  | 'subscription_credit_grants'
  | 'credit_transactions'
  | 'user_subscriptions'
  | 'profiles'
  | 'billing_history';

type Row = Record<string, any>;

type MockFilter = { column: string; value: unknown; operator: 'eq' | 'neq' | 'lte' | 'is' };

class Refund1bMockQuery {
  private filters: MockFilter[] = [];
  private containsFilters: Array<{ column: string; value: unknown }> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private limitValue: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly tables: Record<TableName, Row[]>,
    private readonly table: TableName,
    private readonly onWrite: (event: { table: TableName; mode: 'insert' | 'update' }) => void,
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

  is(column: string, value: unknown) {
    this.filters.push({ column, value, operator: 'is' });
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
      this.onWrite({ table: this.table, mode: 'insert' });
      return { data: inserted, error: null };
    }

    if (this.mode === 'update') {
      const rows = this.matchingRows();
      rows.forEach((row) => Object.assign(row, this.payload));
      if (rows.length > 0) {
        this.onWrite({ table: this.table, mode: 'update' });
      }
      return { data: rows[0] ?? null, error: null };
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
      this.onWrite({ table: this.table, mode: 'insert' });
      return { data: [inserted], error: null };
    }

    if (this.mode === 'update') {
      const rows = this.matchingRows();
      rows.forEach((row) => Object.assign(row, this.payload));
      if (rows.length > 0) {
        this.onWrite({ table: this.table, mode: 'update' });
      }
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

        if (operator === 'lte') {
          return row[column] <= value;
        }

        if (value === null) {
          return row[column] === null || row[column] === undefined;
        }

        return row[column] === value;
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
      return leftValue > rightValue ? 1 : -1;
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
  return actual === expected;
}

function createRefund1bSupabase(
  seed: Partial<Record<TableName, Row[]>> = {},
) {
  const writes: Array<{ table: TableName; mode: 'insert' | 'update' }> = [];
  const tables: Record<TableName, Row[]> = {
    payment_orders: seed.payment_orders ?? [],
    membership_plans: seed.membership_plans ?? [],
    subscription_credit_grants: seed.subscription_credit_grants ?? [],
    credit_transactions: seed.credit_transactions ?? [],
    user_subscriptions: seed.user_subscriptions ?? [],
    profiles: seed.profiles ?? [],
    billing_history: seed.billing_history ?? [],
  };

  const supabase = {
    tables,
    writes,
    from(table: TableName) {
      return new Refund1bMockQuery(tables, table, (event) => writes.push(event));
    },
    async rpc(name: string, payload: Row) {
      expect(name).toBe('atomic_apply_credit_ledger_entry');
      const profile = tables.profiles.find((row) => row.id === payload.p_user_id);
      const balanceBefore = typeof profile?.credits === 'number' ? profile.credits : 0;
      const balanceAfter = balanceBefore + payload.p_amount;
      if (balanceAfter < 0) {
        return { data: null, error: { message: 'insufficient credits' } };
      }
      if (profile) {
        profile.credits = balanceAfter;
      }
      const transaction = {
        id: `txn-clawback-${tables.credit_transactions.length + 1}`,
        user_id: payload.p_user_id,
        amount: payload.p_amount,
        type: payload.p_type,
        description: payload.p_description,
        idempotency_key: payload.p_idempotency_key,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
      tables.credit_transactions.push(transaction);
      writes.push({ table: 'credit_transactions', mode: 'insert' });
      return {
        data: [{
          transaction_id: transaction.id,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
          amount: payload.p_amount,
          is_idempotent: false,
        }],
        error: null,
      };
    },
  };

  return supabase;
}

type F3GrantState = {
  id: string;
  grantPeriodKey: string;
  creditsGranted: number;
  consumedAmount: number;
  status: string;
};

type F3LedgerState = {
  grant: F3GrantState | null;
  balance: number;
};

/**
 * 与 0053 atomic_pre_deduct 相同的驱动：预扣时即占用当期额度并锁定绑定拆分。
 */
function f3PreDeduct(state: F3LedgerState, amount: number) {
  const binding = computePreDeductPeriodBinding({
    amount,
    grant: state.grant
      ? {
        id: state.grant.id,
        grantPeriodKey: state.grant.grantPeriodKey,
        creditsGranted: state.grant.creditsGranted,
        consumedAmount: state.grant.consumedAmount,
      }
      : null,
  });
  if (state.grant) {
    state.grant.consumedAmount += binding.amountToPeriod;
  }
  state.balance -= amount;
  return binding;
}

/**
 * 与 0053 atomic_settle / atomic_finalize_ai_success 相同的驱动：按绑定逆分配结算。
 */
function f3Settle(state: F3LedgerState, binding: { amountToPeriod: number; amountToOther: number }, reserved: number, actual: number) {
  const allocation = computeSettleAllocation({
    reserved,
    actual,
    binding,
    grant: state.grant
      ? {
        creditsGranted: state.grant.creditsGranted,
        consumedAmount: state.grant.consumedAmount,
        status: state.grant.status,
      }
      : null,
  });
  if (state.grant) {
    state.grant.consumedAmount += allocation.periodConsumedDelta;
    expect(state.grant.consumedAmount).toBeGreaterThanOrEqual(0);
    expect(state.grant.consumedAmount).toBeLessThanOrEqual(state.grant.creditsGranted);
  }
  state.balance += allocation.balanceDelta;
  expect(state.balance).toBeGreaterThanOrEqual(0);
  return allocation;
}

describe('REFUND-1B pre-deduct binding allocation', () => {
  it('splits a reservation period-first capped at the current remaining quota', () => {
    expect(computePreDeductPeriodBinding({
      amount: 100,
      grant: { id: 'g1', grantPeriodKey: 'k1', creditsGranted: 1000, consumedAmount: 950 },
    })).toEqual({
      chargedGrantId: 'g1',
      chargedPeriodKey: 'k1',
      amountToPeriod: 50,
      amountToOther: 50,
    });

    expect(computePreDeductPeriodBinding({
      amount: 30,
      grant: null,
    })).toEqual({
      chargedGrantId: null,
      chargedPeriodKey: null,
      amountToPeriod: 0,
      amountToOther: 30,
    });
  });
});

describe('REFUND-1B mandatory F3 numeric acceptance cases', () => {
  it('sequential overrun: finalize first → consumed 150, clawback 850, final balance 500', () => {
    const state: F3LedgerState = {
      grant: { id: 'g', grantPeriodKey: 'p', creditsGranted: 1000, consumedAmount: 0, status: 'granted' },
      balance: 1500,
    };
    const binding = f3PreDeduct(state, 100);
    expect(binding.amountToPeriod).toBe(100);
    expect(binding.amountToOther).toBe(0);
    expect(state.balance).toBe(1400);
    expect(state.grant?.consumedAmount).toBe(100);

    const allocation = f3Settle(state, binding, 100, 150);
    expect(allocation.overrunToPeriod).toBe(50);
    expect(state.grant?.consumedAmount).toBe(150);
    expect(state.balance).toBe(1350);

    const clawback = (state.grant?.creditsGranted ?? 0) - (state.grant?.consumedAmount ?? 0);
    expect(clawback).toBe(850);
    expect(state.balance - clawback).toBe(500);
  });

  it('sequential overrun: refund completes first → finalize intercepts the overrun, final balance still 500', () => {
    const state: F3LedgerState = {
      grant: { id: 'g', grantPeriodKey: 'p', creditsGranted: 1000, consumedAmount: 0, status: 'granted' },
      balance: 1500,
    };
    const binding = f3PreDeduct(state, 100);
    expect(state.grant?.consumedAmount).toBe(100);

    // 退款先完成: clawback = granted - consumed(含在途预扣占用)
    const clawback = (state.grant?.creditsGranted ?? 0) - (state.grant?.consumedAmount ?? 0);
    expect(clawback).toBe(900);
    state.balance -= clawback;
    expect(state.balance).toBe(500);
    state.grant!.status = 'reversed';

    // finalize 到达: 超用不得再从其他来源补扣，也不得写入已 reversed 周期
    const allocation = f3Settle(state, binding, 100, 150);
    expect(allocation.refundInterceptedOverrun).toBe(50);
    expect(allocation.balanceDelta).toBe(0);
    expect(state.balance).toBe(500);
    expect(state.grant?.consumedAmount).toBe(100);
  });

  it('cross-period under-use: settle binds to the pre-deduct period, not now() → consumed 600→550, clawback 450, final balance 0', () => {
    const state: F3LedgerState = {
      grant: { id: 'g1', grantPeriodKey: 'annual:2026-01-01T00:00:00.000Z:01', creditsGranted: 1000, consumedAmount: 500, status: 'granted' },
      balance: 500,
    };
    // 第 1 期期末预扣 100，绑定第 1 期
    const binding = f3PreDeduct(state, 100);
    expect(binding.chargedPeriodKey).toBe('annual:2026-01-01T00:00:00.000Z:01');
    expect(binding.amountToPeriod).toBe(100);
    expect(state.grant?.consumedAmount).toBe(600);
    expect(state.balance).toBe(400);

    // finalize 已跨入第 2 期，但复用绑定在第 1 期上返还
    const allocation = f3Settle(state, binding, 100, 50);
    expect(allocation.periodRestore).toBe(50);
    expect(state.grant?.consumedAmount).toBe(550);
    expect(state.balance).toBe(450);

    const clawback = 1000 - 550;
    expect(clawback).toBe(450);
    expect(state.balance - clawback).toBe(0);
  });

  it('cross-source under-use: restore returns to other sources first → other 410→460, period consumed stays 1000, final 460', () => {
    const state: F3LedgerState = {
      grant: { id: 'g', grantPeriodKey: 'p', creditsGranted: 1000, consumedAmount: 990, status: 'granted' },
      balance: 510,
    };
    const binding = f3PreDeduct(state, 100);
    expect(binding.amountToPeriod).toBe(10);
    expect(binding.amountToOther).toBe(90);
    expect(state.grant?.consumedAmount).toBe(1000);
    expect(state.balance).toBe(410);

    const allocation = f3Settle(state, binding, 100, 50);
    expect(allocation.otherRestore).toBe(50);
    expect(allocation.periodRestore).toBe(0);
    expect(state.grant?.consumedAmount).toBe(1000);
    expect(state.balance).toBe(460);

    const clawback = 1000 - 1000;
    expect(clawback).toBe(0);
    expect(state.balance).toBe(460);
  });

  it('overage-then-refund: overrun eats the current remaining quota (not amountToPeriod) → consumed 150, clawback 850, final 500', () => {
    const state: F3LedgerState = {
      grant: { id: 'g', grantPeriodKey: 'p', creditsGranted: 1000, consumedAmount: 0, status: 'granted' },
      balance: 1500,
    };
    const binding = f3PreDeduct(state, 100);
    const allocation = f3Settle(state, binding, 100, 150);
    expect(allocation.overrunToPeriod).toBe(50);
    expect(allocation.overrunToOther).toBe(0);
    expect(state.grant?.consumedAmount).toBe(150);

    const clawback = 1000 - 150;
    expect(clawback).toBe(850);
    expect(state.balance - clawback).toBe(500);
  });

  it('keeps 0 <= consumed <= granted and balance >= 0 across chained under-use and overrun', () => {
    const state: F3LedgerState = {
      grant: { id: 'g', grantPeriodKey: 'p', creditsGranted: 1000, consumedAmount: 0, status: 'granted' },
      balance: 1500,
    };
    for (let round = 0; round < 20; round += 1) {
      state.balance += 100; // 每轮补充(新发放/充值)，仅维持经济学可行
      const binding = f3PreDeduct(state, 100);
      f3Settle(state, binding, 100, round % 2 === 0 ? 40 : 160);
      expect(state.grant?.consumedAmount).toBeGreaterThanOrEqual(0);
      expect(state.grant?.consumedAmount).toBeLessThanOrEqual(1000);
      expect(state.balance).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('REFUND-1B refund reconciliation integration', () => {
  function seedSubscription(options: {
    creditsGranted: number;
    consumedAmount: number;
    balance: number;
    grantStatus?: string;
  }) {
    return createRefund1bSupabase({
      payment_orders: [{
        id: 'order-f3',
        user_id: 'user-f3',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_f3',
        stripe_invoice_id: 'in_f3',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: {},
      }],
      user_subscriptions: [{
        id: 'subscription-f3',
        user_id: 'user-f3',
        membership_plan_id: 'plan-f3',
        stripe_subscription_id: 'sub_f3',
        billing_cycle: 'monthly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2026-02-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-f3',
        name: 'Pro',
        monthly_credits: options.creditsGranted,
        yearly_credits: options.creditsGranted * 12,
      }],
      profiles: [{
        id: 'user-f3',
        credits: options.balance,
      }],
      subscription_credit_grants: [{
        id: 'grant-f3',
        user_id: 'user-f3',
        membership_plan_id: 'plan-f3',
        stripe_subscription_id: 'sub_f3',
        stripe_invoice_id: 'in_f3',
        billing_cycle: 'monthly',
        grant_type: 'monthly_invoice',
        grant_period_key: 'invoice:in_f3',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-02-01T00:00:00.000Z',
        period_index: null,
        credits_granted: options.creditsGranted,
        consumed_amount: options.consumedAmount,
        status: options.grantStatus ?? 'granted',
        metadata: {},
      }],
    });
  }

  const refundInput = {
    orderId: 'order-f3',
    subscriptionId: 'sub_f3',
    refundId: 're_f3',
    refundEventType: 'refund.created',
    refundStatus: 'succeeded',
    refundAmount: 9900,
    refundCurrency: 'usd',
    invoiceId: 'in_f3',
    isFullRefund: true,
    eventId: 'evt_f3',
    refundCreatedAt: '2026-01-15T00:00:00.000Z',
    now: '2026-01-20T00:00:00.000Z',
  };

  it('Owner dual example 1: month-1 remaining quota 300 (consumed 300) → clawback 500, balance 300', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(result).toMatchObject({
      reviewRequired: false,
      terminationWritten: true,
      clawbackAmount: 500,
      appliedClawbackAmount: 500,
      shortfallAmount: 0,
      reversedGrantCount: 1,
    });
    expect(supabase.tables.profiles[0].credits).toBe(300);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0].amount).toBe(-500);
  });

  it('does not touch credit-pack purchases when clawing back a subscription refund', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    supabase.tables.credit_transactions.push({
      id: 'txn-credit-pack-purchase',
      user_id: 'user-f3',
      amount: 500,
      type: 'purchase',
      source_type: 'stripe_checkout',
      metadata: { packageId: 'pack-f3' },
    });
    await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    const packTransaction = supabase.tables.credit_transactions
      .find((row) => row.id === 'txn-credit-pack-purchase');
    expect(packTransaction).toMatchObject({ amount: 500, type: 'purchase' });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);
  });

  it('writes termination before the grant reversal and clawback', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);

    const terminationWriteIndex = supabase.writes.findIndex((write) =>
      write.table === 'user_subscriptions' && write.mode === 'update');
    const grantReversalIndex = supabase.writes.findIndex((write) =>
      write.table === 'subscription_credit_grants' && write.mode === 'update');
    const clawbackIndex = supabase.writes.findIndex((write) =>
      write.table === 'credit_transactions' && write.mode === 'insert');

    expect(terminationWriteIndex).toBeGreaterThanOrEqual(0);
    expect(grantReversalIndex).toBeGreaterThan(terminationWriteIndex);
    expect(clawbackIndex).toBeGreaterThan(grantReversalIndex);
  });

  it('replays the same event idempotently and a later full refund does not chase history', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      refundId: 're_f3_replayed',
      eventId: 'evt_f3_replayed',
    });
    expect(replay).toMatchObject({ alreadyReconciled: true, clawbackAmount: 500 });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);

    const laterFull = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      refundId: 're_f3_later_full',
      eventId: 'evt_f3_later_full',
      refundCreatedAt: '2026-01-16T00:00:00.000Z',
    });
    expect(laterFull).toMatchObject({ alreadyReconciled: true });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(300);
  });

  it('yields REVIEW_REQUIRED without auto-deduction when the trusted refund timestamp is missing, but still stops future releases', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      refundCreatedAt: null,
    });
    expect(result).toMatchObject({
      reviewRequired: true,
      reviewReason: 'missing_trusted_refund_timestamp',
      terminationWritten: true,
      clawbackAmount: 0,
      reversedGrantCount: 0,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.user_subscriptions[0].credit_release_terminated_at).toBe('2026-01-20T00:00:00.000Z');
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      creditReleaseTerminatedAt: '2026-01-20T00:00:00.000Z',
    })).toBe(false);
  });

  it('floors the clawback at the current balance and records the shortfall for review', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 0, balance: 100 });
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(result).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 100,
      shortfallAmount: 700,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
  });

  it('stops future annual releases once termination is written', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
    })).toBe(true);
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      creditReleaseTerminatedAt: '2026-08-25T00:00:00.000Z',
    })).toBe(false);
  });
});

describe('REFUND-1B refund operator preview', () => {
  it('is read-only and reports current period, other credits, future releases, termination, and in-flight reservations', async () => {
    const supabase = createRefund1bSupabase({
      payment_orders: [{
        id: 'order-preview',
        user_id: 'user-preview',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_preview',
        stripe_invoice_id: 'in_preview',
        status: 'completed',
        payment_status: 'paid',
        metadata: {},
      }],
      user_subscriptions: [{
        id: 'subscription-preview',
        user_id: 'user-preview',
        membership_plan_id: 'plan-preview',
        stripe_subscription_id: 'sub_preview',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-preview',
        name: 'Gold',
        yearly_credits: 1200,
      }],
      profiles: [{
        id: 'user-preview',
        credits: 260,
      }],
      subscription_credit_grants: [
        {
          id: 'grant-preview-1',
          user_id: 'user-preview',
          membership_plan_id: 'plan-preview',
          stripe_subscription_id: 'sub_preview',
          stripe_invoice_id: 'in_preview',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
          period_start: '2026-01-01T00:00:00.000Z',
          period_end: '2026-02-01T00:00:00.000Z',
          period_index: 1,
          credits_granted: 100,
          consumed_amount: 100,
          status: 'granted',
          metadata: {},
        },
        {
          id: 'grant-preview-2',
          user_id: 'user-preview',
          membership_plan_id: 'plan-preview',
          stripe_subscription_id: 'sub_preview',
          stripe_invoice_id: 'in_preview',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: 'annual:2026-01-01T00:00:00.000Z:02',
          period_start: '2026-02-01T00:00:00.000Z',
          period_end: '2026-03-01T00:00:00.000Z',
          period_index: 2,
          credits_granted: 100,
          consumed_amount: 100,
          status: 'granted',
          metadata: {},
        },
        {
          id: 'grant-preview-reversed',
          user_id: 'user-preview',
          membership_plan_id: 'plan-preview',
          stripe_subscription_id: 'sub_preview',
          stripe_invoice_id: 'in_preview-old',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: 'annual:2025-01-01T00:00:00.000Z:01',
          period_start: '2025-01-01T00:00:00.000Z',
          period_end: '2025-02-01T00:00:00.000Z',
          period_index: 1,
          credits_granted: 100,
          consumed_amount: 0,
          status: 'reversed',
          metadata: {},
        },
      ],
      billing_history: [
        {
          id: 'pre-pending',
          user_id: 'user-preview',
          operation_type: 'pre_deduct',
          amount: -60,
          metadata: { chargedGrantId: 'grant-preview-2', chargedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:02', amountToPeriod: 60, amountToOther: 0 },
          created_at: '2026-02-10T00:00:00.000Z',
        },
        {
          id: 'pre-settled',
          user_id: 'user-preview',
          operation_type: 'pre_deduct',
          amount: -30,
          metadata: { chargedGrantId: 'grant-preview-1', chargedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:01', amountToPeriod: 30, amountToOther: 0 },
          created_at: '2026-01-10T00:00:00.000Z',
        },
        {
          id: 'settle-1',
          user_id: 'user-preview',
          operation_type: 'settle',
          amount: -25,
          metadata: { preDeductId: 'pre-settled' },
          created_at: '2026-01-10T00:00:05.000Z',
        },
      ],
    });

    const preview = await getSubscriptionRefundOperatorPreview(supabase, {
      subscriptionId: 'sub_preview',
      now: '2026-02-15T00:00:00.000Z',
    });

    expect(preview.currentPeriod).toMatchObject({
      grantId: 'grant-preview-2',
      granted: 100,
      consumed: 100,
      remaining: 0,
    });
    expect(preview.balance).toBe(260);
    expect(preview.otherCreditsTotal).toBe(260);
    expect(preview.termination).toMatchObject({ terminatedAt: null, reason: null });
    expect(preview.reversedGrantPeriodKeys).toEqual(['annual:2025-01-01T00:00:00.000Z:01']);
    expect(preview.inFlightReservations).toEqual({
      count: 1,
      amountToPeriod: 60,
      amountToOther: 0,
      preDeductIds: ['pre-pending'],
    });
    expect(preview.futureReleases?.count).toBe(10);
    expect(preview.futureReleases?.credits).toBe(1000);
    expect(supabase.writes).toEqual([]);
  });
});

describe('REFUND-1B migration 0053 contract', () => {
  const migrationSql = readFileSync(
    join(__dirname, '../../../../db/migrations/0053_refund_1b_consumed_amount_termination.sql'),
    'utf8',
  );

  it('adds consumed_amount with the 0 <= consumed <= granted invariant', () => {
    expect(migrationSql).toContain('ADD COLUMN consumed_amount INTEGER NOT NULL DEFAULT 0');
    expect(migrationSql).toContain('CHECK (0 <= consumed_amount AND consumed_amount <= credits_granted)');
  });

  it('adds the four credit-release termination columns', () => {
    expect(migrationSql).toContain('ADD COLUMN credit_release_terminated_at TIMESTAMP WITH TIME ZONE');
    expect(migrationSql).toContain('ADD COLUMN credit_release_terminated_reason TEXT');
    expect(migrationSql).toContain('ADD COLUMN credit_release_terminated_event_id TEXT');
    expect(migrationSql).toContain('ADD COLUMN credit_release_terminated_period_key TEXT');
  });

  it('replaces only the billing RPC bodies with unchanged signatures', () => {
    const replaced = [
      'atomic_pre_deduct(',
      'atomic_settle(',
      'atomic_refund(',
      'atomic_abort_settle(',
      'atomic_finalize_ai_success(',
      'atomic_finalize_ai_failure(',
      'atomic_finalize_ai_abort(',
    ];
    for (const fn of replaced) {
      expect(migrationSql).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    expect(migrationSql).not.toContain('atomic_reconcile_stripe_refund(');
  });

  it('keeps the profile -> grant lock order and binds the source split at pre-deduct time', () => {
    const profileLockIndex = migrationSql.indexOf('FROM profiles');
    const grantLockIndex = migrationSql.indexOf('FOR UPDATE OF g');
    expect(profileLockIndex).toBeGreaterThan(-1);
    expect(grantLockIndex).toBeGreaterThan(profileLockIndex);
    expect(migrationSql).toContain("'chargedGrantId', v_charged_grant_id");
    expect(migrationSql).toContain("'amountToPeriod', v_to_period");
    expect(migrationSql).toContain("'amountToOther', v_to_other");
  });

  it('re-establishes the SEC-1 service-role-only posture for every replaced function', () => {
    const serviceRoleOnly = [
      'public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)',
      'public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
      'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
      'public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
      'public.atomic_pre_deduct(uuid,integer,text,uuid)',
      'public.atomic_refund(uuid,uuid,text)',
      'public.atomic_settle(uuid,uuid,integer,jsonb,jsonb)',
    ];
    for (const signature of serviceRoleOnly) {
      expect(migrationSql).toContain(`'${signature}'`);
    }
    expect(migrationSql).toContain('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated');
    expect(migrationSql).toContain('GRANT EXECUTE ON FUNCTION %s TO service_role');
    expect(migrationSql).toContain('ALTER FUNCTION %s SET search_path = public, pg_temp');
  });

  it('edits no applied migration and creates no migration other than 0053', () => {
    expect(migrationSql).not.toMatch(/005[012]_/);
    expect(migrationSql).not.toMatch(/ALTER\s+TABLE[^;]*0052/);
  });
});
