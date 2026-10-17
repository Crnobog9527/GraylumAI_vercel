/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonthlyRefundQuoteCard, type MonthlyRefundQuoteTerms } from './MonthlyRefundQuoteCard';

const terms: MonthlyRefundQuoteTerms = { orderId: 'order', ticketId: 'ticket', plan: 'gold', currency: 'usd', mode: 'test',
  paidMinor: 6900, basisMinor: 6900, feeMinor: 414, netMinor: 6486, credits: 8970, paidAt: '2026-10-05T00:00:00Z',
  submittedAt: '2026-10-07T00:00:00Z', periodEnd: '2026-11-05T00:00:00Z', feePermitted: 'confirmed',
  feeEvidence: 'legal:us-ca:2026-10', evidenceRefs: ['a', 'b', 'c', 'd'] };
const render = (t: MonthlyRefundQuoteTerms) =>
  renderToStaticMarkup(createElement(MonthlyRefundQuoteCard, { terms: t, approving: false, disabled: false, onApprove: () => {} }));

describe('monthly refund quote card', () => {
  it('shows the amount charged as before for an order without tax', () => {
    const html = render(terms);
    expect(html).toContain('实付金额');
    expect(html).not.toContain('含税');
  });
  it('breaks an international card charge into the pre-tax price and the tax refunded in full (PAY-STRIPE-MP)', () => {
    const html = render({ ...terms, taxMinor: 1380, netMinor: 7866 });
    expect(html).toContain('实付金额（含税）');
    expect(html).toContain('82.80');
    expect(html).toContain('其中税前价');
    expect(html).toContain('其中税（全额退回）');
    expect(html).toContain('13.80');
    expect(html).toContain('78.66');
  });
  it('R7: labels a live refund as real money and never claims it is sandbox-only', () => {
    const live = render({ ...terms, mode: 'live' });
    expect(live).toContain('正式（真实付款，会退真钱）');
    expect(live).not.toContain('只在测试模式');
    expect(render(terms)).toContain('测试（Stripe 沙盒）');
  });
});
