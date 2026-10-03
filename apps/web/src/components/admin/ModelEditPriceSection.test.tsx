/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown, refreshError: null as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({}),
  modelReasoning: {
    get: { useQuery: () => ({ data: state.data, error: state.error }) },
    refreshCatalog: { useMutation: () => ({ mutate: () => undefined, isPending: false, error: state.refreshError }) },
  },
  modelPricing: { getMultipliers: { useQuery: () => ({ data: {
    site: { creditsPerUsd: '100' }, models: [{ id: 'model-1', effective: '2' }],
  } }) } },
} }));
const prices = await vi.hoisted(async () => import('./modelPriceFixtures'));

import { ModelEditPriceSection } from './ModelEditPriceSection';

const render = (modelId: string | null) =>
  renderToStaticMarkup(createElement(ModelEditPriceSection, { modelId, open: true, onShowMultipliers: () => undefined }));
const capacity = { route: 'example/fp8', fetchedAt: '2026-10-01T00:00:00.000Z',
  inputLimit: { supplier: 272000, current: 272000, matches: true }, maxTokens: { supplier: 128000, current: 4096, matches: false } };
const pricing = { fetchedAt: '2026-10-01T00:00:00.000Z', model: 'example/model', source: 'openrouter', pricingHash: 'a'.repeat(64),
  endpoints: [{ tag: 'example/fp8', contextLength: 272000, admissible: true, issues: [], discount: null, unknownKeys: [],
    base: { prompt: '1.25', completion: '10' }, raw: {}, overrides: [] }] };
const view = (priceView: unknown) => ({ model: 'example/model', maxTokens: 4096, issues: [], capacity, priceView, pricing,
  config: { route: 'example/fp8', purposes: {}, catalog: { fetchedAt: '2026-10-01T00:00:00.000Z', model: 'example/model' } } });

beforeEach(() => { state.data = undefined; state.error = null; state.refreshError = null; });

describe('model edit form price section', () => {
  it('tells a new model it can be saved but not called yet', () => {
    const html = render(null);
    expect(html).toContain('这个模型可以保存，但在读取价格并选定线路之前不能被调用。');
    expect(html).toContain('新模型先使用默认值');
  });

  it('shows prices, frozen prices, the user price preview and capacity of the saved route', () => {
    state.data = view({ ...prices.readyPrice, route: 'example/fp8' });
    const html = render('model-1');
    expect(html).not.toContain('model-readiness-note');
    expect(html).toContain('按已保存的线路 example/fp8 显示');
    expect(html).toContain('data-testid="model-price-snapshot"');
    expect(html).toContain('输入最高单价 $2.5 美元 / 百万 token');
    expect(html).toContain('输入最多约 500 积分 / 百万 token');
    expect(html).toContain('查看或修改这个模型的加价倍数');
    expect(html).toContain('点本区的&quot;读取价格和容量&quot;同步');
    expect(html).toContain('>读取价格和容量</button>');
    expect(html).not.toContain('点上面的');
    expect(html).not.toContain('type="number"');
  });

  it('shows the read failure safely, keeping server validation text', () => {
    state.data = view({ ...prices.readyPrice, route: 'example/fp8' });
    state.refreshError = { message: 'fetch failed: internal transport token', data: { code: 'INTERNAL_SERVER_ERROR' } };
    expect(render('model-1')).toContain('暂时无法读取模型目录，请稍后重试');
    state.refreshError = { message: 'OpenRouter 目录里没有这个模型 ID', data: { code: 'BAD_REQUEST' } };
    expect(render('model-1')).toContain('OpenRouter 目录里没有这个模型 ID');
  });

  it('has no read button for a model that is not saved yet', () => {
    expect(render(null)).not.toContain('读取价格和容量</button>');
  });

  it('keeps the not-callable notice while the price is unread', () => {
    state.data = view({ ...prices.unreadPrice, route: 'example/fp8' });
    const html = render('model-1');
    expect(html).toContain('data-testid="model-readiness-note"');
    expect(html).not.toContain('model-frozen-price');
  });

  it('says when the saved settings cannot be read', () => {
    state.error = { message: 'boom' };
    expect(render('model-1')).toContain('暂时无法读取容量');
  });
});
