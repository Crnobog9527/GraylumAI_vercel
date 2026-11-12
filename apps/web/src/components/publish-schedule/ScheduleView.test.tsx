/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ list: {} as Record<string, unknown>, asked: [] as unknown[], drafts: {} as Record<string, unknown>,
  businesses: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ publishMonitor: { schedule: { list: { invalidate: vi.fn() } } } }),
  opc: { list: { useQuery: () => state.drafts }, businesses: { useQuery: () => state.businesses } },
  publishMonitor: { schedule: {
    list: { useQuery: (input: unknown) => { state.asked.push(input); return state.list; } },
    cancel: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) },
    reschedule: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) },
  } },
} }));
import { isNewUser, positioningHref, positioningLabel, ScheduleView } from './ScheduleView';

const text = (html: string) => html.replace(/<[^>]*>/g, '');
const ok = (data: unknown) => ({ isPending: false, error: null, data });
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

// A Wednesday noon local time, so the posts below fall inside the shown week.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 18, 12, 0), toFake: ['Date'] });
  state.list = ok([]); state.asked = []; state.drafts = ok({ drafts: [] }); state.businesses = ok([]);
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

  it('an empty week points a new user (no confirmed positioning) to positioning first (walkthrough 27)', () => {
    const html = renderToStaticMarkup(<ScheduleView />);
    expect(text(html)).toContain('先完成定位、写好第一篇，就能在这里排期。');
    // No positioning at all: the button starts one (验收 of #1891: 继续定位 fits only when one is under way).
    expect(html).toMatch(/<a[^>]*href="\/app\/positioning"[^>]*>开始定位<\/a>/);
    expect(text(html)).not.toContain('请在资料库里打开一条内容');
    // A positioning under way: the same one the guide card's 继续我的定位 opens (the newest profile not archived).
    state.drafts = ok({ drafts: [{ draftId: 'd-old', state: 'draft' }, { draftId: 'd-new', state: 'draft' }] });
    state.businesses = ok([{ businessId: 'b1', isArchived: false, drafts: [{ draftId: 'd-old' }] },
      { businessId: 'b2', isArchived: false, drafts: [{ draftId: 'd-new' }] },
      { businessId: 'b3', isArchived: true, archivedAt: '2026-11-01', drafts: [{ draftId: 'd-gone' }] }]);
    expect(renderToStaticMarkup(<ScheduleView />)).toMatch(/<a[^>]*href="\/app\/positioning\/d-new"[^>]*>继续定位<\/a>/);
  });

  it('an existing user with a confirmed positioning sees the ordinary empty week, not the new-user guide (review of #1891)', () => {
    state.drafts = ok({ drafts: [{ draftId: 'd-done', state: 'published' }, { draftId: 'd-rev', state: 'draft' }] });
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('这周还没有安排。');
    expect(html).toContain('请在资料库里打开一条内容');
    expect(html).not.toContain('先完成定位');
    expect(html).not.toContain('继续定位');
  });

  it('while the positioning list is read or cannot be read, the user is treated as an existing one', () => {
    for (const drafts of [{ isPending: true, error: null, data: undefined }, { isPending: false, error: { message: 'x' }, data: undefined }]) {
      state.drafts = drafts;
      const html = text(renderToStaticMarkup(<ScheduleView />));
      expect(html).toContain('这周还没有安排。');
      expect(html).not.toContain('先完成定位');
    }
  });

  it('a week with posts keeps the note about scheduling from the library and editing after scheduling', () => {
    const at = inHours(2);
    state.list = ok([{ id: 'j1', state: 'scheduled', at, scheduledAt: at, captionPreview: '合成排期文案', cancelReason: null,
      errorCode: null, manualReview: false, holdCredits: 12, chargedCredits: null, targets: [] }]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('要改内容，请取消后重新排期');
    expect(html).not.toContain('继续定位');
  });

  it('names every platform in Chinese where it has a Chinese name, never its code (抖音, 小红书)', () => {
    const at = inHours(2);
    state.list = ok([{ id: 'j3', state: 'failed', at, scheduledAt: at, captionPreview: '平台名', cancelReason: null, errorCode: null,
      manualReview: false, holdCredits: null, chargedCredits: null, targets: [
        { connectionId: 'c1', platform: 'douyin', status: 'failed' }, { connectionId: 'c2', platform: 'xiaohongshu', status: 'failed' },
        { connectionId: 'c3', platform: 'instagram', status: 'failed' }] }]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('抖音 · 失败');
    expect(html).toContain('小红书 · 失败');
    expect(html).toContain('Instagram · 失败');
    expect(html).not.toMatch(/douyin|xiaohongshu/);
  });
});

describe('who is new, and where 继续定位 goes', () => {
  it('new means the positioning list is read and has no confirmed positioning', () => {
    expect(isNewUser(ok({ drafts: [] }))).toBe(true);
    expect(isNewUser(ok({ drafts: [{ draftId: 'a', state: 'draft' }] }))).toBe(true);
    expect(isNewUser(ok({ drafts: [{ draftId: 'a', state: 'published' }] }))).toBe(false);
    // A confirmed positioning being revised (not published right now, but published before) is not new.
    expect(isNewUser(ok({ drafts: [{ draftId: 'a', state: 'draft', currentVersion: 2 }] }))).toBe(false);
    expect(isNewUser({ isPending: true, error: null })).toBe(false);
    expect(isNewUser({ isPending: false, error: { message: 'x' } })).toBe(false);
  });

  it('opens the positioning under way, else starts one', () => {
    expect(positioningHref({ state: 'draft', draftId: 'd1' })).toBe('/app/positioning/d1');
    expect(positioningHref({ state: 'none' })).toBe('/app/positioning');
    expect(positioningHref({ state: 'checking' })).toBe('/app/positioning');
    expect(positioningLabel({ state: 'draft', draftId: 'd1' })).toBe('继续定位');
    expect(positioningLabel({ state: 'none' })).toBe('开始定位');
    expect(positioningLabel({ state: 'checking' })).toBe('开始定位');
  });
});
