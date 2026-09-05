/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  addUtcCalendarMonthsClamped,
  calculateAnnualMonthlyGrantSchedule,
  fulfillMembershipInvoiceWithSubscriptionCreditGrants,
  getCanonicalAnnualGrantPeriod,
  getCanonicalMonthlyGrantPeriod,
  getDueAnnualGrantPeriods,
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

type MockFilter = { column: string; value: unknown; operator: 'eq' | 'neq' | 'lte' | 'is' };

type MockSupabaseHooks = {
  beforeRpc?: (context: {
    name: string;
    payload: Row;
    tables: Record<TableName, Row[]>;
  }) => void | Promise<void>;
  beforeExecute?: (context: {
    table: TableName;
    mode: 'select' | 'insert' | 'update';
    filters: MockFilter[];
    tables: Record<TableName, Row[]>;
  }) => void | Promise<void>;
  beforeInvoiceGrantAdmission?: (context: {
    payload: Row;
    tables: Record<TableName, Row[]>;
  }) => void | Promise<void>;
  afterInvoiceGrantAdmission?: (context: {
    payload: Row;
    tables: Record<TableName, Row[]>;
  }) => void | Promise<void>;
};

class MockQuery {
  private filters: MockFilter[] = [];
  private containsFilters: Array<{ column: string; value: unknown }> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private limitValue: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly tables: Record<TableName, Row[]>,
    private readonly table: TableName,
    private readonly hooks: MockSupabaseHooks = {},
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
    await this.runBeforeExecute();

    if (this.mode === 'insert') {
      return this.insertOne();
    }

    if (this.mode === 'update') {
      const rows = this.matchingRows();
      rows.forEach((row) => Object.assign(row, this.payload));
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
    await this.runBeforeExecute();

    if (this.mode === 'insert') {
      const result = this.insertOne();
      return result.error
        ? result
        : { data: [result.data], error: null };
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

  private async runBeforeExecute() {
    await this.hooks.beforeExecute?.({
      table: this.table,
      mode: this.mode,
      filters: this.filters.map((filter) => ({ ...filter })),
      tables: this.tables,
    });
  }

  private insertOne() {
    const inserted = {
      id: this.payload?.id ?? `${this.table}-${this.tables[this.table].length + 1}`,
      ...this.payload,
    };
    const uniqueViolation = this.getUniqueViolation(inserted);
    if (uniqueViolation) {
      return { data: null, error: uniqueViolation };
    }

    this.tables[this.table].push(inserted);
    return { data: inserted, error: null };
  }

  private getUniqueViolation(inserted: Row) {
    const duplicateId = inserted.id
      && this.tables[this.table].some((row) => row.id === inserted.id);
    if (duplicateId) {
      return {
        code: '23505',
        message: `duplicate key value violates unique constraint "${this.table}_pkey"`,
      };
    }

    if (
      this.table === 'subscription_credit_grants'
      && inserted.idempotency_key
      && this.tables.subscription_credit_grants.some((row) => row.idempotency_key === inserted.idempotency_key)
    ) {
      return {
        code: '23505',
        message: 'duplicate key value violates unique constraint "subscription_credit_grants_idempotency_key_key"',
      };
    }

    return null;
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

/**
 * REFUND-1B: 独立实现 0053 atomic_refund_termination_clawback 的 SQL 合同
 * (非复制 TS 公式): mirror 缺失/授权 grant 缺失/状态异常失败关闭、首个成功
 * 事件确立 termination、后续事件不重复扣、canonical 幂等键重放返回既有交易、
 * clawback 以当前余额封顶 (LEAST) 绝不为负。
 */
function applyRefundTerminationClawbackContract(
  tables: Record<TableName, Row[]>,
  payload: Row,
) {
  // SQL 语义: 单事务, 任何异常路径整体回滚 — mock 用快照还原等价行为
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
      const requiredAmount = Math.abs(Number(
        existingMetadata.requiredClawbackAmount ?? existing.amount ?? 0,
      ));
      const appliedAmount = Math.abs(Number(
        existingMetadata.appliedClawbackAmount ?? existing.amount ?? 0,
      ));
      const shortfallAmount = Number(existingMetadata.shortfallAmount ?? 0);
      return {
        data: [{
          transaction_id: existing.id,
          balance_after: existing.balance_after ?? 0,
          clawback_amount: requiredAmount,
          applied_clawback_amount: appliedAmount,
          shortfall_amount: shortfallAmount,
          already_applied: true,
          termination_written: false,
          already_terminated: false,
          grant_reversed: true,
          already_reversed: false,
          credits_granted: null,
          consumed_amount: null,
        }],
        error: null,
      };
    }
  }

  const mirror = tables.user_subscriptions.find((row) =>
    row.stripe_subscription_id === subscriptionId) ?? null;
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
    .filter((row) => row.stripe_subscription_id === subscriptionId && row.grant_period_key === periodKey)
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

  const granted = Math.floor(Number(grant.credits_granted ?? 0));
  const consumed = Math.floor(Number(grant.consumed_amount ?? 0));
  const clawback = Math.max(granted - consumed, 0);
  const balanceBefore = Math.floor(Number(profile!.credits ?? 0));
  const applied = Math.min(clawback, Math.max(balanceBefore, 0));
  const shortfall = clawback - applied;

  let transactionId: string | null = null;
  if (applied > 0) {
    profile!.credits = balanceBefore - applied;
    const transaction = {
      id: `txn-refund-clawback-${tables.credit_transactions.length + 1}`,
      user_id: payload.p_user_id,
      amount: -applied,
      type: 'deduction',
      description: 'Stripe subscription refund credit clawback',
      idempotency_key: payload.p_idempotency_key,
      balance_before: balanceBefore,
      balance_after: balanceBefore - applied,
    };
    tables.credit_transactions.push(transaction);
    transactionId = transaction.id;
  }

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

function applyAnnualGrantAdmissionContract(
  tables: Record<TableName, Row[]>,
  payload: Row,
) {
  const profile = tables.profiles.find((row) => row.id === payload.p_user_id) ?? null;
  if (!profile && payload.p_billing_cycle) {
    return { data: null, error: { message: 'INVOICE_GRANT_PROFILE_MISSING' } };
  }
  let subscription = tables.user_subscriptions.find((row) =>
    row.user_id === payload.p_user_id
    && row.stripe_subscription_id === payload.p_stripe_subscription_id,
  ) ?? null;

  if (!subscription && payload.p_billing_cycle) {
    subscription = {
      id: `subscription-${tables.user_subscriptions.length + 1}`,
      user_id: payload.p_user_id,
      membership_plan_id: payload.p_membership_plan_id,
      stripe_subscription_id: payload.p_stripe_subscription_id,
      billing_cycle: payload.p_billing_cycle,
      status: 'active',
      current_period_start: payload.p_period_start,
      current_period_end: payload.p_period_end,
    };
    tables.user_subscriptions.push(subscription);
  }

  if (!subscription) {
    return { data: null, error: { message: 'ANNUAL_GRANT_SUBSCRIPTION_MIRROR_MISSING' } };
  }

  const balanceBefore = profile ? Math.floor(Number(profile.credits ?? 0)) : 0;
  if (subscription.credit_release_terminated_at != null) {
    return {
      data: [{
        transaction_id: null,
        balance_before: balanceBefore,
        balance_after: balanceBefore,
        amount: 0,
        is_idempotent: false,
        granted: false,
        blocked_by_termination: true,
        grant_id: null,
        credits_granted: 0,
      }],
      error: null,
    };
  }

  // Invoice admission receives the full Stripe term, while its annual p01
  // grant is a separate, calendar-clamped window. Cron rows already carry
  // their own canonical grant window and intentionally bypass this branch.
  const annualInvoiceGrantPeriod = payload.p_billing_cycle === 'yearly'
    && payload.p_grant_type === 'annual_monthly_release'
    ? getCanonicalAnnualGrantPeriod({
      yearlyCredits: 0,
      termStart: payload.p_period_start,
      termEnd: payload.p_period_end,
      periodIndex: 1,
    })
    : null;
  const grantPeriodStart = annualInvoiceGrantPeriod?.periodStart ?? payload.p_period_start;
  const grantPeriodEnd = annualInvoiceGrantPeriod?.periodEnd ?? payload.p_period_end;
  const grantPeriodKey = annualInvoiceGrantPeriod?.grantPeriodKey ?? payload.p_grant_period_key;

  const existing = tables.subscription_credit_grants.find((row) =>
    row.stripe_subscription_id === payload.p_stripe_subscription_id
    && (
      row.idempotency_key === payload.p_idempotency_key
      || row.grant_period_key === grantPeriodKey
    ),
  );
  if (existing) {
    return {
      data: [{
        transaction_id: existing.credit_transaction_id ?? null,
        balance_before: balanceBefore,
        balance_after: balanceBefore,
        amount: existing.credits_granted ?? 0,
        is_idempotent: true,
        granted: false,
        blocked_by_termination: false,
        grant_id: existing.id ?? null,
        credits_granted: existing.credits_granted ?? 0,
      }],
      error: null,
    };
  }

  const amount = Math.floor(Number(payload.p_credits_granted ?? 0));
  const balanceAfter = balanceBefore + amount;
  const transactionId = `txn-${tables.credit_transactions.length + 1}`;
  const grantId = `grant-${tables.subscription_credit_grants.length + 1}`;
  if (profile) {
    profile.credits = balanceAfter;
  }
  tables.credit_transactions.push({
    id: transactionId,
    user_id: payload.p_user_id,
    amount,
    type: 'addition',
    description: payload.p_description,
    idempotency_key: payload.p_idempotency_key,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    ledger_type: 'grant',
    reason_code: payload.p_grant_type ?? 'annual_monthly_release',
    counts_as_spend: false,
    source_type: payload.p_source_type,
    source_id: payload.p_source_id,
    source_order_id: payload.p_source_order_id ?? null,
    grant_period_key: grantPeriodKey,
    metadata: payload.p_metadata ?? {},
  });
  tables.subscription_credit_grants.push({
    id: grantId,
    user_id: payload.p_user_id,
    membership_plan_id: payload.p_membership_plan_id,
    stripe_subscription_id: payload.p_stripe_subscription_id,
    stripe_invoice_id: payload.p_stripe_invoice_id ?? null,
    billing_cycle: payload.p_billing_cycle ?? 'yearly',
    grant_type: payload.p_grant_type ?? 'annual_monthly_release',
    grant_period_key: grantPeriodKey,
    period_start: grantPeriodStart,
    period_end: grantPeriodEnd,
    period_index: payload.p_period_index,
    total_periods: payload.p_total_periods,
    credits_granted: amount,
    consumed_amount: 0,
    status: 'granted',
    idempotency_key: payload.p_idempotency_key,
    credit_transaction_id: transactionId,
    metadata: payload.p_grant_metadata ?? {},
  });

  if (payload.p_billing_cycle) {
    const sourceOrder = tables.payment_orders.find((row) => row.id === payload.p_source_order_id);
    subscription.membership_plan_id = payload.p_membership_plan_id;
    subscription.stripe_customer_id = payload.p_stripe_customer_id ?? sourceOrder?.stripe_customer_id ?? subscription.stripe_customer_id ?? null;
    subscription.stripe_price_id = sourceOrder?.stripe_price_id ?? subscription.stripe_price_id ?? null;
    subscription.billing_cycle = payload.p_billing_cycle;
    subscription.current_period_start = payload.p_period_start;
    subscription.current_period_end = payload.p_period_end;
    subscription.metadata = {
      ...(subscription.metadata ?? {}),
      lastInvoiceId: payload.p_stripe_invoice_id,
      lastInvoicePaymentStatus: payload.p_payment_status ?? 'paid',
      transactionId: transactionId,
      subscriptionCreditGrantId: grantId,
      fulfillmentSource: 'atomic_grant_subscription_invoice_credits',
    };
  }

  return {
    data: [{
      transaction_id: transactionId,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      amount,
      is_idempotent: false,
      granted: true,
      blocked_by_termination: false,
      grant_id: grantId,
      credits_granted: amount,
      invoice_order_id: null,
    }],
    error: null,
  };
}

function isRefundBlockedOrder(order: Row | null) {
  if (!order) {
    return false;
  }

  return ['refunded', 'partially_refunded'].includes(String(order.status ?? '').toLowerCase())
    || ['refunded', 'partially_refunded'].includes(String(order.payment_status ?? '').toLowerCase())
    || Boolean(order.metadata?.stripeRefund)
    || Boolean(order.metadata?.subscriptionCreditGrantReversal);
}

function applyFreshRefundTerminationClawbackContract(
  tables: Record<TableName, Row[]>,
  payload: Row,
) {
  const subscription = tables.user_subscriptions.find((row) =>
    row.user_id === payload.p_user_id
      && row.stripe_subscription_id === payload.p_subscription_id) ?? null;
  const refundMs = payload.p_refund_created_at ? Date.parse(String(payload.p_refund_created_at)) : Number.NaN;
  const termStartMs = subscription?.current_period_start
    ? Date.parse(String(subscription.current_period_start))
    : Number.NaN;
  let periodKey: string | null = null;
  let reviewReason: string | null = typeof payload.p_invoice_scope_review_reason === 'string'
    && payload.p_invoice_scope_review_reason.trim()
    ? payload.p_invoice_scope_review_reason.trim()
    : null;

  if (!reviewReason && !Number.isFinite(refundMs)) {
    reviewReason = 'missing_trusted_refund_timestamp';
  } else if (!reviewReason && !Number.isFinite(termStartMs)) {
    reviewReason = 'missing_trusted_term_start';
  } else if (!reviewReason && refundMs < termStartMs) {
    reviewReason = 'refund_timestamp_precedes_term_start';
  } else if (!reviewReason) {
    const candidate = tables.subscription_credit_grants
      .filter((row) => row.user_id === payload.p_user_id
        && row.stripe_subscription_id === payload.p_subscription_id
        && Date.parse(String(row.period_start)) <= refundMs
        && refundMs < Date.parse(String(row.period_end)))
      .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0];
    if (!candidate) {
      reviewReason = 'no_period_window_covers_refund_timestamp';
    } else if (candidate.grant_type === 'annual_monthly_release'
      && Number.isInteger(candidate.period_index)
      && candidate.period_index >= 1
      && Date.parse(String(candidate.period_start)) === addUtcCalendarMonthsClamped(new Date(termStartMs), candidate.period_index - 1).getTime()) {
      periodKey = candidate.grant_period_key;
    } else if (candidate.grant_type === 'monthly_invoice'
      && Date.parse(String(candidate.period_start)) === termStartMs) {
      periodKey = candidate.grant_period_key;
    } else {
      reviewReason = candidate.grant_type === 'annual_monthly_release' || candidate.grant_type === 'monthly_invoice'
        ? 'term_start_period_mismatch'
        : 'term_start_period_anchor_unknown';
    }
  }

  const eventId = typeof payload.p_event_id === 'string' && payload.p_event_id.trim()
    ? payload.p_event_id.trim()
    : null;
  if (!reviewReason && !eventId) {
    reviewReason = 'missing_event_id';
  }
  const idempotencyKey = `stripe_refund:subscription_grants:event:${eventId ?? 'unlocated'}:sub:${payload.p_subscription_id}:period:${periodKey ?? 'unlocated'}`;
  const result = applyRefundTerminationClawbackContract(tables, {
    ...payload,
    p_period_key: periodKey,
    p_idempotency_key: idempotencyKey,
    p_termination_only: Boolean(reviewReason) || !periodKey,
  });

  return {
    ...result,
    data: result.data?.map((row: Row) => ({
      ...row,
      resolved_period_key: periodKey,
      review_required: Boolean(reviewReason) || !periodKey,
      review_reason: reviewReason,
      idempotency_key: idempotencyKey,
    })),
  };
}

function createMockSupabase(
  seed: Partial<Record<TableName, Row[]>> = {},
  hooks: MockSupabaseHooks = {},
) {
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
      return new MockQuery(tables, table, hooks);
    },
    async rpc(name: string, payload: Row) {
      await hooks.beforeRpc?.({ name, payload, tables });
      if (name === 'atomic_refund_termination_clawback_fresh') {
        return applyFreshRefundTerminationClawbackContract(tables, payload);
      }

      if (name === 'atomic_refund_termination_clawback') {
        return applyRefundTerminationClawbackContract(tables, payload);
      }

      if (name === 'atomic_grant_annual_subscription_credits') {
        return applyAnnualGrantAdmissionContract(tables, payload);
      }

      if (name === 'atomic_grant_subscription_invoice_credits') {
        await hooks.beforeInvoiceGrantAdmission?.({ payload, tables });
        const sourceOrder = tables.payment_orders.find((row) => row.id === payload.p_source_order_id) ?? null;
        const invoiceOrder = tables.payment_orders.find((row) =>
          row.stripe_invoice_id === payload.p_stripe_invoice_id) ?? null;
        const subscription = tables.user_subscriptions.find((row) =>
          row.user_id === payload.p_user_id
            && row.stripe_subscription_id === payload.p_stripe_subscription_id) ?? null;
        if (isRefundBlockedOrder(sourceOrder) || isRefundBlockedOrder(invoiceOrder)
          || subscription?.credit_release_terminated_at != null) {
          return {
            data: [{
              transaction_id: null,
              granted: false,
              blocked_by_termination: true,
              grant_id: null,
              credits_granted: 0,
              invoice_order_id: invoiceOrder?.id ?? null,
            }],
            error: null,
          };
        }
        const admission = applyAnnualGrantAdmissionContract(tables, payload);
        if (!admission.error && admission.data?.[0]?.granted && hooks.afterInvoiceGrantAdmission) {
          await hooks.afterInvoiceGrantAdmission({ payload, tables });
          const committedInvoiceOrder = tables.payment_orders.find((row) =>
            row.stripe_invoice_id === payload.p_stripe_invoice_id) ?? null;
          return {
            data: admission.data.map((row: Row) => ({
              ...row,
              invoice_order_id: committedInvoiceOrder?.id ?? null,
            })),
            error: null,
          };
        }
        return admission;
      }

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

function createInvoiceAdmissionRaceHarness(hooks: MockSupabaseHooks) {
  return createMockSupabase({
    payment_orders: [{
      id: 'order-v6-race-source',
      user_id: 'user-v6-race',
      item_id: 'plan-v6-race',
      item_type: 'membership_plan',
      billing_cycle: 'monthly',
      stripe_subscription_id: 'sub_v6_race',
      stripe_customer_id: 'cus_v6_race',
      stripe_price_id: 'price_v6_race',
      status: 'pending',
      payment_status: 'paid',
      created_at: '2026-08-01T00:00:00.000Z',
    }],
    membership_plans: [{
      id: 'plan-v6-race',
      name: 'Gold',
      level: 'gold',
      monthly_credits: 100,
      monthly_bonus_credits: 0,
    }],
    profiles: [{ id: 'user-v6-race', membership_level: 'free', credits: 0 }],
  }, hooks);
}

function createRenewalHarness(input: {
  billingCycle: 'monthly' | 'yearly';
  oldStart: string;
  oldEnd: string;
  newPlanId: string;
  newStart: string;
  newEnd: string;
  invoiceId: string;
  terminated?: boolean;
  mirrorStatus?: string;
  cancelAtPeriodEnd?: string;
}, hooks: MockSupabaseHooks = {}) {
  const isYearly = input.billingCycle === 'yearly';
  return createMockSupabase({
    payment_orders: [{
      id: `order-${input.invoiceId}`, user_id: 'user-v7-renewal', item_id: input.newPlanId,
      item_type: 'membership_plan', billing_cycle: input.billingCycle,
      stripe_subscription_id: 'sub_v7_renewal', stripe_customer_id: 'cus_v7_new',
      stripe_price_id: 'price-v7-new', status: 'pending', payment_status: 'paid',
      created_at: input.newStart,
    }],
    user_subscriptions: [{
      id: 'subscription-v7-renewal', user_id: 'user-v7-renewal', membership_plan_id: 'plan-v7-old',
      stripe_subscription_id: 'sub_v7_renewal', stripe_customer_id: 'cus_v7_old', stripe_price_id: 'price-v7-old',
      billing_cycle: input.billingCycle, status: input.mirrorStatus ?? 'past_due',
      cancel_at_period_end: input.cancelAtPeriodEnd ?? 'true',
      current_period_start: input.oldStart, current_period_end: input.oldEnd,
      credit_release_terminated_at: input.terminated ? '2027-01-01T00:00:00.000Z' : null,
      metadata: { lastInvoiceId: 'in_v7_old', lastInvoicePaymentStatus: 'paid' },
    }],
    membership_plans: [{
      id: input.newPlanId, name: 'Gold', level: 'gold',
      yearly_credits: isYearly ? 120 : 0, monthly_credits: isYearly ? 0 : 100, monthly_bonus_credits: 0,
    }],
    profiles: [{ id: 'user-v7-renewal', membership_level: 'free', credits: 0 }],
  }, hooks);
}

function createAsyncBarrier(expectedArrivals: number) {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    get arrivals() {
      return arrivals;
    },
    async wait() {
      arrivals += 1;
      if (arrivals >= expectedArrivals) {
        release();
      }

      await Promise.race([
        released,
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out waiting for ${expectedArrivals} barrier arrivals`)), 1000);
        }),
      ]);
    },
  };
}

function createRefundCrashRecoveryHarness() {
  let failNextPaymentOrderUpdate = true;
  const supabase = createMockSupabase({
    payment_orders: [{
      id: 'order-refund-crash-recovery',
      user_id: 'user-refund-crash-recovery',
      stripe_subscription_id: 'sub_refund_crash_recovery',
      stripe_invoice_id: 'in_refund_crash_recovery',
      status: 'completed',
      payment_status: 'paid',
      metadata: { source: 'invoice.payment_succeeded' },
    }],
    user_subscriptions: [{
      id: 'subscription-refund-crash-recovery',
      user_id: 'user-refund-crash-recovery',
      membership_plan_id: 'plan-refund-crash-recovery',
      stripe_subscription_id: 'sub_refund_crash_recovery',
      billing_cycle: 'yearly',
      status: 'active',
      current_period_start: '2026-01-01T00:00:00.000Z',
      current_period_end: '2027-01-01T00:00:00.000Z',
    }],
    profiles: [{ id: 'user-refund-crash-recovery', credits: 100 }],
    subscription_credit_grants: [{
      id: 'grant-refund-crash-recovery',
      user_id: 'user-refund-crash-recovery',
      membership_plan_id: 'plan-refund-crash-recovery',
      stripe_subscription_id: 'sub_refund_crash_recovery',
      stripe_invoice_id: 'in_refund_crash_recovery',
      billing_cycle: 'yearly',
      grant_type: 'annual_monthly_release',
      grant_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-02-01T00:00:00.000Z',
      period_index: 1,
      total_periods: 12,
      credits_granted: 10,
      consumed_amount: 4,
      status: 'granted',
    }],
  }, {
    beforeExecute: ({ table, mode }) => {
      if (failNextPaymentOrderUpdate && table === 'payment_orders' && mode === 'update') {
        failNextPaymentOrderUpdate = false;
        throw new Error('simulated post-rpc payment-order crash');
      }
    },
  });

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

  it('V8 CASE 1/7: derives canonical annual windows from the full Stripe term with UTC calendar clamping', () => {
    expect(getCanonicalAnnualGrantPeriod({
      yearlyCredits: 1200,
      termStart: '2028-01-31T09:30:15.500Z',
      termEnd: '2029-01-31T09:30:15.500Z',
      periodIndex: 1,
    })).toMatchObject({
      periodStart: '2028-01-31T09:30:15.500Z',
      periodEnd: '2028-02-29T09:30:15.500Z',
      grantPeriodKey: 'annual:2028-01-31T09:30:15.500Z:01',
    });
    expect(getCanonicalAnnualGrantPeriod({
      yearlyCredits: 1200,
      termStart: '2026-01-31T00:00:00.000Z',
      termEnd: '2026-02-15T00:00:00.000Z',
      periodIndex: 1,
    })).toMatchObject({
      periodStart: '2026-01-31T00:00:00.000Z',
      periodEnd: '2026-02-15T00:00:00.000Z',
    });
  });

  it('V8 canonical identity: derives a complete monthly invoice window and rejects invalid terms', () => {
    expect(getCanonicalMonthlyGrantPeriod({
      invoiceId: '  in_monthly_canonical  ',
      termStart: '2028-01-31T09:30:15.500Z',
      termEnd: '2028-02-29T09:30:15.500Z',
      creditsGranted: 2100,
    })).toEqual({
      periodIndex: null,
      totalPeriods: 1,
      periodStart: '2028-01-31T09:30:15.500Z',
      periodEnd: '2028-02-29T09:30:15.500Z',
      creditsGranted: 2100,
      grantPeriodKey: 'invoice:in_monthly_canonical',
    });
    expect(getCanonicalMonthlyGrantPeriod({
      invoiceId: '   ',
      termStart: '2028-01-01T00:00:00.000Z',
      termEnd: '2028-02-01T00:00:00.000Z',
      creditsGranted: 100,
    })).toBeNull();
    expect(getCanonicalMonthlyGrantPeriod({
      invoiceId: 'in_monthly_invalid_term',
      termStart: '2028-02-01T00:00:00.000Z',
      termEnd: '2028-02-01T00:00:00.000Z',
      creditsGranted: 100,
    })).toBeNull();
  });

  it('grants only the first annual month for a paid yearly invoice', async () => {
    const rpcCalls: Array<{ name: string; payload: Row }> = [];
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
    }, {
      beforeRpc: ({ name, payload }) => rpcCalls.push({ name, payload }),
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
    expect(rpcCalls).toContainEqual(expect.objectContaining({
      name: 'atomic_grant_subscription_invoice_credits',
      payload: expect.objectContaining({
        p_period_start: '2026-06-01T00:00:00.000Z',
        p_period_end: '2027-06-01T00:00:00.000Z',
      }),
    }));
    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-yearly',
      membership_level: 'gold',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      billing_cycle: 'yearly',
      grant_type: 'annual_monthly_release',
      period_start: '2026-06-01T00:00:00.000Z',
      period_end: '2026-07-01T00:00:00.000Z',
      period_index: 1,
      total_periods: 12,
      credits_granted: 1667,
      idempotency_key: expect.stringContaining('subscription_grant:annual_monthly_release:sub_yearly:'),
    });
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2027-06-01T00:00:00.000Z',
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

  it('V8 direct boundary: annual cron sends one canonical grant window to its RPC', async () => {
    const rpcCalls: Array<{ name: string; payload: Row }> = [];
    const supabase = createMockSupabase({
      user_subscriptions: [{
        id: 'subscription-cron-direct',
        user_id: 'user-cron-direct',
        membership_plan_id: 'plan-cron-direct',
        stripe_subscription_id: 'sub-cron-direct',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2027-01-01T00:00:00.000Z',
        current_period_end: '2028-01-01T00:00:00.000Z',
      }],
      profiles: [{ id: 'user-cron-direct', credits: 0 }],
    }, {
      beforeRpc: ({ name, payload }) => rpcCalls.push({ name, payload }),
    });

    await grantSubscriptionCredits(supabase, {
      userId: 'user-cron-direct',
      membershipPlanId: 'plan-cron-direct',
      stripeSubscriptionId: 'sub-cron-direct',
      stripeInvoiceId: null,
      billingCycle: 'yearly',
      grantType: 'annual_monthly_release',
      sourceType: 'system',
      periodIndex: 2,
      totalPeriods: 12,
      periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-03-01T00:00:00.000Z',
      grantPeriodKey: 'annual:2027-01-01T00:00:00.000Z:02',
      creditsGranted: 100,
      subscriptionTermStart: '2027-01-01T00:00:00.000Z',
      subscriptionTermEnd: '2028-01-01T00:00:00.000Z',
      now: '2027-02-15T00:00:00.000Z',
      enforceTerminationBarrier: true,
    });

    expect(rpcCalls).toContainEqual(expect.objectContaining({
      name: 'atomic_grant_annual_subscription_credits',
      payload: expect.objectContaining({
        p_period_start: '2027-02-01T00:00:00.000Z',
        p_period_end: '2027-03-01T00:00:00.000Z',
      }),
    }));
    expect(rpcCalls.find((call) => call.name === 'atomic_grant_annual_subscription_credits')?.payload)
      .not.toMatchObject({
        p_period_start: '2027-01-01T00:00:00.000Z',
        p_period_end: '2028-01-01T00:00:00.000Z',
      });
  });

  it('CASE A: blocks a refund committed after the application precheck and before invoice admission', async () => {
    const supabase = createInvoiceAdmissionRaceHarness({
      beforeInvoiceGrantAdmission: ({ tables }) => {
        Object.assign(tables.payment_orders[0], {
          status: 'refunded',
          payment_status: 'refunded',
          metadata: { stripeRefund: { id: 're_v6_case_a' } },
        });
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v6_case_a', subscriptionId: 'sub_v6_race', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', now: '2026-08-01T00:00:01.000Z',
    });

    expect(result).toMatchObject({ skippedReason: 'blocked_by_termination', grantedCredits: 0 });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(1);
    expect(supabase.tables.payment_orders[0]).toMatchObject({ status: 'refunded', payment_status: 'refunded' });
  });

  it('blocks a termination committed after the application precheck and before invoice admission', async () => {
    const supabase = createInvoiceAdmissionRaceHarness({
      beforeInvoiceGrantAdmission: ({ tables }) => {
        tables.user_subscriptions.push({
          id: 'subscription-v6-case-b', user_id: 'user-v6-race', membership_plan_id: 'plan-v6-race',
          stripe_subscription_id: 'sub_v6_race', credit_release_terminated_at: '2026-08-01T00:00:00.500Z',
        });
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v6_case_b', subscriptionId: 'sub_v6_race', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', now: '2026-08-01T00:00:01.000Z',
    });

    expect(result).toMatchObject({ skippedReason: 'blocked_by_termination', grantedCredits: 0 });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].status).toBe('pending');
  });

  it('blocks a newly refunded invoice written after the legacy precheck', async () => {
    const supabase = createInvoiceAdmissionRaceHarness({
      beforeInvoiceGrantAdmission: ({ tables }) => {
        tables.payment_orders.push({
          id: 'order-v6-case-c-refunded', user_id: 'user-v6-race', item_id: 'plan-v6-race',
          item_type: 'membership_plan', billing_cycle: 'monthly', stripe_invoice_id: 'in_v6_case_c',
          stripe_subscription_id: 'sub_v6_race', status: 'refunded', payment_status: 'refunded',
          metadata: { subscriptionCreditGrantReversal: { refundId: 're_v6_case_c' } },
        });
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v6_case_c', subscriptionId: 'sub_v6_race', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', now: '2026-08-01T00:00:01.000Z',
    });

    expect(result).toMatchObject({ skippedReason: 'blocked_by_termination', grantedCredits: 0 });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.payment_orders.find((row) => row.id === 'order-v6-case-c-refunded'))
      .toMatchObject({ status: 'refunded', payment_status: 'refunded' });
  });

  it('CASE B: lets a committed subscription invoice grant be observed and reversed by a later refund', async () => {
    const supabase = createInvoiceAdmissionRaceHarness({});
    const fulfillment = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v6_case_b_grant_first', subscriptionId: 'sub_v6_race', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', now: '2026-08-01T00:00:01.000Z',
    });
    const refund = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: fulfillment.invoiceOrderId!, subscriptionId: 'sub_v6_race',
      invoiceId: 'in_v6_case_b_grant_first', refundId: 're_v6_case_b', eventId: 'evt_v6_case_b',
      refundEventType: 'charge.refunded', refundStatus: 'succeeded', refundAmount: 9900,
      refundCurrency: 'usd', isFullRefund: true, refundCreatedAt: '2026-08-02T00:00:00.000Z',
      now: '2026-08-02T00:00:01.000Z',
    });

    expect(fulfillment.grantedCredits).toBe(100);
    expect(refund).toMatchObject({ reviewRequired: false, reversedGrantCount: 1, clawbackAmount: 100 });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({ status: 'reversed', consumed_amount: 0 });
    expect(supabase.tables.payment_orders.find((row) => row.id === fulfillment.invoiceOrderId))
      .toMatchObject({ status: 'refunded', payment_status: 'refunded' });
    expect(supabase.tables.profiles[0].credits).toBe(0);
  });

  it('CASE C: does not perform a stale completion write after a committed grant is followed by refund state', async () => {
    const supabase = createInvoiceAdmissionRaceHarness({
      afterInvoiceGrantAdmission: ({ tables }) => {
        tables.payment_orders.push({
          id: 'order-v6-case-c-after-grant', user_id: 'user-v6-race', item_id: 'plan-v6-race',
          item_type: 'membership_plan', billing_cycle: 'monthly', stripe_invoice_id: 'in_v6_case_c_after_grant',
          stripe_subscription_id: 'sub_v6_race', status: 'refunded', payment_status: 'refunded',
          metadata: { subscriptionCreditGrantReversal: { refundId: 're_v6_case_c_after_grant' } },
        });
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v6_case_c_after_grant', subscriptionId: 'sub_v6_race', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z', now: '2026-08-01T00:00:01.000Z',
    });

    expect(result.invoiceOrderId).toBe('order-v6-case-c-after-grant');
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.payment_orders.find((row) => row.id === result.invoiceOrderId))
      .toMatchObject({ status: 'refunded', payment_status: 'refunded' });
  });

  it('TEST 1: refreshes every existing annual mirror field to the successful renewal term', async () => {
    const rpcCalls: Array<{ name: string; payload: Row }> = [];
    const supabase = createRenewalHarness({
      billingCycle: 'yearly', oldStart: '2026-01-01T00:00:00.000Z', oldEnd: '2027-01-01T00:00:00.000Z',
      newPlanId: 'plan-v7-new-annual', newStart: '2027-01-01T00:00:00.000Z', newEnd: '2028-01-01T00:00:00.000Z',
      invoiceId: 'in_v7_annual_renewal',
    }, {
      beforeRpc: ({ name, payload }) => rpcCalls.push({ name, payload }),
    });
    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v7_annual_renewal', subscriptionId: 'sub_v7_renewal', amountTotal: 9900,
      paymentStatus: 'paid', stripeCustomerId: 'cus_v7_new', periodStart: '2027-01-01T00:00:00.000Z',
      periodEnd: '2028-01-01T00:00:00.000Z', now: '2027-01-01T00:00:01.000Z',
    });

    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      membership_plan_id: 'plan-v7-new-annual', stripe_customer_id: 'cus_v7_new', stripe_price_id: 'price-v7-new',
      billing_cycle: 'yearly', current_period_start: '2027-01-01T00:00:00.000Z',
      current_period_end: '2028-01-01T00:00:00.000Z', status: 'past_due', cancel_at_period_end: 'true',
      metadata: expect.objectContaining({ lastInvoiceId: 'in_v7_annual_renewal', transactionId: expect.any(String) }),
    });
    expect(rpcCalls).toContainEqual(expect.objectContaining({
      name: 'atomic_grant_subscription_invoice_credits',
      payload: expect.objectContaining({
        p_period_start: '2027-01-01T00:00:00.000Z',
        p_period_end: '2028-01-01T00:00:00.000Z',
      }),
    }));
  });

  it('TEST 2: anchors the next annual release at the refreshed renewal term', async () => {
    const supabase = createRenewalHarness({
      billingCycle: 'yearly', oldStart: '2026-01-01T00:00:00.000Z', oldEnd: '2027-01-01T00:00:00.000Z',
      newPlanId: 'plan-v7-release', newStart: '2027-01-01T00:00:00.000Z', newEnd: '2028-01-01T00:00:00.000Z',
      invoiceId: 'in_v7_release_renewal', mirrorStatus: 'active', cancelAtPeriodEnd: 'false',
    });
    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v7_release_renewal', subscriptionId: 'sub_v7_renewal', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2027-01-01T00:00:00.000Z', periodEnd: '2028-01-01T00:00:00.000Z',
      now: '2027-01-01T00:00:01.000Z',
    });
    const release = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2027-02-01T00:00:00.000Z'),
    });

    expect(release).toMatchObject({ releasedGrantCount: 1, releasedCredits: 10 });
    expect(supabase.tables.subscription_credit_grants.map((row) => row.grant_period_key))
      .toContain('annual:2027-01-01T00:00:00.000Z:02');
  });

  it('TEST 3: resolves a new-term annual refund against the refreshed mirror period', async () => {
    const supabase = createRenewalHarness({
      billingCycle: 'yearly', oldStart: '2026-01-01T00:00:00.000Z', oldEnd: '2027-01-01T00:00:00.000Z',
      newPlanId: 'plan-v7-refund', newStart: '2027-01-01T00:00:00.000Z', newEnd: '2028-01-01T00:00:00.000Z',
      invoiceId: 'in_v7_refund_renewal', mirrorStatus: 'active', cancelAtPeriodEnd: 'false',
    });
    const fulfillment = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v7_refund_renewal', subscriptionId: 'sub_v7_renewal', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2027-01-01T00:00:00.000Z', periodEnd: '2028-01-01T00:00:00.000Z',
      now: '2027-01-01T00:00:01.000Z',
    });
    const refund = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: fulfillment.invoiceOrderId!, subscriptionId: 'sub_v7_renewal', invoiceId: 'in_v7_refund_renewal',
      refundId: 're_v7_annual', eventId: 'evt_v7_annual', refundEventType: 'charge.refunded', refundStatus: 'succeeded',
      refundAmount: 9900, refundCurrency: 'usd', isFullRefund: true,
      refundCreatedAt: '2027-01-15T00:00:00.000Z', now: '2027-01-15T00:00:01.000Z',
    });

    expect(refund).toMatchObject({ reviewRequired: false, locatedPeriodKey: 'annual:2027-01-01T00:00:00.000Z:01', reversedGrantCount: 1 });
  });

  it('TEST 4: refreshes a monthly renewal mirror and locates its exact refund period', async () => {
    const supabase = createRenewalHarness({
      billingCycle: 'monthly', oldStart: '2027-01-01T00:00:00.000Z', oldEnd: '2027-02-01T00:00:00.000Z',
      newPlanId: 'plan-v7-monthly', newStart: '2027-02-01T00:00:00.000Z', newEnd: '2027-03-01T00:00:00.000Z',
      invoiceId: 'in_v7_monthly_renewal', mirrorStatus: 'active', cancelAtPeriodEnd: 'false',
    });
    const fulfillment = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v7_monthly_renewal', subscriptionId: 'sub_v7_renewal', amountTotal: 1200,
      paymentStatus: 'paid', periodStart: '2027-02-01T00:00:00.000Z', periodEnd: '2027-03-01T00:00:00.000Z',
      now: '2027-02-01T00:00:01.000Z',
    });
    const refund = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: fulfillment.invoiceOrderId!, subscriptionId: 'sub_v7_renewal', invoiceId: 'in_v7_monthly_renewal',
      refundId: 're_v7_monthly', eventId: 'evt_v7_monthly', refundEventType: 'charge.refunded', refundStatus: 'succeeded',
      refundAmount: 1200, refundCurrency: 'usd', isFullRefund: true,
      refundCreatedAt: '2027-02-15T00:00:00.000Z', now: '2027-02-15T00:00:01.000Z',
    });

    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      current_period_start: '2027-02-01T00:00:00.000Z', current_period_end: '2027-03-01T00:00:00.000Z',
      billing_cycle: 'monthly',
    });
    expect(refund).toMatchObject({ reviewRequired: false, locatedPeriodKey: 'invoice:in_v7_monthly_renewal', reversedGrantCount: 1 });
  });

  it('TEST 5: leaves a terminated mirror completely unchanged and blocks renewal', async () => {
    const supabase = createRenewalHarness({
      billingCycle: 'yearly', oldStart: '2026-01-01T00:00:00.000Z', oldEnd: '2027-01-01T00:00:00.000Z',
      newPlanId: 'plan-v7-terminated', newStart: '2027-01-01T00:00:00.000Z', newEnd: '2028-01-01T00:00:00.000Z',
      invoiceId: 'in_v7_terminated', terminated: true,
    });
    const before = JSON.parse(JSON.stringify(supabase.tables.user_subscriptions[0]));
    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      invoiceId: 'in_v7_terminated', subscriptionId: 'sub_v7_renewal', amountTotal: 9900,
      paymentStatus: 'paid', periodStart: '2027-01-01T00:00:00.000Z', periodEnd: '2028-01-01T00:00:00.000Z',
      now: '2027-01-01T00:00:01.000Z',
    });

    expect(result).toMatchObject({ skippedReason: 'blocked_by_termination', grantedCredits: 0 });
    expect(supabase.tables.user_subscriptions[0]).toEqual(before);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(1);
  });

  it('TEST 6: exact invoice replay keeps refreshed term and legitimate status/cancel state', async () => {
    const supabase = createRenewalHarness({
      billingCycle: 'monthly', oldStart: '2027-01-01T00:00:00.000Z', oldEnd: '2027-02-01T00:00:00.000Z',
      newPlanId: 'plan-v7-replay', newStart: '2027-02-01T00:00:00.000Z', newEnd: '2027-03-01T00:00:00.000Z',
      invoiceId: 'in_v7_replay', mirrorStatus: 'past_due', cancelAtPeriodEnd: 'true',
    });
    const input = {
      invoiceId: 'in_v7_replay', subscriptionId: 'sub_v7_renewal', amountTotal: 1200,
      paymentStatus: 'paid' as const, periodStart: '2027-02-01T00:00:00.000Z', periodEnd: '2027-03-01T00:00:00.000Z',
      now: '2027-02-01T00:00:01.000Z',
    };
    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);
    const replay = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);

    expect(replay).toMatchObject({ alreadyFulfilled: true, grantedCredits: 0 });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      current_period_start: input.periodStart, current_period_end: input.periodEnd,
      status: 'past_due', cancel_at_period_end: 'true',
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
      user_subscriptions: [{
        id: 'subscription-invoice-refund-race',
        user_id: 'user-invoice-refund-race',
        membership_plan_id: 'plan-invoice-refund-race',
        stripe_subscription_id: 'sub_invoice_refund_race',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-06-01T00:00:00.000Z',
        current_period_end: '2027-06-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_invoice_refund_race' },
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
      reviewRequired: true,
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
          reviewRequired: true,
          reversalStatus: 'review_required',
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
          reversalStatus: 'review_required',
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
      user_subscriptions: [{
        id: 'subscription-invoice-partial-review-block',
        user_id: 'user-invoice-partial-review-block',
        membership_plan_id: 'plan-invoice-partial-review-block',
        stripe_subscription_id: 'sub_invoice_partial_review_block',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-06-01T00:00:00.000Z',
        current_period_end: '2027-06-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_invoice_partial_review_block' },
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
          reversalStatus: 'review_required',
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
          reversalStatus: 'review_required',
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

  it('rechecks subscription mirrors before insert when a concurrent path inserts first', async () => {
    let subscriptionSelects = 0;
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-concurrent-mirror',
        user_id: 'user-concurrent-mirror',
        item_id: 'plan-concurrent-mirror',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_concurrent_mirror',
        stripe_checkout_session_id: 'cs_test_concurrent_mirror',
        stripe_customer_id: 'cus_concurrent_mirror',
        stripe_price_id: 'price_concurrent_mirror',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-concurrent-mirror',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-concurrent-mirror',
        membership_level: 'free',
        credits: 0,
      }],
    }, {
      beforeExecute(context) {
        if (
          context.table === 'user_subscriptions'
          && context.mode === 'select'
          && context.filters.some((filter) =>
            filter.column === 'stripe_subscription_id'
            && filter.value === 'sub_concurrent_mirror'
          )
        ) {
          subscriptionSelects += 1;

          if (subscriptionSelects === 2 && context.tables.user_subscriptions.length === 0) {
            context.tables.user_subscriptions.push({
              id: 'subscription-concurrent-mirror',
              user_id: 'user-concurrent-mirror',
              membership_plan_id: 'plan-concurrent-mirror',
              stripe_subscription_id: 'sub_concurrent_mirror',
              status: 'active',
              cancel_at_period_end: 'false',
              created_at: '2026-07-04T00:00:01.500Z',
              metadata: { source: 'concurrent_path' },
            });
          }
        }
      },
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_concurrent_mirror',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2026-08-04T00:00:00.000Z',
      stripeCustomerId: 'cus_concurrent_mirror',
      subscriptionId: 'sub_concurrent_mirror',
      now: '2026-07-04T00:00:02.000Z',
    });

    expect(subscriptionSelects).toBeGreaterThanOrEqual(1);
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      stripe_subscription_id: 'sub_concurrent_mirror',
      status: 'active',
      metadata: expect.objectContaining({
        lastInvoiceId: 'in_concurrent_mirror',
      }),
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
  });

  it('converges simultaneous subscription mirror inserts onto one deterministic row', async () => {
    const subscriptionInsertBarrier = createAsyncBarrier(2);
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-atomic-mirror-source',
        user_id: 'user-atomic-mirror',
        item_id: 'plan-atomic-mirror',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_atomic_mirror',
        stripe_customer_id: 'cus_atomic_mirror',
        stripe_price_id: 'price_atomic_mirror',
        status: 'completed',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-atomic-mirror',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-atomic-mirror',
        membership_level: 'free',
        credits: 0,
      }],
    }, {
      async beforeExecute(context) {
        if (context.table === 'user_subscriptions' && context.mode === 'insert') {
          await subscriptionInsertBarrier.wait();
        }
      },
    });

    const webhookInput = {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_atomic_mirror_webhook',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2026-08-04T00:00:00.000Z',
      stripeCustomerId: 'cus_atomic_mirror',
      subscriptionId: 'sub_atomic_mirror',
      now: '2026-07-04T00:00:02.000Z',
    };
    const returnSyncInput = {
      ...webhookInput,
      invoiceId: 'in_atomic_mirror_return_sync',
      invoiceCreatedAt: '2026-07-04T00:00:02.000Z',
      now: '2026-07-04T00:00:03.000Z',
    };

    await Promise.all([
      fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, webhookInput),
      fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, returnSyncInput),
    ]);

    expect(subscriptionInsertBarrier.arrivals).toBe(0);
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      stripe_subscription_id: 'sub_atomic_mirror',
      status: 'active',
      billing_cycle: 'monthly',
    });
    expect([
      'in_atomic_mirror_webhook',
      'in_atomic_mirror_return_sync',
    ]).toContain(supabase.tables.user_subscriptions[0].metadata.lastInvoiceId);
    expect(supabase.tables.payment_orders.filter((order) => order.stripe_invoice_id)).toHaveLength(2);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(2);
    expect(new Set(supabase.tables.subscription_credit_grants.map((grant) => grant.idempotency_key)).size).toBe(2);
    expect(supabase.tables.credit_transactions).toHaveLength(2);
    const ledgerDelta = supabase.tables.credit_transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    expect(supabase.tables.profiles[0].credits).toBe(ledgerDelta);
  });

  it('converges simultaneous non-promotion invoice order inserts onto one deterministic row', async () => {
    const grantInsertBarrier = createAsyncBarrier(2);
    const invoiceOrderInsertBarrier = createAsyncBarrier(2);
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-atomic-invoice-source',
        user_id: 'user-atomic-invoice',
        item_id: 'plan-atomic-invoice',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_atomic_invoice',
        stripe_customer_id: 'cus_atomic_invoice',
        stripe_price_id: 'price_atomic_invoice',
        status: 'completed',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-atomic-invoice',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-atomic-invoice',
        membership_level: 'free',
        credits: 100,
      }],
    }, {
      async beforeExecute(context) {
        if (context.table === 'subscription_credit_grants' && context.mode === 'insert') {
          await grantInsertBarrier.wait();
        }

        if (context.table === 'payment_orders' && context.mode === 'insert') {
          await invoiceOrderInsertBarrier.wait();
        }
      },
    });

    const input = {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_atomic_invoice',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2026-08-04T00:00:00.000Z',
      stripeCustomerId: 'cus_atomic_invoice',
      subscriptionId: 'sub_atomic_invoice',
      now: '2026-07-04T00:00:02.000Z',
    };

    const [webhookResult, returnSyncResult] = await Promise.all([
      fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input),
      fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
        ...input,
        now: '2026-07-04T00:00:03.000Z',
      }),
    ]);

    const invoiceOrders = supabase.tables.payment_orders.filter((order) => order.stripe_invoice_id === 'in_atomic_invoice');
    expect(grantInsertBarrier.arrivals).toBe(0);
    expect(invoiceOrderInsertBarrier.arrivals).toBe(2);
    expect(invoiceOrders).toHaveLength(1);
    expect(webhookResult.invoiceOrderId).toBe(invoiceOrders[0].id);
    expect(returnSyncResult.invoiceOrderId).toBe(invoiceOrders[0].id);
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      stripe_subscription_id: 'sub_atomic_invoice',
      status: 'active',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    const ledgerDelta = supabase.tables.credit_transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    expect(ledgerDelta).toBe(100);
    expect(supabase.tables.profiles[0].credits - 100).toBe(ledgerDelta);
  });

  it('does not overwrite checkout row when promotion sees a stale invoice claim', async () => {
    let promotionUpdates = 0;
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-stale-promotion',
        user_id: 'user-stale-promotion',
        item_id: 'plan-stale-promotion',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_subscription_id: 'sub_stale_promotion',
        stripe_checkout_session_id: 'cs_test_stale_promotion',
        stripe_customer_id: 'cus_stale_promotion',
        stripe_price_id: 'price_stale_promotion',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-07-04T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-stale-promotion',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-stale-promotion',
        membership_level: 'free',
        credits: 0,
      }],
    }, {
      beforeExecute(context) {
        if (
          context.table === 'payment_orders'
          && context.mode === 'update'
          && context.filters.some((filter) => filter.column === 'id' && filter.value === 'order-stale-promotion')
          && context.filters.some((filter) =>
            filter.column === 'stripe_invoice_id'
            && filter.operator === 'is'
            && filter.value === null
          )
        ) {
          promotionUpdates += 1;
          const row = context.tables.payment_orders.find((order) => order.id === 'order-stale-promotion');
          if (row && !row.stripe_invoice_id) {
            Object.assign(row, {
              stripe_invoice_id: 'in_already_claimed',
              status: 'completed',
              payment_status: 'paid',
              fulfilled_at: '2026-07-04T00:00:01.500Z',
              metadata: { source: 'concurrent_invoice' },
            });
          }
        }
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      currency: 'usd',
      invoiceId: 'in_stale_promotion',
      invoiceCreatedAt: '2026-07-04T00:00:01.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-07-04T00:00:00.000Z',
      periodEnd: '2026-08-04T00:00:00.000Z',
      stripeCustomerId: 'cus_stale_promotion',
      subscriptionId: 'sub_stale_promotion',
      now: '2026-07-04T00:00:02.000Z',
    });

    expect(promotionUpdates).toBe(1);
    const insertedOrder = supabase.tables.payment_orders.find((order) => order.stripe_invoice_id === 'in_stale_promotion');
    expect(result.invoiceOrderId).toBe(insertedOrder?.id);
    expect(supabase.tables.payment_orders).toHaveLength(2);
    expect(supabase.tables.payment_orders.find((order) => order.id === 'order-stale-promotion')).toMatchObject({
      stripe_invoice_id: 'in_already_claimed',
      metadata: { source: 'concurrent_invoice' },
    });
    expect(supabase.tables.payment_orders.find((order) => order.stripe_invoice_id === 'in_stale_promotion')).toMatchObject({
      status: 'completed',
      payment_status: 'paid',
      stripe_subscription_id: 'sub_stale_promotion',
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
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

  it('releases its exact residual plan-change lock on already fulfilled upgrade invoice replay', async () => {
    const residualLockLookups: MockFilter[][] = [];
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
    }, {
      beforeExecute({ table, mode, filters }) {
        if (table === 'payment_orders' && mode === 'select'
          && filters.some((filter) => filter.column === 'stripe_checkout_session_id')) {
          residualLockLookups.push(filters);
        }
      },
    });

    const result = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 1990,
      expectedSourceOrderId: 'order-source-replay-lock',
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
    expect(residualLockLookups).toContainEqual(expect.arrayContaining([
      { column: 'stripe_subscription_id', value: 'sub_replay_lock', operator: 'eq' },
      { column: 'stripe_checkout_session_id', value: 'change_subscription_plan_lock:sub_replay_lock', operator: 'eq' },
      { column: 'id', value: 'order-source-replay-lock', operator: 'eq' },
    ]));
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('does not release a pending plan-change lock created 500ms after an ordinary fulfilled renewal invoice', async () => {
    let residualLockLookupCount = 0;
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-renewal-plus-500ms-lock',
          user_id: 'user-renewal-plus-500ms',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_renewal_plus_500ms',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_renewal_plus_500ms',
          stripe_customer_id: 'cus_renewal_plus_500ms',
          stripe_price_id: 'price_gold_monthly',
          status: 'pending',
          payment_status: 'active',
          fulfilled_at: null,
          created_at: '2026-06-01T00:00:00.500Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-invoice-renewal-plus-500ms',
          user_id: 'user-renewal-plus-500ms',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_renewal_plus_500ms',
          stripe_subscription_id: 'sub_renewal_plus_500ms',
          stripe_customer_id: 'cus_renewal_plus_500ms',
          stripe_price_id: 'price_pro_monthly',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-01T00:00:01.000Z',
          created_at: '2026-06-01T00:00:01.000Z',
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        },
      ],
      profiles: [{
        id: 'user-renewal-plus-500ms',
        membership_level: 'pro',
        credits: 321,
      }],
      user_subscriptions: [{
        id: 'subscription-renewal-plus-500ms',
        user_id: 'user-renewal-plus-500ms',
        membership_plan_id: 'plan-pro-monthly',
        stripe_subscription_id: 'sub_renewal_plus_500ms',
        stripe_customer_id: 'cus_renewal_plus_500ms',
        stripe_price_id: 'price_pro_monthly',
        billing_cycle: 'monthly',
        status: 'active',
      }],
    }, {
      beforeExecute({ table, mode, filters }) {
        if (table === 'payment_orders' && mode === 'select'
          && filters.some((filter) => filter.column === 'stripe_checkout_session_id')) {
          residualLockLookupCount += 1;
        }
      },
    });

    const input = {
      amountTotal: 990,
      expectedSourcePriceId: 'price_pro_monthly',
      excludeSubscriptionPlanChangeSources: true,
      invoiceId: 'in_renewal_plus_500ms',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      subscriptionId: 'sub_renewal_plus_500ms',
      now: '2026-06-01T00:00:02.000Z',
    } as const;

    const first = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);
    const second = await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, input);

    expect(first).toMatchObject({ alreadyFulfilled: true, grantedCredits: 0 });
    expect(second).toMatchObject({ alreadyFulfilled: true, grantedCredits: 0 });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-renewal-plus-500ms-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_renewal_plus_500ms',
      status: 'pending',
      payment_status: 'active',
      fulfilled_at: null,
    });
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      membership_plan_id: 'plan-pro-monthly',
      stripe_price_id: 'price_pro_monthly',
    });
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'pro',
      credits: 321,
    });
    expect(residualLockLookupCount).toBe(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('does not release a same-timestamp plan-change lock during ordinary fulfilled renewal replay', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-renewal-same-time-lock',
          user_id: 'user-renewal-same-time',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_renewal_same_time',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_renewal_same_time',
          status: 'pending',
          payment_status: 'active',
          fulfilled_at: null,
          created_at: '2026-06-01T00:00:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-invoice-renewal-same-time',
          user_id: 'user-renewal-same-time',
          item_id: 'plan-pro-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_renewal_same_time',
          stripe_subscription_id: 'sub_renewal_same_time',
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

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 990,
      invoiceId: 'in_renewal_same_time',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      subscriptionId: 'sub_renewal_same_time',
      now: '2026-06-01T00:00:02.000Z',
    });

    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-renewal-same-time-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_renewal_same_time',
      status: 'pending',
      payment_status: 'active',
      fulfilled_at: null,
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('does not release a different pending plan-change lock during exact upgrade invoice replay', async () => {
    const supabase = createMockSupabase({
      payment_orders: [
        {
          id: 'order-source-different-upgrade-lock',
          user_id: 'user-different-upgrade-lock',
          item_id: 'plan-gold-yearly',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_different_upgrade_lock',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_different_upgrade_lock',
          status: 'pending',
          payment_status: 'active',
          fulfilled_at: null,
          created_at: '2026-06-01T00:00:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-invoice-different-upgrade-lock',
          user_id: 'user-different-upgrade-lock',
          item_id: 'plan-gold-monthly',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_different_upgrade_lock',
          stripe_subscription_id: 'sub_different_upgrade_lock',
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

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 1990,
      expectedSourceOrderId: 'order-source-original-upgrade',
      invoiceId: 'in_different_upgrade_lock',
      invoiceCreatedAt: '2026-06-01T00:00:00.000Z',
      paymentStatus: 'paid',
      subscriptionId: 'sub_different_upgrade_lock',
      now: '2026-06-01T00:00:02.000Z',
    });

    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-source-different-upgrade-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_different_upgrade_lock',
      status: 'pending',
      payment_status: 'active',
      fulfilled_at: null,
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
      stage: 'subscription_invoice_credit_grant_admission',
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

  it('clamps UTC calendar month arithmetic to end of month', () => {
    const anchor = new Date('2026-01-31T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(anchor, 0).toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(anchor, 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(anchor, 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(anchor, 3).toISOString()).toBe('2026-04-30T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(anchor, 12).toISOString()).toBe('2027-01-31T00:00:00.000Z');
  });

  it('uses February 29 in leap years when clamping', () => {
    expect(addUtcCalendarMonthsClamped(new Date('2028-01-31T00:00:00.000Z'), 1).toISOString())
      .toBe('2028-02-29T00:00:00.000Z');
    expect(addUtcCalendarMonthsClamped(new Date('2027-08-31T00:00:00.000Z'), 6).toISOString())
      .toBe('2028-02-29T00:00:00.000Z');
  });

  it('preserves anchor time of day and rejects invalid offsets', () => {
    expect(addUtcCalendarMonthsClamped(new Date('2026-01-31T09:30:15.500Z'), 1).toISOString())
      .toBe('2026-02-28T09:30:15.500Z');
    expect(() => addUtcCalendarMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), -1)).toThrow();
    expect(() => addUtcCalendarMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 1.5)).toThrow();
  });

  it('builds calendar-month annual periods keyed by term start', () => {
    const periods = getDueAnnualGrantPeriods({
      yearlyCredits: 1200,
      stripeSubscriptionId: 'sub_calendar',
      currentPeriodStart: '2026-01-31T00:00:00.000Z',
      currentPeriodEnd: '2027-01-31T00:00:00.000Z',
      now: new Date('2026-02-28T00:00:00.000Z'),
    });

    expect(periods.map((period) => period.periodIndex)).toEqual([1, 2]);
    expect(periods[0]).toMatchObject({
      periodStart: '2026-01-31T00:00:00.000Z',
      periodEnd: '2026-02-28T00:00:00.000Z',
      grantPeriodKey: 'annual:2026-01-31T00:00:00.000Z:01',
    });
    expect(periods[1]).toMatchObject({
      periodStart: '2026-02-28T00:00:00.000Z',
      periodEnd: '2026-03-31T00:00:00.000Z',
      grantPeriodKey: 'annual:2026-01-31T00:00:00.000Z:02',
    });
  });

  it('computes every annual period from the original anchor and ends period 12 at the Stripe period end', () => {
    const periods = getDueAnnualGrantPeriods({
      yearlyCredits: 1200,
      stripeSubscriptionId: 'sub_calendar_full',
      currentPeriodStart: '2026-01-31T00:00:00.000Z',
      currentPeriodEnd: '2027-01-31T00:00:00.000Z',
      now: new Date('2027-02-01T00:00:00.000Z'),
    });

    expect(periods).toHaveLength(12);
    expect(periods.reduce((sum, period) => sum + period.creditsGranted, 0)).toBe(1200);
    expect(periods[2].periodStart).toBe('2026-03-31T00:00:00.000Z');
    expect(periods[3].periodStart).toBe('2026-04-30T00:00:00.000Z');
    expect(periods[11]).toMatchObject({
      periodIndex: 12,
      periodStart: '2026-12-31T00:00:00.000Z',
      periodEnd: '2027-01-31T00:00:00.000Z',
      grantPeriodKey: 'annual:2026-01-31T00:00:00.000Z:12',
    });
  });

  it('releases the first annual period immediately and only once per due month', () => {
    const immediate = getDueAnnualGrantPeriods({
      yearlyCredits: 1200,
      stripeSubscriptionId: 'sub_immediate',
      currentPeriodStart: '2026-05-15T00:00:00.000Z',
      currentPeriodEnd: '2027-05-15T00:00:00.000Z',
      now: new Date('2026-05-15T00:00:00.000Z'),
    });
    expect(immediate.map((period) => period.periodIndex)).toEqual([1]);

    const later = getDueAnnualGrantPeriods({
      yearlyCredits: 1200,
      stripeSubscriptionId: 'sub_immediate',
      currentPeriodStart: '2026-05-15T00:00:00.000Z',
      currentPeriodEnd: '2027-05-15T00:00:00.000Z',
      now: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(later.map((period) => period.periodIndex)).toEqual([1, 2, 3]);
  });

  it('does not duplicate the first annual period when cron runs after the invoice webhook already granted it', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-webhook-cron-once',
        user_id: 'user-webhook-cron-once',
        item_id: 'plan-webhook-cron-once',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_cron_once',
        stripe_customer_id: 'cus_webhook_cron_once',
        stripe_price_id: 'price_webhook_cron_once',
        status: 'completed',
        payment_status: 'paid',
        created_at: '2026-01-31T00:00:00.000Z',
      }],
      membership_plans: [{
        id: 'plan-webhook-cron-once',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 1200,
      }],
      profiles: [{
        id: 'user-webhook-cron-once',
        membership_level: 'free',
        credits: 0,
      }],
    });

    await fulfillMembershipInvoiceWithSubscriptionCreditGrants(supabase, {
      amountTotal: 9900,
      currency: 'usd',
      invoiceId: 'in_webhook_cron_once',
      invoiceCreatedAt: '2026-01-31T00:00:00.000Z',
      paymentStatus: 'paid',
      periodStart: '2026-01-31T00:00:00Z',
      periodEnd: '2027-01-31T00:00:00Z',
      stripeCustomerId: 'cus_webhook_cron_once',
      subscriptionId: 'sub_webhook_cron_once',
      now: '2026-01-31T00:00:01.000Z',
    });

    const release = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-01-31T00:05:00.000Z'),
    });

    expect(release.releasedGrantCount).toBe(0);
    expect(release.releasedCredits).toBe(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      period_index: 1,
      grant_period_key: 'annual:2026-01-31T00:00:00.000Z:01',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
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

  it('does not release future annual credits while any legacy grant accounting is under review', async () => {
    const supabase = createMockSupabase({
      user_subscriptions: [{
        id: 'subscription-accounting-review',
        user_id: 'user-accounting-review',
        membership_plan_id: 'plan-accounting-review',
        stripe_subscription_id: 'sub_accounting_review',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_accounting_review' },
      }],
      membership_plans: [{
        id: 'plan-accounting-review',
        name: 'Gold',
        yearly_credits: 120,
      }],
      subscription_credit_grants: [{
        id: 'grant-accounting-review',
        user_id: 'user-accounting-review',
        membership_plan_id: 'plan-accounting-review',
        stripe_subscription_id: 'sub_accounting_review',
        stripe_invoice_id: 'in_accounting_review',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-02-01T00:00:00.000Z',
        period_index: 1,
        total_periods: 12,
        credits_granted: 10,
        consumed_amount: 0,
        accounting_state: 'review_required',
        accounting_review_reason: 'legacy_consumption_unproven',
        status: 'granted',
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
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('blocks a stale annual cron snapshot after refund termination commits before grant admission', async () => {
    let terminationCommitted = false;
    const supabase = createMockSupabase({
      user_subscriptions: [{
        id: 'subscription-annual-toctou',
        user_id: 'user-annual-toctou',
        membership_plan_id: 'plan-annual-toctou',
        stripe_subscription_id: 'sub_annual_toctou',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_annual_toctou' },
      }],
      membership_plans: [{
        id: 'plan-annual-toctou',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-annual-toctou',
        credits: 0,
      }],
    }, {
      beforeExecute: ({ table, mode, tables }) => {
        if (!terminationCommitted && table === 'membership_plans' && mode === 'select') {
          terminationCommitted = true;
          tables.user_subscriptions[0].credit_release_terminated_at = '2026-03-15T00:00:00.000Z';
        }
      },
    });

    const result = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      scannedSubscriptions: 1,
      releasedGrantCount: 0,
      releasedCredits: 0,
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
  });

  it('keeps an annual grant and ledger row together before a later refund observes it', async () => {
    const supabase = createMockSupabase({
      payment_orders: [{
        id: 'order-annual-toctou-refund',
        user_id: 'user-annual-toctou-refund',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_annual_toctou_refund',
        stripe_invoice_id: 'in_annual_toctou_refund',
        status: 'completed',
        payment_status: 'paid',
        amount_total: 9900,
        currency: 'usd',
      }],
      user_subscriptions: [{
        id: 'subscription-annual-toctou-refund',
        user_id: 'user-annual-toctou-refund',
        membership_plan_id: 'plan-annual-toctou-refund',
        stripe_subscription_id: 'sub_annual_toctou_refund',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_annual_toctou_refund' },
      }],
      membership_plans: [{
        id: 'plan-annual-toctou-refund',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-annual-toctou-refund',
        credits: 10,
      }],
    });

    const release = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-01-15T00:00:00.000Z'),
    });

    expect(release).toMatchObject({
      releasedGrantCount: 1,
      releasedCredits: 10,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0].credit_transaction_id)
      .toBe(supabase.tables.credit_transactions[0].id);

    const refund = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-annual-toctou-refund',
      subscriptionId: 'sub_annual_toctou_refund',
      refundId: 're_annual_toctou_refund',
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 9900,
      refundCurrency: 'usd',
      invoiceId: 'in_annual_toctou_refund',
      isFullRefund: true,
      eventId: 'evt_annual_toctou_refund',
      refundCreatedAt: '2026-01-20T00:00:00.000Z',
      now: '2026-01-20T00:00:01.000Z',
    });

    expect(refund).toMatchObject({
      reviewRequired: false,
      reversedGrantCount: 1,
      clawbackAmount: 10,
      appliedClawbackAmount: 10,
    });
    expect(supabase.tables.profiles[0].credits).toBe(10);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('reversed');
  });

  it('continues annual release before current_period_end for a normal cancel', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      now: new Date('2026-08-01T00:00:00.000Z'),
    })).toBe(true);
  });

  it('stops annual release at current_period_end even while still active', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-08-01T00:00:00.000Z'),
    })).toBe(false);
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-07-01T00:00:00.000Z'),
    })).toBe(false);
  });

  it('stops annual release after canceled subscription passes current_period_end', () => {
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'canceled',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-08-01T00:00:00.000Z'),
    })).toBe(false);
  });

  it('does not release annual credits for canceled, refunded, or invalid subscription states', () => {
    for (const status of ['canceled', 'cancelled', 'refunded', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
      expect(shouldReleaseAnnualSubscriptionCredits({
        billingCycle: 'yearly',
        status,
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

  it('recovers REVIEW_REQUIRED evidence after an ambiguous DB-commit crash on same-event replay', async () => {
    const supabase = createRefundCrashRecoveryHarness();
    const input = {
      orderId: 'order-refund-crash-recovery',
      subscriptionId: 'sub_refund_crash_recovery',
      refundId: null,
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 1_000,
      refundCurrency: 'usd',
      invoiceId: 'in_refund_crash_recovery',
      isFullRefund: true,
      eventId: 'evt-refund-crash-ambiguous',
      refundCreatedAt: null,
      refundIdentityAmbiguous: true,
      terminationReviewReason: 'ambiguous_charge_refunded_refund_identity',
      now: '2026-01-20T00:00:01.000Z',
    } as const;

    await expect(reconcileSubscriptionRefundCreditGrants(supabase, input))
      .rejects.toThrow('simulated post-rpc payment-order crash');
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_at: '2026-01-20T00:00:01.000Z',
      credit_release_terminated_reason: 'stripe_refund:charge.refunded',
      credit_release_terminated_event_id: input.eventId,
      credit_release_terminated_period_key: null,
    });
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toBeUndefined();

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...input,
      now: '2026-01-20T00:05:01.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: true,
      reviewReason: 'ambiguous_charge_refunded_refund_identity',
      terminationWritten: false,
      terminatedAt: '2026-01-20T00:00:01.000Z',
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      reversedGrantCount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0].credits).toBe(100);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toMatchObject({
        reviewRequired: true,
        reviewReason: 'ambiguous_charge_refunded_refund_identity',
        reversalStatus: 'review_required',
        termination: {
          written: true,
          terminatedAt: '2026-01-20T00:00:01.000Z',
          reason: 'stripe_refund:charge.refunded',
          eventId: input.eventId,
        },
      });
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal.reversalStatus)
      .not.toBe('pending');
    expect(shouldReleaseAnnualSubscriptionCredits({
      billingCycle: 'yearly',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      creditReleaseTerminatedAt: supabase.tables.user_subscriptions[0].credit_release_terminated_at,
      now: new Date('2026-02-15T00:00:00.000Z'),
    })).toBe(false);
  });

  it('does not let a different precise event claim evidence after an ambiguous DB-commit crash', async () => {
    const supabase = createRefundCrashRecoveryHarness();
    await expect(reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-refund-crash-recovery',
      subscriptionId: 'sub_refund_crash_recovery',
      refundId: null,
      refundEventType: 'charge.refunded',
      refundStatus: 'succeeded',
      refundAmount: 1_000,
      refundCurrency: 'usd',
      invoiceId: 'in_refund_crash_recovery',
      isFullRefund: true,
      eventId: 'evt-refund-crash-ambiguous-owner',
      refundCreatedAt: null,
      refundIdentityAmbiguous: true,
      terminationReviewReason: 'ambiguous_charge_refunded_refund_identity',
      now: '2026-01-20T00:00:01.000Z',
    }))
      .rejects.toThrow('simulated post-rpc payment-order crash');

    const laterPrecise = await reconcileSubscriptionRefundCreditGrants(supabase, {
      orderId: 'order-refund-crash-recovery',
      subscriptionId: 'sub_refund_crash_recovery',
      refundId: 're-refund-crash-different-precise',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 1_000,
      refundCurrency: 'usd',
      invoiceId: 'in_refund_crash_recovery',
      isFullRefund: true,
      eventId: 'evt-refund-crash-different-precise',
      refundCreatedAt: '2026-01-20T00:00:00.000Z',
      now: '2026-01-20T00:06:01.000Z',
    });

    expect(laterPrecise).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: true,
      reviewReason: 'first_event_reconciliation_evidence_missing',
      terminationWritten: false,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      reversedGrantCount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_event_id: 'evt-refund-crash-ambiguous-owner',
      credit_release_terminated_reason: 'stripe_refund:charge.refunded',
    });
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0].credits).toBe(100);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toBeUndefined();
  });

  it('fails closed when a precise owner crashes before evidence and a different ambiguous event arrives', async () => {
    const supabase = createRefundCrashRecoveryHarness();
    const preciseInput = {
      orderId: 'order-refund-crash-recovery',
      subscriptionId: 'sub_refund_crash_recovery',
      refundId: 're-refund-crash-precise-owner',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 1_000,
      refundCurrency: 'usd',
      invoiceId: 'in_refund_crash_recovery',
      isFullRefund: true,
      eventId: 'evt-refund-crash-precise-owner',
      refundCreatedAt: '2026-01-20T00:00:00.000Z',
      now: '2026-01-20T00:00:01.000Z',
    } as const;

    await expect(reconcileSubscriptionRefundCreditGrants(supabase, preciseInput))
      .rejects.toThrow('simulated post-rpc payment-order crash');

    const laterAmbiguous = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...preciseInput,
      refundId: null,
      refundEventType: 'charge.refunded',
      eventId: 'evt-refund-crash-different-ambiguous',
      refundCreatedAt: null,
      refundIdentityAmbiguous: true,
      terminationReviewReason: 'ambiguous_charge_refunded_refund_identity',
      now: '2026-01-20T00:06:01.000Z',
    });

    expect(laterAmbiguous).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: true,
      reviewReason: 'first_event_reconciliation_evidence_missing',
      terminationWritten: false,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      reversedGrantCount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.user_subscriptions[0].credit_release_terminated_event_id)
      .toBe(preciseInput.eventId);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toBeUndefined();
  });

  it('recovers complete precise evidence after a precise DB-commit crash on same-event replay', async () => {
    const supabase = createRefundCrashRecoveryHarness();
    const input = {
      orderId: 'order-refund-crash-recovery',
      subscriptionId: 'sub_refund_crash_recovery',
      refundId: 're-refund-crash-precise',
      refundEventType: 'refund.created',
      refundStatus: 'succeeded',
      refundAmount: 1_000,
      refundCurrency: 'usd',
      invoiceId: 'in_refund_crash_recovery',
      isFullRefund: true,
      eventId: 'evt-refund-crash-precise',
      refundCreatedAt: '2026-01-20T00:00:00.000Z',
      now: '2026-01-20T00:00:01.000Z',
    } as const;

    await expect(reconcileSubscriptionRefundCreditGrants(supabase, input))
      .rejects.toThrow('simulated post-rpc payment-order crash');
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_at: input.now,
      credit_release_terminated_event_id: input.eventId,
      credit_release_terminated_reason: 'stripe_refund:refund.created',
      credit_release_terminated_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
    });
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('reversed');
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(94);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toBeUndefined();

    const replay = await reconcileSubscriptionRefundCreditGrants(supabase, {
      ...input,
      now: '2026-01-20T00:05:01.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: false,
      reviewReason: null,
      terminationWritten: false,
      terminatedAt: input.now,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:01',
      clawbackAmount: 6,
      appliedClawbackAmount: 6,
      shortfallAmount: 0,
      reversedGrantCount: 1,
      creditTransactionId: 'txn-refund-clawback-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(94);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal)
      .toMatchObject({
        reviewRequired: false,
        reversalStatus: 'complete',
        termination: {
          written: true,
          terminatedAt: input.now,
          reason: 'stripe_refund:refund.created',
          eventId: input.eventId,
        },
      });
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal.reversalStatus)
      .not.toBe('pending');
  });

  it('claws back the located period as granted minus consumed on full refund and keeps the clawback out of spend', async () => {
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
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: periodIndex === 3 ? 4 : 10,
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
      eventId: 'evt_subscription_full',
      refundCreatedAt: '2026-03-15T00:00:00.000Z',
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: false,
      terminationWritten: true,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:03',
      reversedGrantCount: 1,
      clawbackAmount: 6,
      appliedClawbackAmount: 6,
      shortfallAmount: 0,
      creditTransactionId: 'txn-refund-clawback-1',
      alreadyReconciled: false,
    });
    expect(supabase.tables.profiles[0].credits).toBe(94);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_at: '2026-04-01T00:00:00.000Z',
      credit_release_terminated_reason: 'stripe_refund:refund.created',
      credit_release_terminated_event_id: 'evt_subscription_full',
      credit_release_terminated_period_key: 'annual:2026-01-01T00:00:00.000Z:03',
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      id: 'order-subscription-refund',
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          fullRefund: true,
          reviewRequired: false,
          clawbackAmount: 6,
          reversedGrantCount: 1,
          creditTransactionId: 'txn-refund-clawback-1',
          locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:03',
          idempotencyKey: 'stripe_refund:subscription_grants:event:evt_subscription_full:sub:sub_subscription_refund:period:annual:2026-01-01T00:00:00.000Z:03',
        }),
      },
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -6,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_type: 'stripe_refund',
      source_id: 're_subscription_full',
      source_refund_id: 're_subscription_full',
      source_order_id: 'order-subscription-refund',
      idempotency_key: 'stripe_refund:subscription_grants:event:evt_subscription_full:sub:sub_subscription_refund:period:annual:2026-01-01T00:00:00.000Z:03',
    });
    expect(countsAsCreditSpend(supabase.tables.credit_transactions[0])).toBe(false);
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'granted',
      'granted',
      'reversed',
    ]);
    expect(supabase.tables.subscription_credit_grants[2].metadata.reversal).toMatchObject({
      refundId: 're_subscription_full',
      periodKey: 'annual:2026-01-01T00:00:00.000Z:03',
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
      eventId: 'evt_subscription_full_later',
      refundCreatedAt: '2026-03-15T00:00:00.000Z',
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      clawbackAmount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_subscription_full',
      eventType: 'refund.created',
      reversedGrantCount: 1,
      clawbackAmount: 6,
      reviewRequired: false,
      idempotencyKey: 'stripe_refund:subscription_grants:event:evt_subscription_full:sub:sub_subscription_refund:period:annual:2026-01-01T00:00:00.000Z:03',
    });
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
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: 0,
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
      eventId: 'evt_subscription_shortfall',
      refundCreatedAt: '2026-03-15T00:00:00.000Z',
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: true,
      terminationWritten: true,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:03',
      reversedGrantCount: 1,
      clawbackAmount: 10,
      appliedClawbackAmount: 5,
      shortfallAmount: 5,
      creditTransactionId: 'txn-refund-clawback-1',
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
          clawbackAmount: 10,
          appliedClawbackAmount: 5,
          shortfallAmount: 5,
          shortfallReason: 'insufficient_balance',
          reversedGrantCount: 1,
          creditTransactionId: 'txn-refund-clawback-1',
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
        requiredClawbackAmount: 10,
        shortfallAmount: 5,
      }),
    });
    expect(countsAsCreditSpend(supabase.tables.credit_transactions[0])).toBe(false);
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'granted',
      'granted',
      'reversed',
    ]);
    expect(supabase.tables.subscription_credit_grants[2].metadata.reversal).toMatchObject({
      refundId: 're_subscription_shortfall',
      periodKey: 'annual:2026-01-01T00:00:00.000Z:03',
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
      eventId: 'evt_subscription_shortfall_later',
      refundCreatedAt: '2026-03-15T00:00:00.000Z',
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(replay).toMatchObject({
      alreadyReconciled: true,
      reviewRequired: true,
      reviewReason: null,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_subscription_shortfall',
      eventType: 'refund.created',
      reversedGrantCount: 1,
      shortfallAmount: 5,
      reversalStatus: 'shortfall_review_required',
      idempotencyKey: 'stripe_refund:subscription_grants:event:evt_subscription_shortfall:sub:sub_subscription_refund_shortfall:period:annual:2026-01-01T00:00:00.000Z:03',
    });
  });

  it('resumes a pending full refund whose located period was already reversed without re-deducting', async () => {
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
      user_subscriptions: [{
        id: 'subscription-refund-pending',
        user_id: 'user-subscription-refund-pending',
        membership_plan_id: 'plan-subscription-refund-pending',
        stripe_subscription_id: 'sub_subscription_refund_pending',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
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
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: 0,
        status: 'reversed',
        metadata: {
          sourceType: 'stripe_invoice',
          reversal: {
            invoiceId: 'in_subscription_refund_pending',
            idempotencyKey: invoiceScopedKey,
            clawbackAmount: 20,
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
      eventId: 'evt_subscription_refund_pending_later',
      refundCreatedAt: '2026-02-15T00:00:00.000Z',
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: false,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:02',
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0].credits).toBe(80);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_subscription_refund_pending_later_event',
          eventType: 'charge.refunded',
          fullRefund: true,
          reviewRequired: false,
          reversedGrantCount: 0,
          clawbackAmount: 0,
          appliedClawbackAmount: 0,
          shortfallAmount: 0,
          creditTransactionId: null,
          idempotencyKey: 'stripe_refund:subscription_grants:event:evt_subscription_refund_pending_later:sub:sub_subscription_refund_pending:period:annual:2026-01-01T00:00:00.000Z:02',
          alreadyReversed: true,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
    ]);
    expect(supabase.tables.subscription_credit_grants.map((grant) =>
      grant.metadata.reversal.idempotencyKey,
    )).toEqual([invoiceScopedKey, invoiceScopedKey]);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_reason: 'stripe_refund:charge.refunded',
    });
  });

  it('finishes a pending full refund without re-deducting when the located period was already reversed under legacy metadata', async () => {
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
      user_subscriptions: [{
        id: 'subscription-refund-legacy',
        user_id: 'user-subscription-refund-legacy',
        membership_plan_id: 'plan-subscription-refund-legacy',
        stripe_subscription_id: 'sub_subscription_refund_legacy',
        billing_cycle: 'yearly',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
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
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: 0,
        status: 'reversed',
        metadata: {
          sourceType: 'stripe_invoice',
          reversal: {
            invoiceId: 'in_subscription_refund_legacy',
            idempotencyKey: legacyRefundKey,
            clawbackAmount: 20,
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
      eventId: 'evt_subscription_refund_legacy_later',
      refundCreatedAt: '2026-02-15T00:00:00.000Z',
      now: '2026-04-01T00:05:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: false,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:02',
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
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
          reviewRequired: false,
          clawbackAmount: 0,
          appliedClawbackAmount: 0,
          shortfallAmount: 0,
          creditTransactionId: null,
          idempotencyKey: 'stripe_refund:subscription_grants:event:evt_subscription_refund_legacy_later:sub:sub_subscription_refund_legacy:period:annual:2026-01-01T00:00:00.000Z:02',
          alreadyReconciled: true,
          alreadyReversed: true,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) =>
      grant.metadata.reversal.idempotencyKey,
    )).toEqual([legacyRefundKey, legacyRefundKey]);
  });

  it('limits full-refund reversal to the period located by the trusted refund timestamp', async () => {
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
          grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
          period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
          period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
          period_index: periodIndex,
          credits_granted: 10,
          consumed_amount: 10,
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
          grant_period_key: `annual:2027-01-01T00:00:00.000Z:0${periodIndex}`,
          period_start: `2027-0${periodIndex}-01T00:00:00.000Z`,
          period_end: `2027-0${periodIndex + 1}-01T00:00:00.000Z`,
          period_index: periodIndex,
          credits_granted: 10,
          consumed_amount: 5,
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
      eventId: 'evt_subscription_renewal_full',
      refundCreatedAt: '2027-02-15T00:00:00.000Z',
      now: '2027-03-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      fullRefund: true,
      reviewRequired: false,
      locatedPeriodKey: 'annual:2027-01-01T00:00:00.000Z:02',
      reversedGrantCount: 1,
      clawbackAmount: 5,
      appliedClawbackAmount: 5,
      shortfallAmount: 0,
      creditTransactionId: 'txn-refund-clawback-1',
    });
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_subscription_refund_2026')
      .map((grant) => grant.status)).toEqual(['granted', 'granted', 'granted']);
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_subscription_refund_2027')
      .map((grant) => grant.status)).toEqual(['granted', 'reversed']);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -5,
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
      metadata: expect.objectContaining({
        invoiceId: 'in_subscription_refund_2027',
        requiredClawbackAmount: 5,
        reversedGrantCount: 1,
        reversedGrantPeriodKeys: ['annual:2027-01-01T00:00:00.000Z:02'],
      }),
    });
    expect(supabase.tables.subscription_credit_grants
      .find((grant) => grant.id === 'grant-refund-2026-1')?.metadata.reversal).toBeUndefined();
    expect(supabase.tables.subscription_credit_grants
      .find((grant) => grant.id === 'grant-refund-2027-1')?.metadata.reversal).toBeUndefined();
    expect(supabase.tables.subscription_credit_grants
      .find((grant) => grant.id === 'grant-refund-2027-2')?.metadata.reversal).toMatchObject({
        periodKey: 'annual:2027-01-01T00:00:00.000Z:02',
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
      user_subscriptions: [{
        id: 'subscription-partial-refund',
        user_id: 'user-subscription-partial-refund',
        membership_plan_id: 'plan-subscription-partial-refund',
        stripe_subscription_id: 'sub_subscription_partial_refund',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
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
