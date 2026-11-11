/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ list: {} as Record<string, unknown>, asked: [] as unknown[], drafts: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ publishMonitor: { schedule: { list: { invalidate: vi.fn() } } } }),
  opc: { list: { useQuery: () => state.drafts } },
  publishMonitor: { schedule: {
    list: { useQuery: (input: unknown) => { state.asked.push(input); return state.list; } },
    cancel: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) },
    reschedule: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) },
  } },
} }));
import { positioningHref, ScheduleView } from './ScheduleView';

const text = (html: string) => html.replace(/<[^>]*>/g, '');
const ok = (data: unknown) => ({ isPending: false, error: null, data });
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

// A Wednesday noon local time, so the posts below fall inside the shown week.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 18, 12, 0), toFake: ['Date'] });
  state.list = ok([]); state.asked = []; state.drafts = ok({ drafts: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('the schedule page', () => {
  it('asks the server for this local week and shows seven days, the time zone and how to schedule', () => {
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('发布排期');
    expect(html).toContain('时间按你的时区显示');
    expect((html.match(/没有安排/g) ?? []).length).toBe(7);
    const range = state.asked[0] as { from: string; to: string };
    expect(range).toEqual({ from: new Date(2026, 10, 16).toISOString(), to: new Date(2026, 10, 23).toISOString() });
    expect(html).toContain('11月18日 周三（今天）');
  });

  it('a scheduled post shows its preview, platforms, the hold, and reschedule and cancel', () => {
    const at = inHours(2);
    state.list = ok([{ id: 'j1', state: 'scheduled', at, scheduledAt: at, captionPreview: '合成排期文案', cancelReason: null,
      errorCode: null, manualReview: false, holdCredits: 12, chargedCredits: null,
      targets: [{ connectionId: 'c1', platform: 'x', status: 'pending' }] }]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('合成排期文案');
    expect(html).toContain('已排期');
    expect(html).toContain('X');
    expect(html).toContain('冻结 12 积分');
    expect(html).toContain('改期');
    expect(html).toContain('取消排期');
  });

  it('a post too close to its time, a cancelled one and a failure show no change buttons', () => {
    const soon = inHours(0.1);
    state.list = ok([{ id: 'j2', state: 'scheduled', at: soon, scheduledAt: soon, captionPreview: '快到点', cancelReason: null,
      errorCode: null, manualReview: false, holdCredits: 6, chargedCredits: null, targets: [] }]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('快到点');
    expect(html).toContain('已经不能改期或取消');
    expect(html).not.toContain('取消排期');
  });

  it('shows a readable message and a retry when the list cannot be read', () => {
    state.list = { isPending: false, data: undefined, error: { message: 'PUBLISH_MONITOR_UNAVAILABLE', data: {} } };
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('暂时没有完成，请稍后重试。');
    expect(html).toContain('重试');
  });

  it('an empty week points a new user to positioning first, not to an empty library (walkthrough 27)', () => {
    const html = renderToStaticMarkup(<ScheduleView />);
    expect(text(html)).toContain('先完成定位、写好第一篇，就能在这里排期。');
    expect(html).toMatch(/<a[^>]*href="\/app\/positioning"[^>]*>继续定位<\/a>/);
    expect(text(html)).not.toContain('请在资料库里打开一条内容');
    state.drafts = ok({ drafts: [{ draftId: 'd-done', state: 'published' }, { draftId: 'd-open', state: 'draft' }] });
    expect(renderToStaticMarkup(<ScheduleView />)).toMatch(/<a[^>]*href="\/app\/positioning\/d-open"[^>]*>继续定位<\/a>/);
  });

  it('a week with posts keeps the note about scheduling from the library and editing after scheduling', () => {
    const at = inHours(2);
    state.list = ok([{ id: 'j1', state: 'scheduled', at, scheduledAt: at, captionPreview: '合成排期文案', cancelReason: null,
      errorCode: null, manualReview: false, holdCredits: 12, chargedCredits: null, targets: [] }]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('要改内容，请取消后重新排期');
    expect(html).not.toContain('继续定位');
  });
});

describe('where 继续定位 goes', () => {
  it('opens the first positioning not confirmed yet, else starts one', () => {
    expect(positioningHref(undefined)).toBe('/app/positioning');
    expect(positioningHref([{ draftId: 'a', state: 'published' }])).toBe('/app/positioning');
    expect(positioningHref([{ draftId: 'a', state: 'published' }, { draftId: 'b', state: 'draft' }, { draftId: 'c' }]))
      .toBe('/app/positioning/b');
  });
});
