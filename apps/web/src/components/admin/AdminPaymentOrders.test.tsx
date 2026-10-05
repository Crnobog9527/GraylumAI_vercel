/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const calls: unknown[] = [];
const order = {
  id: 'order-1', itemType: 'membership_plan', billingCycle: 'yearly', status: 'completed', paymentStatus: 'paid',
  amountMinor: 49600, currency: 'usd', createdAt: '2026-10-05T00:00:00Z', fulfilledAt: null,
  paymentChannel: 'stripe', paymentChannelLabel: 'Stripe', paymentMode: 'test', documentSource: 'stripe',
  documentStatus: 'unknown', amountFacts: [{ kind: 'paid', amount: '496.00', currency: 'usd', unit: 'major' }],
  invoiceNumber: null, invoicePdfUrl: null, hostedInvoiceUrl: null, receiptUrl: null,
};
vi.mock('@/trpc/client', () => ({ trpc: { payments: { listAdminOrders: {
  useQuery: (input: unknown) => {
    calls.push(input);
    return { data: { items: [order, { ...order, id: 'order-2', amountMinor: null, documentStatus: 'unavailable' }], total: 45 },
      error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
  },
} } } }));

import { AdminPaymentOrders } from './AdminPaymentOrders';

describe('AdminPaymentOrders', () => {
  it('requests a bounded page and shows only API fields with unknowns kept unknown', () => {
    const html = renderToStaticMarkup(createElement(AdminPaymentOrders));
    expect(calls[0]).toEqual({ offset: 0, limit: 20 });
    expect(html).toContain('共 45 笔');
    expect(html).toContain('第 1 / 3 页');
    expect(html).toContain('$496.00');
    expect(html).toContain('Stripe · 测试');
    expect(html).toContain('会员订阅');
    expect(html).toContain('年付');
    expect(html).toContain('<dt>渠道手续费</dt><dd style="color:var(--text-secondary)">未知</dd>');
    expect(html).toContain('<dt>到账净额</dt><dd style="color:var(--text-secondary)">未知</dd>');
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('data-status="unavailable"');
    // A null order amount is unknown, not $0.00.
    expect(html).not.toContain('$0.00');
  });
});
