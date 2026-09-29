/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cacheHitRate: null as number | null }));
vi.mock('@/trpc/client', () => ({ trpc: { admin: { getPerformanceStats: { useQuery: () => ({
  isLoading: false, error: null, refetch: vi.fn(),
  data: {
    aiPerformance: {
      totalRequests: 3, rangeRequests: 3, avgResponseTime: 100, p95ResponseTime: 200,
      errorRate: 0.5, cacheHitRate: state.cacheHitRate, healthStatus: 'healthy',
    },
    costStats: { totalCost: 0.001626671224, avgCostPerRequest: 0.0005, cacheSavings: 0.00009, estimatedMonthly: 1 },
  },
}) } } } }));
// Render every tab so the cost cards are part of the static markup.
vi.mock('@/components/ui/tabs', () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Tabs: Pass, TabsList: Pass, TabsTrigger: Pass, TabsContent: Pass };
});

import AdminPerformancePage from './page';

beforeEach(() => { state.cacheHitRate = null; });

describe('admin performance page', () => {
  it('shows an unknown cache hit rate without claiming savings', () => {
    const html = renderToStaticMarkup(createElement(AdminPerformancePage));
    expect(html).toContain('>未知</p>');
    expect(html).toContain('命中率 未知');
    expect(html).not.toContain('节省成本');
    expect(html).not.toContain('>0%</p>');
  });

  it('shows a known cache hit rate with the savings hint', () => {
    state.cacheHitRate = 20;
    const html = renderToStaticMarkup(createElement(AdminPerformancePage));
    expect(html).toContain('>20%</p>');
    expect(html).toContain('节省成本');
  });

  it('shows compact cost card amounts with exact values', () => {
    const html = renderToStaticMarkup(createElement(AdminPerformancePage));
    expect(html).toContain('≈ $0.001627');
    expect(html).toContain('>$0.001626671224</p>');
    expect(html).toContain('>-$0.00009</p>');
    expect(html).toContain('>$1.00</p>');
  });
});
