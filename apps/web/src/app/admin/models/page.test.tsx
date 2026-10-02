/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { query, mutation } = vi.hoisted(() => ({
  query: () => ({ data: undefined, isLoading: false, error: null, refetch: () => undefined }),
  mutation: () => ({ mutate: () => undefined, isPending: false }),
}));
vi.mock('@/trpc/client', () => ({ trpc: {
  model: {
    getAdminModelsDashboard: { useQuery: () => ({ ...query(), data: { models: [], connectionStatus: [] } }) },
    createModel: { useMutation: mutation }, updateModel: { useMutation: mutation },
    deleteModel: { useMutation: mutation }, testConnection: { useMutation: mutation },
  },
  modelReasoning: { get: { useQuery: query } },
  modelPricing: { getMultipliers: { useQuery: query } },
} }));
// The page's own panels have their own tests; render only the create/edit form here.
vi.mock('@/components/admin/ModelMultiplierPanel', () => ({ ModelMultiplierPanel: () => null }));
vi.mock('@/components/admin/ProviderPricesEditor', () => ({ ProviderPricesEditor: () => null }));
vi.mock('@/components/ui/dialog', () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Dialog: Pass, DialogContent: Pass, DialogDescription: Pass, DialogHeader: Pass, DialogTitle: Pass, DialogFooter: Pass };
});

import AdminModelsPage from './page';

describe('admin model form', () => {
  it('has no manual cost or capacity inputs and explains where capacity comes from', () => {
    const html = renderToStaticMarkup(createElement(AdminModelsPage));
    expect(html).toContain('添加模型');
    expect(html).not.toContain('Token 成本设置');
    expect(html).not.toContain('输入成本');
    expect(html).not.toContain('type="number"');
    expect(html).toContain('data-testid="model-capacity-panel"');
    expect(html).toContain('上下文限制 / 最大输出 Token（只读）');
    expect(html).toContain('新模型先使用默认值');
    expect(html).toContain('这个模型可以保存，但在读取价格并选定线路之前不能被调用。');
  });
});
