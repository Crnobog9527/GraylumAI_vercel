/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ q: { data: undefined as unknown, isLoading: false, error: null as unknown } }));
vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { admin: { quota: { useQuery: () => state.q } } } } }));
import { PublishMonitorQuota } from './PublishMonitorQuota';

beforeEach(() => { state.q = { data: undefined, isLoading: false, error: null }; });

it('shows delivered count, limit, held count and the period', () => {
  state.q = { data: { configured: true, periodStart: '2026-10-13T00:00:00+00:00', periodEnd: '2026-11-13T00:00:00+00:00',
    limit: 1000, used: 12, reserved: 2 }, isLoading: false, error: null };
  const html = renderToStaticMarkup(<PublishMonitorQuota />).replace(/<[^>]+>/g, '');
  expect(html).toMatch(/本周期已成功发送 12 条 \/ 上限 1000 条\s*（冻结中 2 条）/);
  expect(html).toContain('2026-10-13 至 2026-11-13');
});

it('says so when the plan size is not set, and when the count cannot be read', () => {
  state.q = { data: { configured: false }, isLoading: false, error: null };
  expect(renderToStaticMarkup(<PublishMonitorQuota />)).toContain('还没有设置套餐条数');
  state.q = { data: undefined, isLoading: false, error: new Error('x') };
  expect(renderToStaticMarkup(<PublishMonitorQuota />)).toContain('暂时读不到发布条数');
});
