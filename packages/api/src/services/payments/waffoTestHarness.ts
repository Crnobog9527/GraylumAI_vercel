/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Test-only helpers for the Waffo payment services. Not imported by production code.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WaffoPayment } from './waffoPayments';

type Row = Record<string, unknown>;
const field = (row: Row, column: string) => column.includes('->>')
  ? (row[column.split('->>')[0]!] as Row | null)?.[column.split('->>')[1]!] : row[column];

/** Minimal in-memory PostgREST stand-in: select/eq/in/is/lt/order/limit/maybeSingle and awaiting a list. */
export function fakeDb(tables: Record<string, Row[]>, rpc: (fn: string, args: Row) => unknown) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { rows = rows.filter(row => field(row, column) === value); return query; },
      in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(field(row, column))); return query; },
      is: (column: string, value: null) => { rows = rows.filter(row => (field(row, column) ?? null) === value); return query; },
      limit: (count: number) => { rows = rows.slice(0, count); return query; },
      lt: (column: string, value: string) => { rows = rows.filter(row => String(field(row, column)) < value); return query; },
      order: (column: string, options: { ascending: boolean }) => {
        rows = [...rows].sort((a, b) => String(field(a, column)).localeCompare(String(field(b, column))) * (options.ascending ? 1 : -1));
        return query;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    };
    return query;
  };
  return { from, rpc } as unknown as SupabaseClient;
}

/** Shape of the measured 69 USD test payment (#802 sample), with overridable fields. */
export function payment(overrides: Partial<WaffoPayment> = {}, order: Partial<NonNullable<WaffoPayment['subscriptionOrder']>> = {}): WaffoPayment {
  return {
    id: 'PAY_fixture1', orderId: 'ORD_fixture1', status: 'succeeded', testMode: true,
    orderMerchantExternalId: '00000000-0000-4000-8000-000000000001', periodNumber: 1, createdAt: '2026-10-11T05:59:48.325Z',
    amount: { amount: '6900', currency: 'USD' }, refundedAmount: { amount: '0', currency: 'USD' }, refundStatus: 'none',
    isFullyRefunded: false, pspAmountDetails: { amount: '69.00', currency: 'USD' }, paymentMethod: { type: 'card' },
    ...overrides,
    subscriptionOrder: overrides.subscriptionOrder === null ? null : {
      id: 'ORD_fixture1', storeId: 'STO_fixture', status: 'active', currentPeriodNumber: 1,
      currentPeriodStart: '2026-10-11T05:59:47.000Z', currentPeriodEnd: '2026-11-11T05:59:47.000Z', testMode: true,
      orderMerchantExternalId: '00000000-0000-4000-8000-000000000001', subscriptionProduct: { id: 'PROD_fixture' }, ...order,
    },
  };
}
