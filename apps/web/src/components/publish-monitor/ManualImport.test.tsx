/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { manualImport: { useMutation: () => ({}) } } } }));
import { RowPreview } from './ManualImport';

describe('import confirmation preview', () => {
  it('lists every row that will be written, not a first page, and never hides the rest', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ postKey: `post-${i}`, url: null, postedAt: null, titleExcerpt: null,
      metrics: { views: i + 1 } }));
    const html = renderToStaticMarkup(<RowPreview rows={rows} />);
    expect((html.match(/<tr/g) ?? []).length).toBe(61);
    expect(html).toContain('post-59');
    expect(html.replace(/<[^>]*>/g, '')).not.toContain('只显示前');
  });
});
