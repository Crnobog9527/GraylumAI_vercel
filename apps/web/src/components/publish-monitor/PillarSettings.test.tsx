/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pillars: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ publishMonitor: { review: { pillars: { invalidate: vi.fn() } } } }),
  publishMonitor: { review: { pillars: { useQuery: () => state.pillars },
    savePillars: { useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }) } } } } }));
import { draftProblem, PillarSettings } from './PillarSettings';

const brand = { businessId: 'b1', businessName: '家常菜', source: 'extracted',
  pillars: [{ key: 'p1', name: '读书笔记', definition: '读书笔记' }, { key: 'p2', name: '城市探店', definition: '城市探店' }] };

describe('content pillar setting', () => {
  it('lists each brand with its pillars to rename, move or delete, and says where unsaved candidates came from', () => {
    state.pillars = { isPending: false, error: null, data: [brand] };
    const html = renderToStaticMarkup(<PillarSettings />);
    for (const words of ['内容方向', '家常菜', '从定位报告整理，还没保存过', 'value="读书笔记"', 'value="城市探店"', '添加内容方向', '删除', '最多 6 个'])
      expect(html).toContain(words);
    // Nothing changed yet: no save button, and keys never show.
    expect(html).not.toContain('保存</button>');
    for (const code of ['p1', 'p2', 'extracted']) expect(html).not.toContain(`>${code}<`);
  });

  it('adding is disabled at six pillars', () => {
    state.pillars = { isPending: false, error: null, data: [{ ...brand, source: 'user',
      pillars: Array.from({ length: 6 }, (_, i) => ({ key: `p${i + 1}`, name: `n${i}`, definition: `n${i}` })) }] };
    expect(renderToStaticMarkup(<PillarSettings />)).toMatch(/disabled=""[^>]*>添加内容方向/);
  });

  it('while reading shows a wordless skeleton; without the review (FORBIDDEN) or without a brand it is not shown', () => {
    state.pillars = { isPending: true };
    const html = renderToStaticMarkup(<PillarSettings />);
    expect(html).toContain('data-testid="pillar-skeleton"');
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/读取|加载/);
    state.pillars = { isPending: false, error: { message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' } };
    expect(renderToStaticMarkup(<PillarSettings />)).toBe('');
    state.pillars = { isPending: false, error: null, data: [] };
    expect(renderToStaticMarkup(<PillarSettings />)).toBe('');
  });

  it('a draft with an empty or repeated name cannot be saved', () => {
    expect(draftProblem([{ key: 'p1', name: '读书' }, { key: null, name: ' ' }])).toBe('名称要 1–40 个字。');
    expect(draftProblem([{ key: 'p1', name: '读书' }, { key: null, name: '读书 ' }])).toBe('两个内容方向不能同名。');
    expect(draftProblem([{ key: 'p1', name: '读书' }, { key: null, name: '探店' }])).toBeNull();
  });
});
