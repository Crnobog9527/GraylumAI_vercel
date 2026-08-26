/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerState = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  logger: loggerState,
}));

import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  fulfillPaidMembershipCheckoutSession,
  markMembershipInvoicePaymentFailed,
  reconcileStripeRefund,
  reconcileSubscriptionRefundFromStripeWebhook,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '../stripeFulfillment';
import { releaseDueAnnualSubscriptionCredits } from '../subscriptionCreditGrants';

type RefundWebhookTableName =
  | 'payment_orders'
  | 'membership_plans'
  | 'subscription_credit_grants'
  | 'credit_transactions'
  | 'user_subscriptions'
  | 'profiles';
type RefundWebhookRow = Record<string, any>;

class RefundWebhookMockQuery {
  private filters: Array<{ column: string; value: unknown; operator: 'eq' | 'neq' | 'lte' | 'like' | 'is' }> = [];
  private containsFilters: Array<{ column: string; value: unknown }> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: RefundWebhookRow | null = null;
  private limitValue: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly tables: Record<RefundWebhookTableName, RefundWebhookRow[]>,
    private readonly table: RefundWebhookTableName,
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

  like(column: string, value: unknown) {
    this.filters.push({ column, value, operator: 'like' });
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

  update(payload: RefundWebhookRow) {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  insert(payload: RefundWebhookRow) {
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
      return { data: rows[0] ?? null, error: null };
    }

    const rows = this.matchingRows();
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = { data: RefundWebhookRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: RefundWebhookRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
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

        if (operator === 'lte') {
          return row[column] <= value;
        }

        if (operator === 'like') {
          const pattern = String(value).replace(/%/g, '');
          return typeof row[column] === 'string' && row[column].startsWith(pattern);
        }

        if (value === null) {
          return row[column] === null || row[column] === undefined;
        }

        return row[column] === value;
      })
      && this.containsFilters.every(({ column, value }) =>
        refundWebhookContainsValue(row[column], value),
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

function refundWebhookContainsValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return false;
    }

    return Object.entries(expected as RefundWebhookRow).every(([key, value]) =>
      refundWebhookContainsValue((actual as RefundWebhookRow)[key], value),
    );
  }

  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.every((value) => (actual as unknown[]).some((item) => refundWebhookContainsValue(item, value)));
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
  tables: Record<RefundWebhookTableName, RefundWebhookRow[]>,
  payload: RefundWebhookRow,
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
      return {
        data: [{
          transaction_id: existing.id,
          balance_after: existing.balance_after ?? 0,
          clawback_amount: 0,
          applied_clawback_amount: Math.abs(Number(existing.amount ?? 0)),
          shortfall_amount: 0,
          already_applied: true,
          termination_written: false,
          already_terminated: false,
          grant_reversed: false,
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

  const baseRow = (extra: RefundWebhookRow = {}) => ({
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
      id: `txn-refund-webhook-${tables.credit_transactions.length + 1}`,
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

function createRefundWebhookSupabase(seed: Partial<Record<RefundWebhookTableName, RefundWebhookRow[]>> = {}) {
  const tables: Record<RefundWebhookTableName, RefundWebhookRow[]> = {
    payment_orders: seed.payment_orders ?? [],
    membership_plans: seed.membership_plans ?? [],
    subscription_credit_grants: seed.subscription_credit_grants ?? [],
    credit_transactions: seed.credit_transactions ?? [],
    user_subscriptions: seed.user_subscriptions ?? [],
    profiles: seed.profiles ?? [],
  };

  const supabase = {
    tables,
    from(table: RefundWebhookTableName) {
      return new RefundWebhookMockQuery(tables, table);
    },
    async rpc(name: string, payload: RefundWebhookRow) {
      if (name === 'atomic_refund_termination_clawback') {
        return applyRefundTerminationClawbackContract(tables, payload);
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

      const profile = tables.profiles.find((row) => row.id === payload.p_user_id);
      const balanceBefore = typeof profile?.credits === 'number' ? profile.credits : Number(profile?.credits ?? 0);
      const balanceAfter = balanceBefore + payload.p_amount;
      if (balanceAfter < 0) {
        return {
          data: null,
          error: { message: 'insufficient credits' },
        };
      }

      const transaction = {
        id: `txn-refund-webhook-${tables.credit_transactions.length + 1}`,
        user_id: payload.p_user_id,
        amount: payload.p_amount,
        type: payload.p_type,
        description: payload.p_description,
        idempotency_key: payload.p_idempotency_key,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
      if (profile) {
        profile.credits = balanceAfter;
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

function makeGenericRefundSupabase(options: {
  match: { column: string; value: string };
  order?: { id: string; amount_total: number | string | null; metadata: Record<string, unknown> | null };
  rpcData?: unknown[];
}) {
  const order = options.order ?? {
    id: '00000000-0000-4000-8000-000000000100',
    amount_total: 990,
    metadata: { grantedCredits: 100 },
  };
  const lookups: Array<{ table: string; column: string; value: unknown }> = [];
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcData ?? [
      {
        order_id: order.id,
        user_id: '00000000-0000-4000-8000-000000000101',
        order_status: 'refunded',
        clawback_amount: 100,
        shortfall_amount: 0,
        transaction_id: '00000000-0000-4000-8000-000000000102',
        already_reconciled: false,
      },
    ],
    error: null,
  });

  const matchesMetadata = (marker: Record<string, unknown>) =>
    Object.entries(marker).every(([key, value]) => order.metadata?.[key] === value);

  const supabase = {
    rpc,
    from(table: string) {
      if (table !== 'payment_orders') {
        throw new Error(`Refund reconciliation should not touch ${table}`);
      }

      let lookup: { column: string; value: unknown } | null = null;
      let marker: Record<string, unknown> | null = null;

      const match = () => {
        if (marker) {
          return matchesMetadata(marker);
        }

        return lookup?.column === options.match.column && lookup.value === options.match.value;
      };

      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          lookup = { column, value };
          lookups.push({ table, column, value });
          return this;
        },
        contains(column: string, value: Record<string, unknown>) {
          marker = value;
          lookups.push({ table, column, value });
          return this;
        },
        limit() {
          return Promise.resolve({
            data: match() ? [order] : [],
            error: null,
          });
        },
        maybeSingle() {
          return Promise.resolve({
            data: match() ? order : null,
            error: null,
          });
        },
      };
    },
  };

  return { lookups, order, rpc, supabase };
}

describe('stripe fulfillment helpers', () => {
  beforeEach(() => {
    loggerState.error.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
  });

  it('syncs subscription state deterministically when duplicate mirrors already exist', async () => {
    const supabase = createRefundWebhookSupabase({
      user_subscriptions: [
        {
          id: 'subscription-duplicate-a',
          user_id: 'user-duplicate-subscription',
          membership_plan_id: 'plan-duplicate-subscription',
          stripe_subscription_id: 'sub_duplicate_subscription',
          billing_cycle: 'yearly',
          status: 'active',
          cancel_at_period_end: 'false',
          created_at: '2026-07-04T00:00:01.000Z',
        },
        {
          id: 'subscription-duplicate-b',
          user_id: 'user-duplicate-subscription',
          membership_plan_id: 'plan-duplicate-subscription',
          stripe_subscription_id: 'sub_duplicate_subscription',
          billing_cycle: 'yearly',
          status: 'active',
          cancel_at_period_end: 'false',
          created_at: '2026-07-04T00:00:02.000Z',
        },
      ],
      profiles: [{
        id: 'user-duplicate-subscription',
        membership_level: 'gold',
      }],
    });
    const subscription = {
      id: 'sub_duplicate_subscription',
      status: 'active',
      cancel_at_period_end: true,
      items: {
        data: [{
          current_period_start: 1783123200,
          current_period_end: 1814659200,
        }],
      },
    } as unknown as Stripe.Subscription;

    await expect(syncSubscriptionState(supabase, subscription)).resolves.toBeUndefined();

    expect(supabase.tables.user_subscriptions).toHaveLength(2);
    expect(supabase.tables.user_subscriptions).toEqual([
      expect.objectContaining({
        id: 'subscription-duplicate-a',
        status: 'active',
        cancel_at_period_end: 'true',
      }),
      expect.objectContaining({
        id: 'subscription-duplicate-b',
        status: 'active',
        cancel_at_period_end: 'true',
      }),
    ]);
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'subscription_state_duplicate_mirror_detected',
      expect.objectContaining({
        subscriptionId: 'sub_dupl...iption',
        subscriptionCount: 2,
        canonicalSubscriptionId: 'subscrip...cate-a',
      }),
    );
  });

  it('skips credit package fulfillment when the checkout session is already fulfilled', async () => {
    const updates: Array<{ table: string; payload: unknown }> = [];

    const supabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              expect(column).toBe('stripe_checkout_session_id');
              expect(value).toBe('cs_test_credit_replay');
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'order-credit-1',
                  fulfilled_at: '2026-03-12T16:01:26.787Z',
                },
              });
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table access during replay: ${table}`);
      },
    };

    await fulfillCreditPackageOrder(
      supabase,
      {
        id: 'cs_test_credit_replay',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
        },
        client_reference_id: 'user-1',
        payment_status: 'paid',
        mode: 'payment',
      } as Stripe.Checkout.Session,
    );

    expect(updates).toEqual([]);
  });

  it('persists stripe_subscription_id while keeping paid checkout sessions pending until fulfillment', async () => {
    const updates: unknown[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'order-1' },
            });
          },
          update(payload: unknown) {
            updates.push(payload);
            return {
              eq() {
                return Promise.resolve({ error: null });
              },
            };
          },
          insert() {
            throw new Error('insert should not be called for an existing order');
          },
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_subscription',
        metadata: {
          userId: 'user-1',
          itemType: 'membership_plan',
          itemId: 'plan-1',
          billingCycle: 'monthly',
          priceId: 'price_test_monthly',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        subscription: {
          id: 'sub_test_123',
        },
        amount_total: 990,
        currency: 'usd',
        mode: 'subscription',
        payment_status: 'paid',
      } as Stripe.Checkout.Session,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        stripe_checkout_session_id: 'cs_test_subscription',
        stripe_customer_id: 'cus_test_123',
        stripe_subscription_id: 'sub_test_123',
        stripe_price_id: 'price_test_monthly',
        status: 'pending',
        payment_status: 'paid',
      }),
    );
  });

  it('fulfills a paid yearly membership checkout through subscription latest_invoice exactly once', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-source-paid-yearly-checkout',
        user_id: 'user-paid-yearly-checkout',
        item_id: 'plan-pro-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_paid_yearly_checkout',
        stripe_checkout_session_id: 'cs_test_paid_yearly_checkout',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_paid_yearly_checkout',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {
          source: 'checkout.session.sync',
        },
      }],
      membership_plans: [{
        id: 'plan-pro-yearly',
        name: 'Pro',
        level: 'pro',
        yearly_credits: 1200,
        monthly_credits: 100,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-paid-yearly-checkout',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const paidInvoice = {
      id: 'in_paid_yearly_checkout',
      status: 'paid',
      created: 1782627600,
      amount_paid: 9900,
      currency: 'usd',
      customer: 'cus_paid_yearly_checkout',
      period_start: 1782627600,
      period_end: 1814163600,
      parent: {
        subscription_details: {
          subscription: 'sub_paid_yearly_checkout',
        },
      },
    } as Stripe.Invoice;
    const subscription = {
      id: 'sub_paid_yearly_checkout',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: 'in_paid_yearly_checkout',
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(subscription),
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue(paidInvoice),
        list: vi.fn(),
      },
    };
    const session = {
      id: 'cs_test_paid_yearly_checkout',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-paid-yearly-checkout',
      metadata: {
        userId: 'user-paid-yearly-checkout',
        itemType: 'membership_plan',
        itemId: 'plan-pro-yearly',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_paid_yearly_checkout',
      subscription: 'sub_paid_yearly_checkout',
      invoice: null,
    } as Stripe.Checkout.Session;

    const firstResult = await fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session);
    const replayResult = await fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session);

    expect(firstResult).toMatchObject({
      fulfilled: true,
      invoiceId: 'in_paid_yearly_checkout',
      subscriptionId: 'sub_paid_yearly_checkout',
    });
    expect(replayResult).toMatchObject({
      fulfilled: true,
      invoiceId: 'in_paid_yearly_checkout',
      subscriptionId: 'sub_paid_yearly_checkout',
    });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_paid_yearly_checkout', {
      expand: ['latest_invoice'],
    });
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith('in_paid_yearly_checkout');
    expect(stripe.invoices.list).not.toHaveBeenCalled();

    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      user_id: 'user-paid-yearly-checkout',
      membership_plan_id: 'plan-pro-yearly',
      stripe_subscription_id: 'sub_paid_yearly_checkout',
      billing_cycle: 'yearly',
      status: 'active',
      metadata: expect.objectContaining({
        lastInvoiceId: 'in_paid_yearly_checkout',
        fulfillmentSource: 'subscription_credit_grants',
      }),
    });
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      user_id: 'user-paid-yearly-checkout',
      membership_plan_id: 'plan-pro-yearly',
      stripe_subscription_id: 'sub_paid_yearly_checkout',
      stripe_invoice_id: 'in_paid_yearly_checkout',
      billing_cycle: 'yearly',
      grant_type: 'annual_monthly_release',
      period_index: 1,
      total_periods: 12,
      credits_granted: 100,
      status: 'granted',
      idempotency_key: expect.stringContaining(
        'subscription_grant:annual_monthly_release:sub_paid_yearly_checkout:',
      ),
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      user_id: 'user-paid-yearly-checkout',
      amount: 100,
      ledger_type: 'grant',
      reason_code: 'annual_monthly_release',
      source_type: 'stripe_invoice',
      source_id: 'in_paid_yearly_checkout',
    });
    expect(supabase.tables.profiles[0]).toMatchObject({
      id: 'user-paid-yearly-checkout',
      membership_level: 'pro',
      credits: 200,
    });

    const checkoutOrder = supabase.tables.payment_orders.find((row) =>
      row.id === 'order-source-paid-yearly-checkout');
    expect(checkoutOrder).toMatchObject({
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: expect.any(String),
    });
    const invoiceOrders = supabase.tables.payment_orders.filter((row) =>
      row.stripe_invoice_id === 'in_paid_yearly_checkout');
    expect(invoiceOrders).toHaveLength(1);
    expect(invoiceOrders[0]).toMatchObject({
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: expect.any(String),
      metadata: expect.objectContaining({
        source: 'invoice.payment_succeeded',
        grantedCredits: 100,
      }),
    });
  });

  it('fulfills a paid yearly membership checkout through expanded subscription latest_invoice', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-expanded-latest-invoice',
        user_id: 'user-expanded-latest-invoice',
        item_id: 'plan-pro-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_expanded_latest_invoice',
        stripe_checkout_session_id: 'cs_test_expanded_latest_invoice',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_expanded_latest_invoice',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {},
      }],
      membership_plans: [{
        id: 'plan-pro-yearly',
        name: 'Pro',
        level: 'pro',
        yearly_credits: 1200,
      }],
      profiles: [{
        id: 'user-expanded-latest-invoice',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const paidInvoice = {
      id: 'in_expanded_latest_invoice',
      status: 'paid',
      created: 1782627600,
      amount_paid: 9900,
      currency: 'usd',
      customer: 'cus_expanded_latest_invoice',
      period_start: 1782627600,
      period_end: 1814163600,
      parent: {
        subscription_details: {
          subscription: 'sub_expanded_latest_invoice',
        },
      },
    } as Stripe.Invoice;
    const subscription = {
      id: 'sub_expanded_latest_invoice',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: paidInvoice,
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(),
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    const session = {
      id: 'cs_test_expanded_latest_invoice',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-expanded-latest-invoice',
      metadata: {
        userId: 'user-expanded-latest-invoice',
        itemType: 'membership_plan',
        itemId: 'plan-pro-yearly',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_expanded_latest_invoice',
      subscription,
      invoice: null,
    } as Stripe.Checkout.Session;

    await expect(
      fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session),
    ).resolves.toMatchObject({
      fulfilled: true,
      invoiceId: 'in_expanded_latest_invoice',
      subscriptionId: 'sub_expanded_latest_invoice',
    });

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(supabase.tables.user_subscriptions).toHaveLength(1);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(1);
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.profiles[0]).toMatchObject({
      membership_level: 'pro',
      credits: 200,
    });
  });

  it('fulfills a paid yearly membership checkout through invoice list fallback', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-invoice-list-fallback',
        user_id: 'user-invoice-list-fallback',
        item_id: 'plan-pro-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_invoice_list_fallback',
        stripe_checkout_session_id: 'cs_test_invoice_list_fallback',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_invoice_list_fallback',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {},
      }],
      membership_plans: [{
        id: 'plan-pro-yearly',
        name: 'Pro',
        level: 'pro',
        yearly_credits: 1200,
      }],
      profiles: [{
        id: 'user-invoice-list-fallback',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const paidInvoice = {
      id: 'in_invoice_list_fallback',
      status: 'paid',
      created: 1782627600,
      amount_paid: 9900,
      currency: 'usd',
      customer: 'cus_invoice_list_fallback',
      period_start: 1782627600,
      period_end: 1814163600,
      parent: {
        subscription_details: {
          subscription: 'sub_invoice_list_fallback',
        },
      },
    } as Stripe.Invoice;
    const subscription = {
      id: 'sub_invoice_list_fallback',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(subscription),
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'in_open_invoice_list_fallback', status: 'open' },
            paidInvoice,
          ],
        }),
      },
    };
    const session = {
      id: 'cs_test_invoice_list_fallback',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-invoice-list-fallback',
      metadata: {
        userId: 'user-invoice-list-fallback',
        itemType: 'membership_plan',
        itemId: 'plan-pro-yearly',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_invoice_list_fallback',
      subscription: 'sub_invoice_list_fallback',
      invoice: null,
    } as Stripe.Checkout.Session;

    await expect(
      fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session),
    ).resolves.toMatchObject({
      fulfilled: true,
      invoiceId: 'in_invoice_list_fallback',
      subscriptionId: 'sub_invoice_list_fallback',
    });

    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_invoice_list_fallback',
      limit: 10,
    });
    expect(supabase.tables.payment_orders.find((row) =>
      row.id === 'order-invoice-list-fallback')).toMatchObject({
      status: 'completed',
      fulfilled_at: expect.any(String),
    });
  });

  it('records an auditable reason when a paid checkout has no invoice to fulfill', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-missing-paid-invoice',
        user_id: 'user-missing-paid-invoice',
        item_id: 'plan-pro-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_missing_paid_invoice',
        stripe_checkout_session_id: 'cs_test_missing_paid_invoice',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_missing_paid_invoice',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {
          source: 'checkout.session.sync',
        },
      }],
      profiles: [{
        id: 'user-missing-paid-invoice',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const subscription = {
      id: 'sub_missing_paid_invoice',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(subscription),
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const session = {
      id: 'cs_test_missing_paid_invoice',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-missing-paid-invoice',
      metadata: {
        userId: 'user-missing-paid-invoice',
        itemType: 'membership_plan',
        itemId: 'plan-pro-yearly',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_missing_paid_invoice',
      subscription: 'sub_missing_paid_invoice',
      invoice: null,
    } as Stripe.Checkout.Session;

    await expect(
      fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session),
    ).rejects.toMatchObject({
      stage: 'checkout_paid_invoice_resolution',
      safeContext: expect.objectContaining({
        reason: 'paid_invoice_missing',
        invoiceListCount: 0,
      }),
    });

    expect(supabase.tables.payment_orders[0].metadata).toMatchObject({
      source: 'checkout.session.sync',
      invoiceResolutionAudit: expect.objectContaining({
        sessionInvoicePresent: false,
        latestInvoicePresent: false,
        invoiceListCount: 0,
        invoiceListStatuses: [],
        paidInvoiceFound: false,
        reason: 'paid_invoice_missing',
      }),
      syncCheckoutSessionFulfillment: expect.objectContaining({
        status: 'blocked',
        stage: 'checkout_paid_invoice_resolution',
        reason: 'paid_invoice_missing',
        checkoutStatus: 'complete',
        paymentStatus: 'paid',
        subscriptionId: expect.stringContaining('...'),
        invoiceResolutionAudit: expect.objectContaining({
          invoiceListCount: 0,
          paidInvoiceFound: false,
        }),
      }),
      lastFulfillmentError: expect.objectContaining({
        stage: 'checkout_paid_invoice_resolution',
        reason: 'paid_invoice_missing',
      }),
    });
    const metadataJson = JSON.stringify(supabase.tables.payment_orders[0].metadata);
    expect(metadataJson).not.toContain('sub_missing_paid_invoice');
    expect(metadataJson).not.toContain('cs_test_missing_paid_invoice');
    expect(metadataJson).not.toContain('cus_missing_paid_invoice');
    expect(supabase.tables.user_subscriptions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('records an auditable reason when resolved checkout invoices are not paid', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-unpaid-invoice',
        user_id: 'user-unpaid-invoice',
        item_id: 'plan-pro-yearly',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_unpaid_invoice',
        stripe_checkout_session_id: 'cs_test_unpaid_invoice',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_unpaid_invoice',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {},
      }],
      profiles: [{
        id: 'user-unpaid-invoice',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const openInvoice = {
      id: 'in_unpaid_invoice',
      status: 'open',
      amount_paid: 0,
      currency: 'usd',
      customer: 'cus_unpaid_invoice',
      parent: {
        subscription_details: {
          subscription: 'sub_unpaid_invoice',
        },
      },
    } as Stripe.Invoice;
    const subscription = {
      id: 'sub_unpaid_invoice',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue(subscription),
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue(openInvoice),
        list: vi.fn().mockResolvedValue({ data: [openInvoice] }),
      },
    };
    const session = {
      id: 'cs_test_unpaid_invoice',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-unpaid-invoice',
      metadata: {
        userId: 'user-unpaid-invoice',
        itemType: 'membership_plan',
        itemId: 'plan-pro-yearly',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_unpaid_invoice',
      subscription: 'sub_unpaid_invoice',
      invoice: openInvoice,
    } as Stripe.Checkout.Session;

    await expect(
      fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session),
    ).rejects.toMatchObject({
      stage: 'checkout_paid_invoice_resolution',
      safeContext: expect.objectContaining({
        reason: 'paid_invoice_unpaid',
        sessionInvoiceStatus: 'open',
        invoiceListStatuses: ['open'],
      }),
    });

    expect(supabase.tables.payment_orders[0].metadata).toMatchObject({
      invoiceResolutionAudit: expect.objectContaining({
        sessionInvoicePresent: true,
        sessionInvoiceId: expect.stringContaining('...'),
        sessionInvoiceStatus: 'open',
        latestInvoicePresent: false,
        invoiceListCount: 1,
        invoiceListStatuses: ['open'],
        paidInvoiceFound: false,
        reason: 'paid_invoice_unpaid',
      }),
      syncCheckoutSessionFulfillment: expect.objectContaining({
        status: 'blocked',
        stage: 'checkout_paid_invoice_resolution',
        reason: 'paid_invoice_unpaid',
        subscriptionId: expect.stringContaining('...'),
        invoiceResolutionAudit: expect.objectContaining({
          sessionInvoiceStatus: 'open',
          invoiceListStatuses: ['open'],
        }),
      }),
      lastFulfillmentError: expect.objectContaining({
        stage: 'checkout_paid_invoice_resolution',
        reason: 'paid_invoice_unpaid',
      }),
    });
    const metadataJson = JSON.stringify(supabase.tables.payment_orders[0].metadata);
    expect(metadataJson).not.toContain('sub_unpaid_invoice');
    expect(metadataJson).not.toContain('in_unpaid_invoice');
    expect(metadataJson).not.toContain('cus_unpaid_invoice');
    expect(supabase.tables.user_subscriptions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
  });

  it('records safe checkout audit metadata when invoice fulfillment fails', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-rpc-failure-audit',
        user_id: 'user-rpc-failure-audit',
        item_id: 'plan-missing',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_rpc_failure_audit',
        stripe_checkout_session_id: 'cs_test_rpc_failure_audit',
        stripe_invoice_id: null,
        stripe_customer_id: 'cus_rpc_failure_audit',
        stripe_price_id: 'price_pro_yearly',
        amount_total: 9900,
        currency: 'usd',
        status: 'pending',
        payment_status: 'paid',
        created_at: '2026-06-28T06:19:36.000Z',
        metadata: {},
      }],
      profiles: [{
        id: 'user-rpc-failure-audit',
        membership_level: 'free',
        credits: 100,
      }],
    });
    const paidInvoice = {
      id: 'in_rpc_failure_audit',
      status: 'paid',
      created: 1782627600,
      amount_paid: 9900,
      currency: 'usd',
      customer: 'cus_rpc_failure_audit',
      period_start: 1782627600,
      period_end: 1814163600,
      parent: {
        subscription_details: {
          subscription: 'sub_rpc_failure_audit',
        },
      },
    } as Stripe.Invoice;
    const subscription = {
      id: 'sub_rpc_failure_audit',
      status: 'active',
      cancel_at_period_end: false,
      latest_invoice: paidInvoice,
      items: {
        data: [{
          current_period_start: 1782627600,
          current_period_end: 1814163600,
        }],
      },
    } as Stripe.Subscription;
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(),
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    const session = {
      id: 'cs_test_rpc_failure_audit',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-rpc-failure-audit',
      metadata: {
        userId: 'user-rpc-failure-audit',
        itemType: 'membership_plan',
        itemId: 'plan-missing',
        billingCycle: 'yearly',
        priceId: 'price_pro_yearly',
      },
      customer: 'cus_rpc_failure_audit',
      subscription,
      invoice: paidInvoice,
    } as Stripe.Checkout.Session;

    await expect(
      fulfillPaidMembershipCheckoutSession(supabase, stripe as any, session),
    ).rejects.toMatchObject({
      stage: 'subscription_membership_plan_missing',
    });

    expect(supabase.tables.payment_orders[0].metadata).toMatchObject({
      syncCheckoutSessionFulfillment: expect.objectContaining({
        status: 'failed',
        stage: 'fulfill_membership_invoice',
        reason: 'membership_invoice_fulfillment_failed',
        subscriptionId: expect.stringContaining('...'),
      }),
      lastFulfillmentError: expect.objectContaining({
        stage: 'fulfill_membership_invoice',
        reason: 'membership_invoice_fulfillment_failed',
        errorStage: 'subscription_membership_plan_missing',
      }),
      invoiceResolutionAudit: expect.objectContaining({
        paidInvoiceFound: true,
      }),
    });
    const metadataJson = JSON.stringify(supabase.tables.payment_orders[0].metadata);
    expect(metadataJson).not.toContain('sub_rpc_failure_audit');
    expect(metadataJson).not.toContain('in_rpc_failure_audit');
    expect(metadataJson).not.toContain('cus_rpc_failure_audit');
    expect(metadataJson).not.toContain('cs_test_rpc_failure_audit');
  });

  it('preserves completed fulfilled checkout orders during paid session replay', async () => {
    const updates: unknown[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-completed',
                status: 'completed',
                fulfilled_at: '2026-03-22T12:00:00.000Z',
                metadata: {
                  transactionId: 'txn-1',
                  grantedCredits: 100,
                },
              },
              error: null,
            });
          },
          update(payload: unknown) {
            updates.push(payload);
            return {
              eq() {
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_replay_completed',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
          billingCycle: 'one_time',
          priceId: 'price_test_package',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        amount_total: 1000,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
      } as Stripe.Checkout.Session,
      {
        eventType: 'checkout.session.completed',
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        payment_status: 'paid',
        metadata: expect.objectContaining({
          transactionId: 'txn-1',
          grantedCredits: 100,
          lastPaymentOrderStatus: 'completed',
          lastPaymentOrderStatusSource: 'checkout.session.completed',
        }),
      }),
    );
  });

  it('marks expired checkout sessions as terminal without fulfillment', async () => {
    const updates: unknown[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-expired',
                status: 'pending',
                fulfilled_at: null,
                metadata: {},
              },
              error: null,
            });
          },
          update(payload: unknown) {
            updates.push(payload);
            return {
              eq() {
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };

    await upsertPaymentOrderBySession(
      supabase,
      {
        id: 'cs_test_expired',
        status: 'expired',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
          billingCycle: 'one_time',
          priceId: 'price_test_package',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        amount_total: 1000,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'unpaid',
      } as Stripe.Checkout.Session,
      {
        eventType: 'checkout.session.expired',
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        status: 'expired',
        payment_status: 'unpaid',
        metadata: expect.objectContaining({
          lastPaymentOrderStatus: 'expired',
          lastPaymentOrderStatusSource: 'checkout.session.expired',
        }),
      }),
    );
  });

  it('throws a diagnostic error when checkout order update fails', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'order-update-fail' },
              error: null,
            });
          },
          update() {
            return {
              eq() {
                return Promise.resolve({
                  error: {
                    code: '42501',
                    message: 'permission denied for table payment_orders',
                  },
                });
              },
            };
          },
          insert() {
            throw new Error('insert should not be called for an existing order');
          },
        };
      },
    };

    await expect(
      upsertPaymentOrderBySession(
        supabase,
        {
          id: 'cs_test_upsert_update_failure',
          metadata: {
            userId: 'user-1',
            itemType: 'membership_plan',
            itemId: 'plan-1',
            billingCycle: 'monthly',
            priceId: 'price_test_monthly',
          },
          client_reference_id: 'user-1',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          amount_total: 990,
          currency: 'usd',
          mode: 'subscription',
          payment_status: 'paid',
        } as Stripe.Checkout.Session,
      ),
    ).rejects.toMatchObject({
      name: 'StripeFulfillmentError',
      stage: 'upsert_payment_order_update',
      safeContext: expect.objectContaining({
        supabaseError: expect.objectContaining({
          code: '42501',
          message: 'permission denied for table payment_orders',
        }),
      }),
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'stripe_fulfillment_stage_failed',
      expect.objectContaining({
        stage: 'upsert_payment_order_update',
        supabaseError: expect.objectContaining({ code: '42501' }),
      }),
    );
  });

  it('throws a diagnostic error when checkout order insert fails', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('payment_orders');

        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
          insert() {
            return Promise.resolve({
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint for cs_test_insert_failure',
              },
            });
          },
        };
      },
    };

    await expect(
      upsertPaymentOrderBySession(
        supabase,
        {
          id: 'cs_test_insert_failure',
          metadata: {
            userId: 'user-1',
            itemType: 'membership_plan',
            itemId: 'plan-1',
            billingCycle: 'monthly',
            priceId: 'price_test_monthly',
          },
          client_reference_id: 'user-1',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          amount_total: 990,
          currency: 'usd',
          mode: 'subscription',
          payment_status: 'paid',
        } as Stripe.Checkout.Session,
      ),
    ).rejects.toMatchObject({
      name: 'StripeFulfillmentError',
      stage: 'upsert_payment_order_insert',
      safeContext: expect.objectContaining({
        supabaseError: expect.objectContaining({
          code: '23505',
          message: expect.stringContaining('cs_test_...ailure'),
        }),
      }),
    });
  });

  it('backfills checkout order fulfillment when invoice fulfillment already exists', async () => {
    const updates: Array<{ table: string; payload: unknown }> = [];
    const backfillFilters: Array<[string, unknown]> = [];
    const profileUpdates: unknown[] = [];
    let transactionsTouched = false;
    let subscriptionTouched = false;

    const supabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              if (column === 'stripe_invoice_id') {
                expect(value).toBe('in_test_123');
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: {
                        id: 'invoice-order-1',
                        fulfilled_at: '2026-03-12T14:58:21.498Z',
                      },
                    });
                  },
                };
              }

              if (column === 'stripe_subscription_id') {
                expect(value).toBe('sub_test_123');
                return this;
              }

              if (column === 'stripe_checkout_session_id') {
                expect(value).toBe('change_subscription_plan_lock:sub_test_123');
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              }

              throw new Error(`Unexpected eq(${column}, ${value})`);
            },
            order() {
              return this;
            },
            limit() {
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'order-source-1',
                  user_id: 'user-1',
                  item_id: 'plan-1',
                  item_type: 'membership_plan',
                  billing_cycle: 'monthly',
                  stripe_subscription_id: 'sub_test_123',
                  stripe_customer_id: 'cus_test_123',
                  stripe_price_id: 'price_monthly',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return this;
            },
            is(nullColumn: string, nullValue: null) {
              expect(nullColumn).toBe('stripe_invoice_id');
              expect(nullValue).toBeNull();
              backfillFilters.push([nullColumn, nullValue]);
              return this;
            },
            like(column: string, value: string) {
              expect(column).toBe('stripe_checkout_session_id');
              expect(value).toBe('cs_%');
              backfillFilters.push([column, value]);
              return this;
            },
            neq(column: string, value: string) {
              expect(column).toBe('status');
              expect(value).toBe('failed');
              backfillFilters.push([column, value]);
              return Promise.resolve({ error: null });
            },
            insert() {
              throw new Error('insert should not be called when invoice order already exists');
            },
          };
        }

        if (table === 'membership_plans') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              expect(column).toBe('id');
              expect(value).toBe('plan-1');
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'plan-1',
                  name: 'Pro',
                  level: 'pro',
                  monthly_credits: 1000,
                  monthly_bonus_credits: 0,
                },
                error: null,
              });
            },
          };
        }

        if (table === 'profiles') {
          return {
            update(payload: unknown) {
              profileUpdates.push(payload);
              return this;
            },
            eq(column: string, value: string) {
              expect(column).toBe('id');
              expect(value).toBe('user-1');
              return this;
            },
            select() {
              return this;
            },
            maybeSingle() {
              return Promise.resolve({ data: { id: 'user-1' }, error: null });
            },
          };
        }

        if (table === 'credit_transactions') {
          transactionsTouched = true;
          throw new Error('credit_transactions should not be touched during invoice replay');
        }

        if (table === 'user_subscriptions') {
          subscriptionTouched = true;
          throw new Error('user_subscriptions should not be touched during invoice replay');
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_123',
        customer: 'cus_test_123',
        status: 'paid',
        currency: 'usd',
        amount_paid: 990,
        parent: {
          subscription_details: {
            subscription: 'sub_test_123',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          fulfilled_at: '2026-03-12T14:58:21.498Z',
          status: 'completed',
          payment_status: 'paid',
        }),
      },
    ]);
    expect(backfillFilters).toEqual([
      ['stripe_checkout_session_id', 'cs_%'],
      ['stripe_invoice_id', null],
      ['status', 'failed'],
    ]);
    expect(profileUpdates).toEqual([]);
    expect(transactionsTouched).toBe(false);
    expect(subscriptionTouched).toBe(false);
  });

  it('does not backfill a newer pending plan-change lock during old invoice replay', async () => {
    const tables: Record<string, Array<Record<string, any>>> = {
      payment_orders: [
        {
          id: 'order-initial-checkout',
          user_id: 'user-1',
          item_id: 'plan-pro',
          item_type: 'membership_plan',
          billing_cycle: 'monthly',
          stripe_subscription_id: 'sub_test_123',
          stripe_checkout_session_id: 'cs_test_initial',
          stripe_invoice_id: null,
          status: 'pending',
          payment_status: 'paid',
          created_at: '2026-03-12T14:00:00.000Z',
        },
        {
          id: 'order-new-plan-change-lock',
          user_id: 'user-1',
          item_id: 'plan-gold',
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: 'sub_test_123',
          stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_123',
          stripe_invoice_id: null,
          status: 'pending',
          payment_status: 'active',
          created_at: '2026-03-12T15:10:00.000Z',
          metadata: {
            source: 'changeSubscriptionPlan',
          },
        },
        {
          id: 'order-old-invoice',
          stripe_invoice_id: 'in_test_old',
          stripe_subscription_id: 'sub_test_123',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-03-12T14:58:21.498Z',
          created_at: '2026-03-12T14:58:21.498Z',
        },
      ],
    };

    const supabase = {
      from(table: string) {
        if (!tables[table]) {
          throw new Error(`Unexpected table: ${table}`);
        }

        const filters: Array<{
          column: string;
          operator: 'eq' | 'is' | 'like' | 'neq';
          value: unknown;
        }> = [];
        let mode: 'select' | 'update' = 'select';
        let payload: Record<string, unknown> = {};

        const matchingRows = () => tables[table].filter((row) =>
          filters.every(({ column, operator, value }) => {
            if (operator === 'neq') {
              return row[column] !== value;
            }

            if (operator === 'like') {
              if (value !== 'cs_%') {
                throw new Error(`Unexpected like pattern: ${String(value)}`);
              }

              return typeof row[column] === 'string' && row[column].startsWith('cs_');
            }

            return row[column] === value;
          }),
        );

        return {
          select() {
            return this;
          },
          update(nextPayload: Record<string, unknown>) {
            mode = 'update';
            payload = nextPayload;
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ column, operator: 'eq', value });
            return this;
          },
          is(column: string, value: unknown) {
            filters.push({ column, operator: 'is', value });
            return this;
          },
          like(column: string, value: unknown) {
            filters.push({ column, operator: 'like', value });
            return this;
          },
          neq(column: string, value: unknown) {
            filters.push({ column, operator: 'neq', value });
            if (mode === 'update') {
              matchingRows().forEach((row) => Object.assign(row, payload));
              return Promise.resolve({ error: null });
            }

            return this;
          },
          maybeSingle() {
            if (mode === 'update') {
              const rows = matchingRows();
              rows.forEach((row) => Object.assign(row, payload));
              return Promise.resolve({ data: rows[0] ? { id: rows[0].id } : null, error: null });
            }

            return Promise.resolve({ data: matchingRows()[0] ?? null, error: null });
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_old',
        customer: 'cus_test_123',
        status: 'paid',
        currency: 'usd',
        amount_paid: 990,
        parent: {
          subscription_details: {
            subscription: 'sub_test_123',
          },
        },
      } as Stripe.Invoice,
    );

    expect(tables.payment_orders[0]).toMatchObject({
      id: 'order-initial-checkout',
      status: 'completed',
      payment_status: 'paid',
      fulfilled_at: '2026-03-12T14:58:21.498Z',
    });
    expect(tables.payment_orders[1]).toMatchObject({
      id: 'order-new-plan-change-lock',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_123',
      status: 'pending',
      payment_status: 'active',
    });
    expect(tables.payment_orders[1]).not.toHaveProperty('fulfilled_at');
  });

  it('delegates pending credit package fulfillment to the atomic RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:00:00.000Z',
        },
      ],
      error: null,
    });

    const supabase = {
      rpc,
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table access: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            expect(column).toBe('stripe_checkout_session_id');
            expect(value).toBe('cs_test_credit_atomic');
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-credit-atomic',
                fulfilled_at: null,
              },
            });
          },
        };
      },
    };

    await fulfillCreditPackageOrder(
      supabase,
      {
        id: 'cs_test_credit_atomic',
        metadata: {
          userId: 'user-atomic',
          itemType: 'credit_package',
          itemId: 'package-atomic',
        },
        client_reference_id: 'user-atomic',
        payment_status: 'paid',
        mode: 'payment',
      } as Stripe.Checkout.Session,
    );

    expect(rpc).toHaveBeenCalledWith('atomic_fulfill_credit_package', {
      p_checkout_session_id: 'cs_test_credit_atomic',
      p_payment_status: 'paid',
    });
  });

  it('fulfills membership invoices through subscription credit grants and backfills checkout order', async () => {
    const tables: Record<string, Array<Record<string, any>>> = {
      payment_orders: [{
        id: 'order-source',
        user_id: 'user-atomic',
        item_id: 'plan-atomic',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: null,
        stripe_subscription_id: 'sub_test_atomic',
        stripe_checkout_session_id: 'cs_test_atomic',
        stripe_customer_id: 'cus_test_atomic',
        stripe_price_id: 'price_yearly',
        created_at: '2025-03-22T12:26:40.000Z',
      }],
      membership_plans: [{
        id: 'plan-atomic',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
        monthly_credits: 20,
        monthly_bonus_credits: 0,
      }],
      subscription_credit_grants: [],
      credit_transactions: [],
      user_subscriptions: [],
      profiles: [{
        id: 'user-atomic',
        membership_level: 'free',
      }],
    };

    const supabase = {
      async rpc(name: string, payload: Record<string, unknown>) {
        expect(name).toBe('atomic_apply_credit_ledger_entry');
        const transaction = {
          id: 'txn-membership-grant',
          user_id: payload.p_user_id,
          amount: payload.p_amount,
          type: payload.p_type,
          idempotency_key: payload.p_idempotency_key,
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
      from(table: string) {
        const filters: Array<{ column: string; operator: 'eq' | 'like'; value: unknown }> = [];
        let mode: 'select' | 'insert' | 'update' = 'select';
        let payload: Record<string, unknown> = {};

        const matchingRows = () => tables[table].filter((row) =>
          filters.every(({ column, operator, value }) => {
            if (operator === 'like') {
              const pattern = String(value);
              if (pattern.endsWith('%')) {
                return typeof row[column] === 'string' && row[column].startsWith(pattern.slice(0, -1));
              }

              return row[column] === value;
            }

            return row[column] === value;
          }),
        );

        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ column, operator: 'eq', value });
            return this;
          },
          is(column: string, value: unknown) {
            filters.push({ column, operator: 'eq', value });
            if (mode === 'update') {
              matchingRows().forEach((row) => Object.assign(row, payload));
            }
            return Promise.resolve({ error: null });
          },
          like(column: string, value: unknown) {
            filters.push({ column, operator: 'like', value });
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          update(nextPayload: Record<string, unknown>) {
            mode = 'update';
            payload = nextPayload;
            return this;
          },
          insert(nextPayload: Record<string, unknown>) {
            mode = 'insert';
            payload = nextPayload;
            return this;
          },
          async maybeSingle() {
            if (mode === 'insert') {
              const inserted = {
                id: `${table}-${tables[table].length + 1}`,
                ...payload,
              };
              tables[table].push(inserted);
              return { data: inserted, error: null };
            }

            if (mode === 'update') {
              const rows = matchingRows();
              rows.forEach((row) => Object.assign(row, payload));
              return { data: rows[0] ? { id: rows[0].id } : null, error: null };
            }

            return { data: matchingRows()[0] ?? null, error: null };
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_atomic',
        customer: 'cus_test_atomic',
        status: 'paid',
        currency: 'usd',
        amount_paid: 1990,
        period_start: 1_742_646_400,
        period_end: 1_745_238_400,
        parent: {
          subscription_details: {
            subscription: 'sub_test_atomic',
          },
        },
      } as Stripe.Invoice,
    );

    expect(tables.subscription_credit_grants).toHaveLength(1);
    expect(tables.subscription_credit_grants[0]).toMatchObject({
      billing_cycle: 'yearly',
      grant_type: 'annual_monthly_release',
      period_index: 1,
      total_periods: 12,
      credits_granted: 10,
    });
    expect(tables.credit_transactions[0]).toMatchObject({
      amount: 10,
      ledger_type: 'grant',
      reason_code: 'annual_monthly_release',
      counts_as_spend: false,
      source_type: 'stripe_invoice',
      source_id: 'in_test_atomic',
    });
    expect(tables.profiles[0]).toMatchObject({
      id: 'user-atomic',
      membership_level: 'gold',
    });
    expect(tables.payment_orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stripe_invoice_id: 'in_test_atomic',
          status: 'completed',
          payment_status: 'paid',
        }),
        expect.objectContaining({
          id: 'order-source',
          fulfilled_at: expect.any(String),
          status: 'completed',
          payment_status: 'paid',
        }),
      ]),
    );
  });

  it('throws retryable errors for subscription refund webhooks when the invoice order is not visible yet', async () => {
    const charge = {
      id: 'ch_webhook_order_missing',
      amount: 9900,
      amount_refunded: 9900,
      currency: 'usd',
      refunded: true,
      status: 'succeeded',
      invoice: 'in_webhook_order_missing',
      payment_intent: 'pi_webhook_order_missing',
      refunds: {
        data: [{
          id: 're_webhook_order_missing_full',
          status: 'succeeded',
        }],
      },
    } as Stripe.Charge;
    const retrieveCharge = vi.fn().mockResolvedValue(charge);
    const webhookCases = [
      {
        event: {
          id: 'evt_webhook_refund_created_order_missing',
          type: 'refund.created',
          data: {
            object: {
              id: 're_webhook_order_missing_full',
              amount: 9900,
              currency: 'usd',
              status: 'succeeded',
              charge: 'ch_webhook_order_missing',
              payment_intent: 'pi_webhook_order_missing',
              metadata: {},
            } as Stripe.Refund,
          },
        } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
        options: { retrieveCharge },
      },
      {
        event: {
          id: 'evt_webhook_charge_refunded_order_missing',
          type: 'charge.refunded',
          data: {
            object: charge,
          },
        } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
        options: {},
      },
    ];

    for (const webhookCase of webhookCases) {
      const supabase = createRefundWebhookSupabase();

      await expect(reconcileSubscriptionRefundFromStripeWebhook(
        supabase,
        webhookCase.event,
        webhookCase.options,
      )).rejects.toMatchObject({
        stage: 'refund_subscription_order_missing',
      });
      expect(supabase.tables.payment_orders).toHaveLength(0);
      expect(supabase.tables.credit_transactions).toHaveLength(0);
      expect(loggerState.error).toHaveBeenCalledWith(
        'billing',
        'stripe_fulfillment_stage_failed',
        expect.objectContaining({
          stage: 'refund_subscription_order_missing',
        }),
      );
    }
    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_order_missing');
  });

  it('resolves subscription refund invoices through payment intents when Charge.invoice is absent', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-payment-intent-invoice',
        user_id: 'user-webhook-payment-intent-invoice',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_payment_intent_invoice',
        stripe_invoice_id: 'in_webhook_payment_intent_invoice',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-payment-intent-invoice',
        user_id: 'user-webhook-payment-intent-invoice',
        membership_plan_id: 'plan-webhook-payment-intent-invoice',
        stripe_subscription_id: 'sub_webhook_payment_intent_invoice',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_payment_intent_invoice' },
      }],
      membership_plans: [{
        id: 'plan-webhook-payment-intent-invoice',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-payment-intent-invoice',
        credits: 100,
      }],
      subscription_credit_grants: [{
        id: 'grant-webhook-payment-intent-invoice-1',
        user_id: 'user-webhook-payment-intent-invoice',
        membership_plan_id: 'plan-webhook-payment-intent-invoice',
        stripe_subscription_id: 'sub_webhook_payment_intent_invoice',
        stripe_invoice_id: 'in_webhook_payment_intent_invoice',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-02-01T00:00:00.000Z',
        period_index: 1,
        credits_granted: 10,
        consumed_amount: 0,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      }],
    });
    const retrieveCharge = vi.fn().mockResolvedValue({
      id: 'ch_webhook_payment_intent_invoice',
      amount: 9900,
      amount_refunded: 9900,
      currency: 'usd',
      refunded: true,
      status: 'succeeded',
      payment_intent: 'pi_webhook_payment_intent_invoice',
    } as Stripe.Charge);
    const retrievePaymentIntent = vi.fn().mockResolvedValue({
      id: 'pi_webhook_payment_intent_invoice',
      invoice: 'in_webhook_payment_intent_invoice',
    } as Stripe.PaymentIntent);

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_payment_intent_invoice',
        type: 'refund.created',
        data: {
          object: {
            id: 're_webhook_payment_intent_invoice_full',
            amount: 9900,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_payment_intent_invoice',
            payment_intent: 'pi_webhook_payment_intent_invoice',
            metadata: {},
            created: 1768348800,
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
      {
        now: '2026-02-01T00:00:00.000Z',
        retrieveCharge,
        retrievePaymentIntent,
      },
    );

    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_payment_intent_invoice');
    expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_webhook_payment_intent_invoice');
    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: true,
      reviewRequired: false,
      reversedGrantCount: 1,
      clawbackAmount: 10,
      appliedClawbackAmount: 10,
      shortfallAmount: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_payment_intent_invoice_full',
          invoiceId: 'in_webhook_payment_intent_invoice',
          fullRefund: true,
          reviewRequired: false,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
      status: 'reversed',
      metadata: {
        reversal: expect.objectContaining({
          subscriptionId: 'sub_webhook_payment_intent_invoice',
          periodKey: 'annual:2026-01-01T00:00:00.000Z:01',
        }),
      },
    });
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -10,
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_refund_id: 're_webhook_payment_intent_invoice_full',
    });
  });

  it('throws retryable errors when subscription refund invoices cannot be resolved', async () => {
    const retrieveCharge = vi.fn().mockResolvedValue({
      id: 'ch_webhook_invoice_unresolved',
      amount: 9900,
      amount_refunded: 9900,
      currency: 'usd',
      refunded: true,
      status: 'succeeded',
      payment_intent: 'pi_webhook_invoice_unresolved',
    } as Stripe.Charge);
    const retrievePaymentIntent = vi.fn().mockResolvedValue({
      id: 'pi_webhook_invoice_unresolved',
    } as Stripe.PaymentIntent);
    const supabase = createRefundWebhookSupabase();

    await expect(reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_invoice_unresolved',
        type: 'refund.created',
        data: {
          object: {
            id: 're_webhook_invoice_unresolved_full',
            amount: 9900,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_invoice_unresolved',
            payment_intent: 'pi_webhook_invoice_unresolved',
            metadata: {},
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
      {
        retrieveCharge,
        retrievePaymentIntent,
      },
    )).rejects.toMatchObject({
      stage: 'refund_subscription_invoice_missing',
    });
    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_invoice_unresolved');
    expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_webhook_invoice_unresolved');
    expect(supabase.tables.payment_orders).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'stripe_fulfillment_stage_failed',
      expect.objectContaining({
        stage: 'refund_subscription_invoice_missing',
      }),
    );
  });

  it.each(['pending', 'failed', 'canceled'])(
    'audits %s subscription refunds without clawback or grant reversal',
    async (refundStatus) => {
      const supabase = createRefundWebhookSupabase({
        payment_orders: [{
          id: `order-webhook-${refundStatus}-refund`,
          user_id: `user-webhook-${refundStatus}-refund`,
          item_id: `plan-webhook-${refundStatus}-refund`,
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: `sub_webhook_${refundStatus}_refund`,
          stripe_invoice_id: `in_webhook_${refundStatus}_refund`,
          amount_total: 9900,
          currency: 'usd',
          status: 'completed',
          payment_status: 'paid',
          metadata: { source: 'invoice.payment_succeeded' },
        }],
        user_subscriptions: [{
          id: `subscription-webhook-${refundStatus}-refund`,
          user_id: `user-webhook-${refundStatus}-refund`,
          membership_plan_id: `plan-webhook-${refundStatus}-refund`,
          stripe_subscription_id: `sub_webhook_${refundStatus}_refund`,
          billing_cycle: 'yearly',
          status: 'active',
          cancel_at_period_end: 'false',
          current_period_start: '2026-01-01T00:00:00.000Z',
          current_period_end: '2027-01-01T00:00:00.000Z',
          metadata: { lastInvoiceId: `in_webhook_${refundStatus}_refund` },
        }],
        membership_plans: [{
          id: `plan-webhook-${refundStatus}-refund`,
          name: 'Gold',
          level: 'gold',
          yearly_credits: 120,
        }],
        profiles: [{
          id: `user-webhook-${refundStatus}-refund`,
          membership_level: 'gold',
          credits: 100,
        }],
      });
      const retrieveCharge = vi.fn().mockResolvedValue({
        id: `ch_webhook_${refundStatus}_refund`,
        amount: 9900,
        amount_refunded: 9900,
        currency: 'usd',
        refunded: true,
        status: 'succeeded',
        invoice: `in_webhook_${refundStatus}_refund`,
        payment_intent: `pi_webhook_${refundStatus}_refund`,
      } as Stripe.Charge);

      const result = await reconcileSubscriptionRefundFromStripeWebhook(
        supabase,
        {
          id: `evt_webhook_${refundStatus}_refund`,
          type: 'refund.created',
          data: {
            object: {
              id: `re_webhook_${refundStatus}_refund`,
              amount: 9900,
              currency: 'usd',
              status: refundStatus,
              charge: `ch_webhook_${refundStatus}_refund`,
              payment_intent: `pi_webhook_${refundStatus}_refund`,
              metadata: {},
            } as Stripe.Refund,
          },
        } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
        {
          now: '2026-02-01T00:00:00.000Z',
          retrieveCharge,
        },
      );

      expect(result).toMatchObject({
        reconciled: false,
        reason: 'refund_not_successful',
        orderId: `order-webhook-${refundStatus}-refund`,
        subscriptionId: `sub_webhook_${refundStatus}_refund`,
        refundId: `re_webhook_${refundStatus}_refund`,
        refundStatus,
      });
      expect(supabase.tables.payment_orders[0]).toMatchObject({
        status: 'completed',
        payment_status: 'paid',
        metadata: {
          source: 'invoice.payment_succeeded',
          stripeRefundWebhookAudit: expect.objectContaining({
            refundId: `re_webhook_${refundStatus}_refund`,
            refundStatus,
            invoiceId: `in_webhook_${refundStatus}_refund`,
            creditClawbackApplied: false,
            grantReversalApplied: false,
          }),
        },
      });
      expect(supabase.tables.payment_orders[0].metadata).not.toHaveProperty('subscriptionCreditGrantReversal');
      expect(supabase.tables.credit_transactions).toHaveLength(0);
      expect(supabase.tables.subscription_credit_grants).toHaveLength(0);

      const releaseAfterNonSuccessfulRefund = await releaseDueAnnualSubscriptionCredits(supabase, {
        now: new Date('2026-02-15T00:00:00.000Z'),
      });
      expect(releaseAfterNonSuccessfulRefund).toMatchObject({
        releasedGrantCount: 2,
        releasedCredits: 20,
        skippedSubscriptions: 0,
      });
      expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
        stripe_invoice_id: `in_webhook_${refundStatus}_refund`,
        status: 'granted',
        credits_granted: 10,
      });
      expect(supabase.tables.credit_transactions.map((transaction) => transaction.ledger_type))
        .toEqual(['grant', 'grant']);
      expect(supabase.tables.credit_transactions.every((transaction) =>
        transaction.counts_as_spend === false,
      )).toBe(true);
    },
  );

  it.each([
    {
      label: 'missing-status',
      refundStatus: null,
      reconciliationStatus: 'waiting_for_successful_refund_status',
    },
    {
      label: 'pending',
      refundStatus: 'pending',
      reconciliationStatus: 'waiting_for_successful_refund',
    },
    {
      label: 'failed',
      refundStatus: 'failed',
      reconciliationStatus: 'ignored_non_successful_refund',
    },
    {
      label: 'canceled',
      refundStatus: 'canceled',
      reconciliationStatus: 'ignored_non_successful_refund',
    },
  ])(
    'audits charge.refunded %s refunds without clawback or grant reversal',
    async ({ label, refundStatus, reconciliationStatus }) => {
      const supabase = createRefundWebhookSupabase({
        payment_orders: [{
          id: `order-webhook-charge-${label}`,
          user_id: `user-webhook-charge-${label}`,
          item_id: `plan-webhook-charge-${label}`,
          item_type: 'membership_plan',
          billing_cycle: 'yearly',
          stripe_subscription_id: `sub_webhook_charge_${label}`,
          stripe_invoice_id: `in_webhook_charge_${label}`,
          amount_total: 9900,
          currency: 'usd',
          status: 'completed',
          payment_status: 'paid',
          metadata: { source: 'invoice.payment_succeeded' },
        }],
        user_subscriptions: [{
          id: `subscription-webhook-charge-${label}`,
          user_id: `user-webhook-charge-${label}`,
          membership_plan_id: `plan-webhook-charge-${label}`,
          stripe_subscription_id: `sub_webhook_charge_${label}`,
          billing_cycle: 'yearly',
          status: 'active',
          cancel_at_period_end: 'false',
          current_period_start: '2026-01-01T00:00:00.000Z',
          current_period_end: '2027-01-01T00:00:00.000Z',
          metadata: { lastInvoiceId: `in_webhook_charge_${label}` },
        }],
        membership_plans: [{
          id: `plan-webhook-charge-${label}`,
          name: 'Gold',
          level: 'gold',
          yearly_credits: 120,
        }],
        profiles: [{
          id: `user-webhook-charge-${label}`,
          membership_level: 'gold',
          credits: 100,
        }],
        subscription_credit_grants: [{
          id: `grant-webhook-charge-${label}-1`,
          user_id: `user-webhook-charge-${label}`,
          membership_plan_id: `plan-webhook-charge-${label}`,
          stripe_subscription_id: `sub_webhook_charge_${label}`,
          stripe_invoice_id: `in_webhook_charge_${label}`,
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: `sub_webhook_charge_${label}:2026-01:01`,
          period_index: 1,
          credits_granted: 10,
          status: 'granted',
          metadata: { sourceType: 'stripe_invoice' },
        }],
      });
      const refundObject = {
        id: `re_webhook_charge_${label}`,
        ...(refundStatus ? { status: refundStatus } : {}),
      };

      const result = await reconcileSubscriptionRefundFromStripeWebhook(
        supabase,
        {
          id: `evt_webhook_charge_${label}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: `ch_webhook_charge_${label}`,
              amount: 9900,
              amount_refunded: 9900,
              currency: 'usd',
              refunded: true,
              status: 'succeeded',
              invoice: `in_webhook_charge_${label}`,
              payment_intent: `pi_webhook_charge_${label}`,
              refunds: {
                data: [refundObject],
              },
            } as Stripe.Charge,
          },
        } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
        { now: '2026-02-01T00:00:00.000Z' },
      );

      expect(result).toMatchObject({
        reconciled: false,
        reason: 'refund_not_successful',
        orderId: `order-webhook-charge-${label}`,
        subscriptionId: `sub_webhook_charge_${label}`,
        refundId: `re_webhook_charge_${label}`,
        refundStatus,
      });
      expect(supabase.tables.payment_orders[0]).toMatchObject({
        status: 'completed',
        payment_status: 'paid',
        metadata: {
          source: 'invoice.payment_succeeded',
          stripeRefundWebhookAudit: expect.objectContaining({
            refundId: `re_webhook_charge_${label}`,
            eventType: 'charge.refunded',
            refundStatus,
            invoiceId: `in_webhook_charge_${label}`,
            reconciliationStatus,
            creditClawbackApplied: false,
            grantReversalApplied: false,
          }),
        },
      });
      expect(supabase.tables.payment_orders[0].metadata).not.toHaveProperty('subscriptionCreditGrantReversal');
      expect(supabase.tables.subscription_credit_grants[0]).toMatchObject({
        status: 'granted',
      });
      expect(supabase.tables.credit_transactions).toHaveLength(0);

      const releaseAfterChargeAudit = await releaseDueAnnualSubscriptionCredits(supabase, {
        now: new Date('2026-02-15T00:00:00.000Z'),
      });
      expect(releaseAfterChargeAudit).toMatchObject({
        releasedGrantCount: 2,
        releasedCredits: 20,
        skippedSubscriptions: 0,
      });
      expect(supabase.tables.credit_transactions.map((transaction) => transaction.ledger_type))
        .toEqual(['grant', 'grant']);
      expect(supabase.tables.credit_transactions.every((transaction) =>
        transaction.counts_as_spend === false,
      )).toBe(true);
    },
  );

  it('reconciles charge.refunded subscription webhooks into invoice-scoped grant reversal markers', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-charge-refund',
        user_id: 'user-webhook-charge-refund',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_charge_refund',
        stripe_invoice_id: 'in_webhook_charge_refund_2027',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-charge-refund',
        user_id: 'user-webhook-charge-refund',
        membership_plan_id: 'plan-webhook-charge-refund',
        stripe_subscription_id: 'sub_webhook_charge_refund',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2027-01-01T00:00:00.000Z',
        current_period_end: '2028-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_charge_refund_2027' },
      }],
      membership_plans: [{
        id: 'plan-webhook-charge-refund',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-charge-refund',
        credits: 100,
      }],
      subscription_credit_grants: [
        ...[1, 2].map((periodIndex) => ({
          id: `grant-webhook-charge-2026-${periodIndex}`,
          user_id: 'user-webhook-charge-refund',
          membership_plan_id: 'plan-webhook-charge-refund',
          stripe_subscription_id: 'sub_webhook_charge_refund',
          stripe_invoice_id: 'in_webhook_charge_refund_2026',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
          period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
          period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
          period_index: periodIndex,
          credits_granted: 10,
          consumed_amount: 10,
          status: 'granted',
          metadata: { sourceType: 'stripe_invoice', sourceId: 'in_webhook_charge_refund_2026' },
        })),
        ...[1, 2].map((periodIndex) => ({
          id: `grant-webhook-charge-2027-${periodIndex}`,
          user_id: 'user-webhook-charge-refund',
          membership_plan_id: 'plan-webhook-charge-refund',
          stripe_subscription_id: 'sub_webhook_charge_refund',
          stripe_invoice_id: 'in_webhook_charge_refund_2027',
          billing_cycle: 'yearly',
          grant_type: 'annual_monthly_release',
          grant_period_key: `annual:2027-01-01T00:00:00.000Z:0${periodIndex}`,
          period_start: `2027-0${periodIndex}-01T00:00:00.000Z`,
          period_end: `2027-0${periodIndex + 1}-01T00:00:00.000Z`,
          period_index: periodIndex,
          credits_granted: 10,
          consumed_amount: 5,
          status: 'granted',
          metadata: { sourceType: 'stripe_invoice', sourceId: 'in_webhook_charge_refund_2027' },
        })),
      ],
    });

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_charge_refunded',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_webhook_charge_refund',
            amount: 9900,
            amount_refunded: 9900,
            currency: 'usd',
            refunded: true,
            status: 'succeeded',
            invoice: 'in_webhook_charge_refund_2027',
            payment_intent: 'pi_webhook_charge_refund',
            created: 1802649600,
            refunds: {
              data: [{
                id: 're_webhook_charge_refund_pending',
                status: 'pending',
              }, {
                id: 're_webhook_charge_refund_full',
                status: 'succeeded',
                created: 1802649700,
              }],
            },
          } as Stripe.Charge,
        },
      } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
      { now: '2027-03-01T00:00:00.000Z' },
    );

    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: true,
      reviewRequired: false,
      locatedPeriodKey: 'annual:2027-01-01T00:00:00.000Z:02',
      reversedGrantCount: 1,
      clawbackAmount: 5,
      appliedClawbackAmount: 5,
      shortfallAmount: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_charge_refund_full',
          eventType: 'charge.refunded',
          invoiceId: 'in_webhook_charge_refund_2027',
          fullRefund: true,
          reviewRequired: false,
          reversalStatus: 'complete',
          locatedPeriodKey: 'annual:2027-01-01T00:00:00.000Z:02',
          reversedGrantCount: 1,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_webhook_charge_refund_2026')
      .map((grant) => grant.status)).toEqual(['granted', 'granted']);
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_webhook_charge_refund_2027')
      .map((grant) => grant.status)).toEqual(['granted', 'reversed']);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -5,
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_type: 'stripe_refund',
      source_refund_id: 're_webhook_charge_refund_full',
    });

    const releaseAfterRefund = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2027-04-15T00:00:00.000Z'),
    });
    expect(releaseAfterRefund).toMatchObject({
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });

    const replay = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_charge_refunded_replay',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_webhook_charge_refund',
            amount: 9900,
            amount_refunded: 9900,
            currency: 'usd',
            refunded: true,
            status: 'succeeded',
            invoice: 'in_webhook_charge_refund_2027',
            payment_intent: 'pi_webhook_charge_refund',
            created: 1802649600,
            refunds: {
              data: [{
                id: 're_webhook_charge_refund_pending',
                status: 'pending',
              }, {
                id: 're_webhook_charge_refund_full',
                status: 'succeeded',
              }],
            },
          } as Stripe.Charge,
        },
      } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
      { now: '2027-03-01T00:05:00.000Z' },
    );

    expect(replay).toMatchObject({
      reconciled: true,
      alreadyReconciled: true,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
  });

  it('R4: charge.refunded without a refund-object created timestamp never falls back to charge.created and stops for review', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-charge-refund-no-ts',
        user_id: 'user-webhook-charge-refund-no-ts',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_charge_refund_no_ts',
        stripe_invoice_id: 'in_webhook_charge_refund_no_ts',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-charge-refund-no-ts',
        user_id: 'user-webhook-charge-refund-no-ts',
        membership_plan_id: 'plan-webhook-charge-refund-no-ts',
        stripe_subscription_id: 'sub_webhook_charge_refund_no_ts',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_charge_refund_no_ts' },
      }],
      membership_plans: [{
        id: 'plan-webhook-charge-refund-no-ts',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-charge-refund-no-ts',
        credits: 100,
      }],
      subscription_credit_grants: [1].map((periodIndex) => ({
        id: `grant-webhook-charge-refund-no-ts-${periodIndex}`,
        user_id: 'user-webhook-charge-refund-no-ts',
        membership_plan_id: 'plan-webhook-charge-refund-no-ts',
        stripe_subscription_id: 'sub_webhook_charge_refund_no_ts',
        stripe_invoice_id: 'in_webhook_charge_refund_no_ts',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: 4,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      })),
    });

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_charge_refunded_no_ts',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_webhook_charge_refund_no_ts',
            amount: 9900,
            amount_refunded: 9900,
            currency: 'usd',
            refunded: true,
            status: 'succeeded',
            invoice: 'in_webhook_charge_refund_no_ts',
            payment_intent: 'pi_webhook_charge_refund_no_ts',
            created: 1767225600,
            refunds: {
              data: [{
                id: 're_webhook_charge_refund_no_ts',
                status: 'succeeded',
              }],
            },
          } as Stripe.Charge,
        },
      } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
      { now: '2026-02-01T00:00:00.000Z' },
    );

    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: true,
      reviewRequired: true,
      reviewReason: 'missing_trusted_refund_timestamp',
      terminationWritten: true,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      reversedGrantCount: 0,
    });
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.profiles[0].credits).toBe(100);
    expect(supabase.tables.user_subscriptions[0].credit_release_terminated_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('reconciles refund.created subscription webhooks into auditable shortfall markers', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-refund-created',
        user_id: 'user-webhook-refund-created',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_refund_created',
        stripe_invoice_id: 'in_webhook_refund_created',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-refund-created',
        user_id: 'user-webhook-refund-created',
        membership_plan_id: 'plan-webhook-refund-created',
        stripe_subscription_id: 'sub_webhook_refund_created',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_refund_created' },
      }],
      membership_plans: [{
        id: 'plan-webhook-refund-created',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-refund-created',
        credits: 5,
      }],
      subscription_credit_grants: [1, 2, 3].map((periodIndex) => ({
        id: `grant-webhook-refund-created-${periodIndex}`,
        user_id: 'user-webhook-refund-created',
        membership_plan_id: 'plan-webhook-refund-created',
        stripe_subscription_id: 'sub_webhook_refund_created',
        stripe_invoice_id: 'in_webhook_refund_created',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: periodIndex === 3 ? 0 : 10,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      })),
    });
    const retrieveCharge = vi.fn().mockResolvedValue({
      id: 'ch_webhook_refund_created',
      amount: 9900,
      amount_refunded: 9900,
      currency: 'usd',
      refunded: true,
      status: 'succeeded',
      invoice: 'in_webhook_refund_created',
      payment_intent: 'pi_webhook_refund_created',
    } as Stripe.Charge);

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_refund_created',
        type: 'refund.created',
        data: {
          object: {
            id: 're_webhook_refund_created_full',
            amount: 9900,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_refund_created',
            payment_intent: 'pi_webhook_refund_created',
            metadata: {},
            created: 1773446400,
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
      {
        now: '2026-04-01T00:00:00.000Z',
        retrieveCharge,
      },
    );

    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_refund_created');
    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: true,
      reviewRequired: true,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:03',
      reversedGrantCount: 1,
      clawbackAmount: 10,
      appliedClawbackAmount: 5,
      shortfallAmount: 5,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_refund_created_full',
          eventType: 'refund.created',
          invoiceId: 'in_webhook_refund_created',
          fullRefund: true,
          reviewRequired: true,
          clawbackAmount: 10,
          appliedClawbackAmount: 5,
          shortfallAmount: 5,
          shortfallReason: 'insufficient_balance',
          reversalStatus: 'shortfall_review_required',
          reversedGrantCount: 1,
          creditTransactionId: 'txn-refund-webhook-1',
        }),
      },
    });
    expect(supabase.tables.profiles[0].credits).toBe(0);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -5,
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      metadata: expect.objectContaining({
        requiredClawbackAmount: 10,
        shortfallAmount: 5,
      }),
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'granted',
      'granted',
      'reversed',
    ]);

    const releaseAfterShortfall = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-04-15T00:00:00.000Z'),
    });
    expect(releaseAfterShortfall).toMatchObject({
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });

    const chargeRefundedReplay = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_refund_created_charge_replay',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_webhook_refund_created',
            amount: 9900,
            amount_refunded: 9900,
            currency: 'usd',
            refunded: true,
            status: 'succeeded',
            invoice: 'in_webhook_refund_created',
            payment_intent: 'pi_webhook_refund_created',
            created: 1773446400,
            refunds: {
              data: [{
                id: 're_webhook_refund_created_charge_later',
                status: 'succeeded',
              }],
            },
          } as Stripe.Charge,
        },
      } as Stripe.Event & { type: 'charge.refunded'; data: { object: Stripe.Charge } },
      { now: '2026-04-01T00:05:00.000Z' },
    );

    expect(chargeRefundedReplay).toMatchObject({
      reconciled: true,
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: true,
      reversedGrantCount: 1,
      clawbackAmount: 10,
      appliedClawbackAmount: 5,
      shortfallAmount: 5,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_webhook_refund_created_full',
      eventType: 'refund.created',
      invoiceId: 'in_webhook_refund_created',
      reviewRequired: true,
      shortfallAmount: 5,
      reversalStatus: 'shortfall_review_required',
      reversedGrantCount: 1,
    });
  });

  it('treats cumulative partial refunds that reach the order total as full subscription refunds', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-cumulative-full',
        user_id: 'user-webhook-cumulative-full',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_cumulative_full',
        stripe_invoice_id: 'in_webhook_cumulative_full',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-cumulative-full',
        user_id: 'user-webhook-cumulative-full',
        membership_plan_id: 'plan-webhook-cumulative-full',
        stripe_subscription_id: 'sub_webhook_cumulative_full',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_cumulative_full' },
      }],
      membership_plans: [{
        id: 'plan-webhook-cumulative-full',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-cumulative-full',
        credits: 100,
      }],
      subscription_credit_grants: [1, 2].map((periodIndex) => ({
        id: `grant-webhook-cumulative-full-${periodIndex}`,
        user_id: 'user-webhook-cumulative-full',
        membership_plan_id: 'plan-webhook-cumulative-full',
        stripe_subscription_id: 'sub_webhook_cumulative_full',
        stripe_invoice_id: 'in_webhook_cumulative_full',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: `annual:2026-01-01T00:00:00.000Z:0${periodIndex}`,
        period_start: `2026-0${periodIndex}-01T00:00:00.000Z`,
        period_end: `2026-0${periodIndex + 1}-01T00:00:00.000Z`,
        period_index: periodIndex,
        credits_granted: 10,
        consumed_amount: periodIndex === 2 ? 5 : 10,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      })),
    });
    const retrieveCharge = vi.fn().mockResolvedValue({
      id: 'ch_webhook_cumulative_full',
      amount: 9900,
      amount_refunded: 9900,
      currency: 'usd',
      refunded: true,
      status: 'succeeded',
      invoice: 'in_webhook_cumulative_full',
      payment_intent: 'pi_webhook_cumulative_full',
    } as Stripe.Charge);

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_cumulative_full',
        type: 'refund.created',
        data: {
          object: {
            id: 're_webhook_cumulative_full_second',
            amount: 4900,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_cumulative_full',
            payment_intent: 'pi_webhook_cumulative_full',
            metadata: {},
            created: 1771027200,
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
      {
        now: '2026-03-01T00:00:00.000Z',
        retrieveCharge,
      },
    );

    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_cumulative_full');
    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: true,
      reviewRequired: false,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:02',
      reversedGrantCount: 1,
      clawbackAmount: 5,
      appliedClawbackAmount: 5,
      shortfallAmount: 0,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'refunded',
      payment_status: 'refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_cumulative_full_second',
          eventType: 'refund.created',
          invoiceId: 'in_webhook_cumulative_full',
          amountRefunded: 4900,
          fullRefund: true,
          reviewRequired: false,
          reversalStatus: 'complete',
          reversedGrantCount: 1,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'granted',
      'reversed',
    ]);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -5,
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_refund_id: 're_webhook_cumulative_full_second',
      idempotency_key: 'stripe_refund:subscription_grants:event:evt_webhook_cumulative_full:sub:sub_webhook_cumulative_full:period:annual:2026-01-01T00:00:00.000Z:02',
    });
    expect(supabase.tables.subscription_credit_grants[1].metadata.reversal.idempotencyKey).toBe(
      'stripe_refund:subscription_grants:event:evt_webhook_cumulative_full:sub:sub_webhook_cumulative_full:period:annual:2026-01-01T00:00:00.000Z:02',
    );
    expect(supabase.tables.subscription_credit_grants[0].metadata.reversal).toBeUndefined();

    const refundUpdatedReplay = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_cumulative_full_update',
        type: 'refund.updated',
        data: {
          object: {
            id: 're_webhook_cumulative_full_update',
            amount: 100,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_cumulative_full',
            payment_intent: 'pi_webhook_cumulative_full',
            metadata: {},
            created: 1771027200,
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.updated'; data: { object: Stripe.Refund } },
      {
        now: '2026-03-01T00:05:00.000Z',
        retrieveCharge,
      },
    );

    expect(refundUpdatedReplay).toMatchObject({
      reconciled: true,
      fullRefund: true,
      alreadyReconciled: true,
      reviewRequired: false,
      reversedGrantCount: 1,
      clawbackAmount: 5,
      appliedClawbackAmount: 5,
      shortfallAmount: 0,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_webhook_cumulative_full_second',
      eventType: 'refund.created',
      reversedGrantCount: 1,
      clawbackAmount: 5,
      reviewRequired: false,
    });

    const releaseAfterCumulativeFullRefund = await releaseDueAnnualSubscriptionCredits(supabase, {
      now: new Date('2026-04-15T00:00:00.000Z'),
    });
    expect(releaseAfterCumulativeFullRefund).toMatchObject({
      releasedGrantCount: 0,
      releasedCredits: 0,
      skippedSubscriptions: 1,
    });
  });

  it('applies the same termination and located-period clawback to partial subscription refunds', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-cumulative-partial',
        user_id: 'user-webhook-cumulative-partial',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_subscription_id: 'sub_webhook_cumulative_partial',
        stripe_invoice_id: 'in_webhook_cumulative_partial',
        amount_total: 9900,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        metadata: { source: 'invoice.payment_succeeded' },
      }],
      user_subscriptions: [{
        id: 'subscription-webhook-cumulative-partial',
        user_id: 'user-webhook-cumulative-partial',
        membership_plan_id: 'plan-webhook-cumulative-partial',
        stripe_subscription_id: 'sub_webhook_cumulative_partial',
        billing_cycle: 'yearly',
        status: 'active',
        cancel_at_period_end: 'false',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2027-01-01T00:00:00.000Z',
        metadata: { lastInvoiceId: 'in_webhook_cumulative_partial' },
      }],
      membership_plans: [{
        id: 'plan-webhook-cumulative-partial',
        name: 'Gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-cumulative-partial',
        credits: 100,
      }],
      subscription_credit_grants: [{
        id: 'grant-webhook-cumulative-partial-1',
        user_id: 'user-webhook-cumulative-partial',
        membership_plan_id: 'plan-webhook-cumulative-partial',
        stripe_subscription_id: 'sub_webhook_cumulative_partial',
        stripe_invoice_id: 'in_webhook_cumulative_partial',
        billing_cycle: 'yearly',
        grant_type: 'annual_monthly_release',
        grant_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-02-01T00:00:00.000Z',
        period_index: 1,
        credits_granted: 10,
        consumed_amount: 4,
        status: 'granted',
        metadata: { sourceType: 'stripe_invoice' },
      }],
    });
    const retrieveCharge = vi.fn().mockResolvedValue({
      id: 'ch_webhook_cumulative_partial',
      amount: 9900,
      amount_refunded: 4000,
      currency: 'usd',
      refunded: false,
      status: 'succeeded',
      invoice: 'in_webhook_cumulative_partial',
      payment_intent: 'pi_webhook_cumulative_partial',
    } as Stripe.Charge);

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_webhook_cumulative_partial',
        type: 'refund.created',
        data: {
          object: {
            id: 're_webhook_cumulative_partial_second',
            amount: 2500,
            currency: 'usd',
            status: 'succeeded',
            charge: 'ch_webhook_cumulative_partial',
            payment_intent: 'pi_webhook_cumulative_partial',
            metadata: {},
            created: 1768348800,
          } as Stripe.Refund,
        },
      } as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
      {
        now: '2026-02-01T00:00:00.000Z',
        retrieveCharge,
      },
    );

    expect(retrieveCharge).toHaveBeenCalledWith('ch_webhook_cumulative_partial');
    expect(result).toMatchObject({
      reconciled: true,
      fullRefund: false,
      reviewRequired: false,
      terminationWritten: true,
      locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:01',
      reversedGrantCount: 1,
      clawbackAmount: 6,
      appliedClawbackAmount: 6,
      shortfallAmount: 0,
    });
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partially_refunded',
      payment_status: 'partially_refunded',
      metadata: {
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_cumulative_partial_second',
          eventType: 'refund.created',
          invoiceId: 'in_webhook_cumulative_partial',
          amountRefunded: 2500,
          fullRefund: false,
          reviewRequired: false,
          reversalStatus: 'complete',
          locatedPeriodKey: 'annual:2026-01-01T00:00:00.000Z:01',
          reversedGrantCount: 1,
        }),
      },
    });
    expect(supabase.tables.user_subscriptions[0]).toMatchObject({
      credit_release_terminated_reason: 'stripe_refund:refund.created',
      credit_release_terminated_period_key: 'annual:2026-01-01T00:00:00.000Z:01',
    });
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('reversed');
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -6,
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
      source_refund_id: 're_webhook_cumulative_partial_second',
    });
    expect(supabase.tables.profiles[0].credits).toBe(94);
  });

  it('marks a pending subscription plan-change order failed and releases its lock when the first invoice payment fails', async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown>; orderId?: string }> = [];

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_failed');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_failed');
              return this;
            }

            if (column === 'id') {
              updates[updates.length - 1].orderId = value;
              return Promise.resolve({ error: null });
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          is(column: string, value: null) {
            expect(column).toBe('stripe_invoice_id');
            expect(value).toBeNull();
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-pending-subscription',
                status: 'pending',
                fulfilled_at: null,
                created_at: '2026-06-13T10:25:00.500Z',
                stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_failed',
                metadata: {
                  existing: 'kept',
                  source: 'changeSubscriptionPlan',
                },
              },
              error: null,
            });
          },
          update(payload: Record<string, unknown>) {
            updates.push({ table, payload });
            return this;
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_failed',
        created: 1781346300,
        status: 'open',
        amount_due: 2990,
        amount_paid: 0,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_test_failed',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([
      {
        table: 'payment_orders',
        orderId: 'order-pending-subscription',
        payload: expect.objectContaining({
          stripe_invoice_id: 'in_test_failed',
          stripe_checkout_session_id: null,
          stripe_subscription_id: 'sub_test_failed',
          amount_total: 2990,
          currency: 'usd',
          status: 'failed',
          payment_status: 'open',
          metadata: expect.objectContaining({
            existing: 'kept',
            source: 'invoice.payment_failed',
            invoiceId: 'in_test_failed',
            subscriptionId: 'sub_test_failed',
            lastPaymentOrderStatus: 'failed',
            lastPaymentOrderStatusSource: 'invoice.payment_failed',
          }),
        }),
      },
    ]);
  });

  it('preserves a newer pending plan-change lock during stale failed invoice replay', async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_stale_failed');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_stale_failed');
              return this;
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          order(column: string, options: { ascending: boolean }) {
            expect(column).toBe('created_at');
            expect(options).toEqual({ ascending: false });
            return this;
          },
          neq(column: string, value: string) {
            expect(column).toBe('status');
            expect(value).toBe('failed');
            return this;
          },
          limit(value: number) {
            expect(value).toBe(1);
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-new-plan-change-lock',
                user_id: 'user-stale-failed',
                item_type: 'membership_plan',
                item_id: 'plan-upgrade',
                billing_cycle: 'monthly',
                stripe_invoice_id: null,
                stripe_subscription_id: 'sub_test_stale_failed',
                stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_stale_failed',
                status: 'pending',
                fulfilled_at: null,
                created_at: '2026-06-13T10:20:00.000Z',
                metadata: {
                  existing: 'kept',
                  source: 'changeSubscriptionPlan',
                },
              },
              error: null,
            });
          },
          update(payload: Record<string, unknown>) {
            updates.push({ table, payload });
            return this;
          },
          insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_stale_failed',
        created: 1781344800,
        status: 'open',
        amount_due: 2990,
        amount_paid: 0,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_test_stale_failed',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(loggerState.info).toHaveBeenCalledWith(
      'billing',
      'stripe_invoice_payment_failed_plan_change_lock_preserved',
      expect.objectContaining({
        invoiceId: 'in_test_...failed',
        subscriptionId: 'sub_test...failed',
        orderId: 'order-ne...e-lock',
        sourceOrderCreatedAt: '2026-06-13T10:20:00.000Z',
        invoiceCreatedAt: '2026-06-13T10:00:00.000Z',
      }),
    );
  });

  it('does not infer a stale failed invoice from a later completed upgraded invoice order', async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const lteFilters: Array<[string, unknown]> = [];
    const tables: Record<string, Array<Record<string, any>>> = {
      payment_orders: [
        {
          id: 'order-later-upgraded-completed',
          user_id: 'user-stale-failed-completed',
          item_type: 'membership_plan',
          item_id: 'plan-gold-monthly',
          billing_cycle: 'monthly',
          stripe_invoice_id: 'in_later_upgrade_paid',
          stripe_subscription_id: 'sub_test_stale_failed_completed',
          stripe_customer_id: 'cus_test_stale_failed_completed',
          stripe_price_id: 'price_gold_monthly',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-13T10:20:01.000Z',
          created_at: '2026-06-13T10:20:01.000Z',
          metadata: {
            source: 'invoice.payment_succeeded',
          },
        },
        {
          id: 'order-older-valid-source',
          user_id: 'user-stale-failed-completed',
          item_type: 'membership_plan',
          item_id: 'plan-pro-monthly',
          billing_cycle: 'monthly',
          stripe_invoice_id: null,
          stripe_subscription_id: 'sub_test_stale_failed_completed',
          stripe_customer_id: 'cus_test_stale_failed_completed',
          stripe_price_id: 'price_pro_monthly',
          status: 'completed',
          payment_status: 'paid',
          fulfilled_at: '2026-06-13T09:55:00.000Z',
          created_at: '2026-06-13T09:55:00.000Z',
          metadata: {
            source: 'checkout.session.completed',
          },
        },
      ],
    };

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        const filters: Array<{ column: string; operator: 'eq' | 'neq' | 'lte'; value: unknown }> = [];
        let orderBy: { column: string; ascending: boolean } | null = null;
        let limitValue: number | null = null;

        const matchingRows = () => {
          const rows = tables.payment_orders.filter((row) =>
            filters.every(({ column, operator, value }) => {
              if (operator === 'eq') {
                return row[column] === value;
              }

              if (operator === 'neq') {
                return row[column] !== value;
              }

              return row[column] <= value;
            }),
          );

          const orderedRows = orderBy
            ? [...rows].sort((left, right) => {
              const comparison = left[orderBy.column] > right[orderBy.column] ? 1 : -1;
              return orderBy.ascending ? comparison : -comparison;
            })
            : rows;

          return limitValue === null ? orderedRows : orderedRows.slice(0, limitValue);
        };

        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ column, operator: 'eq', value });
            return this;
          },
          neq(column: string, value: unknown) {
            filters.push({ column, operator: 'neq', value });
            return this;
          },
          lte(column: string, value: unknown) {
            lteFilters.push([column, value]);
            filters.push({ column, operator: 'lte', value });
            return this;
          },
          order(column: string, options: { ascending?: boolean } = {}) {
            orderBy = { column, ascending: options.ascending ?? true };
            return this;
          },
          limit(value: number) {
            limitValue = value;
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: matchingRows()[0] ?? null, error: null });
          },
          update(payload: Record<string, unknown>) {
            updates.push({ table, payload });
            return Promise.resolve({ error: null });
          },
          insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_stale_failed_completed',
        created: Date.parse('2026-06-13T10:00:00.000Z') / 1000,
        status: 'open',
        amount_due: 2990,
        amount_paid: 0,
        currency: 'usd',
        customer: 'cus_test_stale_failed_completed',
        parent: {
          subscription_details: {
            subscription: 'sub_test_stale_failed_completed',
          },
        },
      } as Stripe.Invoice,
    );

    expect(lteFilters).toEqual([['created_at', '2026-06-13T10:00:00.999Z']]);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          user_id: 'user-stale-failed-completed',
          item_id: 'plan-pro-monthly',
          stripe_invoice_id: 'in_test_stale_failed_completed',
          stripe_subscription_id: 'sub_test_stale_failed_completed',
          stripe_price_id: 'price_pro_monthly',
          status: 'failed',
          payment_status: 'open',
        }),
      },
    ]);
    expect(inserts[0]?.payload).not.toMatchObject({
      item_id: 'plan-gold-monthly',
      stripe_price_id: 'price_gold_monthly',
    });
  });

  it('creates a separate failed invoice order for renewal invoice failures without touching the completed checkout order', async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const sourceFilters: Array<[string, unknown]> = [];

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_renewal_failed');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_renewal');
              return this;
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          order(column: string, options: { ascending: boolean }) {
            expect(column).toBe('created_at');
            expect(options).toEqual({ ascending: false });
            return this;
          },
          neq(column: string, value: string) {
            expect(column).toBe('status');
            expect(value).toBe('failed');
            sourceFilters.push([column, value]);
            return this;
          },
          limit(value: number) {
            expect(value).toBe(1);
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-original-checkout-completed',
                user_id: 'user-renewal',
                item_type: 'membership_plan',
                item_id: 'plan-renewal',
                billing_cycle: 'yearly',
                stripe_invoice_id: null,
                stripe_subscription_id: 'sub_test_renewal',
                stripe_customer_id: 'cus_test_renewal',
                stripe_price_id: 'price_test_yearly',
                status: 'completed',
                fulfilled_at: '2026-05-07T09:00:00.000Z',
                metadata: {
                  checkoutSessionId: 'cs_test_completed_original',
                  existing: 'source-kept',
                },
              },
              error: null,
            });
          },
          update(payload: Record<string, unknown>) {
            updates.push({ table, payload });
            return this;
          },
          insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_renewal_failed',
        status: 'open',
        amount_due: 2990,
        amount_paid: 0,
        currency: 'usd',
        customer: 'cus_test_renewal',
        parent: {
          subscription_details: {
            subscription: 'sub_test_renewal',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([]);
    expect(sourceFilters).toEqual([['status', 'failed']]);
    expect(inserts).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          user_id: 'user-renewal',
          item_type: 'membership_plan',
          item_id: 'plan-renewal',
          billing_cycle: 'yearly',
          stripe_invoice_id: 'in_test_renewal_failed',
          stripe_subscription_id: 'sub_test_renewal',
          stripe_customer_id: 'cus_test_renewal',
          stripe_price_id: 'price_test_yearly',
          amount_total: 2990,
          currency: 'usd',
          mode: 'subscription',
          status: 'failed',
          payment_status: 'open',
          metadata: expect.objectContaining({
            checkoutSessionId: 'cs_test_completed_original',
            existing: 'source-kept',
            source: 'invoice.payment_failed',
            invoiceId: 'in_test_renewal_failed',
            subscriptionId: 'sub_test_renewal',
            lastPaymentOrderStatus: 'failed',
            lastPaymentOrderStatusSource: 'invoice.payment_failed',
          }),
        }),
      },
    ]);
  });

  it('leaves a completed checkout order untouched when failed renewal invoice fields cannot be inferred', async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];

    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_renewal_missing_plan');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_missing_plan');
              return this;
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'order-completed-missing-plan',
                user_id: 'user-renewal',
                item_type: 'membership_plan',
                item_id: null,
                billing_cycle: 'monthly',
                stripe_invoice_id: null,
                stripe_subscription_id: 'sub_test_missing_plan',
                stripe_customer_id: 'cus_test_missing_plan',
                stripe_price_id: 'price_test_monthly',
                status: 'completed',
                fulfilled_at: '2026-05-07T09:00:00.000Z',
                metadata: {},
              },
              error: null,
            });
          },
          update(payload: unknown) {
            updates.push(payload);
            return this;
          },
          insert(payload: unknown) {
            inserts.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await markMembershipInvoicePaymentFailed(
      supabase,
      {
        id: 'in_test_renewal_missing_plan',
        status: 'open',
        amount_due: 2990,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_test_missing_plan',
          },
        },
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'stripe_invoice_payment_failed_order_inference_incomplete',
      expect.objectContaining({
        invoiceId: 'in_test_...g_plan',
        subscriptionId: 'sub_test...g_plan',
        sourceOrderId: 'order-co...g-plan',
        sourceOrderStatus: 'completed',
        missingFields: ['item_id'],
      }),
    );
  });

  it('skips invoice payment replay when the invoice order is already blocked by a full-refund marker', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-invoice-refunded-replay',
        user_id: 'user-webhook-invoice-refunded-replay',
        item_id: 'plan-webhook-invoice-refunded-replay',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_webhook_invoice_refunded_replay',
        stripe_subscription_id: 'sub_webhook_invoice_refunded_replay',
        stripe_customer_id: 'cus_webhook_invoice_refunded_replay',
        stripe_price_id: 'price_webhook_invoice_refunded_replay',
        status: 'refunded',
        payment_status: 'refunded',
        metadata: {
          source: 'invoice.payment_succeeded',
          subscriptionCreditGrantReversal: {
            refundId: 're_webhook_invoice_refunded_replay_full',
            fullRefund: true,
            reviewRequired: false,
            reversalStatus: 'complete',
          },
        },
      }],
      membership_plans: [{
        id: 'plan-webhook-invoice-refunded-replay',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-invoice-refunded-replay',
        membership_level: 'free',
        credits: 0,
      }],
    });

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_webhook_invoice_refunded_replay',
        amount_paid: 9900,
        currency: 'usd',
        status: 'paid',
        customer: 'cus_webhook_invoice_refunded_replay',
        created: 1_780_291_200,
        period_start: 1_780_291_200,
        period_end: 1_811_827_200,
        parent: {
          subscription_details: {
            subscription: 'sub_webhook_invoice_refunded_replay',
          },
        },
      } as Stripe.Invoice,
    );

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
        source: 'invoice.payment_succeeded',
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_invoice_refunded_replay_full',
          fullRefund: true,
          reversalStatus: 'complete',
        }),
      },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'subscription_invoice_fulfillment_refund_blocked',
      expect.objectContaining({
        invoiceId: 'in_webho...replay',
        subscriptionId: 'sub_webh...replay',
        orderId: 'order-we...replay',
        reason: 'refunded_status',
      }),
    );
  });

  it('skips invoice payment replay when the invoice order is under partial refund review', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-invoice-partial-review-replay',
        user_id: 'user-webhook-invoice-partial-review-replay',
        item_id: 'plan-webhook-invoice-partial-review-replay',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_webhook_invoice_partial_review_replay',
        stripe_subscription_id: 'sub_webhook_invoice_partial_review_replay',
        stripe_customer_id: 'cus_webhook_invoice_partial_review_replay',
        stripe_price_id: 'price_webhook_invoice_partial_review_replay',
        status: 'partially_refunded',
        payment_status: 'partially_refunded',
        metadata: {
          source: 'subscription_credit_grants_refund_reconciliation',
          subscriptionCreditGrantReversal: {
            refundId: 're_webhook_invoice_partial_review_replay',
            fullRefund: false,
            reviewRequired: true,
            clawbackAmount: 0,
            appliedClawbackAmount: 0,
            shortfallAmount: 0,
            reversalStatus: 'partial_refund_review_required',
          },
        },
      }],
      membership_plans: [{
        id: 'plan-webhook-invoice-partial-review-replay',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-invoice-partial-review-replay',
        membership_level: 'free',
        credits: 0,
      }],
    });

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_webhook_invoice_partial_review_replay',
        amount_paid: 9900,
        currency: 'usd',
        status: 'paid',
        customer: 'cus_webhook_invoice_partial_review_replay',
        created: 1_780_291_200,
        period_start: 1_780_291_200,
        period_end: 1_811_827_200,
        parent: {
          subscription_details: {
            subscription: 'sub_webhook_invoice_partial_review_replay',
          },
        },
      } as Stripe.Invoice,
    );

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
        source: 'subscription_credit_grants_refund_reconciliation',
        subscriptionCreditGrantReversal: expect.objectContaining({
          refundId: 're_webhook_invoice_partial_review_replay',
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
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'subscription_invoice_fulfillment_refund_blocked',
      expect.objectContaining({
        invoiceId: 'in_webho...replay',
        subscriptionId: 'sub_webh...replay',
        orderId: 'order-we...replay',
        reason: 'grant_reversal_partial_review_required',
      }),
    );
  });

  it('skips invoice payment fulfillment when only legacy partial-refund source orders exist', async () => {
    const supabase = createRefundWebhookSupabase({
      payment_orders: [{
        id: 'order-webhook-source-partial-review-only',
        user_id: 'user-webhook-source-partial-review-only',
        item_id: 'plan-webhook-source-partial-review-only',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_invoice_id: 'in_webhook_source_partial_review_old',
        stripe_subscription_id: 'sub_webhook_source_partial_review_only',
        stripe_customer_id: 'cus_webhook_source_partial_review_only',
        stripe_price_id: 'price_webhook_source_partial_review_only',
        status: 'partial_refunded',
        payment_status: 'partial_refunded',
        created_at: '2026-06-01T00:00:00.000Z',
        metadata: { source: 'legacy_refund_marker' },
      }],
      membership_plans: [{
        id: 'plan-webhook-source-partial-review-only',
        name: 'Gold',
        level: 'gold',
        yearly_credits: 120,
      }],
      profiles: [{
        id: 'user-webhook-source-partial-review-only',
        membership_level: 'free',
        credits: 0,
      }],
    });

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_webhook_source_partial_review_replay',
        amount_paid: 9900,
        currency: 'usd',
        status: 'paid',
        customer: 'cus_webhook_source_partial_review_only',
        created: 1_780_291_203,
        period_start: 1_780_291_203,
        period_end: 1_811_827_203,
        parent: {
          subscription_details: {
            subscription: 'sub_webhook_source_partial_review_only',
          },
        },
      } as Stripe.Invoice,
    );

    expect(supabase.tables.subscription_credit_grants).toHaveLength(0);
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.payment_orders).toHaveLength(1);
    expect(supabase.tables.payment_orders[0]).toMatchObject({
      status: 'partial_refunded',
      payment_status: 'partial_refunded',
      metadata: { source: 'legacy_refund_marker' },
    });
    expect(supabase.tables.payment_orders[0]).not.toHaveProperty('fulfilled_at');
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'subscription_invoice_fulfillment_refund_source_blocked',
      expect.objectContaining({
        invoiceId: 'in_webho...replay',
        subscriptionId: 'sub_webh...w_only',
        orderId: 'order-we...w-only',
        reason: 'partial_refund_status',
      }),
    );
  });

  it('preserves generic credit package refund reconciliation through the atomic refund RPC', async () => {
    const { lookups, rpc, supabase } = makeGenericRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_credit_package_refund' },
      order: {
        id: '00000000-0000-4000-8000-000000000300',
        amount_total: 500,
        metadata: {
          checkoutSessionId: 'cs_test_credit_package_refund',
          grantedCredits: 50,
          paymentIntentId: 'pi_test_credit_package_refund',
        },
      },
      rpcData: [
        {
          order_id: '00000000-0000-4000-8000-000000000300',
          user_id: '00000000-0000-4000-8000-000000000101',
          order_status: 'refunded',
          clawback_amount: 50,
          shortfall_amount: 0,
          transaction_id: '00000000-0000-4000-8000-000000000301',
          already_reconciled: false,
        },
      ],
    });

    const result = await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_credit_package_refund',
      eventType: 'refund.created',
      refund: {
        id: 're_test_credit_package_refund',
        amount: 500,
        charge: 'ch_test_credit_package_refund',
        created: 1_742_646_400,
        currency: 'usd',
        metadata: {},
        payment_intent: 'pi_test_credit_package_refund',
        reason: 'requested_by_customer',
        status: 'succeeded',
      } as unknown as Stripe.Refund,
    });

    expect(lookups).toEqual([
      {
        table: 'payment_orders',
        column: 'metadata->>paymentIntentId',
        value: 'pi_test_credit_package_refund',
      },
    ]);
    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_full_refund: true,
      p_order_id: '00000000-0000-4000-8000-000000000300',
      p_payment_intent_id: 'pi_test_credit_package_refund',
      p_refund_id: 're_test_credit_package_refund',
    }));
    expect(result).toEqual(expect.objectContaining({
      order_status: 'refunded',
      clawback_amount: 50,
      shortfall_amount: 0,
    }));
  });

  it('falls back from subscription refund webhook handling to generic refund reconciliation for credit package orders', async () => {
    const { rpc, supabase } = makeGenericRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_credit_package_webhook_refund' },
      order: {
        id: '00000000-0000-4000-8000-000000000310',
        amount_total: 500,
        metadata: {
          itemType: 'credit_package',
          paymentIntentId: 'pi_test_credit_package_webhook_refund',
        },
      },
    });

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_test_credit_package_webhook_refund',
        type: 'refund.created',
        data: {
          object: {
            id: 're_test_credit_package_webhook_refund',
            amount: 500,
            charge: null,
            created: 1_742_646_400,
            currency: 'usd',
            metadata: {},
            payment_intent: 'pi_test_credit_package_webhook_refund',
            reason: 'requested_by_customer',
            status: 'succeeded',
          },
        },
      } as unknown as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
    );

    expect(result).toMatchObject({
      reconciled: true,
      reason: 'non_subscription_order_reconciled',
      orderId: '00000000-0000-4000-8000-000000000310',
    });
    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_order_id: '00000000-0000-4000-8000-000000000310',
      p_refund_id: 're_test_credit_package_webhook_refund',
    }));
  });

  it('falls back to generic refund reconciliation for checkout-session refund metadata without an invoice', async () => {
    const { lookups, rpc, supabase } = makeGenericRefundSupabase({
      match: { column: 'stripe_checkout_session_id', value: 'cs_test_checkout_metadata_refund' },
      order: {
        id: '00000000-0000-4000-8000-000000000320',
        amount_total: 500,
        metadata: {
          itemType: 'credit_package',
          grantedCredits: 50,
        },
      },
    });

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_test_checkout_metadata_refund',
        type: 'refund.created',
        data: {
          object: {
            id: 're_test_checkout_metadata_refund',
            amount: 500,
            charge: null,
            created: 1_742_646_400,
            currency: 'usd',
            metadata: {
              checkoutSessionId: 'cs_test_checkout_metadata_refund',
            },
            payment_intent: null,
            reason: 'requested_by_customer',
            status: 'succeeded',
          } as unknown as Stripe.Refund,
        },
      } as unknown as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
    );

    expect(lookups).toContainEqual(
      {
        table: 'payment_orders',
        column: 'stripe_checkout_session_id',
        value: 'cs_test_checkout_metadata_refund',
      },
    );
    expect(result).toMatchObject({
      reconciled: true,
      reason: 'non_subscription_order_reconciled',
      orderId: null,
    });
    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_order_id: '00000000-0000-4000-8000-000000000320',
      p_refund_id: 're_test_checkout_metadata_refund',
    }));
  });

  it('returns unreconciled for non-invoice refund webhooks that have no generic order match', async () => {
    const supabase = createRefundWebhookSupabase();

    const result = await reconcileSubscriptionRefundFromStripeWebhook(
      supabase,
      {
        id: 'evt_test_unknown_checkout_refund',
        type: 'refund.created',
        data: {
          object: {
            id: 're_test_unknown_checkout_refund',
            amount: 500,
            charge: null,
            created: 1_742_646_400,
            currency: 'usd',
            metadata: {
              checkoutSessionId: 'cs_test_unknown_checkout_refund',
            },
            payment_intent: null,
            reason: 'requested_by_customer',
            status: 'succeeded',
          } as unknown as Stripe.Refund,
        },
      } as unknown as Stripe.Event & { type: 'refund.created'; data: { object: Stripe.Refund } },
    );

    expect(result).toMatchObject({
      reconciled: false,
      reason: 'non_subscription_order_not_found',
      orderId: null,
    });
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'stripe_refund_order_not_found',
      expect.objectContaining({
        checkoutSessionId: 'cs_test_...refund',
        refundId: 're_test_...refund',
      }),
    );
  });

  it('parses subscription id from the legacy invoice.subscription shape', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const tables: Record<string, Array<Record<string, any>>> = {
      payment_orders: [{
        id: 'order-source-legacy',
        user_id: 'user-legacy',
        item_id: 'plan-legacy',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_invoice_id: null,
        stripe_subscription_id: 'sub_test_legacy_shape',
        stripe_checkout_session_id: 'cs_test_legacy_shape',
        stripe_customer_id: 'cus_test_legacy',
        stripe_price_id: 'price_legacy',
      }, {
        id: 'order-invoice-legacy',
        stripe_invoice_id: 'in_test_legacy_shape',
        stripe_subscription_id: 'sub_test_legacy_shape',
        fulfilled_at: '2026-03-22T12:34:56.000Z',
      }],
      membership_plans: [{
        id: 'plan-legacy',
        name: 'Pro',
        level: 'pro',
        monthly_credits: 1000,
        monthly_bonus_credits: 0,
      }],
      profiles: [{
        id: 'user-legacy',
        membership_level: 'free',
      }],
    };

    const supabase = {
      from(table: string) {
        if (!tables[table]) {
          throw new Error(`Unexpected table: ${table}`);
        }

        const filters: Array<{ column: string; operator: 'eq' | 'like'; value: unknown }> = [];
        let mode: 'select' | 'update' = 'select';
        let payload: Record<string, unknown> = {};
        const matchingRows = () => tables[table].filter((row) =>
          filters.every(({ column, operator, value }) => {
            if (operator === 'like') {
              const pattern = String(value);
              if (pattern.endsWith('%')) {
                return typeof row[column] === 'string' && row[column].startsWith(pattern.slice(0, -1));
              }

              return row[column] === value;
            }

            return row[column] === value;
          }),
        );

        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_legacy_shape');
            }

            filters.push({ column, operator: 'eq', value });
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          update(nextPayload: Record<string, unknown>) {
            mode = 'update';
            payload = nextPayload;
            return this;
          },
          is(column: string, value: unknown) {
            filters.push({ column, operator: 'eq', value });
            if (mode === 'update') {
              updates.push({ status: payload.status, payment_status: payload.payment_status });
              matchingRows().forEach((row) => Object.assign(row, payload));
            }

            return Promise.resolve({ error: null });
          },
          like(column: string, value: unknown) {
            filters.push({ column, operator: 'like', value });
            return this;
          },
          async maybeSingle() {
            if (mode === 'update') {
              const rows = matchingRows();
              rows.forEach((row) => Object.assign(row, payload));
              return { data: rows[0] ? { id: rows[0].id } : null, error: null };
            }

            return { data: matchingRows()[0] ?? null, error: null };
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_legacy_shape',
        customer: 'cus_test_legacy',
        status: 'paid',
        currency: 'usd',
        amount_paid: 990,
        subscription: 'sub_test_legacy_shape',
      } as Stripe.Invoice,
    );

    expect(updates).toEqual([
      { status: 'completed', payment_status: 'paid' },
    ]);
    expect(tables.profiles[0]).toMatchObject({ membership_level: 'free' });
  });

  it('logs the subscription grant stage and safe Supabase error when source order lookup fails', async () => {
    const supabase = {
      from(table: string) {
        if (table !== 'payment_orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'stripe_invoice_id') {
              expect(value).toBe('in_test_rpc_failure');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_rpc_failure');
              return this;
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: null,
              error: {
                code: 'P0001',
                message: 'subscription order not found for invoice in_test_rpc_failure',
              },
            });
          },
        };
      },
    };

    await expect(
      fulfillMembershipInvoice(
        supabase,
        {
          id: 'in_test_rpc_failure',
          customer: 'cus_test_rpc',
          status: 'paid',
          currency: 'usd',
          amount_paid: 990,
          parent: {
            subscription_details: {
              subscription: 'sub_test_rpc_failure',
            },
          },
        } as Stripe.Invoice,
      ),
    ).rejects.toMatchObject({
      name: 'SubscriptionCreditGrantError',
      stage: 'subscription_source_order_lookup',
      safeContext: expect.objectContaining({
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
          message: 'subscription order not found for invoice in_test_rpc_failure',
        }),
      }),
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'subscription_credit_grant_stage_failed',
      expect.objectContaining({
        stage: 'subscription_source_order_lookup',
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
        }),
      }),
    );
  });
});
