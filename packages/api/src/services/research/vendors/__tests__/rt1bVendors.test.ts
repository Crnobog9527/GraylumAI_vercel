/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-1b: Bilibili account posts, Xiaohongshu profile and posts, YouTube post detail. Bodies follow the TikHub
// OpenAPI descriptions and the platforms' own published shapes; RT-7 replaces them with recorded real samples.
// No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CAPABLE_PLATFORMS, BENCHMARK_ROUTE_KINDS, MAX_BENCHMARK_SUBCALLS_PER_ACCOUNT, benchmarkSubcallsPerAccount,
  researchToolsConfigSchema, type ResearchToolsConfig,
} from '../config';
import { buildTikhubRequest, callTikhub } from '../tikhub';
import { SOCIAL_PLATFORMS } from '../types';
import { FIXED_NOW, jsonFetch, type RecordedCall } from './fetchDoubles';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });
const XHS_USER = '61b46d790000000010008153';
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const billedFailure = { outcome: 'failed', supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [] };

const vlistVideo = (bvid: string, extra: Record<string, unknown> = {}) => ({
  aid: 1, bvid, title: `视频 ${bvid}`, author: '露营老王', mid: 178360345, created: 1_760_000_000, play: 12_000, comment: 30,
  length: '10:00', description: '简介不外传', ...extra,
});
const bilibiliBody = (vlist: unknown[]) => ({ code: 200, data: { code: 0, message: '0', data: { list: { vlist }, page: { count: 2 } } } });

describe('Bilibili account posts', () => {
  it('asks for the newest uploads of a numeric uid only', async () => {
    const calls: RecordedCall[] = [];
    await callTikhub({ platform: 'bilibili', kind: 'account_posts', account: '178360345', limit: 99 },
      deps(jsonFetch(200, bilibiliBody([vlistVideo('BV1')]), calls)));
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/bilibili/web/fetch_user_post_videos');
    expect(query(calls[0].url)).toEqual({ uid: '178360345', pn: '1', ps: '30', order: 'pubdate' });
    expect(buildTikhubRequest({ platform: 'bilibili', kind: 'account_posts', account: 'space.bilibili.com/1' }))
      .toEqual({ reason: 'INVALID_ACCOUNT' });
  });

  it('maps absolute dates, plays and comments; hidden plays and absent likes/shares stay missing, never 0', async () => {
    const body = bilibiliBody([vlistVideo('BV1'), vlistVideo('BV2', { play: '--', comment: 0 })]);
    const result = await callTikhub({ platform: 'bilibili', kind: 'account_posts', account: '178360345' }, deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'ok', supplierMayCharge: true, usage: { unit: 'call', units: '1' } });
    expect(result.items[0]).toEqual({
      url: 'https://www.bilibili.com/video/BV1',
      fields: { id: 'BV1', title: '视频 BV1', author: '露营老王', authorId: '178360345', publishedAt: '2025-10-09T08:53:20.000Z',
        views: 12_000, comments: 30 },
      missing: ['likes', 'shares'],
    });
    expect(result.items[1].fields).toMatchObject({ comments: 0 });
    expect(result.items[1].missing).toEqual(['views', 'likes', 'shares']);
    expect(JSON.stringify(result.items)).not.toContain('简介不外传');
  });

  it('treats only the route empty list as "no results"; risk control or a changed shape is a billed failure', async () => {
    const empty = await callTikhub({ platform: 'bilibili', kind: 'account_posts', account: '1' }, deps(jsonFetch(200, bilibiliBody([]))));
    expect(empty).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', usage: { units: '1' } });
    const riskControl = { code: 200, data: { code: -352, message: '风控校验失败', data: { v_voucher: 'x' } } };
    expect(await callTikhub({ platform: 'bilibili', kind: 'account_posts', account: '1' }, deps(jsonFetch(200, riskControl))))
      .toMatchObject({ ...billedFailure, reason: 'EMPTY_OR_UNRECOGNIZED' });
    const shell = bilibiliBody([{ bvid: 'BV9' }]);
    expect(await callTikhub({ platform: 'bilibili', kind: 'account_posts', account: '1' }, deps(jsonFetch(200, shell))))
      .toMatchObject({ ...billedFailure, reason: 'EMPTY_OR_UNRECOGNIZED' });
  });
});

const xhsProfileBody = (user: Record<string, unknown>) => ({ code: 200, data: { code: 0, success: true, data: user } });
const xhsNotesBody = (notes: unknown[]) => ({ code: 200, data: { code: 0, success: true, data: { notes, has_more: false } } });
const xhsNote = (id: string, extra: Record<string, unknown> = {}) => ({
  note_id: id, display_title: `笔记 ${id}`, type: 'normal', likes: 88, comments_count: 4, share_count: 1, create_time: 1_760_000_000,
  user: { nickname: '露营老王', userid: XHS_USER }, ...extra,
});
// TikHub documents that a wrong user id still answers 200, is billed, and carries Xiaohongshu's "服务异常".
const serviceError = { code: 200, data: { code: -1, success: false, msg: '服务异常' } };

describe('Xiaohongshu account routes', () => {
  it('sends only a strictly checked user_id, never share links', async () => {
    const calls: RecordedCall[] = [];
    await callTikhub({ platform: 'xiaohongshu', kind: 'account_profile', account: XHS_USER },
      deps(jsonFetch(200, xhsProfileBody({ userid: XHS_USER, nickname: 'N', red_id: '123', fans: '15000' }), calls)));
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/xiaohongshu/app_v2/get_user_info');
    expect(query(calls[0].url)).toEqual({ user_id: XHS_USER });
    for (const bad of ['https://www.xiaohongshu.com/user/profile/' + XHS_USER, 'xhslink.com/a/abc', XHS_USER.toUpperCase(),
      XHS_USER.slice(1), XHS_USER + '0']) {
      expect(buildTikhubRequest({ platform: 'xiaohongshu', kind: 'account_posts', account: bad })).toEqual({ reason: 'INVALID_ACCOUNT' });
    }
  });

  it('reads followers as plain counts only (interactions too); abbreviated labels stay missing', async () => {
    const plain = await callTikhub({ platform: 'xiaohongshu', kind: 'account_profile', account: XHS_USER },
      deps(jsonFetch(200, xhsProfileBody({ userid: XHS_USER, nickname: '露营老王', red_id: '95123', desc: '微信 abc',
        interactions: [{ type: 'follows', count: '12' }, { type: 'fans', count: '15300' }, { type: 'interaction', count: '9万' }] }))));
    expect(plain.items).toEqual([{ fields: { id: XHS_USER, name: '露营老王', handle: '95123', followers: 15300, following: 12 },
      missing: ['postsCount', 'likesTotal', 'verified'] }]);
    const abbreviated = await callTikhub({ platform: 'xiaohongshu', kind: 'account_profile', account: XHS_USER },
      deps(jsonFetch(200, xhsProfileBody({ userid: XHS_USER, nickname: 'N', fans: '1.2万' }))));
    expect(abbreviated.items[0].missing).toContain('followers');
  });

  it('never reports views (not public) and keeps a supplied zero as zero', async () => {
    const result = await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: XHS_USER },
      deps(jsonFetch(200, xhsNotesBody([xhsNote('a1'), xhsNote('a2', { likes: 0, view_count: 999 })]))));
    expect(result).toMatchObject({ outcome: 'ok', usage: { units: '1' } });
    expect(result.items[0]).toEqual({ url: 'https://www.xiaohongshu.com/explore/a1',
      fields: { id: 'a1', title: '笔记 a1', author: '露营老王', authorId: XHS_USER, publishedAt: '2025-10-09T08:53:20.000Z',
        likes: 88, comments: 4, shares: 1 },
      missing: ['views'] });
    expect(result.items[1].fields.likes).toBe(0);
    expect(result.items[1].missing).toEqual(['views']);
  });

  it('records "服务异常" as a billed failure (failed, supplier may charge, one unit), for both routes', async () => {
    for (const kind of ['account_profile', 'account_posts'] as const) {
      expect(await callTikhub({ platform: 'xiaohongshu', kind, account: XHS_USER }, deps(jsonFetch(200, serviceError))))
        .toMatchObject({ ...billedFailure, reason: 'EMPTY_OR_UNRECOGNIZED' });
    }
    const empty = await callTikhub({ platform: 'xiaohongshu', kind: 'account_posts', account: XHS_USER }, deps(jsonFetch(200, xhsNotesBody([]))));
    expect(empty).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', usage: { units: '1' } });
  });
});

const videoDetail = (extra: Record<string, unknown> = {}) => ({ code: 200, data: {
  video_id: 'zd3yCa1bJCM', title: 'Minecraft: DREAM!', author: 'Maizen', channel_id: 'UCJHBJ7F-nAIlMGolm0Hu4vg',
  channel_follower_count: 98_400, publish_date: '2026-10-01T09:00:00-07:00', view_count: 343_369, like_count: 0,
  comment_count: 120, ...extra } });

describe('YouTube post detail', () => {
  it('reads one video by a strictly checked id and returns exact followers and an absolute date', async () => {
    const calls: RecordedCall[] = [];
    const result = await callTikhub({ platform: 'youtube', kind: 'post_detail', postId: 'zd3yCa1bJCM' },
      deps(jsonFetch(200, videoDetail(), calls)));
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/youtube/web_v2/get_video_info_v2');
    expect(query(calls[0].url)).toEqual({ video_id: 'zd3yCa1bJCM', need_format: 'true' });
    expect(result).toMatchObject({ outcome: 'ok', usage: { unit: 'call', units: '1' } });
    expect(result.items).toEqual([{ url: 'https://www.youtube.com/watch?v=zd3yCa1bJCM', fields: {
      id: 'zd3yCa1bJCM', title: 'Minecraft: DREAM!', author: 'Maizen', authorId: 'UCJHBJ7F-nAIlMGolm0Hu4vg',
      publishedAt: '2026-10-01T16:00:00.000Z', views: 343_369, likes: 0, comments: 120, followers: 98_400 }, missing: ['shares'] }]);
  });

  it('refuses a bad or missing video id before any call; the account field is never used for it', async () => {
    const calls: RecordedCall[] = [];
    for (const postId of [undefined, 'zd3yCa1bJC', 'https://youtu.be/zd3yCa1bJCM', 'zd3yCa1bJ?M']) {
      expect(await callTikhub({ platform: 'youtube', kind: 'post_detail', postId, account: 'zd3yCa1bJCM' }, deps(jsonFetch(200, {}, calls))))
        .toMatchObject({ outcome: 'not_sent', reason: 'INVALID_POST', supplierMayCharge: false });
    }
    expect(calls).toHaveLength(0);
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'post_detail', postId: 'zd3yCa1bJCM' })).toEqual({ reason: 'ROUTE_NOT_SUPPORTED' });
  });

  it('is a billed failure when neither followers nor an absolute date came back (relative labels do not count)', async () => {
    const relativeOnly = videoDetail({ channel_follower_count: '9.84万', publish_date: '18小时前', published_at: undefined });
    expect(await callTikhub({ platform: 'youtube', kind: 'post_detail', postId: 'zd3yCa1bJCM' }, deps(jsonFetch(200, relativeOnly))))
      .toMatchObject({ ...billedFailure, reason: 'EMPTY_OR_UNRECOGNIZED' });
  });

  it('keeps channel-list times missing: relative labels are never converted', async () => {
    const list = { code: 200, data: { channel: { name: 'Maizen' }, videos: [
      { video_id: 'zd3yCa1bJCM', title: 'A', view_count: '343,369次观看', published_time: '18小时前' }] } };
    const result = await callTikhub({ platform: 'youtube', kind: 'account_posts', account: 'UCJHBJ7F-nAIlMGolm0Hu4vg' },
      deps(jsonFetch(200, list)));
    expect(result.items[0].fields.views).toBe(343_369);
    expect(result.items[0].missing).toContain('publishedAt');
  });
});

describe('benchmark route sets', () => {
  it('lists each platform set, keeps every set within 3 sub-calls and enables only verified platforms', () => {
    expect(BENCHMARK_ROUTE_KINDS.bilibili).toEqual({ kinds: ['account_profile', 'account_relation', 'account_posts'],
      followersFrom: 'account_relation', verified: false });
    expect(BENCHMARK_ROUTE_KINDS.youtube).toEqual({ kinds: ['account_posts', 'post_detail'], followersFrom: 'post_detail', verified: false });
    expect(BENCHMARK_ROUTE_KINDS.xiaohongshu).toEqual({ kinds: ['account_profile', 'account_posts'],
      followersFrom: 'account_profile', verified: false });
    expect(BENCHMARK_CAPABLE_PLATFORMS).toEqual(['tiktok', 'x']);
    expect(MAX_BENCHMARK_SUBCALLS_PER_ACCOUNT).toBe(3);
    for (const platform of SOCIAL_PLATFORMS) expect(benchmarkSubcallsPerAccount(platform)).toBeLessThanOrEqual(3);
    expect([benchmarkSubcallsPerAccount('bilibili'), benchmarkSubcallsPerAccount('youtube'), benchmarkSubcallsPerAccount('douyin')])
      .toEqual([3, 2, 0]);
    expect(Object.isFrozen(BENCHMARK_ROUTE_KINDS.youtube!.kinds)).toBe(true);
  });

  it('accepts the new routes in admin config but never lets an unverified platform become a benchmark platform', () => {
    const route = (platform: 'bilibili' | 'youtube' | 'xiaohongshu', kind: string, path: string) =>
      ({ platform, kind, vendor: 'tikhub', route: path, backup: null, maxUnitsPerCall: '1' });
    const config = {
      version: 1, enabled: true,
      vendors: { tikhub: { enabled: false, hardCapAttested: null }, parallel: { enabled: false, hardCapAttested: null },
        firecrawl: { enabled: false, hardCapAttested: null } },
      verifiedPlatforms: ['bilibili', 'youtube', 'xiaohongshu'], benchmarkPlatforms: [],
      routes: [
        route('bilibili', 'account_profile', '/bilibili/web/fetch_user_profile'),
        route('bilibili', 'account_relation', '/bilibili/web/fetch_user_relation_stat'),
        route('bilibili', 'account_posts', '/bilibili/web/fetch_user_post_videos'),
        route('xiaohongshu', 'account_profile', '/xiaohongshu/app_v2/get_user_info'),
        route('xiaohongshu', 'account_posts', '/xiaohongshu/app_v2/get_user_posted_notes'),
        route('youtube', 'account_posts', '/youtube/web_v2/get_channel_videos'),
        route('youtube', 'post_detail', '/youtube/web_v2/get_video_info_v2'),
      ],
      limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
      recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
    } as unknown as ResearchToolsConfig;
    expect(researchToolsConfigSchema.safeParse(config).success).toBe(true);
    for (const platform of ['bilibili', 'youtube', 'xiaohongshu'] as const) {
      const parsed = researchToolsConfigSchema.safeParse({ ...config, benchmarkPlatforms: [platform] });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('cannot supply benchmark fields yet');
    }
    const wrongPath = { ...config, routes: [route('youtube', 'post_detail', '/youtube/web_v2/get_video_info')] };
    expect(researchToolsConfigSchema.safeParse(wrongPath).success).toBe(false);
  });
});
