/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[], isError: false }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ admin: { listPackRefundReviews: { invalidate: vi.fn() } } }),
  admin: {
    listPackRefundReviews: { useQuery: () => ({ data: state.rows, isLoading: false, isError: state.isError }) },
    settlePackRefundReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
} }));

import { AdminPackRefundReviews } from './AdminPackRefundReviews';

describe('externally refunded packs held for a person (deep review item 14)', () => {
  it('lists each held pack with its credits and the two decisions, and nothing is sent before a confirmation', () => {
    state.rows = [{ orderId: 'order-1', userId: 'user-1', method: 'alipay', currency: 'usd', packCredits: 2990,
      balanceAtRefund: 3100, refundedMinor: 2990, chargedMinor: 2990, refundedAt: '2026-11-11T00:00:00Z' }];
    const html = renderToStaticMarkup(createElement(AdminPackRefundReviews));
    expect(html).toContain('站外退款的积分包');
    expect(html).toContain('data-testid="pack-refund-review-order-1"');
    expect(html).toContain('支付宝');
    expect(html).toContain('29.90 USD');
    expect(html).toContain('积分包积分：2990 积分');
    expect(html).toContain('收回剩余积分');
    expect(html).toContain('不收回');
    expect(html).toContain('处理后不能更改');
    expect(html).not.toContain('pack-refund-review-confirm');
  });
  it('says when there is nothing to settle, and when the list cannot be read', () => {
    state.rows = [];
    expect(renderToStaticMarkup(createElement(AdminPackRefundReviews))).toContain('暂无待处理的积分包退款');
    state.isError = true;
    expect(renderToStaticMarkup(createElement(AdminPackRefundReviews))).toContain('暂时无法读取');
    state.isError = false;
  });
});
