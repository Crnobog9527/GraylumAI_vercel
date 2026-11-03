/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ candidates: { data: undefined as unknown, isPending: false, error: null as unknown },
  list: { data: undefined as unknown, isPending: false, error: null as unknown } }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ publishMonitor: { diagnostics: { invalidate: () => undefined } } }),
  publishMonitor: { diagnostics: {
    candidates: { useQuery: () => state.candidates }, list: { useQuery: () => state.list },
    save: { useMutation: () => ({ isPending: false, mutateAsync: async () => ({}) }) },
    remove: { useMutation: () => ({ isPending: false, mutateAsync: async () => true }) },
  } } } }));
import { DiagnosticEntry } from './DiagnosticEntry';

const post = { postId: '00000000-0000-4000-8000-0000000f0002', platform: 'douyin', title: '这家店的隐藏菜单', postedAt: '2026-11-01T00:00:00Z',
  businessId: '00000000-0000-4000-8000-0000000f0009', businessName: '复盘测试品牌', diagnosedOn: null };
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('the diagnosis entry page', () => {
  beforeEach(() => { state.candidates = { data: [post], isPending: false, error: null }; state.list = { data: [], isPending: false, error: null }; });

  it('offers the user\'s recent posts and a field for every rate the platform back office shows, with units, and no code names', () => {
    const html = renderToStaticMarkup(<DiagnosticEntry />);
    expect(html).toContain('复盘测试品牌 · 抖音 · 这家店的隐藏菜单');
    for (const label of ['2 秒跳出率', '3 秒完播率（留存）', '完播率', '点赞率', '平均观看时长', '视频时长', '开头的几句话']) expect(html).toContain(label);
    expect(html).toContain('（%）');
    expect(html).toContain('（秒）');
    expect(html).toContain('没有的数据留空，不要填 0');
    for (const code of ['bounce_2s', 'retain_3s', 'avg_watch_seconds']) expect(html).not.toContain(code);
  });

  it('lists what was saved as the user read it, with a way to remove each', () => {
    state.list = { data: [{ id: '00000000-0000-4000-8000-0000000f0010', platform: 'douyin', title: '这家店的隐藏菜单',
      rates: { bounce_2s: 0.42, avg_watch_seconds: 7.5 }, openingText: null, videoSeconds: 30, dropSecond: null, capturedOn: '2026-11-03' }],
      isPending: false, error: null };
    const out = text(renderToStaticMarkup(<DiagnosticEntry />));
    expect(out).toContain('已保存的诊断');
    expect(out).toContain('2 秒跳出率 42%');
    expect(out).toContain('平均观看时长 7.5 秒');
    expect(out).toContain('删除');
  });

  it('says so when there is no post to diagnose, and shows a refusal as a sentence, not a code', () => {
    state.candidates = { data: [], isPending: false, error: null };
    expect(text(renderToStaticMarkup(<DiagnosticEntry />))).toContain('最近 45 天还没有你自己账号发的作品');
    state.candidates = { data: undefined, isPending: false, error: { data: { code: 'FORBIDDEN' }, message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' } };
    const html = renderToStaticMarkup(<DiagnosticEntry />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('PUBLISH_MONITOR_ENTITLEMENT_REQUIRED');
    state.candidates = { data: undefined, isPending: true, error: null };
    expect(renderToStaticMarkup(<DiagnosticEntry />)).toContain('正在读取');
  });
});
