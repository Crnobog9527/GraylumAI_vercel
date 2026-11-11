/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ features: {} as Record<string, unknown>, reviews: {} as Record<string, unknown> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ publishMonitor: { settings: { invalidate: vi.fn() } } }),
  publishMonitor: { features: { useQuery: () => state.features }, review: { list: { useQuery: () => state.reviews }, pillars: { useQuery: () => ({ isPending: true }) },
    savePillars: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    settings: { useQuery: () => ({ data: undefined }) }, setAutoReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } } } }));
import { ReviewPanel, latestReadable, type Review } from './ReviewPanel';

describe('weekly review panel while reading', () => {
  it('shows a wordless skeleton, never loading text or a spinner', () => {
    for (const [features, reviews] of [[{ isPending: true }, { isPending: true }],
      [{ isPending: false, data: { weeklyReview: true } }, { isPending: true }]] as const) {
      state.features = features; state.reviews = reviews;
      const html = renderToStaticMarkup(<ReviewPanel gold={false} />);
      expect(html).toContain('data-testid="review-skeleton"');
      expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/读取|加载/);
      expect(html).not.toContain('animate-spin');
    }
  });
});

describe('weekly reviews: one open at a time, settings folded away from the reading', () => {
  const review = (id: string, periodStart: string, over: Partial<Review> = {}): Review => ({ id, periodStart, status: 'completed',
    body: `正文 ${id}`, tables: null, notice: null, ...over });
  const text = (html: string) => html.replace(/<[^>]*>/g, '');

  it('opens the latest review that has something to read, whatever order the list came in', () => {
    expect(latestReadable([review('a', '2026-10-13T00:00:00Z'), review('b', '2026-11-03T00:00:00Z'), review('c', '2026-10-27T00:00:00Z')])).toBe('b');
    // A newer week that was skipped has nothing to read.
    expect(latestReadable([review('a', '2026-10-13T00:00:00Z'), review('s', '2026-11-10T00:00:00Z', { status: 'skipped', body: null })])).toBe('a');
    expect(latestReadable([])).toBeNull();
  });

  it('draws the text of the open review only; the others are their title and state, and a skipped week cannot be opened', () => {
    state.features = { isPending: false, data: { weeklyReview: true } };
    state.reviews = { isPending: false, isSuccess: true, error: null, data: [review('old', '2026-10-13T00:00:00Z'),
      review('new', '2026-11-03T00:00:00Z'), review('skip', '2026-10-20T00:00:00Z', { status: 'skipped', body: null, notice: '余额不足，未复盘' })] };
    const html = renderToStaticMarkup(<ReviewPanel gold={false} />);
    expect(text(html)).toContain('正文 new');
    expect(text(html)).not.toContain('正文 old');
    expect(text(html)).toContain('余额不足，未复盘');
    // Two reviews can be opened or closed; the skipped week has no such control. The third control folds the settings.
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).toContain('复盘设置');
    // The reviews come before the settings in the page.
    expect(html.indexOf('正文 new')).toBeLessThan(html.indexOf('复盘设置'));
  });

  it('with no review yet says so and points to the conversation', () => {
    state.features = { isPending: false, data: { weeklyReview: true } };
    state.reviews = { isPending: false, isSuccess: true, error: null, data: [] };
    expect(text(renderToStaticMarkup(<ReviewPanel gold />))).toContain('还没有复盘。自动复盘在打开满 7 天后生成第一份。');
    expect(text(renderToStaticMarkup(<ReviewPanel gold={false} />))).toContain('去对话里复盘');
  });
});
