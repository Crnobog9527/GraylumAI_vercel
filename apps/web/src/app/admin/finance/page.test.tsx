/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const prices = await vi.hoisted(async () => import('@/components/admin/modelPriceFixtures'));
const model = (id: string, pricing: unknown) => ({ id, name: id, modelId: `example/${id}`, provider: 'openai', isActive: 'true',
  pricing, maxTokens: 4096, conversationCount: 0, requestCount: 0, creditsConsumed: 0, costUsd: 0 });
vi.mock('@/trpc/client', () => ({ trpc: { admin: { getFinanceStats: { useQuery: () => ({
  isLoading: false, error: null, refetch: vi.fn(),
  data: { financeOverview: {
    paidRevenueCents: 0, recordedCostUsd: 0.0406667806, estimatedProfitUsd: -0.0406667806,
    creditsConsumed: 41, creditsPurchased: 0, creditsGiven: 0, netCreditsFlow: -41,
  }, modelStats: [
    model('unread', prices.unreadPrice), model('ready', prices.readyPrice), model('refused', prices.refusedPrice),
  ] },
}) } } } }));
vi.mock('@/components/admin/Bill2ModelReportCard', async (importOriginal) => ({
  ...await importOriginal<object>(), Bill2ModelReportCard: () => null,
}));
// Render every tab so the model table is part of the static markup.
vi.mock('@/components/ui/tabs', () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Tabs: Pass, TabsList: Pass, TabsTrigger: Pass, TabsContent: Pass };
});

import AdminFinancePage from './page';

describe('admin finance overview', () => {
  it('shows the profit card compactly with the exact amount', () => {
    const html = renderToStaticMarkup(createElement(AdminFinancePage));
    expect(html).toContain('≈ -$0.04067');
    expect(html).toContain('>-$0.0406667806</p>');
    expect(html).toContain('md:grid-cols-2 xl:grid-cols-4');
  });

  it('shows snapshot prices with units, 未读取 for unread models and never a zero price', () => {
    const html = renderToStaticMarkup(createElement(AdminFinancePage));
    const row = (id: string) => html.slice(html.indexOf(`admin-finance-model-row-${id}`), html.indexOf('</tr>', html.indexOf(`admin-finance-model-row-${id}`)));
    expect(row('unread').match(/未读取/g)).toHaveLength(3);
    expect(row('unread')).not.toContain('$');
    expect(row('ready')).toContain('$1.25');
    expect(row('ready')).toContain('美元 / 百万 token');
    expect(row('ready')).toContain('冻结用单价 $2.5');
    expect(row('ready')).toContain('$0.01');
    expect(row('ready')).toContain('美元 / 次');
    expect(row('refused')).toContain('冻结用单价：不可推导');
    expect(row('refused')).toContain('目录未列出');
    expect(html).not.toMatch(/\$0\.000\/1M/);
  });
});
