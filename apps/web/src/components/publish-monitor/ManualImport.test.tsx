/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { manualImport: { useMutation: () => ({}) } } } }));
import { RowPreview } from './ManualImport';
import { buildRows, suggestMapping } from '@/lib/publish-monitor/table-import/mapping';

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

describe('the day shown before importing is the day written in the table', () => {
  // 2026-11-11: in China (UTC+8) a table row dated 2026-11-01 was previewed as 2026-10-31. The stored instant was right
  // (local midnight); the preview cut the UTC text. Run in that time zone, whatever the machine's own is.
  const zone = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Asia/Shanghai'; });
  afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

  it('a date without a time zone keeps its calendar day, and a missing date says so', () => {
    const grid = { header: ['作品链接', '发布时间', '播放'], rows: [['https://example.com/a', '2026-11-01', '1200'],
      ['https://example.com/b', '2026/11/02 23:30', '8'], ['https://example.com/c', '', '5']] };
    const built = buildRows(grid, suggestMapping(grid.header));
    expect(built.errors).toEqual([]);
    // What is stored is the instant of local midnight, which is the previous day in UTC.
    expect(built.rows[0]!.postedAt).toBe('2026-10-31T16:00:00.000Z');
    const text = renderToStaticMarkup(<RowPreview rows={built.rows} />).replace(/<[^>]*>/g, ' ');
    expect(text).toContain('2026-11-01');
    expect(text).toContain('2026-11-02');
    expect(text).not.toContain('2026-10-31');
    expect(text).toContain('未提供');
  });
});
