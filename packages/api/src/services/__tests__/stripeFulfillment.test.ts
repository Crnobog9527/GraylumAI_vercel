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
  markMembershipInvoicePaymentFailed,
  reconcileSubscriptionRefundFromStripeWebhook,
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
  private filters: Array<{ column: string; value: unknown; operator: 'eq' | 'neq' | 'lte' }> = [];
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
      return { data: rows[0] ? { id: rows[0].id } : null, error: null };
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

        return row[column] <= value;
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

describe('stripe fulfillment helpers', () => {
  beforeEach(() => {
    loggerState.error.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
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
          grant_period_key: `sub_webhook_charge_refund:2026-0${periodIndex}:0${periodIndex}`,
          period_index: periodIndex,
          credits_granted: 10,
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
          grant_period_key: `sub_webhook_charge_refund:2027-0${periodIndex}:0${periodIndex}`,
          period_index: periodIndex,
          credits_granted: 10,
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
            refunds: {
              data: [{
                id: 're_webhook_charge_refund_full',
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
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 20,
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
          reversedGrantCount: 2,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_webhook_charge_refund_2026')
      .map((grant) => grant.status)).toEqual(['granted', 'granted']);
    expect(supabase.tables.subscription_credit_grants
      .filter((grant) => grant.stripe_invoice_id === 'in_webhook_charge_refund_2027')
      .map((grant) => grant.status)).toEqual(['reversed', 'reversed']);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -20,
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
            refunds: {
              data: [{
                id: 're_webhook_charge_refund_full',
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
        grant_period_key: `sub_webhook_refund_created:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
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
      reversedGrantCount: 3,
      clawbackAmount: 30,
      appliedClawbackAmount: 5,
      shortfallAmount: 25,
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
          clawbackAmount: 30,
          appliedClawbackAmount: 5,
          shortfallAmount: 25,
          shortfallReason: 'insufficient_balance',
          reversalStatus: 'shortfall_review_required',
          reversedGrantCount: 3,
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
        requiredClawbackAmount: 30,
        shortfallAmount: 25,
      }),
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
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
            refunds: {
              data: [{
                id: 're_webhook_refund_created_charge_later',
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
      reversedGrantCount: 3,
      clawbackAmount: 30,
      appliedClawbackAmount: 5,
      shortfallAmount: 25,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_webhook_refund_created_full',
      eventType: 'refund.created',
      invoiceId: 'in_webhook_refund_created',
      reviewRequired: true,
      shortfallAmount: 25,
      reversalStatus: 'shortfall_review_required',
      reversedGrantCount: 3,
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
        grant_period_key: `sub_webhook_cumulative_full:2026-0${periodIndex}:0${periodIndex}`,
        period_index: periodIndex,
        credits_granted: 10,
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
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 20,
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
          reversedGrantCount: 2,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) => grant.status)).toEqual([
      'reversed',
      'reversed',
    ]);
    expect(supabase.tables.credit_transactions[0]).toMatchObject({
      amount: -20,
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_refund_id: 're_webhook_cumulative_full_second',
      idempotency_key: 'stripe_refund:subscription_grants:invoice:in_webhook_cumulative_full:sub_webhook_cumulative_full',
    });
    expect(supabase.tables.subscription_credit_grants.map((grant) =>
      grant.metadata.reversal.idempotencyKey,
    )).toEqual([
      'stripe_refund:subscription_grants:invoice:in_webhook_cumulative_full:sub_webhook_cumulative_full',
      'stripe_refund:subscription_grants:invoice:in_webhook_cumulative_full:sub_webhook_cumulative_full',
    ]);

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
      reversedGrantCount: 2,
      clawbackAmount: 20,
      appliedClawbackAmount: 20,
      shortfallAmount: 0,
      creditTransactionId: 'txn-refund-webhook-1',
    });
    expect(supabase.tables.credit_transactions).toHaveLength(1);
    expect(supabase.tables.payment_orders[0].metadata.subscriptionCreditGrantReversal).toMatchObject({
      refundId: 're_webhook_cumulative_full_second',
      eventType: 'refund.created',
      reversedGrantCount: 2,
      clawbackAmount: 20,
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

  it('keeps cumulative partial refunds below the order total in review without clawback', async () => {
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
        grant_period_key: 'sub_webhook_cumulative_partial:2026-01:01',
        period_index: 1,
        credits_granted: 10,
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
          refundId: 're_webhook_cumulative_partial_second',
          eventType: 'refund.created',
          invoiceId: 'in_webhook_cumulative_partial',
          amountRefunded: 2500,
          fullRefund: false,
          reviewRequired: true,
          reversalStatus: 'partial_refund_review_required',
          reversedGrantCount: 0,
        }),
      },
    });
    expect(supabase.tables.subscription_credit_grants[0].status).toBe('granted');
    expect(supabase.tables.credit_transactions).toHaveLength(0);
    expect(supabase.tables.profiles[0].credits).toBe(100);
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
