/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ features: {} as Record<string, unknown>, reviews: {} as Record<string, unknown> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ publishMonitor: { settings: { invalidate: vi.fn() } } }),
  publishMonitor: { features: { useQuery: () => state.features }, review: { list: { useQuery: () => state.reviews } },
    settings: { useQuery: () => ({ data: undefined }) }, setAutoReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } } } }));
import { ReviewPanel } from './ReviewPanel';

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
