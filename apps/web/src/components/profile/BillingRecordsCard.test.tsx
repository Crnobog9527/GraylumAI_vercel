/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: { data?: unknown[]; isError?: boolean } = {};
vi.mock('@/trpc/client', () => ({ trpc: { payments: { listBillingRecords: {
  useQuery: () => ({ data: state.data, isLoading: false, isError: Boolean(state.isError), refetch: vi.fn() }),
} } } }));

import BillingRecordsCard from './BillingRecordsCard';

const base = {
  itemType: 'credit_package', title: '加油包', description: '一次性积分购买', status: 'completed', amountTotal: 9.9,
  currency: 'usd', billingCycle: 'one_time', createdAt: '2026-10-05T00:00:00Z', fulfilledAt: null, invoiceNumber: null,
  invoicePdfUrl: null, hostedInvoiceUrl: null, receiptUrl: null, paymentChannel: 'stripe', paymentChannelLabel: 'Stripe',
  paymentMode: 'test', documentSource: 'stripe', amountFacts: [],
};

describe('BillingRecordsCard', () => {
  beforeEach(() => { state.data = undefined; state.isError = false; });

  it('shows unknown and unavailable documents differently and never as no document when unknown', () => {
    state.data = [{ ...base, id: 'a', documentStatus: 'unknown' }, { ...base, id: 'b', documentStatus: 'unavailable' }];
    const html = renderToStaticMarkup(createElement(BillingRecordsCard));
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('凭证暂时无法核实');
    expect(html).toContain('data-status="unavailable"');
    expect(html).toContain('没有可用凭证');
    expect(html).toContain('支付渠道 Stripe');
  });

  it('shows a null paid amount as unknown and hides merchant-side facts', () => {
    state.data = [{ ...base, id: 'a', documentStatus: 'available', receiptUrl: 'https://example.test/receipt',
      amountFacts: [{ kind: 'paid', amount: null, currency: 'usd', unit: 'major' },
        { kind: 'fee', amount: '0.59', currency: 'usd', unit: 'major' }] }];
    const html = renderToStaticMarkup(createElement(BillingRecordsCard));
    expect(html).toContain('<dt>实付</dt><dd style="color:var(--text-secondary)">未知</dd>');
    expect(html).not.toContain('渠道手续费');
    expect(html).toContain('href="https://example.test/receipt"');
    expect(html).toContain('凭证可查看');
  });

  it('shows a Stripe tax-exclusive order as the tax-inclusive amount charged', () => {
    state.data = [{ ...base, id: 'a', itemType: 'membership_plan', amountTotal: 496, documentStatus: 'available',
      amountFacts: [{ kind: 'paid', amount: '496.00', currency: 'usd', unit: 'major' },
        { kind: 'tax', amount: '24.80', currency: 'usd', unit: 'major' }] }];
    const html = renderToStaticMarkup(createElement(BillingRecordsCard));
    expect(html).toContain('$520.80');
    expect(html).not.toContain('$496.00');
    expect(html).toContain('<dt>实付</dt><dd');
    expect(html).toContain('USD 520.80（含税 USD 24.80）');
    expect(html).not.toContain('<dt>税费</dt>');
  });

  it('labels a missing channel as unknown', () => {
    state.data = [{ ...base, id: 'a', paymentChannel: null, paymentChannelLabel: '未知渠道', documentStatus: 'unknown' }];
    expect(renderToStaticMarkup(createElement(BillingRecordsCard))).toContain('支付渠道 未知渠道');
  });

  it('shows a read failure instead of an empty list', () => {
    state.isError = true;
    const html = renderToStaticMarkup(createElement(BillingRecordsCard));
    expect(html).toContain('data-testid="billing-records-error"');
    expect(html).not.toContain('暂无账单记录');
  });
});
