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
  upsertPaymentOrderBySession,
} from '../stripeFulfillment';

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
      ['stripe_invoice_id', null],
      ['status', 'failed'],
    ]);
    expect(profileUpdates).toEqual([]);
    expect(transactionsTouched).toBe(false);
    expect(subscriptionTouched).toBe(false);
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
        stripe_customer_id: 'cus_test_atomic',
        stripe_price_id: 'price_yearly',
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
        const filters: Array<{ column: string; value: unknown }> = [];
        let mode: 'select' | 'insert' | 'update' = 'select';
        let payload: Record<string, unknown> = {};

        const matchingRows = () => tables[table].filter((row) =>
          filters.every(({ column, value }) => row[column] === value),
        );

        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ column, value });
            return this;
          },
          is(column: string, value: unknown) {
            filters.push({ column, value });
            if (mode === 'update') {
              matchingRows().forEach((row) => Object.assign(row, payload));
            }
            return Promise.resolve({ error: null });
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

  it('marks the pending subscription checkout order failed when the first invoice payment fails', async () => {
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
                metadata: {
                  existing: 'kept',
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

        const filters: Array<{ column: string; value: unknown }> = [];
        let mode: 'select' | 'update' = 'select';
        let payload: Record<string, unknown> = {};
        const matchingRows = () => tables[table].filter((row) =>
          filters.every(({ column, value }) => row[column] === value),
        );

        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_legacy_shape');
            }

            filters.push({ column, value });
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
            filters.push({ column, value });
            if (mode === 'update') {
              updates.push({ status: payload.status, payment_status: payload.payment_status });
              matchingRows().forEach((row) => Object.assign(row, payload));
            }

            return Promise.resolve({ error: null });
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
