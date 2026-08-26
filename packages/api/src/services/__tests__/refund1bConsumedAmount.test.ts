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

/**
 * REFUND-1B: supplemental in-memory driver for the 0053 contract. It is not
 * PostgreSQL execution and cannot prove transaction isolation or PL/pgSQL
 * compilation; production SQL structure and ownership predicates are checked
 * separately below, while Supabase staging validation remains separately gated.
 */
function applyRefundTerminationClawbackContract(
  tables: Record<TableName, Row[]>,
  writes: Array<{ table: TableName; mode: 'insert' | 'update' }>,
  payload: Row,
) {
  // SQL 语义: 单事务, 任何异常路径整体回滚 — mock 用快照还原等价行为
  const writesLength = writes.length;
  const snapshot = {
    user_subscriptions: tables.user_subscriptions.map((row) => ({ ...row })),
    profiles: tables.profiles.map((row) => ({ ...row })),
    subscription_credit_grants: tables.subscription_credit_grants.map((row) => ({
      ...row,
      metadata: row.metadata ? { ...row.metadata } : row.metadata,
    })),
    credit_transactions: tables.credit_transactions.map((row) => ({ ...row })),
  };
  const rollback = () => {
    tables.user_subscriptions.splice(0, tables.user_subscriptions.length, ...snapshot.user_subscriptions);
    tables.profiles.splice(0, tables.profiles.length, ...snapshot.profiles);
    tables.subscription_credit_grants.splice(0, tables.subscription_credit_grants.length, ...snapshot.subscription_credit_grants);
    tables.credit_transactions.splice(0, tables.credit_transactions.length, ...snapshot.credit_transactions);
    writes.splice(writesLength, writes.length - writesLength);
  };

  const subscriptionId = String(payload.p_subscription_id ?? '');
  const periodKey = typeof payload.p_period_key === 'string' && payload.p_period_key.trim()
    ? payload.p_period_key.trim()
    : null;
  const fullMode = payload.p_termination_only !== true && periodKey !== null;
  const now = typeof payload.p_now === 'string' ? payload.p_now : new Date().toISOString();

  const profile = tables.profiles.find((row) => row.id === payload.p_user_id) ?? null;

  if (fullMode) {
    if (!payload.p_user_id || !profile) {
      rollback();
      return { data: null, error: { message: 'REFUND_CLAWBACK_PROFILE_MISSING' } };
    }

    const existing = tables.credit_transactions.find((row) =>
      row.user_id === payload.p_user_id && row.idempotency_key === payload.p_idempotency_key);
    if (existing) {
      const existingMetadata = existing.metadata ?? {};
      const existingApplied = Math.max(0, Math.floor(Number(
        existingMetadata.appliedClawbackAmount ?? Math.abs(Number(existing.amount ?? 0)),
      )));
      const existingRequired = Math.max(0, Math.floor(Number(
        existingMetadata.requiredClawbackAmount ?? existingApplied,
      )));
      const existingShortfall = Math.max(0, Math.floor(Number(
        existingMetadata.shortfallAmount ?? Math.max(existingRequired - existingApplied, 0),
      )));
      return {
        data: [{
          transaction_id: existing.id,
          balance_after: existing.balance_after ?? 0,
          clawback_amount: existingRequired,
          applied_clawback_amount: existingApplied,
          shortfall_amount: existingShortfall,
          already_applied: true,
          termination_written: false,
          already_terminated: false,
          grant_reversed: existingMetadata.reversedGrantCount == null
            ? true
            : existingMetadata.reversedGrantCount === 1,
          already_reversed: false,
          credits_granted: null,
          consumed_amount: null,
        }],
        error: null,
      };
    }
  }

  const mirror = tables.user_subscriptions.find((row) =>
    row.stripe_subscription_id === subscriptionId
      && row.user_id === payload.p_user_id) ?? null;
  if (!mirror) {
    rollback();
    return { data: null, error: { message: 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING' } };
  }

  let terminationWritten = false;
  if (mirror.credit_release_terminated_at == null) {
    mirror.credit_release_terminated_at = now;
    mirror.credit_release_terminated_reason = payload.p_reason ?? 'stripe_refund';
    mirror.credit_release_terminated_event_id = payload.p_event_id ?? null;
    mirror.credit_release_terminated_period_key = periodKey;
    mirror.updated_at = now;
    terminationWritten = true;
    writes.push({ table: 'user_subscriptions', mode: 'update' });
  }

  const baseRow = (extra: Row = {}) => ({
    transaction_id: null,
    balance_after: null,
    clawback_amount: 0,
    applied_clawback_amount: 0,
    shortfall_amount: 0,
    already_applied: false,
    termination_written: terminationWritten,
    already_terminated: !terminationWritten,
    grant_reversed: false,
    already_reversed: false,
    credits_granted: null,
    consumed_amount: null,
    ...extra,
  });

  if (!fullMode) {
    return { data: [baseRow()], error: null };
  }

  if (!terminationWritten) {
    return { data: [baseRow({ balance_after: profile!.credits })], error: null };
  }

  const grant = tables.subscription_credit_grants
    .filter((row) => row.user_id === payload.p_user_id
      && row.stripe_subscription_id === subscriptionId
      && row.grant_period_key === periodKey)
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0];
  if (!grant) {
    rollback();
    return { data: null, error: { message: 'REFUND_CLAWBACK_GRANT_MISSING' } };
  }
  if (grant.status !== 'granted' && grant.status !== 'reversed') {
    rollback();
    return { data: null, error: { message: 'REFUND_CLAWBACK_GRANT_UNEXPECTED_STATUS' } };
  }
  if (grant.status === 'reversed') {
    return {
      data: [baseRow({
        balance_after: profile!.credits,
        already_reversed: true,
        credits_granted: grant.credits_granted ?? null,
        consumed_amount: grant.consumed_amount ?? null,
      })],
      error: null,
    };
  }

  grant.status = 'reversed';
  grant.updated_at = now;
  grant.metadata = {
    ...(grant.metadata ?? {}),
    reversal: {
      refundId: payload.p_refund_id ?? null,
      eventId: payload.p_event_id ?? null,
      subscriptionId,
      periodKey,
      idempotencyKey: payload.p_idempotency_key,
      reversedAt: now,
      source: 'subscription_refund',
    },
  };
  writes.push({ table: 'subscription_credit_grants', mode: 'update' });

  const granted = Math.floor(Number(grant.credits_granted ?? 0));
  const consumed = Math.floor(Number(grant.consumed_amount ?? 0));
  const clawback = Math.max(granted - consumed, 0);
  const balanceBefore = Math.floor(Number(profile!.credits ?? 0));
  const applied = Math.min(clawback, Math.max(balanceBefore, 0));
  const shortfall = clawback - applied;

  if (applied > 0) {
    profile!.credits = balanceBefore - applied;
  }

  const transaction = {
    id: `txn-refund-clawback-${tables.credit_transactions.length + 1}`,
    user_id: payload.p_user_id,
    amount: applied === 0 ? 0 : -applied,
    type: 'deduction',
    ledger_type: 'refund_clawback',
    reason_code: 'refund_clawback',
    counts_as_spend: false,
    source_type: 'stripe_refund',
    source_id: payload.p_refund_id ?? subscriptionId,
    source_refund_id: payload.p_refund_id ?? null,
    grant_period_key: periodKey,
    description: 'Stripe subscription refund credit clawback',
    idempotency_key: payload.p_idempotency_key,
    balance_before: balanceBefore,
    balance_after: balanceBefore - applied,
    metadata: {
      canonicalResult: 'refund_clawback',
      eventId: payload.p_event_id ?? null,
      subscriptionId,
      periodKey,
      refundId: payload.p_refund_id ?? null,
      idempotencyKey: payload.p_idempotency_key,
      requiredClawbackAmount: clawback,
      appliedClawbackAmount: applied,
      shortfallAmount: shortfall,
      reviewRequired: shortfall > 0,
      reversedGrantCount: 1,
    },
  };
  tables.credit_transactions.push(transaction);
  writes.push({ table: 'credit_transactions', mode: 'insert' });
  const transactionId = transaction.id;

  return {
    data: [{
      transaction_id: transactionId,
      balance_after: Math.floor(Number(profile!.credits ?? 0)),
      clawback_amount: clawback,
      applied_clawback_amount: applied,
      shortfall_amount: shortfall,
      already_applied: false,
      termination_written: true,
      already_terminated: false,
      grant_reversed: true,
      already_reversed: false,
      credits_granted: granted,
      consumed_amount: consumed,
    }],
    error: null,
  };
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
      expect(name).toBe('atomic_refund_termination_clawback');
      return applyRefundTerminationClawbackContract(tables, writes, payload);
    },
  };

  return supabase;
}

function extractMigrationFunction(sql: string, functionName: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = sql.indexOf('\nCREATE OR REPLACE FUNCTION', start + 1);
  const end = nextFunction >= 0 ? nextFunction : sql.indexOf('\n-- 11.', start);
  return sql.slice(start, end >= 0 ? end : undefined);
}

function stripSqlCommentsAndLiterals(sql: string) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function findUndeclaredPlpgsqlVariables(functionBody: string) {
  const sanitized = stripSqlCommentsAndLiterals(functionBody);
  const declareSection = sanitized.match(/\bDECLARE\b([\s\S]*?)\bBEGIN\b/)?.[1] ?? '';
  const signature = sanitized.slice(0, sanitized.indexOf('RETURNS'));
  const declared = new Set([
    ...declareSection.matchAll(/\bv_[a-z0-9_]+\b/gi),
    ...signature.matchAll(/\bp_[a-z0-9_]+\b/gi),
  ].map((match) => match[0].toLowerCase()));
  return [...new Set([...sanitized.matchAll(/\bv_[a-z0-9_]+\b/gi)]
    .map((match) => match[0].toLowerCase()))]
    .filter((name) => !declared.has(name));
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
      eventId: refundInput.eventId,
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

  it('R1: exact shortfall replay restores the durable first-event result without completing review', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 0, balance: 100 });
    const first = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(first).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 100,
      shortfallAmount: 700,
      alreadyReconciled: false,
    });

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(replay).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 100,
      shortfallAmount: 700,
      alreadyReconciled: true,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('reversed');
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -100,
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
      metadata: expect.objectContaining({
        requiredClawbackAmount: 800,
        appliedClawbackAmount: 100,
        shortfallAmount: 700,
        reviewRequired: true,
      }),
    });
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 100,
      shortfallAmount: 700,
      reversalStatus: 'shortfall_review_required',
    });
  });

  it('R1/B: exact zero-applied replay hits one durable zero-amount canonical marker', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 0, balance: 0 });
    const first = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(first).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 0,
      shortfallAmount: 800,
      alreadyReconciled: false,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: 0,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
      metadata: expect.objectContaining({
        requiredClawbackAmount: 800,
        appliedClawbackAmount: 0,
        shortfallAmount: 800,
        reviewRequired: true,
      }),
    });

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(replay).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 0,
      shortfallAmount: 800,
      alreadyReconciled: true,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('reversed');
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 0,
      shortfallAmount: 800,
      reversalStatus: 'shortfall_review_required',
    });
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

  it('R1: derives the canonical idempotency key from event_id + subscription_id + period_key and replays exactly once through the RPC barrier', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    const first = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(first).toMatchObject({ reviewRequired: false, clawbackAmount: 500, alreadyReconciled: false });
    expect(supabase.tables.credit_transactions[0].idempotency_key).toBe(
      'stripe_refund:subscription_grants:event:evt_f3:sub:sub_f3:period:invoice:in_f3',
    );
    expect(supabase.tables.credit_transactions[0].idempotency_key).not.toContain('order:');
    expect(supabase.tables.credit_transactions[0].idempotency_key).not.toContain('re_f3');

    // 精确重放同一 event (订单 metadata 被清空模拟崩溃后恢复): canonical 幂等屏障
    // 返回既有交易, 不重复扣、不重复反转
    supabase.tables.payment_orders[0].metadata = {};
    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(replay).toMatchObject({ alreadyReconciled: true, reviewRequired: false });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(300);
  });

  it('R1: a later different full-refund event on the same subscription does not chase history even when order metadata is missing', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);

    supabase.tables.payment_orders[0].metadata = {};
    const laterFull = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      refundId: 're_f3_later_full',
      eventId: 'evt_f3_later_full',
      refundCreatedAt: '2026-01-16T00:00:00.000Z',
    });
    expect(laterFull).toMatchObject({ alreadyReconciled: true, clawbackAmount: 0, appliedClawbackAmount: 0 });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(300);
  });

  it('R1: stale order reversal metadata cannot swallow a new canonical event before the RPC barrier', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    supabase.tables.payment_orders[0].metadata = {
      subscriptionCreditGrantReversal: {
        reversalStatus: 'reversed',
        clawbackAmount: 800,
        reviewRequired: false,
      },
    };

    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      eventId: 'evt_f3_new_canonical_event',
      refundId: 're_f3_new_canonical_event',
    });

    expect(result).toMatchObject({ alreadyReconciled: false, clawbackAmount: 500 });
    expect(supabase.tables.credit_transactions.filter((row) => row.type === 'deduction')).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(300);
  });

  it('R5: fails closed when the user_subscriptions mirror is missing — no grant reversal, no clawback', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    supabase.tables.user_subscriptions = [];

    await expect(reconcileSubscriptionRefundCreditGrants(supabase, refundInput)).rejects.toThrow(
      /Failed to apply the unified refund termination clawback transaction|REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING/i,
    );
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0].credits).toBe(800);
  });

  it('R4: REVIEW_REQUIRED without auto-deduction when the trusted subscription term start is missing', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    supabase.tables.user_subscriptions[0].current_period_start = null;
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(result).toMatchObject({
      reviewRequired: true,
      reviewReason: 'missing_trusted_term_start',
      terminationWritten: true,
      clawbackAmount: 0,
      reversedGrantCount: 0,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
  });

  it('R4: REVIEW_REQUIRED when the refund timestamp is not covered by a term-start-anchored period window', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    // 月度 grant 的可信锚: period_start 必须等于 term start; 偏移即 REVIEW, 不猜测
    supabase.tables.user_subscriptions[0].current_period_start = '2026-01-15T00:00:00.000Z';
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(result).toMatchObject({
      reviewRequired: true,
      reviewReason: 'term_start_period_mismatch',
      clawbackAmount: 0,
      reversedGrantCount: 0,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('R1: REVIEW_REQUIRED without auto-deduction when the canonical event id is missing', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...refundInput,
      eventId: null,
    });
    expect(result).toMatchObject({
      reviewRequired: true,
      reviewReason: 'missing_event_id',
      terminationWritten: true,
      clawbackAmount: 0,
      reversedGrantCount: 0,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('R8: fails closed when the located charged grant row is missing or deleted for the trusted period', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });

    // 定位出的周期 grant 行在统一事务读取时缺失 (并发删除/不一致) → 失败关闭
    const missing = await supabase.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt_f3',
      p_period_key: 'invoice:missing-period',
      p_idempotency_key: 'stripe_refund:subscription_grants:event:evt_f3:sub:sub_f3:period:invoice:missing-period',
      p_reason: 'stripe_refund:refund.created',
      p_termination_only: false,
      p_refund_id: 're_f3',
      p_now: '2026-01-20T00:00:00.000Z',
    });
    expect(missing.error).toMatchObject({ message: 'REFUND_CLAWBACK_GRANT_MISSING' });

    // grant 行存在但状态异常 (failed) → 失败关闭, 不得继续 reversal/clawback
    supabase.tables.subscription_credit_grants[0].status = 'failed';
    const unexpected = await supabase.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt_f3b',
      p_period_key: 'invoice:in_f3',
      p_idempotency_key: 'stripe_refund:subscription_grants:event:evt_f3b:sub:sub_f3:period:invoice:in_f3',
      p_reason: 'stripe_refund:refund.created',
      p_termination_only: false,
      p_refund_id: 're_f3b',
      p_now: '2026-01-20T00:00:00.000Z',
    });
    expect(unexpected.error).toMatchObject({ message: 'REFUND_CLAWBACK_GRANT_UNEXPECTED_STATUS' });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0].credits).toBe(800);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('failed');
  });

  it('R8: fails closed for wrong user, subscription, period, and grant ownership bindings', async () => {
    const wrongUser = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    wrongUser.tables.user_subscriptions[0].user_id = 'user-other';
    wrongUser.tables.profiles.push({ id: 'user-other', credits: 700 });
    const wrongUserResult = await wrongUser.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt-wrong-user',
      p_period_key: 'invoice:in_f3',
      p_idempotency_key: 'stripe_refund:event:evt-wrong-user',
      p_termination_only: false,
    });
    expect(wrongUserResult.error).toMatchObject({ message: 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING' });
    expect(wrongUser.tables.profiles.find((row) => row.id === 'user-f3')?.credits).toBe(800);
    expect(wrongUser.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(wrongUser.tables.user_subscriptions[0].credit_release_terminated_at).toBeUndefined();

    const wrongSubscription = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    wrongSubscription.tables.user_subscriptions[0].stripe_subscription_id = 'sub-other';
    const wrongSubscriptionResult = await wrongSubscription.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt-wrong-subscription',
      p_period_key: 'invoice:in_f3',
      p_idempotency_key: 'stripe_refund:event:evt-wrong-subscription',
      p_termination_only: false,
    });
    expect(wrongSubscriptionResult.error).toMatchObject({ message: 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING' });

    const wrongPeriod = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    const wrongPeriodResult = await wrongPeriod.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt-wrong-period',
      p_period_key: 'invoice:other-period',
      p_idempotency_key: 'stripe_refund:event:evt-wrong-period',
      p_termination_only: false,
    });
    expect(wrongPeriodResult.error).toMatchObject({ message: 'REFUND_CLAWBACK_GRANT_MISSING' });
    expect(wrongPeriod.tables.profiles[0].credits).toBe(800);
    expect(wrongPeriod.tables.user_subscriptions[0].credit_release_terminated_at).toBeUndefined();

    const wrongGrantOwner = seedSubscription({ creditsGranted: 800, consumedAmount: 300, balance: 800 });
    wrongGrantOwner.tables.subscription_credit_grants[0].user_id = 'user-other';
    const wrongGrantOwnerResult = await wrongGrantOwner.rpc('atomic_refund_termination_clawback', {
      p_user_id: 'user-f3',
      p_subscription_id: 'sub_f3',
      p_event_id: 'evt-wrong-grant-owner',
      p_period_key: 'invoice:in_f3',
      p_idempotency_key: 'stripe_refund:event:evt-wrong-grant-owner',
      p_termination_only: false,
    });
    expect(wrongGrantOwnerResult.error).toMatchObject({ message: 'REFUND_CLAWBACK_GRANT_MISSING' });
    expect(wrongGrantOwner.tables.profiles[0].credits).toBe(800);
    expect(wrongGrantOwner.tables.user_subscriptions[0].credit_release_terminated_at).toBeUndefined();
  });

  it('R6: never applies more clawback than the current balance even in the unified transaction', async () => {
    const supabase = seedSubscription({ creditsGranted: 800, consumedAmount: 0, balance: 250 });
    const result = await reconcileSubscriptionRefundCreditGrants(supabase, refundInput);
    expect(result).toMatchObject({
      reviewRequired: true,
      clawbackAmount: 800,
      appliedClawbackAmount: 250,
      shortfallAmount: 550,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -250,
      balance_before: 250,
      balance_after: 0,
    });
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
  const stripeFulfillmentSource = readFileSync(
    join(__dirname, '../stripeFulfillment.ts'),
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

  it('R7: serializes duplicate settle/finalize with a unique terminal-record barrier plus post-lock rechecks', () => {
    expect(migrationSql).toContain('CREATE UNIQUE INDEX billing_history_terminal_pre_deduct_unique');
    expect(migrationSql).toContain("ON public.billing_history ((metadata->>'preDeductId'))");
    expect(migrationSql).toContain("WHERE operation_type IN ('settle', 'refund', 'abort_settle')");

    const postLockRecheckCount = (migrationSql.match(/R7: 持锁后复查重复/g) ?? []).length;
    expect(postLockRecheckCount).toBe(6);

    for (const fn of [
      'atomic_settle',
      'atomic_refund',
      'atomic_abort_settle',
      'atomic_finalize_ai_success',
      'atomic_finalize_ai_failure',
      'atomic_finalize_ai_abort',
    ]) {
      const fnStart = migrationSql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      const fnEnd = migrationSql.indexOf('CREATE OR REPLACE FUNCTION', fnStart + 1);
      const body = migrationSql.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
      const lockIndex = body.indexOf('FOR UPDATE;');
      const recheckIndex = body.indexOf('R7: 持锁后复查重复');
      expect(lockIndex).toBeGreaterThan(-1);
      expect(recheckIndex).toBeGreaterThan(lockIndex);
    }
  });

  it('R3: every settle/refund/abort path re-reads the subscription termination state under the grant lock', () => {
    expect((migrationSql.match(/us\.credit_release_terminated_at IS NOT NULL/g) ?? []).length)
      .toBeGreaterThanOrEqual(7);
    expect((migrationSql.match(/v_intercepted := \(v_grant_status = 'reversed'\) OR v_grant_terminated;/g) ?? []).length)
      .toBe(6);
  });

  it('R6: enforces credits >= 0 inside the SQL body of every profile-debit path', () => {
    const guardCount = (migrationSql.match(/v_balance_after < 0/g) ?? []).length;
    expect(guardCount).toBe(4);
    expect(migrationSql).toContain('结算将导致负余额');
    expect(migrationSql).toContain('中断结算将导致负余额');
    expect(migrationSql).toContain('LEAST(v_clawback, v_balance_before)');
  });

  it('R8: bound-grant rereads fail closed on missing rows, unexpected statuses, and missed updates', () => {
    expect((migrationSql.match(/绑定积分发放记录缺失/g) ?? []).length).toBe(6);
    expect((migrationSql.match(/绑定积分发放记录状态异常/g) ?? []).length).toBe(6);
    expect((migrationSql.match(/积分发放记录消耗更新未命中/g) ?? []).length).toBe(6);
    expect(migrationSql).toContain("v_grant_status NOT IN ('granted', 'reversed')");
  });

  it('B/D: validates every production PL/pgSQL function body for undeclared local variables', () => {
    const functions = [
      'atomic_pre_deduct',
      'atomic_settle',
      'atomic_refund',
      'atomic_abort_settle',
      'atomic_finalize_ai_success',
      'atomic_finalize_ai_failure',
      'atomic_finalize_ai_abort',
      'atomic_refund_termination_clawback',
    ];

    for (const functionName of functions) {
      expect(findUndeclaredPlpgsqlVariables(extractMigrationFunction(migrationSql, functionName)))
        .toEqual([]);
    }
  });

  it('R1/B: persists a complete canonical result marker for every full-mode refund', () => {
    const body = extractMigrationFunction(migrationSql, 'atomic_refund_termination_clawback');
    expect(body).toContain('IF v_applied > 0 THEN');
    expect(body).toContain('persist the complete first-event result even when applied is zero');
    expect(body).toContain('ledger_type');
    expect(body).toContain('counts_as_spend');
    expect(body).toContain("'requiredClawbackAmount', v_clawback");
    expect(body).toContain("'appliedClawbackAmount', v_applied");
    expect(body).toContain("'shortfallAmount', v_shortfall");
    expect(body).toContain("'reviewRequired', (v_shortfall > 0)");
  });

  it('R8: every bound terminal path requires the complete owner/period/mirror binding', () => {
    for (const functionName of [
      'atomic_settle',
      'atomic_refund',
      'atomic_abort_settle',
      'atomic_finalize_ai_success',
      'atomic_finalize_ai_failure',
      'atomic_finalize_ai_abort',
    ]) {
      const body = extractMigrationFunction(migrationSql, functionName);
      expect(body).toMatch(
        /WHERE g\.id = v_charged_grant_id\s+AND g\.user_id = p_user_id\s+AND g\.grant_period_key = v_period_key/,
      );
      expect(body).toContain('JOIN user_subscriptions AS us');
      expect(body).toContain('us.user_id = p_user_id');
    }

    const refundBody = extractMigrationFunction(migrationSql, 'atomic_refund_termination_clawback');
    expect(refundBody).toMatch(
      /WHERE stripe_subscription_id = p_subscription_id\s+AND user_id = p_user_id/,
    );
    expect(refundBody).toMatch(
      /WHERE g\.user_id = p_user_id\s+AND g\.stripe_subscription_id = p_subscription_id\s+AND g\.grant_period_key = p_period_key/,
    );
    expect(refundBody).toContain('us.id = v_mirror_id');
  });

  it('R2/R5: provides the unified refund transaction with mirror-missing fail-closed', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.atomic_refund_termination_clawback(');
    expect(migrationSql).toContain('REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING');
    expect(migrationSql).toContain('REFUND_CLAWBACK_GRANT_MISSING');
    expect(migrationSql).toContain('REFUND_CLAWBACK_GRANT_UNEXPECTED_STATUS');
    expect(migrationSql).toContain('REFUND_CLAWBACK_PROFILE_MISSING');

    const fnStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_refund_termination_clawback(');
    const body = migrationSql.slice(fnStart);
    const profileLockIndex = body.indexOf('FROM profiles');
    const terminationIndex = body.indexOf('UPDATE user_subscriptions');
    const grantLockIndex = body.indexOf('FOR UPDATE;', terminationIndex);
    expect(profileLockIndex).toBeGreaterThan(-1);
    expect(terminationIndex).toBeGreaterThan(profileLockIndex);
    expect(grantLockIndex).toBeGreaterThan(terminationIndex);
  });

  it('R1: the unified refund transaction rechecks the canonical idempotency key after taking the profile lock', () => {
    const fnStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_refund_termination_clawback(');
    const body = migrationSql.slice(fnStart);
    const lockIndex = body.indexOf('FOR UPDATE;');
    const canonicalRecheckIndex = body.indexOf('ct.idempotency_key = p_idempotency_key');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(canonicalRecheckIndex).toBeGreaterThan(lockIndex);
  });

  it('R4: the subscription refund timestamp never falls back to charge.created', () => {
    expect(stripeFulfillmentSource).toContain('getSuccessfulChargeRefund(charge)?.created ?? null');
    expect(stripeFulfillmentSource).not.toContain('getSuccessfulChargeRefund(charge)?.created ?? charge?.created');
  });

  it('re-establishes the SEC-1 service-role-only posture for every replaced function', () => {
    const serviceRoleOnly = [
      'public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)',
      'public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
      'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
      'public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
      'public.atomic_pre_deduct(uuid,integer,text,uuid)',
      'public.atomic_refund(uuid,uuid,text)',
      'public.atomic_refund_termination_clawback(uuid,text,text,text,text,text,boolean,text,timestamptz)',
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
