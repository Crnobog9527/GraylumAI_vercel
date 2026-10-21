/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cacheHitRate: null as number | null, cacheSavings: 0.00009 as number | null }));
const prices = await vi.hoisted(async () => import('@/components/admin/modelPriceFixtures'));
const usage = (id: string, pricing: unknown) => ({ id, name: id, provider: 'openai', isActive: 'true', conversationCount: 1,
  requestCount: 1, creditsConsumed: 0, totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, pricing });
vi.mock('@/trpc/client', () => ({ trpc: { admin: { getPerformanceStats: { useQuery: () => ({
  isLoading: false, error: null, refetch: vi.fn(),
  data: {
    aiPerformance: {
      totalRequests: 3, rangeRequests: 3, avgResponseTime: 100, p95ResponseTime: 200,
      errorRate: 0.5, cacheHitRate: state.cacheHitRate, healthStatus: 'healthy',
    },
    costStats: { totalCost: 0.001626671224, avgCostPerRequest: 0.0005, cacheSavings: state.cacheSavings, estimatedMonthly: 1 },
    conversations: { total: 2, today: 0, thisWeek: 0, thisMonth: 0, inRange: 2 },
    modelUsage: [usage('unread', prices.unreadPrice), usage('ready', prices.readyPrice)],
  },
}) } } } }));
// Render every tab so the cost cards are part of the static markup.
vi.mock('@/components/ui/tabs', () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Tabs: Pass, TabsList: Pass, TabsTrigger: Pass, TabsContent: Pass };
});

import AdminPerformancePage from './page';

beforeEach(() => { state.cacheHitRate = null; state.cacheSavings = 0.00009; });

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

  it('shows unknown cache savings as 未知, never as zero', () => {
    state.cacheSavings = null;
    const html = renderToStaticMarkup(createElement(AdminPerformancePage));
    expect(html).toContain('text-emerald-400">未知</p>');
    expect(html).toContain('text-emerald-400">未知</span>');
    expect(html).not.toContain('-$0');
    expect(html).toContain('不是历史实际节省');
  });

  it('shows snapshot prices per model and 未读取 when no snapshot was read', () => {
    const html = renderToStaticMarkup(createElement(AdminPerformancePage));
    const start = html.indexOf('admin-performance-model-row-unread');
    const unread = html.slice(start, html.indexOf('</tr>', start));
    expect(unread.match(/未读取/g)).toHaveLength(2);
    expect(unread).not.toContain('$');
    const ready = html.slice(html.indexOf('admin-performance-model-row-ready'));
    expect(ready).toContain('$1.25');
    expect(ready).toContain('$10');
    expect(ready).toContain('美元 / 百万 token');
  });
});
