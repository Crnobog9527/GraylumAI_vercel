/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prices = await vi.hoisted(async () => import('@/components/admin/modelPriceFixtures'));
const model = (id: string, pricing: unknown, isActive: string | boolean = 'true') => ({
  id, name: id, modelId: `example/${id}`, provider: 'openai', isActive, pricing,
  maxTokens: 4096, conversationCount: 0, requestCount: 0, creditsConsumed: 0, costUsd: 0,
});
const baseData = () => ({ financeOverview: {
  paidRevenueCents: 0, recordedCostUsd: 0.0406667806, estimatedProfitUsd: -0.0406667806,
  creditsConsumed: 41, creditsPurchased: 0, creditsGiven: 0, netCreditsFlow: -41,
}, modelStats: [
  model('unread', prices.unreadPrice), model('ready', prices.readyPrice), model('refused', prices.refusedPrice),
] } as Record<string, unknown>);
const query = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: { admin: { getFinanceStats: { useQuery: () => ({
  isLoading: false, error: null, refetch: vi.fn(), data: query.data,
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

const render = () => renderToStaticMarkup(createElement(AdminFinancePage));
const rowOf = (html: string, testId: string) => html.slice(html.indexOf(testId), html.indexOf('</tr>', html.indexOf(testId)));
const transactions = (extra: Record<string, unknown> = {}) => ({ totalAdditions: 10, totalCheckins: 20, totalDeductions: 41,
  totalPurchases: 0, totalRefunds: 0, todayTransactions: 0, weekTransactions: 0, monthTransactions: 0,
  unknownTypeCount: 0, unknownTypes: {}, ...extra });
const pkg = (id: string, active: string) => ({ id, name: id, price: 500, creditsAmount: 500, active });
const billing = (unknownModelActiveCount: number) => ({ creditsPerUsd: 100, tokenPriceMultiplier: 1.5,
  billingUnitSource: null, activeModelCount: 1, unknownModelActiveCount, inputCreditsPer1KRange: null,
  outputCreditsPer1KRange: null, searchCreditsPer1KRange: null, searchSurchargeCredits: 0, newUserCredits: 100 });
const knownPackages = { totalPackages: 1, activePackages: 1, unknownActiveCount: 0, packages: [pkg('basic', 'true')] };

beforeEach(() => { query.data = baseData(); });

describe('admin finance overview', () => {
  it('shows the profit card compactly with the exact amount', () => {
    const html = render();
    expect(html).toContain('≈ -$0.04067');
    expect(html).toContain('>-$0.0406667806</p>');
    expect(html).toContain('md:grid-cols-2 xl:grid-cols-4');
  });

  it('shows snapshot prices with units, 未读取 for unread models and never a zero price', () => {
    const html = render();
    const row = (id: string) => rowOf(html, `admin-finance-model-row-${id}`);
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

  it('counts check-in rewards in 赠送 and in the daily chart', () => {
    query.data = { ...baseData(), transactions: transactions(),
      financeOverview: { ...(baseData().financeOverview as object), creditsGiven: 30 },
      dailyChart: [{ date: '2026-10-02', additions: 10, checkins: 20, purchases: 0, deductions: 41, unknownTypeCount: 0 }] };
    const html = render();
    const givenAt = html.indexOf('admin-finance-credits-given');
    const given = html.slice(givenAt, html.indexOf('</span></div>', givenAt));
    expect(given).toContain('+30');
    expect(given).toContain('含签到 20');
    expect(html).toContain('赠送（含签到）');
    expect(rowOf(html, 'admin-finance-day-2026-10-02')).toContain('data-given="30"');
  });

  it('shows no unknown-value notice when every type and status is known', () => {
    query.data = { ...baseData(), transactions: transactions({ totalCheckins: 0 }), packages: knownPackages,
      runtimeBilling: billing(0) };
    const html = render();
    expect(html).not.toContain('admin-finance-unknown-notice');
    expect(html).not.toContain('含签到 ');
    expect(html).not.toContain('未知状态');
  });

  it('flags unknown ledger types and statuses and shows the raw status values', () => {
    query.data = { ...baseData(), transactions: transactions({ unknownTypeCount: 2, unknownTypes: { bonus: 2 } }),
      packages: { totalPackages: 2, activePackages: 1, unknownActiveCount: 1,
        packages: [pkg('basic', 'true'), pkg('legacy', 'paused')] },
      runtimeBilling: billing(1),
      modelStats: [model('beta', prices.readyPrice, 'beta'), model('flagged', prices.readyPrice, true)] };
    const html = render();
    expect(html).toContain('admin-finance-unknown-notice');
    expect(html).toMatch(/未知流水类型（未计入收支）.*2 条.*bonus × 2/);
    expect(html).toMatch(/未知积分包状态.*1 条.*paused × 1/);
    expect(html).toMatch(/未知模型状态（不计入活跃模型）.*1 条.*beta × 1/);
    const packageRow = html.slice(html.indexOf('>legacy<'), html.indexOf('</tr>', html.indexOf('>legacy<')));
    expect(packageRow).toContain('paused（未知状态）');
    expect(packageRow).not.toContain('已下架');
    expect(rowOf(html, 'admin-finance-model-row-beta')).toContain('beta（未知状态）');
    expect(rowOf(html, 'admin-finance-model-row-beta')).not.toContain('禁用');
  });

  it('treats a boolean true model status as 启用', () => {
    query.data = { ...baseData(), modelStats: [model('flagged', prices.readyPrice, true)] };
    const row = rowOf(render(), 'admin-finance-model-row-flagged');
    expect(row).toContain('启用');
    expect(row).not.toContain('禁用');
  });
});
