/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const dashboard = {
  overview: {
    todayCost: 0.001626671224, todayCalls: 3, todayCredits: 2, todayUsd: 0.001626671224,
    monthCost: 12.5, monthCalls: 9, monthCredits: 20, monthUsd: 12.5, avgCostPerCall: 0.0005,
  },
  trend: [], distribution: [], topUsers: [], cacheEfficiency: { hitRate: null, savedValue: null },
};
vi.mock('@/trpc/client', () => ({ trpc: { costs: {
  getDashboard: { useQuery: () => ({ data: dashboard, isLoading: false, isFetching: false, isError: false }) },
} } }));

import AICostsPage from './page';

describe('admin costs overview', () => {
  it('shows compact card amounts with exact values and a real model distribution title', () => {
    const html = renderToStaticMarkup(createElement(AICostsPage));
    expect(html).toContain('≈ $0.001627');
    expect(html).toContain('>$0.001626671224</p>');
    expect(html).toContain('>$12.50</p>');
    expect(html).toContain('模型成本分布');
    expect(html).not.toContain('模型$');
    expect(html).toContain('未知');
  });
});
