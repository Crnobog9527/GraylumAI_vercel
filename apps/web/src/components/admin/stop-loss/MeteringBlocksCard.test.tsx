/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { exactUsd, MeteringBlocksCard } from './MeteringBlocksCard';

const fixture = vi.hoisted(() => ({ blocks: undefined as unknown, error: null as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ billingReport: { meteringBlocks: { invalidate: vi.fn() } } }),
  billingReport: {
    meteringBlocks: { useQuery: () => ({ data: fixture.blocks, error: fixture.error }) },
    reviewMeteringBlock: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
} }));

const MODEL = '00000000-0000-4000-8000-000000000020';
const block = { modelId: MODEL, model: 'Sonnet 5.5', calls: 2, firstAt: '2026-11-11T01:00:00+00:00', lastAt: '2026-11-11T02:00:00+00:00',
  turnId: 7, upperUsd: '0.020000000000', nominalUsd: '0.010000000000', actualUsd: '0.050000000000' };

// Deep review 2026-11-11, finding 10: before this card a blocked model had no way back short of editing the database.
describe('the admin card of models held by a metering block', () => {
  it('lists a blocked model with the receipt that went over and the action that lets it through', () => {
    fixture.error = null; fixture.blocks = { available: true, blocks: [block, { ...block, modelId: 'other', model: null, actualUsd: null }] };
    const html = renderToStaticMarkup(<MeteringBlocksCard />);
    expect(html).toContain('被暂停的模型');
    expect(html).toContain('Sonnet 5.5');
    expect(html).toContain('$0.02'); expect(html).toContain('$0.01'); expect(html).toContain('$0.05');
    expect(html.match(/已核对价格，恢复调用<\/button>/g)).toHaveLength(2);
    // A model with no name shows its id; a cost that is not known is said, never shown as 0.
    expect(html).toContain('>other<');
    expect(html).toContain('未知');
  });

  // Staging check of #1854 (2026-11-12): the column showed the database's own text, "2026-11-05T05:31:14.58843+00:00".
  it('shows when the first over-bound call was in the page\'s date format, never the raw stored timestamp', () => {
    fixture.error = null;
    fixture.blocks = { available: true, blocks: [{ ...block, firstAt: '2026-11-05T05:31:14.58843+00:00' }, { ...block, modelId: 'other', firstAt: null }] };
    const html = renderToStaticMarkup(<MeteringBlocksCard />);
    // The same format as the alert list and the balance record on this page (stopLossFormat.formatTime), in the viewer's time zone.
    const shown = new Date('2026-11-05T05:31:14.58843+00:00').toLocaleString('zh-CN', { hour12: false });
    // Day, hour and minute depend on the machine's time zone (some are half an hour off); the shape and the seconds do not.
    expect(shown).toMatch(/^2026\/11\/\d{1,2} \d{2}:\d{2}:14$/);
    expect(html).toContain(`<td>${shown}</td>`);
    expect(html).not.toContain('T05:31:14'); expect(html).not.toContain('+00:00'); expect(html).not.toContain('58843');
    // A time that is missing is a dash, not "Invalid Date".
    expect(html).toContain('<td>—</td>'); expect(html).not.toContain('Invalid');
  });

  it('says when no model is held, and never shows "none" for a list it could not read', () => {
    fixture.error = null; fixture.blocks = { available: true, blocks: [] };
    let html = renderToStaticMarkup(<MeteringBlocksCard />);
    expect(html).toContain('当前没有被暂停的模型');
    expect(html).not.toContain('<button');
    fixture.blocks = { available: false };
    html = renderToStaticMarkup(<MeteringBlocksCard />);
    expect(html).toContain('列表暂不可用'); expect(html).not.toContain('当前没有被暂停的模型');
    fixture.blocks = undefined; fixture.error = new Error('down');
    html = renderToStaticMarkup(<MeteringBlocksCard />);
    expect(html).toContain('无法读取'); expect(html).not.toContain('当前没有被暂停的模型');
  });

  it('shows the stored amount exactly, without its padding zeros', () => {
    expect(exactUsd('0.020000000000')).toBe('$0.02');
    expect(exactUsd('3.000000000000')).toBe('$3');
    expect(exactUsd('10')).toBe('$10');
    expect(exactUsd('0.000003000000')).toBe('$0.000003');
    expect(exactUsd(null)).toBe('未知');
  });
});
