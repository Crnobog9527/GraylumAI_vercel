/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-7: Xiaohongshu and Douyin benchmark routes checked against REAL TikHub responses recorded on 2026-10-18
// (get_user_info, get_user_posted_notes, handler_user_profile, fetch_user_post_videos; 2 public accounts each, about
// 0.08 USD at the documented 0.01 USD per call). The fixtures keep the real field structure and numbers but replace
// every account name, id, title and link. No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { BENCHMARK_CAPABLE_PLATFORMS, researchToolsConfigSchema } from '../config';
import { callTikhub, tikhubRouteId } from '../tikhub';
import { FIXED_NOW, failingFetch, hangingFetch, jsonFetch } from './fetchDoubles';
import samples from './fixtures/rt7Samples.json';

const XID = '0123456789abcdef01234567';
const SEC = 'MS4wLjABAAAA' + 'a'.repeat(40);
const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });
const call = (platform: 'xiaohongshu' | 'douyin', kind: 'account_profile' | 'account_posts', body: unknown, account = platform === 'douyin' ? SEC : XID) =>
  callTikhub({ platform, kind, account }, deps(jsonFetch(200, body)));

describe('Xiaohongshu account routes on real response shapes', () => {
  it('reads exact followers, post count and absolute publication times; views stay missing, never 0', async () => {
    const profile = await call('xiaohongshu', 'account_profile', samples.xhsProfile);
    expect(profile).toMatchObject({ outcome: 'ok', items: [{ fields: { id: XID, followers: 855, following: 22, postsCount: 15 } }] });
    const posts = await call('xiaohongshu', 'account_posts', samples.xhsNotes);
    expect(posts.outcome).toBe('ok');
    expect(posts.items).toHaveLength(3);
    for (const item of posts.items) {
      expect(item.fields.publishedAt).toMatch(/^2026-\d\d-\d\dT/);
      expect(item.missing).toContain('views');
      expect(item.fields).not.toHaveProperty('views');
      expect(item.fields.authorId).toBe(XID);
    }
    expect(posts.items[0]!.fields).toMatchObject({ likes: 84, comments: 4 });
  });

  it('treats an abbreviated follower label as missing, not as a number', async () => {
    const body = { code: 200, data: { code: 0, success: true, data: { userid: XID, nickname: '测试账号A', fans: '1.2万' } } };
    const profile = await call('xiaohongshu', 'account_profile', body);
    expect(profile.items[0]!.missing).toContain('followers');
    expect(profile.items[0]!.fields).not.toHaveProperty('followers');
  });
});

describe('Xiaohongshu notes pagination', () => {
  const notes = (samples.xhsNotes.data as { data: { notes: Array<{ id: string }> } }).data.notes;
  const lastId = notes[notes.length - 1]!.id;
  const page = (hasMore: boolean, extra: Record<string, unknown> = {}) => ({ ...samples.xhsNotes,
    data: { ...samples.xhsNotes.data, data: { ...(samples.xhsNotes.data as { data: object }).data, has_more: hasMore, ...extra } } });

  it('returns the last note as the next cursor only when the supplier says there is more', async () => {
    const withCursor = page(true, { notes: notes.map((note, i) => ({ ...note, cursor: i === notes.length - 1 ? '6a00000000000000000000ff' : note.id })) });
    expect((await call('xiaohongshu', 'account_posts', withCursor)).nextCursor).toBe('6a00000000000000000000ff');
    expect((await call('xiaohongshu', 'account_posts', page(true))).nextCursor).toBe(lastId);
    expect((await call('xiaohongshu', 'account_posts', page(false))).nextCursor).toBeUndefined();
  });

  it('sends the cursor on the next request and refuses a malformed one without calling', async () => {
    const calls: Array<{ url: string }> = [];
    await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: XID, cursor: '6a0000000000000000000001' },
      deps(jsonFetch(200, page(false), calls as never)));
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('6a0000000000000000000001');
    const first: Array<{ url: string }> = [];
    await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: XID }, deps(jsonFetch(200, page(false), first as never)));
    expect(new URL(first[0]!.url).searchParams.has('cursor')).toBe(false);
    const bad: Array<{ url: string }> = [];
    expect(await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: XID, cursor: '../x' }, deps(jsonFetch(200, {}, bad as never))))
      .toMatchObject({ outcome: 'not_sent', reason: 'INVALID_CURSOR' });
    expect(bad).toHaveLength(0);
  });
});

describe('Douyin account routes on real response shapes', () => {
  it('reads followers and posts; hidden play counts (always 0 upstream) are missing, not 0', async () => {
    const profile = await call('douyin', 'account_profile', samples.douyinProfile);
    expect(profile).toMatchObject({ outcome: 'ok', items: [{ fields: { followers: 43909, postsCount: 333 } }] });
    const posts = await call('douyin', 'account_posts', samples.douyinPosts);
    expect(posts.items).toHaveLength(3);
    for (const item of posts.items) {
      expect(item.fields.publishedAt).toMatch(/^20\d\d-/);
      expect(item.fields).not.toHaveProperty('views');
      expect(item.missing).toContain('views');
      // The profile route needs the sec_user_id, so that is the author id a later fetch uses.
      expect(item.fields.authorId).toBe(SEC);
    }
  });

  it.each(['tiktok', 'douyin'] as const)('%s follows the recorded TikHub max_cursor fields and sends the next cursor', async platform => {
    // TikTok RESEARCH-0 sample and RT-7 Douyin sample both expose data.has_more, data.max_cursor and data.aweme_list.
    // This fixture keeps only the verified field names and sanitized post payload.
    const data = samples.douyinPosts.data as Record<string, unknown>;
    const body = { ...samples.douyinPosts, data: { ...data, has_more: 1, max_cursor: 1790600000000 } };
    const account = platform === 'tiktok' ? 'alice' : SEC;
    const firstCalls: Array<{ url: string }> = [];
    const first = await callTikhub({ platform, kind: 'account_posts', account }, deps(jsonFetch(200, body, firstCalls as never)));
    expect(first.nextCursor).toBe('1790600000000');
    expect(first.items.length).toBeGreaterThan(0);
    const path = platform === 'tiktok' ? '/api/v1/tiktok/app/v3/fetch_user_post_videos'
      : '/api/v1/douyin/app/v3/fetch_user_post_videos';
    expect(new URL(firstCalls[0]!.url).pathname).toBe(path);
    expect(new URL(firstCalls[0]!.url).searchParams.get('max_cursor')).toBe('0');

    const nextCalls: Array<{ url: string }> = [];
    await callTikhub({ platform, kind: 'account_posts', account, cursor: first.nextCursor },
      deps(jsonFetch(200, { ...body, data: { ...data, has_more: 0, max_cursor: 1790600000000 } }, nextCalls as never)));
    expect(new URL(nextCalls[0]!.url).searchParams.get('max_cursor')).toBe('1790600000000');
  });

  it('does not return a TikTok or Douyin cursor when the upstream has no next page or the cursor does not advance', async () => {
    const data = samples.douyinPosts.data as Record<string, unknown>;
    const noMore = { ...samples.douyinPosts, data: { ...data, has_more: 0, max_cursor: 1790600000000 } };
    const sameCursor = { ...samples.douyinPosts, data: { ...data, has_more: 1, max_cursor: 0 } };
    for (const platform of ['tiktok', 'douyin'] as const) {
      const account = platform === 'tiktok' ? 'alice' : SEC;
      expect((await callTikhub({ platform, kind: 'account_posts', account }, deps(jsonFetch(200, noMore)))).nextCursor)
        .toBeUndefined();
      expect((await callTikhub({ platform, kind: 'account_posts', account }, deps(jsonFetch(200, sameCursor)))).nextCursor)
        .toBeUndefined();
    }
  });

  it('keeps a positive play count (search results may carry one) and still drops a 0', async () => {
    const aweme = (samples.douyinPosts.data as { aweme_list: Array<Record<string, unknown>> }).aweme_list[0]!;
    const withViews = { ...aweme, statistics: { ...(aweme.statistics as object), play_count: 5400 } };
    const result = await callTikhub({ platform: 'douyin', kind: 'keyword_posts', keyword: '露营' },
      deps(jsonFetch(200, { code: 200, data: { data: [{ aweme_info: withViews }, { aweme_info: aweme }] } })));
    expect(result.items.map(item => item.fields.views)).toEqual([5400, undefined]);
  });

  it('a search hit keeps the sec_user_id as author id so discovery can fetch the profile', async () => {
    const hit = { code: 200, data: { data: [{ aweme_info: (samples.douyinPosts.data as { aweme_list: unknown[] }).aweme_list[0] }] } };
    const result = await callTikhub({ platform: 'douyin', kind: 'keyword_posts', keyword: '露营' }, deps(jsonFetch(200, hit)));
    expect(result.items[0]!.fields.authorId).toBe(SEC);
  });
});

describe('error returns and limits', () => {
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    it(`${platform}: upstream error body is a charged failure, 429 and 5xx are free failures, a hang is unknown`, async () => {
      const kind = 'account_profile' as const;
      const account = platform === 'douyin' ? SEC : XID;
      expect(await callTikhub({ platform, kind, account }, deps(jsonFetch(200, { code: 400, message: 'bad' }))))
        .toMatchObject({ outcome: 'failed', reason: 'UPSTREAM_400', supplierMayCharge: true });
      expect(await callTikhub({ platform, kind, account }, deps(jsonFetch(429, { code: 429 }))))
        .toMatchObject({ outcome: 'failed', reason: 'HTTP_429', supplierMayCharge: false });
      expect(await callTikhub({ platform, kind, account }, deps(jsonFetch(503, 'down'))))
        .toMatchObject({ outcome: 'failed', reason: 'HTTP_503', supplierMayCharge: false });
      expect(await callTikhub({ platform, kind, account }, deps(hangingFetch()))).toMatchObject({ outcome: 'unknown', supplierMayCharge: true });
      expect(await callTikhub({ platform, kind, account }, deps(failingFetch()))).toMatchObject({ outcome: 'unknown' });
    });

    it(`${platform}: an unrecognized 200 body is not a delivery, and a bad account id sends nothing`, async () => {
      const account = platform === 'douyin' ? SEC : XID;
      expect(await callTikhub({ platform, kind: 'account_profile', account }, deps(jsonFetch(200, { code: 200, data: { unexpected: true } }))))
        .toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
      const calls: Array<{ url: string }> = [];
      expect(await callTikhub({ platform, kind: 'account_profile', account: 'not-an-id' }, deps(jsonFetch(200, {}, calls as never))))
        .toMatchObject({ outcome: 'not_sent', reason: 'INVALID_ACCOUNT' });
      expect(calls).toHaveLength(0);
    });
  }
});

describe('benchmark platform configuration', () => {
  const route = (platform: string, kind: string, vendor = 'tikhub') => ({ platform, kind, vendor,
    route: vendor === 'tikhub' ? tikhubRouteId(platform as never, kind as never)! : '', backup: null, maxUnitsPerCall: '1' });
  const base = (platforms: string[], routes: unknown[]) => ({ version: 1, enabled: true,
    vendors: { tikhub: { enabled: true, hardCapAttested: { by: '11111111-1111-4111-8111-111111111111', at: '2026-10-18T00:00:00Z' } },
      parallel: { enabled: false, hardCapAttested: null }, firecrawl: { enabled: false, hardCapAttested: null } },
    verifiedPlatforms: platforms, benchmarkPlatforms: platforms, routes,
    limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 }, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' } });

  it('accepts Xiaohongshu and Douyin as benchmark platforms once their profile and post routes are configured', () => {
    expect(BENCHMARK_CAPABLE_PLATFORMS).toEqual(expect.arrayContaining(['xiaohongshu', 'douyin']));
    const routes = (['xiaohongshu', 'douyin'] as const).flatMap(p => (['account_profile', 'account_posts', 'keyword_posts'] as const).map(k => route(p, k)));
    expect(researchToolsConfigSchema.safeParse(base(['xiaohongshu', 'douyin'], routes)).success).toBe(true);
  });

  it('rejects a benchmark platform whose post route is missing', () => {
    const routes = [route('douyin', 'account_profile'), route('douyin', 'keyword_posts')];
    expect(researchToolsConfigSchema.safeParse(base(['douyin'], routes)).success).toBe(false);
  });
});
