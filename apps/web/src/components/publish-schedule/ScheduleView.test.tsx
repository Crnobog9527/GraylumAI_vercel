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
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: Part, DialogContent: Part, DialogDescription: Part, DialogFooter: Part, DialogHeader: Part, DialogTitle: Part };
});
import { isNewUser, positioningHref, positioningLabel, ScheduleView } from './ScheduleView';
import { ScheduleDetailDialog } from './ScheduleDetailDialog';

const text = (html: string) => html.replace(/<[^>]*>/g, '');
const ok = (data: unknown) => ({ isPending: false, error: null, data });
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

// A Wednesday noon local time, so the posts below fall inside the shown week.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 18, 12, 0), toFake: ['Date'] });
  state.list = ok([]); state.asked = []; state.drafts = ok({ drafts: [] }); state.businesses = ok([]);
});
afterEach(() => { vi.useRealTimers(); });

const post = (id: string, iso: string, extra: Record<string, unknown> = {}) => ({ id, state: 'scheduled', at: iso, scheduledAt: iso,
  captionPreview: null, cancelReason: null, errorCode: null, manualReview: false, holdCredits: 6, chargedCredits: null, targets: [],
  ...extra });

describe('the schedule calendar', () => {
  it('opens on this month: asks for its whole weeks, shows the month, Monday first, today and the time zone', () => {
    const html = renderToStaticMarkup(<ScheduleView />);
    expect(text(html)).toContain('发布排期');
    expect(text(html)).toContain('时间按你的时区显示');
    expect(text(html)).toContain('只发布到你授权的账号，发布前由你确认。');
    expect(text(html)).toContain('2026年11月');
    expect(text(html)).toMatch(/周一周二周三周四周五周六周日/);
    expect(html).toContain('aria-label="11月18日 周三（今天），0 条"');
    // November 2026 in whole weeks: Monday 26 October to Sunday 6 December.
    expect(state.asked[0]).toEqual({ from: new Date(2026, 9, 26).toISOString(), to: new Date(2026, 11, 7).toISOString() });
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>月<\/button>/);
  });

  it('a post is a chip on its day with its time and platforms in Chinese; its name says the status and the caption', () => {
    const at = new Date(2026, 10, 19, 9, 30).toISOString();
    state.list = ok([post('j1', at, { captionPreview: '合成排期文案', targets: [
      { connectionId: 'c1', platform: 'xiaohongshu', status: 'pending' }, { connectionId: 'c2', platform: 'douyin', status: 'pending' }] })]);
    const html = renderToStaticMarkup(<ScheduleView />);
    expect(html).toContain('aria-label="11月19日 周四，1 条"');
    expect(html).toContain('aria-label="09:30 小红书、抖音，已排期，合成排期文案"');
    expect(html).toContain('data-tone="scheduled"');
    expect(text(html)).toContain('09:30小红书、抖音');
    expect(text(html)).not.toMatch(/douyin|xiaohongshu/);
  });

  it('a busy day shows two chips and counts the rest, which open that week', () => {
    state.list = ok([8, 10, 12, 14, 16].map(hour => post(`j${hour}`, new Date(2026, 10, 20, hour).toISOString())));
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('08:00');
    expect(html).toContain('10:00');
    expect(html).not.toContain('12:00');
    expect(html).toContain('还有 3 条');
  });

  it('each status has its own colour', () => {
    const day = (h: number) => new Date(2026, 10, 10 + h).toISOString();
    state.list = ok([post('a', day(0)), post('b', day(1), { state: 'unknown' }), post('c', day(2), { state: 'completed', chargedCredits: 6 }),
      post('d', day(3), { state: 'failed' }), post('e', day(4), { state: 'released', cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' })]);
    const html = renderToStaticMarkup(<ScheduleView />);
    for (const tone of ['scheduled', 'working', 'done', 'failed', 'cancelled']) expect(html).toContain(`data-tone="${tone}"`);
    expect(text(html)).toContain('部分成功');
  });

  it('shows a readable message and a retry when the list cannot be read', () => {
    state.list = { isPending: false, data: undefined, error: { message: 'PUBLISH_MONITOR_UNAVAILABLE', data: {} } };
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('暂时没有完成，请稍后重试。');
    expect(html).toContain('重试');
  });

  it('an empty page points a new user (no confirmed positioning) to positioning first (walkthrough 27)', () => {
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

  it('an existing user with a confirmed positioning sees the ordinary empty month, not the new-user guide (review of #1891)', () => {
    state.drafts = ok({ drafts: [{ draftId: 'd-done', state: 'published' }, { draftId: 'd-rev', state: 'draft' }] });
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('这个月还没有安排。');
    expect(html).toContain('请在资料库里打开一条内容');
    expect(html).not.toContain('先完成定位');
    expect(html).not.toContain('继续定位');
  });

  it('while the positioning list is read or cannot be read, the user is treated as an existing one', () => {
    for (const drafts of [{ isPending: true, error: null, data: undefined }, { isPending: false, error: { message: 'x' }, data: undefined }]) {
      state.drafts = drafts;
      const html = text(renderToStaticMarkup(<ScheduleView />));
      expect(html).toContain('这个月还没有安排。');
      expect(html).not.toContain('先完成定位');
    }
  });

  it('a month with posts keeps the note about scheduling from the library and editing after scheduling', () => {
    state.list = ok([post('j1', inHours(2), { captionPreview: '合成排期文案' })]);
    const html = text(renderToStaticMarkup(<ScheduleView />));
    expect(html).toContain('要改内容，请取消后重新排期');
    expect(html).not.toContain('还没有安排');
    expect(html).not.toContain('继续定位');
  });
});

describe('a post opened from the calendar', () => {
  const detail = (entry: Record<string, unknown>) => text(renderToStaticMarkup(
    <ScheduleDetailDialog entry={entry as never} onClose={() => {}} onChange={() => {}} />));

  it('a scheduled post shows its status, the hold, platforms, caption and reschedule and cancel', () => {
    const html = detail(post('j1', inHours(2), { captionPreview: '合成排期文案', holdCredits: 12,
      targets: [{ connectionId: 'c1', platform: 'x', status: 'pending' }] }));
    expect(html).toContain('已排期');
    expect(html).toContain('冻结 12 积分');
    expect(html).toContain('X');
    expect(html).toContain('合成排期文案');
    expect(html).toContain('改期');
    expect(html).toContain('取消排期');
    expect(html).toContain('要改内容，请取消后重新排期');
  });

  it('a post too close to its time, a cancelled one and a failure show no change buttons', () => {
    const near = detail(post('j2', inHours(0.1), { captionPreview: '快到点' }));
    expect(near).toContain('已经不能改期或取消');
    expect(near).not.toContain('取消排期');
    expect(detail(post('j3', inHours(2), { state: 'released', cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' }))).not.toContain('改期');
    expect(detail(post('j4', inHours(-2), { state: 'failed' }))).not.toContain('改期');
  });

  it('names every platform in Chinese where it has a Chinese name, never its code (抖音, 小红书), and links a sent post', () => {
    const html = detail(post('j3', inHours(2), { state: 'failed', targets: [
      { connectionId: 'c1', platform: 'douyin', status: 'failed' }, { connectionId: 'c2', platform: 'xiaohongshu', status: 'failed' },
      { connectionId: 'c3', platform: 'instagram', status: 'failed' }] }));
    expect(html).toContain('抖音 · 失败');
    expect(html).toContain('小红书 · 失败');
    expect(html).toContain('Instagram · 失败');
    expect(html).not.toMatch(/douyin|xiaohongshu/);
    const sent = renderToStaticMarkup(<ScheduleDetailDialog entry={post('j5', inHours(-2), { state: 'completed', chargedCredits: 6,
      targets: [{ connectionId: 'c1', platform: 'xiaohongshu', status: 'published', url: 'https://example.com/p/1' }] }) as never}
      onClose={() => {}} onChange={() => {}} />);
    expect(sent).toMatch(/<a[^>]*href="https:\/\/example.com\/p\/1"[^>]*>查看帖子<\/a>/);
    expect(text(sent)).toContain('小红书 · 已发布');
    // Sent without an address from the platform: still says 已发布, with no link (validation of #1928).
    const noLink = renderToStaticMarkup(<ScheduleDetailDialog entry={post('j6', inHours(-2), { state: 'completed', chargedCredits: 6,
      targets: [{ connectionId: 'c1', platform: 'xiaohongshu', status: 'published', url: null }] }) as never}
      onClose={() => {}} onChange={() => {}} />);
    expect(text(noLink)).toContain('小红书 · 已发布');
    expect(noLink).not.toContain('查看帖子');
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
