/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: { admin: { getFinanceStats: { useQuery: () => ({
  isLoading: false, error: null, refetch: vi.fn(),
  data: { financeOverview: {
    paidRevenueCents: 0, recordedCostUsd: 0.0406667806, estimatedProfitUsd: -0.0406667806,
    creditsConsumed: 41, creditsPurchased: 0, creditsGiven: 0, netCreditsFlow: -41,
  } },
}) } } } }));

import AdminFinancePage from './page';

describe('admin finance overview', () => {
  it('shows the profit card compactly with the exact amount', () => {
    const html = renderToStaticMarkup(createElement(AdminFinancePage));
    expect(html).toContain('≈ -$0.04067');
    expect(html).toContain('>-$0.0406667806</p>');
    expect(html).toContain('md:grid-cols-2 xl:grid-cols-4');
  });
});
