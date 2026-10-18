/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: {
    useUtils: () => ({ admin: { previewPackageRefund: { fetch: vi.fn() }, getPackageRefundStatus: { fetch: vi.fn() } } }),
    admin: { decidePackageRefund: { useMutation: mutation }, executePackageRefund: { useMutation: mutation },
      reconcilePackageRefund: { useMutation: mutation }, rejectPackageRefund: { useMutation: mutation } },
  } };
});

import { AdminPackageRefunds } from './AdminPackageRefunds';

describe('admin credit-pack refund section (PAY-STRIPE-MP 4b-1)', () => {
  it('asks for the order, the billing ticket, the fee decision and its evidence before any quote', () => {
    const html = renderToStaticMarkup(createElement(AdminPackageRefunds));
    expect(html).toContain('积分包和钱包会员退款');
    for (const id of ['package-refund-orderId', 'package-refund-ticketId', 'package-refund-feePermitted', 'package-refund-feeEvidence']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('付款 7 天内、而且付款后整个账户没有用过任何积分才可退');
    expect(html).toContain('6% 手续费只按税前金额算');
    expect(html).toContain('data-testid="package-refund-quote-button"');
    // Nothing to approve or execute before a server quote.
    expect(html).not.toContain('package-refund-approve-button');
    expect(html).not.toContain('package-refund-execute-button');
  });
});
