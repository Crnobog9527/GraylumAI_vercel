/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerState = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  logger: loggerState,
}));

import {
  fulfillCreditPackageOrder,
  fulfillMembershipInvoice,
  reconcileStripeRefund,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '../stripeFulfillment';

function makeRefundSupabase(options: {
  match: { column: string; value: string };
  order?: { id: string; amount_total: number | string | null; metadata: Record<string, unknown> | null };
  rpcData?: unknown[];
}) {
  const order = options.order ?? {
    id: '00000000-0000-4000-8000-000000000100',
    amount_total: 990,
    metadata: { grantedCredits: 100 },
  };
  const lookups: Array<{ table: string; column: string; value: string }> = [];
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

  const supabase = {
    rpc,
    from(table: string) {
      if (table !== 'payment_orders') {
        throw new Error(`Refund reconciliation should not touch ${table}`);
      }

      let lookup: { column: string; value: string } | null = null;
      return {
        select() {
          return this;
        },
        eq(column: string, value: string) {
          lookup = { column, value };
          lookups.push({ table, column, value });
          return this;
        },
        maybeSingle() {
          const matched = lookup?.column === options.match.column
            && lookup.value === options.match.value;

          return Promise.resolve({
            data: matched ? order : null,
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

  it('persists stripe_subscription_id when checkout session has an expanded subscription object', async () => {
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
        status: 'completed',
        payment_status: 'paid',
      }),
    );
  });

  it('stores checkout payment intent metadata for future credit package refund lookup', async () => {
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
              data: { id: 'order-credit-payment-intent' },
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
        id: 'cs_test_credit_payment_intent',
        metadata: {
          userId: 'user-1',
          itemType: 'credit_package',
          itemId: 'package-1',
          priceId: 'price_test_credits',
        },
        client_reference_id: 'user-1',
        customer: 'cus_test_123',
        payment_intent: 'pi_test_credit_refund_lookup',
        amount_total: 500,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
      } as Stripe.Checkout.Session,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          checkoutSessionId: 'cs_test_credit_payment_intent',
          paymentIntentId: 'pi_test_credit_refund_lookup',
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
    let profileTouched = false;
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
                return {
                  is(nullColumn: string, nullValue: null) {
                    expect(nullColumn).toBe('stripe_invoice_id');
                    expect(nullValue).toBeNull();
                    return Promise.resolve({ error: null });
                  },
                };
              }

              throw new Error(`Unexpected eq(${column}, ${value})`);
            },
            order() {
              throw new Error('order should not be called when invoice order already exists');
            },
            limit() {
              throw new Error('limit should not be called when invoice order already exists');
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return this;
            },
            insert() {
              throw new Error('insert should not be called when invoice order already exists');
            },
          };
        }

        if (table === 'profiles') {
          profileTouched = true;
          throw new Error('profiles should not be touched during invoice replay');
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
    expect(profileTouched).toBe(false);
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

  it('delegates pending membership invoice fulfillment to the atomic RPC and backfills checkout order', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:34:56.000Z',
        },
      ],
      error: null,
    });
    const updates: Array<{ table: string; payload: unknown }> = [];

    const supabase = {
      rpc,
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq(column: string, value: string) {
              if (column === 'stripe_invoice_id') {
                expect(value).toBe('in_test_atomic');
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: null });
                  },
                };
              }

              if (column === 'stripe_subscription_id') {
                expect(value).toBe('sub_test_atomic');
                return {
                  is(nullColumn: string, nullValue: null) {
                    expect(nullColumn).toBe('stripe_invoice_id');
                    expect(nullValue).toBeNull();
                    return Promise.resolve({ error: null });
                  },
                };
              }

              throw new Error(`Unexpected eq(${column}, ${value})`);
            },
            update(payload: unknown) {
              updates.push({ table, payload });
              return this;
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
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

    expect(rpc).toHaveBeenCalledWith('atomic_fulfill_membership_invoice', {
      p_amount_total: 1990,
      p_currency: 'usd',
      p_invoice_id: 'in_test_atomic',
      p_payment_status: 'paid',
      p_period_end: '2025-04-21T12:26:40.000Z',
      p_period_start: '2025-03-22T12:26:40.000Z',
      p_stripe_customer_id: 'cus_test_atomic',
      p_subscription_id: 'sub_test_atomic',
    });
    expect(updates).toEqual([
      {
        table: 'payment_orders',
        payload: expect.objectContaining({
          fulfilled_at: '2026-03-22T12:34:56.000Z',
          payment_status: 'paid',
          status: 'completed',
        }),
      },
    ]);
  });

  it('parses subscription id from the legacy invoice.subscription shape', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          fulfilled_at: '2026-03-22T12:34:56.000Z',
        },
      ],
      error: null,
    });

    const supabase = {
      rpc,
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
              expect(value).toBe('in_test_legacy_shape');
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            }

            if (column === 'stripe_subscription_id') {
              expect(value).toBe('sub_test_legacy_shape');
              return {
                is() {
                  return Promise.resolve({ error: null });
                },
              };
            }

            throw new Error(`Unexpected eq(${column}, ${value})`);
          },
          update() {
            return this;
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

    expect(rpc).toHaveBeenCalledWith(
      'atomic_fulfill_membership_invoice',
      expect.objectContaining({
        p_invoice_id: 'in_test_legacy_shape',
        p_subscription_id: 'sub_test_legacy_shape',
      }),
    );
  });

  it('backfills invoice refund lookup metadata from invoice payment details', async () => {
    const updates: Array<{ type: string; payload: Record<string, unknown>; column: string; value: string }> = [];
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          invoice_order_id: '00000000-0000-4000-8000-000000000901',
          fulfilled_at: '2026-03-22T12:34:56.000Z',
        },
      ],
      error: null,
    });

    const supabase = {
      rpc,
      from(table: string) {
        expect(table).toBe('payment_orders');

        let selected = '';
        let lookup: { column: string; value: string } | null = null;

        return {
          select(value: string) {
            selected = value;
            return this;
          },
          eq(column: string, value: string) {
            lookup = { column, value };
            return this;
          },
          maybeSingle() {
            if (selected === 'id, fulfilled_at' && lookup?.column === 'stripe_invoice_id') {
              expect(lookup.value).toBe('in_test_invoice_lookup_metadata');
              return Promise.resolve({ data: null, error: null });
            }

            if (selected === 'metadata' && lookup?.column === 'id') {
              expect(lookup.value).toBe('00000000-0000-4000-8000-000000000901');
              return Promise.resolve({
                data: {
                  metadata: {
                    grantedCredits: 5500,
                    fulfillmentSource: 'atomic_fulfill_membership_invoice',
                  },
                },
                error: null,
              });
            }

            throw new Error(`Unexpected maybeSingle(${selected}, ${lookup?.column})`);
          },
          update(payload: Record<string, unknown>) {
            if ('metadata' in payload) {
              return {
                eq(column: string, value: string) {
                  updates.push({ type: 'invoice-metadata', payload, column, value });
                  return Promise.resolve({ error: null });
                },
              };
            }

            return {
              eq(column: string, value: string) {
                return {
                  is(nullColumn: string, nullValue: null) {
                    expect(nullColumn).toBe('stripe_invoice_id');
                    expect(nullValue).toBeNull();
                    updates.push({ type: 'checkout-backfill', payload, column, value });
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_invoice_lookup_metadata',
        customer: 'cus_test_invoice_lookup_metadata',
        status: 'paid',
        currency: 'usd',
        amount_paid: 2990,
        period_start: 1_742_646_400,
        period_end: 1_745_238_400,
        parent: {
          subscription_details: {
            subscription: 'sub_test_invoice_lookup_metadata',
          },
        },
        payments: {
          data: [
            {
              payment: {
                payment_intent: 'pi_test_invoice_lookup_metadata',
                charge: 'ch_test_invoice_lookup_metadata',
              },
            },
          ],
        },
      } as unknown as Stripe.Invoice,
    );

    expect(updates).toEqual([
      {
        type: 'invoice-metadata',
        column: 'id',
        value: '00000000-0000-4000-8000-000000000901',
        payload: {
          metadata: {
            grantedCredits: 5500,
            fulfillmentSource: 'atomic_fulfill_membership_invoice',
            paymentIntentId: 'pi_test_invoice_lookup_metadata',
            chargeId: 'ch_test_invoice_lookup_metadata',
            subscriptionId: 'sub_test_invoice_lookup_metadata',
          },
        },
      },
      {
        type: 'checkout-backfill',
        column: 'stripe_subscription_id',
        value: 'sub_test_invoice_lookup_metadata',
        payload: expect.objectContaining({
          fulfilled_at: '2026-03-22T12:34:56.000Z',
          payment_status: 'paid',
          status: 'completed',
        }),
      },
    ]);
  });

  it('backfills refund lookup metadata when an already fulfilled invoice is replayed', async () => {
    const updates: Array<{ type: string; payload: Record<string, unknown>; column: string; value: string }> = [];
    const rpc = vi.fn();

    const supabase = {
      rpc,
      from(table: string) {
        expect(table).toBe('payment_orders');

        let selected = '';
        let lookup: { column: string; value: string } | null = null;

        return {
          select(value: string) {
            selected = value;
            return this;
          },
          eq(column: string, value: string) {
            lookup = { column, value };
            return this;
          },
          maybeSingle() {
            if (selected === 'id, fulfilled_at' && lookup?.column === 'stripe_invoice_id') {
              return Promise.resolve({
                data: {
                  id: '00000000-0000-4000-8000-000000000902',
                  fulfilled_at: '2026-03-22T12:34:56.000Z',
                },
                error: null,
              });
            }

            if (selected === 'metadata' && lookup?.column === 'id') {
              return Promise.resolve({
                data: { metadata: { grantedCredits: 5500 } },
                error: null,
              });
            }

            throw new Error(`Unexpected maybeSingle(${selected}, ${lookup?.column})`);
          },
          update(payload: Record<string, unknown>) {
            if ('metadata' in payload) {
              return {
                eq(column: string, value: string) {
                  updates.push({ type: 'invoice-metadata', payload, column, value });
                  return Promise.resolve({ error: null });
                },
              };
            }

            return {
              eq(column: string, value: string) {
                return {
                  is() {
                    updates.push({ type: 'checkout-backfill', payload, column, value });
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      },
    };

    await fulfillMembershipInvoice(
      supabase,
      {
        id: 'in_test_replayed_invoice_lookup_metadata',
        customer: 'cus_test_replayed_invoice_lookup_metadata',
        status: 'paid',
        currency: 'usd',
        amount_paid: 2990,
        parent: {
          subscription_details: {
            subscription: 'sub_test_replayed_invoice_lookup_metadata',
          },
        },
        payment_intent: 'pi_test_replayed_invoice_lookup_metadata',
        charge: 'ch_test_replayed_invoice_lookup_metadata',
      } as unknown as Stripe.Invoice,
    );

    expect(rpc).not.toHaveBeenCalled();
    expect(updates[0]).toEqual({
      type: 'invoice-metadata',
      column: 'id',
      value: '00000000-0000-4000-8000-000000000902',
      payload: {
        metadata: {
          grantedCredits: 5500,
          paymentIntentId: 'pi_test_replayed_invoice_lookup_metadata',
          chargeId: 'ch_test_replayed_invoice_lookup_metadata',
          subscriptionId: 'sub_test_replayed_invoice_lookup_metadata',
        },
      },
    });
  });

  it('logs the fulfillment stage and safe Supabase error when the membership RPC fails', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'subscription order not found for invoice in_test_rpc_failure',
      },
    });

    const supabase = {
      rpc,
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

            throw new Error(`Unexpected eq(${column}, ${value})`);
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
      name: 'StripeFulfillmentError',
      stage: 'fulfill_membership_invoice_rpc',
      safeContext: expect.objectContaining({
        invoiceId: 'in_test_...ailure',
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
          message: 'subscription order not found for invoice in_test_...ailure',
        }),
      }),
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'stripe_fulfillment_stage_failed',
      expect.objectContaining({
        stage: 'fulfill_membership_invoice_rpc',
        invoiceId: 'in_test_...ailure',
        subscriptionId: 'sub_test...ailure',
        supabaseError: expect.objectContaining({
          code: 'P0001',
        }),
      }),
    );
  });

  it('reconciles a full membership invoice refund and delegates credit clawback to the atomic RPC', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'stripe_invoice_id', value: 'in_test_refund_full' },
    });

    const result = await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_refund_full',
      eventType: 'charge.refunded',
      charge: {
        id: 'ch_test_refund_full',
        amount: 990,
        amount_refunded: 990,
        currency: 'usd',
        created: 1_742_646_400,
        invoice: 'in_test_refund_full',
        payment_intent: 'pi_test_refund_full',
        refunded: true,
        refunds: {
          data: [
            {
              id: 're_test_refund_full',
              amount: 990,
              created: 1_742_646_500,
              currency: 'usd',
              metadata: {
                subscriptionId: 'sub_test_refund_full',
              },
              reason: 'requested_by_customer',
              status: 'succeeded',
            },
          ],
        },
      } as unknown as Stripe.Charge,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_charge_id: 'ch_test_refund_full',
      p_idempotency_key: 'stripe_refund:re_test_refund_full',
      p_invoice_id: 'in_test_refund_full',
      p_is_failed: false,
      p_is_full_refund: true,
      p_refund_amount: 990,
      p_refund_currency: 'usd',
      p_refund_event_type: 'charge.refunded',
      p_refund_id: 're_test_refund_full',
      p_refund_reason: 'requested_by_customer',
      p_refund_status: 'succeeded',
      p_subscription_id: 'sub_test_refund_full',
    }));
    expect(result).toEqual(expect.objectContaining({
      order_status: 'refunded',
      clawback_amount: 100,
      shortfall_amount: 0,
    }));
  });

  it('reconciles charge.refunded through stored payment intent metadata when charge has no invoice id', async () => {
    const { lookups, rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_charge_refund_no_invoice' },
    });

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_charge_refund_no_invoice',
      eventType: 'charge.refunded',
      charge: {
        id: 'ch_test_charge_refund_no_invoice',
        amount: 2990,
        amount_refunded: 2990,
        currency: 'usd',
        created: 1_742_646_400,
        invoice: null,
        payment_intent: 'pi_test_charge_refund_no_invoice',
        refunded: true,
        refunds: {
          data: [
            {
              id: 're_test_charge_refund_no_invoice',
              amount: 2990,
              created: 1_742_646_500,
              currency: 'usd',
              metadata: {},
              reason: 'requested_by_customer',
              status: 'succeeded',
            },
          ],
        },
      } as unknown as Stripe.Charge,
    });

    expect(lookups).toEqual([
      {
        table: 'payment_orders',
        column: 'metadata->>paymentIntentId',
        value: 'pi_test_charge_refund_no_invoice',
      },
    ]);
    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_charge_id: 'ch_test_charge_refund_no_invoice',
      p_idempotency_key: 'stripe_refund:re_test_charge_refund_no_invoice',
      p_is_full_refund: true,
      p_payment_intent_id: 'pi_test_charge_refund_no_invoice',
      p_refund_event_type: 'charge.refunded',
      p_refund_id: 're_test_charge_refund_no_invoice',
    }));
  });

  it('uses a stable refund idempotency key for duplicate refund events', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_duplicate_refund' },
      rpcData: [
        {
          order_id: '00000000-0000-4000-8000-000000000100',
          order_status: 'refunded',
          clawback_amount: 100,
          shortfall_amount: 0,
          transaction_id: '00000000-0000-4000-8000-000000000102',
          already_reconciled: false,
        },
        {
          order_id: '00000000-0000-4000-8000-000000000100',
          order_status: 'refunded',
          clawback_amount: 0,
          shortfall_amount: 0,
          transaction_id: '00000000-0000-4000-8000-000000000102',
          already_reconciled: true,
        },
      ],
    });
    const refund = {
      id: 're_test_duplicate_refund',
      amount: 990,
      charge: 'ch_test_duplicate_refund',
      created: 1_742_646_400,
      currency: 'usd',
      metadata: {},
      payment_intent: 'pi_test_duplicate_refund',
      reason: 'requested_by_customer',
      status: 'succeeded',
    } as unknown as Stripe.Refund;

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_duplicate_refund_1',
      eventType: 'refund.created',
      refund,
    });
    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_duplicate_refund_2',
      eventType: 'refund.updated',
      refund,
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map((call) => call[1].p_idempotency_key)).toEqual([
      'stripe_refund:re_test_duplicate_refund',
      'stripe_refund:re_test_duplicate_refund',
    ]);
  });

  it('records partial refunds without requesting a full credit clawback or subscription downgrade', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_partial_refund' },
      rpcData: [
        {
          order_id: '00000000-0000-4000-8000-000000000100',
          order_status: 'partial_refunded',
          clawback_amount: 0,
          shortfall_amount: 0,
          transaction_id: null,
          already_reconciled: false,
        },
      ],
    });

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_partial_refund',
      eventType: 'refund.updated',
      refund: {
        id: 're_test_partial_refund',
        amount: 100,
        charge: 'ch_test_partial_refund',
        created: 1_742_646_400,
        currency: 'usd',
        metadata: {},
        payment_intent: 'pi_test_partial_refund',
        reason: 'requested_by_customer',
        status: 'succeeded',
      } as unknown as Stripe.Refund,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_full_refund: false,
      p_refund_amount: 100,
      p_refund_event_type: 'refund.updated',
      p_refund_id: 're_test_partial_refund',
    }));
  });

  it('keeps cancel-only handling scoped to subscription downgrade without credit clawback', async () => {
    const tableCalls: string[] = [];
    const subscriptionUpdates: unknown[] = [];
    const profileUpdates: unknown[] = [];

    const supabase = {
      from(table: string) {
        tableCalls.push(table);

        if (table === 'user_subscriptions') {
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
                  user_id: '00000000-0000-4000-8000-000000000200',
                  membership_plan_id: 'plan-pro',
                },
                error: null,
              });
            },
            update(payload: unknown) {
              subscriptionUpdates.push(payload);
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'profiles') {
          return {
            update(payload: unknown) {
              profileUpdates.push(payload);
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`cancel-only should not touch ${table}`);
      },
    };

    await syncSubscriptionState(supabase, {
      id: 'sub_test_cancel_only',
      cancel_at_period_end: false,
      status: 'canceled',
      items: {
        data: [
          {
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    } as unknown as Stripe.Subscription);

    expect(tableCalls).toEqual(['user_subscriptions', 'user_subscriptions', 'profiles']);
    expect(subscriptionUpdates).toEqual([
      expect.objectContaining({
        status: 'canceled',
        cancel_at_period_end: 'false',
      }),
    ]);
    expect(profileUpdates).toEqual([
      { membership_level: 'free' },
    ]);
  });

  it('does not claim a Stripe subscription was canceled for refund-only events', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_refund_only' },
    });

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_refund_only',
      eventType: 'refund.created',
      refund: {
        id: 're_test_refund_only',
        amount: 990,
        charge: 'ch_test_refund_only',
        created: 1_742_646_400,
        currency: 'usd',
        metadata: {},
        payment_intent: 'pi_test_refund_only',
        reason: 'requested_by_customer',
        status: 'succeeded',
      } as unknown as Stripe.Refund,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_full_refund: true,
      p_subscription_id: null,
    }));
  });

  it('returns insufficient-credit shortfall details from the atomic refund RPC', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_refund_shortfall' },
      rpcData: [
        {
          order_id: '00000000-0000-4000-8000-000000000100',
          order_status: 'refunded',
          clawback_amount: 20,
          shortfall_amount: 80,
          transaction_id: '00000000-0000-4000-8000-000000000102',
          already_reconciled: false,
        },
      ],
    });

    const result = await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_refund_shortfall',
      eventType: 'refund.created',
      refund: {
        id: 're_test_refund_shortfall',
        amount: 990,
        charge: 'ch_test_refund_shortfall',
        created: 1_742_646_400,
        currency: 'usd',
        metadata: {},
        payment_intent: 'pi_test_refund_shortfall',
        reason: 'requested_by_customer',
        status: 'succeeded',
      } as unknown as Stripe.Refund,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_full_refund: true,
      p_refund_id: 're_test_refund_shortfall',
    }));
    expect(result).toEqual(expect.objectContaining({
      clawback_amount: 20,
      shortfall_amount: 80,
    }));
  });

  it('delegates missing grantedCredits full refunds to the RPC without local entitlement guesses', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_missing_granted_credits' },
      order: {
        id: '00000000-0000-4000-8000-000000000250',
        amount_total: 990,
        metadata: {},
      },
      rpcData: [
        {
          order_id: '00000000-0000-4000-8000-000000000250',
          order_status: 'refunded',
          clawback_amount: 0,
          shortfall_amount: 0,
          transaction_id: null,
          already_reconciled: false,
        },
      ],
    });

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_missing_granted_credits',
      eventType: 'refund.created',
      refund: {
        id: 're_test_missing_granted_credits',
        amount: 990,
        charge: 'ch_test_missing_granted_credits',
        created: 1_742_646_400,
        currency: 'usd',
        metadata: {},
        payment_intent: 'pi_test_missing_granted_credits',
        reason: 'requested_by_customer',
        status: 'succeeded',
      } as unknown as Stripe.Refund,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_full_refund: true,
      p_order_id: '00000000-0000-4000-8000-000000000250',
      p_refund_id: 're_test_missing_granted_credits',
    }));
  });

  it('reconciles credit package refunds through checkout payment intent metadata', async () => {
    const { lookups, rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_credit_package_refund' },
      order: {
        id: '00000000-0000-4000-8000-000000000300',
        amount_total: 500,
        metadata: {
          checkoutSessionId: 'cs_test_credit_package_refund',
          grantedCredits: 50,
        },
      },
    });

    await reconcileStripeRefund(supabase, {
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
    }));
  });

  it('records refund.failed events without requesting entitlement recovery', async () => {
    const { rpc, supabase } = makeRefundSupabase({
      match: { column: 'metadata->>paymentIntentId', value: 'pi_test_refund_failed' },
    });

    await reconcileStripeRefund(supabase, {
      eventId: 'evt_test_refund_failed',
      eventType: 'refund.failed',
      refund: {
        id: 're_test_refund_failed',
        amount: 990,
        charge: 'ch_test_refund_failed',
        created: 1_742_646_400,
        currency: 'usd',
        failure_reason: 'lost_or_stolen_card',
        metadata: {},
        payment_intent: 'pi_test_refund_failed',
        reason: null,
        status: 'failed',
      } as unknown as Stripe.Refund,
    });

    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_stripe_refund', expect.objectContaining({
      p_is_failed: true,
      p_is_full_refund: false,
      p_refund_event_type: 'refund.failed',
      p_refund_reason: 'lost_or_stolen_card',
      p_refund_status: 'failed',
    }));
  });
});
