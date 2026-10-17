/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { ResearchCallResult } from '../research/vendors/types';
import {
  addBenchmark, applyTikhubRead, connectOwnTikhub, tikhubOutcome, tikhubRows, type TikhubClaim,
} from './tikhub';

const actor = '00000000-0000-4000-8000-0000000f0001';
const account = '00000000-0000-4000-8000-0000000f0002';
const XHS = 'https://www.xiaohongshu.com/user/profile/61b46d790000000010008153';
const result = (over: Partial<ResearchCallResult>): ResearchCallResult => ({ vendor: 'tikhub', route: 'r', outcome: 'ok',
  reason: null, httpStatus: 200, supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [], truncated: false,
  fetchedAt: '2026-10-17T00:00:00.000Z', ...over });
const code = (promise: Promise<unknown>) => promise.then(() => 'OK', (error: { code?: string }) => error.code);
function settings(values: Record<string, unknown>) {
  return () => {
    let key = '';
    return { select() { return this; }, eq(_: string, value: string) { key = value; return this; },
      maybeSingle: async () => ({ data: key in values ? { value: values[key] } : null, error: null }) };
  };
}

describe('publish-monitor TikHub connections', () => {
  it('connects an own account by a full profile link on its own platform only', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { connectionId: account, platform: 'xiaohongshu' }, error: null });
    await connectOwnTikhub({ rpc } as never, actor, { accountProjectId: account, profileLink: ` ${XHS}?xsec=1 `, autoTrack: true });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_tikhub_connect', { a: actor, p_account_project_id: account,
      p_platform: 'xiaohongshu', p_profile_ref: '61b46d790000000010008153', p_auto_track: true });
    expect(await code(connectOwnTikhub({ rpc } as never, actor, { accountProjectId: account,
      profileLink: 'https://xhslink.com/a/x', autoTrack: true }))).toBe('PUBLISH_MONITOR_PROFILE_LINK_INVALID');
    expect(await code(connectOwnTikhub({ rpc } as never, actor, { accountProjectId: account,
      profileLink: 'https://www.tiktok.com/@natgeo', autoTrack: true }))).toBe('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('adds a benchmark under the admin limit, on Xiaohongshu/Douyin or a verified overseas platform', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { connectionId: account, platform: 'tiktok', count: 1 }, error: null });
    const db = (verified: string[]) => ({ rpc, from: settings({ publish_monitor_benchmark_limit: 3,
      research_tools_config: { config: { verifiedPlatforms: verified } } }) });
    expect(await code(addBenchmark(db([]) as never, actor, { businessId: account, profileLink: 'https://www.tiktok.com/@natgeo' })))
      .toBe('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
    await addBenchmark(db([]) as never, actor, { businessId: account, profileLink: XHS });
    expect(rpc).toHaveBeenLastCalledWith('publish_monitor_benchmark_add', expect.objectContaining({ p_platform: 'xiaohongshu',
      p_max: expect.any(Number) }));
    const limited = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_BENCHMARK_LIMIT' } });
    expect(await code(addBenchmark({ rpc: limited, from: settings({}) } as never, actor, { businessId: account, profileLink: XHS })))
      .toBe('PUBLISH_MONITOR_BENCHMARK_LIMIT');
  });
});

describe('publish-monitor TikHub read rows', () => {
  const posts = result({ items: [
    { url: 'https://www.xiaohongshu.com/explore/a', fields: { id: 'a', title: 'x'.repeat(200), publishedAt: '2026-10-01T00:00:00Z',
      likes: 30, comments: 2, shares: 1 }, missing: ['views'] },
    { fields: { title: 'no id' }, missing: [] },
  ] });
  it('keeps numbers, lists missing metrics (never zero) and drops posts without an id', () => {
    const rows = tikhubRows(result({ items: [{ fields: { followers: 12_000, name: 'n' }, missing: ['likesTotal'] }] }), posts);
    expect(rows.profile).toEqual({ metrics: { followers: 12_000 }, missingFields: ['following', 'likesTotal', 'postsCount'] });
    expect(rows.posts).toEqual([{ platformPostId: 'a', url: 'https://www.xiaohongshu.com/explore/a',
      postedAt: '2026-10-01T00:00:00.000Z', titleExcerpt: 'x'.repeat(120), metrics: { likes: 30, comments: 2, shares: 1 },
      missingFields: ['views'] }]);
  });

  it('settles: posts -> done, no results -> empty rules, failures -> not fetched (never re-authorise)', () => {
    expect(tikhubOutcome(posts)).toEqual({ outcome: 'done', error: null });
    expect(tikhubOutcome(result({ reason: 'NO_RESULTS' }))).toEqual({ outcome: 'empty', error: null });
    expect(tikhubOutcome(result({ outcome: 'failed', reason: 'UPSTREAM_400' }))).toEqual({ outcome: 'failed', error: 'TIKHUB_UPSTREAM_400' });
    expect(tikhubOutcome(result({ outcome: 'unknown', reason: 'TIMEOUT' })).outcome).toBe('failed');
  });

  it('writes then settles under the claim; a stale claim settles nothing', async () => {
    const claim: TikhubClaim = { connectionId: account, actorId: actor, businessId: account, role: 'own', lease: account,
      refreshId: account, platform: 'xiaohongshu', account: '61b46d790000000010008153', knownPosts: 0 };
    const rpc = vi.fn(async (name: string) => ({ data: name === 'publish_monitor_tikhub_write'
      ? { stale: false, inserted: 1, existing: 0 } : true, error: null }));
    expect(await applyTikhubRead({ rpc } as never, claim, null, posts, 'tikhub:ref')).toBe(true);
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['publish_monitor_tikhub_write', 'publish_monitor_refresh_finish']);
    const stale = vi.fn(async () => ({ data: { stale: true }, error: null }));
    expect(await applyTikhubRead({ rpc: stale } as never, claim, null, posts, 'tikhub:ref')).toBe(false);
    expect(stale).toHaveBeenCalledTimes(1);
  });
});
