/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({
  connections: {} as Record<string, unknown>, data: {} as Record<string, unknown>, library: {} as Record<string, unknown>,
  reviews: {} as Record<string, unknown>, features: {} as Record<string, unknown>, reviewAsked: [] as boolean[],
}));
const mutation = vi.hoisted(() => () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false, error: null,
  data: undefined }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ publishMonitor: { connections: { invalidate: vi.fn() }, data: { invalidate: vi.fn() },
    settings: { invalidate: vi.fn() }, review: { export: { fetch: vi.fn() } } } }),
  opc: { library: { useQuery: () => state.library } },
  publishMonitor: {
    connections: { useQuery: () => state.connections }, data: { useQuery: () => state.data },
    postHistory: { useQuery: () => ({ isPending: true }) },
    refresh: { useMutation: mutation }, disconnect: { useMutation: mutation }, linkPost: { useMutation: mutation },
    addBenchmark: { useMutation: mutation }, connectTikhub: { useMutation: mutation }, manualImport: { useMutation: mutation },
    settings: { useQuery: () => ({ data: { autoReviewEnabled: true, autoReviewEnabledAt: '2026-10-20T00:00:00Z' } }) },
    setAutoReview: { useMutation: mutation },
    features: { useQuery: () => state.features },
    review: { list: { useQuery: (_: unknown, o?: { enabled?: boolean }) => { state.reviewAsked.push(o?.enabled !== false); return state.reviews; } } },
  },
} }));
import { DataReviewView } from './DataReviewView';
import { PostsPanel, type Post } from './PostsPanel';
import { ReviewPanel } from './ReviewPanel';
import { ConnectionsPanel, blockingProjectIds, type Connection } from './ConnectionsPanel';

const ok = (data: unknown) => ({ isPending: false, isSuccess: true, data, error: null });
const failed = (message: string) => ({ isPending: false, isSuccess: false, data: undefined, error: { message, data: {} } });
const text = (html: string) => html.replace(/<[^>]*>/g, '');
const post = (over: Partial<Post> = {}): Post => ({ id: 'p1', connectionId: 'c1', source: 'postforme', url: 'https://x.com/a/status/1',
  postedAt: '2026-10-20T08:00:00Z', postedAtSource: 'x_snowflake', firstSeenAt: '2026-10-21T00:00:00Z', titleExcerpt: '合成作品',
  workItemId: null, latest: { capturedOn: '2026-10-22', metrics: { likes: 0, views: 30 }, missingFields: ['shares'] }, ...over });

beforeEach(() => {
  state.connections = ok([]);
  state.data = ok({ windowDays: 30, connections: [], posts: [] });
  state.library = ok({ businesses: [] });
  state.reviews = ok([]);
  state.features = ok({ ownData: true, weeklyReview: true, publish: false });
  state.reviewAsked = [];
});

describe('data review page access follows the server', () => {
  it('says the feature is not open while the admin switch is off, without offering anything to do', () => {
    state.connections = failed('PUBLISH_MONITOR_DISABLED');
    state.data = failed('PUBLISH_MONITOR_DISABLED');
    const html = renderToStaticMarkup(<DataReviewView />);
    expect(text(html)).toContain('作品数据和复盘还没有开放。');
    expect(text(html)).not.toContain('重试');
    expect(text(html)).not.toContain('连接账号');
  });
  it('shows the upgrade note to a free account (the server refused the data window)', () => {
    state.data = failed('PUBLISH_MONITOR_ENTITLEMENT_REQUIRED');
    const html = renderToStaticMarkup(<DataReviewView />);
    expect(text(html)).toContain('这项功能需要会员');
    expect(html).toContain('/app/profile?tab=subscription');
    expect(text(html)).not.toContain('作品数据（近');
  });
  it('shows the posts tab for a member, with the window from the server', () => {
    state.data = ok({ windowDays: 30, connections: [{ id: 'c1', platform: 'x' }], posts: [post()] });
    const html = renderToStaticMarkup(<DataReviewView />);
    expect(text(html)).toContain('作品数据（近 30 天）');
    expect(text(html)).toContain('合成作品');
  });
});

describe('posts', () => {
  it('shows a real 0, the platform gap and a missing date without inventing numbers', () => {
    const html = renderToStaticMarkup(<PostsPanel windowDays={90} posts={[post(), post({ id: 'p2', postedAt: null, postedAtSource: null,
      latest: null, titleExcerpt: null })]} connections={[{ id: 'c1', platform: 'x' }]} accountOf={() => undefined} onLinked={() => {}} />);
    const t = text(html);
    expect(t).toContain('作品数据（近 90 天）');
    expect(t).toContain('2026-10-20（按作品编号推算）');
    expect(t).toContain('平台不提供');
    expect(t).toContain('未提供');
    expect(t).toContain('未取到');
    expect(t).toContain('从连接那天开始记录');
  });
});

describe('accounts', () => {
  const own = (over: Partial<Connection>): Connection => ({ id: 'c1', businessId: 'b', accountProjectId: 'p', role: 'own',
    source: 'postforme', platform: 'x', displayHint: null, status: 'connected', consentRead: true, consentAutoTrack: true,
    consentPublish: false, lastSuccessAt: '2026-10-22T00:00:00Z', postCount: 3, ...over });
  const render = (connections: Connection[], gold = false) => text(renderToStaticMarkup(
    <ConnectionsPanel brands={[]} connections={connections} refresh={new Map([['c2', { id: 'c2', refreshError: 'x', delayed: false,
      manualRefreshAt: null, refreshState: null }]])} gold={gold} onChanged={() => {}} />));
  it('names each state instead of claiming there was no content', () => {
    const t = render([own({}), own({ id: 'c2' }), own({ id: 'c3', status: 'reauth_required' }), own({ id: 'c4', postCount: 0 })]);
    expect(t).toContain('数据更新失败');
    expect(t).toContain('需要重新授权');
    expect(t).toContain('重新授权');
    expect(t).toContain('还没读到作品，如果你已经发过，请重新授权');
    expect(t).not.toContain('本周没有发内容');
  });
  it('calls a never-read new connection "首次更新中", and a stale one "数据更新延迟"', () => {
    const delayed = (id: string) => new Map([[id, { id, refreshError: null, delayed: true, manualRefreshAt: null, refreshState: null }]]);
    const show = (c: Connection) => text(renderToStaticMarkup(<ConnectionsPanel brands={[]} connections={[c]}
      refresh={delayed(c.id)} gold={false} onChanged={() => {}} />));
    const fresh = show(own({ lastSuccessAt: null, postCount: 0 }));
    expect(fresh).toContain('首次更新中');
    expect(fresh).not.toContain('数据更新延迟');
    expect(show(own({}))).toContain('数据更新延迟');
  });
  it('lets a manual-only or re-authorizing account be connected, and blocks only a live real connection', () => {
    const ids = blockingProjectIds([own({ accountProjectId: 'live' }), own({ id: 'm', accountProjectId: 'manual', source: 'manual' }),
      own({ id: 'r', accountProjectId: 'reauth', status: 'reauth_required' }), own({ id: 'q', accountProjectId: 'quar', status: 'quarantined' }),
      own({ id: 't', accountProjectId: 'tik', source: 'tikhub', platform: 'douyin' }), own({ id: 'n', accountProjectId: null })]);
    expect([...ids].sort()).toEqual(['live', 'tik']);
  });
  it('offers re-authorization through the connect form, not a direct call without the platform details', () => {
    const t = render([own({ id: 'i', platform: 'instagram', status: 'reauth_required' })]);
    expect(t).toContain('重新授权');
  });
  it('shows benchmark accounts only to Gold', () => {
    expect(render([])).not.toContain('对标账号（Gold）');
    expect(render([], true)).toContain('对标账号（Gold）');
  });
});

describe('reviews', () => {
  it('shows the automatic switch only to Gold and the reason a week was skipped', () => {
    state.reviews = ok([{ id: 'r1', periodStart: '2026-10-13T00:00:00Z', status: 'skipped', body: null, tables: null,
      notice: '余额不足，未复盘' }]);
    const pro = text(renderToStaticMarkup(<ReviewPanel gold={false} />));
    expect(pro).not.toContain('每周自动复盘');
    expect(pro).toContain('余额不足，未复盘');
    expect(text(renderToStaticMarkup(<ReviewPanel gold />))).toContain('每周自动复盘');
  });
  it('prefers the server notice over the generating label while a claimed review is being settled', () => {
    state.reviews = ok([{ id: 'r2', periodStart: '2026-10-20T00:00:00Z', status: 'claimed', body: null, tables: null,
      notice: '本周复盘已生成，费用正在核对。' }]);
    const settling = text(renderToStaticMarkup(<ReviewPanel gold />));
    expect(settling).toContain('本周复盘已生成，费用正在核对。');
    expect(settling).not.toContain('正在生成…');
    state.reviews = ok([{ id: 'r3', periodStart: '2026-10-20T00:00:00Z', status: 'claimed', body: null, tables: null, notice: null }]);
    expect(text(renderToStaticMarkup(<ReviewPanel gold />))).toContain('正在生成…');
  });
  it('says the weekly review is not open when the review switch is off', () => {
    state.reviews = failed('PUBLISH_MONITOR_REVIEW_DISABLED');
    expect(text(renderToStaticMarkup(<ReviewPanel gold />))).toContain('每周复盘还没有开放。');
  });
  it('does not ask for the reviews at all while the review switch is off', () => {
    state.features = ok({ ownData: true, weeklyReview: false, publish: false });
    expect(text(renderToStaticMarkup(<ReviewPanel gold />))).toContain('每周复盘还没有开放。');
    expect(state.reviewAsked).toEqual([false]);
  });
});
