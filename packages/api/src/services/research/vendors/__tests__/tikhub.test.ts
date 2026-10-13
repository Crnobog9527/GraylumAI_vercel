/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Response bodies are built from the shapes RESEARCH-0 parsed (#457, #465); RT-7 replaces them with
// recorded real samples. No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { buildTikhubRequest, callTikhub, TIKHUB_ROUTES } from '../tikhub';
import { FIXED_NOW, failingFetch, hangingFetch, jsonFetch, type RecordedCall } from './fetchDoubles';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });

const awemeItem = (id: string, extra: Record<string, unknown> = {}) => ({
  aweme_id: id, desc: `视频 ${id}`, create_time: 1_760_000_000,
  author: { nickname: '露营老王', unique_id: 'laowang' },
  statistics: { play_count: 1200, digg_count: 0, comment_count: 7, share_count: 3 },
  ...extra,
});

describe('TikHub routes', () => {
  it('never offers the endpoints that failed in RESEARCH-0', () => {
    const paths = Object.values(TIKHUB_ROUTES).map(route => route!.path);
    expect(paths).not.toContain('/douyin/search/fetch_video_search_v5');
    expect(paths).not.toContain('/instagram/v2/fetch_user_posts');
    expect(paths).not.toContain('/instagram/v2/search_reels');
    expect(paths).toContain('/douyin/search/fetch_video_search_v2');
    // No follower count without the unverified relation endpoint, so no Bilibili profile route yet.
    expect(Object.keys(TIKHUB_ROUTES).some(key => key.startsWith('bilibili:'))).toBe(false);
    expect(paths).toContain('/instagram/v3/get_user_posts');
  });

  it('refuses unsupported pairs and bad input before any network call', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = jsonFetch(200, {}, calls);
    expect(buildTikhubRequest({ platform: 'douyin', kind: 'account_profile', account: 'x' })).toEqual({ reason: 'ROUTE_NOT_SUPPORTED' });
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'keyword_posts', keyword: '  ' })).toEqual({ reason: 'INVALID_KEYWORD' });
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'keyword_posts', keyword: '一'.repeat(41) })).toEqual({ reason: 'INVALID_KEYWORD' });
    expect(buildTikhubRequest({ platform: 'weibo', kind: 'account_posts', account: 'abc' })).toEqual({ reason: 'INVALID_ACCOUNT' });
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'account_profile', account: 'a/../b' })).toEqual({ reason: 'INVALID_ACCOUNT' });
    const result = await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: 'x' }, deps(fetchImpl));
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'ROUTE_NOT_SUPPORTED', supplierMayCharge: false });
    expect(calls).toHaveLength(0);
  });

  it('builds the tested Douyin v2 POST body and caps the post count at 30', () => {
    const built = buildTikhubRequest({ platform: 'douyin', kind: 'keyword_posts', keyword: ' 露营装备 ' });
    expect(built).toEqual({ request: { method: 'POST', url: 'https://api.tikhub.io/api/v1/douyin/search/fetch_video_search_v2',
      body: expect.objectContaining({ keyword: '露营装备', cursor: 0 }) } });
    const tiktok = buildTikhubRequest({ platform: 'tiktok', kind: 'account_posts', account: 'natgeo', limit: 99 });
    expect('request' in tiktok && new URL(tiktok.request.url).searchParams.get('count')).toBe('30');
  });
});

describe('callTikhub', () => {
  it('normalizes posts, keeps zero as a value and lists missing fields instead of zero', async () => {
    const calls: RecordedCall[] = [];
    const body = { code: 200, data: { data: [awemeItem('1'), awemeItem('2', { statistics: { play_count: 5 } })] } };
    const result = await callTikhub({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'camping gear' }, deps(jsonFetch(200, body, calls)));
    expect(result).toMatchObject({ outcome: 'ok', usage: { unit: 'call', units: '1' }, supplierMayCharge: true, truncated: false });
    expect(result.items[0]).toEqual({
      url: 'https://www.tiktok.com/@laowang/video/1',
      fields: { id: '1', title: '视频 1', author: '露营老王', authorId: 'laowang', publishedAt: '2025-10-09T08:53:20.000Z',
        views: 1200, likes: 0, comments: 7, shares: 3 },
      missing: [],
    });
    expect(result.items[1].missing).toEqual(['likes', 'comments', 'shares']);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('never passes bios or contact details through for profiles', async () => {
    const body = { code: 200, data: { user: { uid: '9', nickname: 'N', unique_id: 'n', follower_count: 15000,
      signature: '微信 abc123', email: 'a@b.c', avatar_larger: { url_list: ['x'] } } } };
    const result = await callTikhub({ platform: 'tiktok', kind: 'account_profile', account: 'n' }, deps(jsonFetch(200, body)));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fields).toMatchObject({ id: '9', followers: 15000, handle: 'n' });
    expect(JSON.stringify(result.items)).not.toMatch(/微信|a@b\.c|url_list/);
    expect(result.items[0].missing).toContain('following');
  });

  it('keeps the YouTube relative date and abbreviated views missing', async () => {
    const body = { code: 200, data: { channel: { name: 'Chan' }, videos: [{ video_id: 'v1', title: 'T', published_at: '2周前', view_count: '50万次观看' }] } };
    const result = await callTikhub({ platform: 'youtube', kind: 'account_posts', account: 'UCLA_DiR1FfKNvjuUpBHmylQ' }, deps(jsonFetch(200, body)));
    expect(result.items[0].fields).toMatchObject({ id: 'v1', author: 'Chan' });
    expect(result.items[0].missing).toEqual(expect.arrayContaining(['publishedAt', 'views']));
  });

  it('treats HTTP 200 with an upstream error code as a failure the supplier may bill', async () => {
    const result = await callTikhub({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '护肤' },
      deps(jsonFetch(200, { code: 400, message: 'upstream error' })));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'UPSTREAM_400', supplierMayCharge: true, usage: { units: '1' }, items: [] });
  });

  it('treats non-200 as a confirmed unbilled failure', async () => {
    const result = await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(402, { detail: 'no credit' })));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'HTTP_402', supplierMayCharge: false, usage: { units: '0' } });
  });

  it('reports network errors and timeouts as unknown with no usage, and sends exactly once', async () => {
    const calls: RecordedCall[] = [];
    const broken = await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(failingFetch(undefined, calls)));
    expect(broken).toMatchObject({ outcome: 'unknown', reason: 'NETWORK_ERROR', usage: { units: null }, supplierMayCharge: true });
    const hung = await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(hangingFetch(calls)));
    expect(hung).toMatchObject({ outcome: 'unknown', reason: 'TIMEOUT', usage: { units: null } });
    expect(calls).toHaveLength(2);
  });

  it('cuts to the requested limit and says so', async () => {
    const posts = Array.from({ length: 35 }, (_, index) => awemeItem(String(index)));
    const result = await callTikhub({ platform: 'tiktok', kind: 'account_posts', account: 'natgeo', limit: 30 },
      deps(jsonFetch(200, { code: 200, data: { aweme_list: posts } })));
    expect(result).toMatchObject({ outcome: 'partial', truncated: true });
    expect(result.items).toHaveLength(30);
  });

  it('keeps a recognized empty list as a successful, billed no-results answer', async () => {
    const empty = await callTikhub({ platform: 'tiktok', kind: 'account_posts', account: 'quiet' },
      deps(jsonFetch(200, { code: 200, data: { aweme_list: [] } })));
    expect(empty).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', items: [], usage: { units: '1' } });
    const weibo = await callTikhub({ platform: 'weibo', kind: 'account_posts', account: '1' },
      deps(jsonFetch(200, { code: 200, data: { data: { statuses: [] } } })));
    expect(weibo).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS' });
    const unrelated = await callTikhub({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'zzzz' },
      deps(jsonFetch(200, { code: 200, data: { metadata: { data: [] } } })));
    expect(unrelated).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
  });

  it('reports an unreadable 200 as unknown (possibly billed, never resent) and out-of-range dates as missing', async () => {
    expect(await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(200, '<html>'))))
      .toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_NOT_JSON', usage: { units: null }, supplierMayCharge: true });
    expect(await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(200, ''))))
      .toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_EMPTY' });
    expect(await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(502, '<html>'))))
      .toMatchObject({ outcome: 'failed', reason: 'HTTP_502' });
    const result = await callTikhub({ platform: 'tiktok', kind: 'account_posts', account: 'natgeo' },
      deps(jsonFetch(200, { code: 200, data: { aweme_list: [awemeItem('1', { create_time: 1e20 })] } })));
    expect(result.items[0].missing).toContain('publishedAt');
  });

  it('reports an empty or unrecognized payload as a failed delivery, never as a billable success', async () => {
    const posts = await callTikhub({ platform: 'weibo', kind: 'account_posts', account: '2803301701' },
      deps(jsonFetch(200, { code: 200, data: { something: 'else' } })));
    expect(posts).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED', items: [], supplierMayCharge: true });
    const shapeless = await callTikhub({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'q' },
      deps(jsonFetch(200, { code: 200, data: { aweme_list: null } })));
    expect(shapeless).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
    const profile = await callTikhub({ platform: 'tiktok', kind: 'account_profile', account: 'n' }, deps(jsonFetch(200, { code: 200 })));
    expect(profile).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
  });
});
