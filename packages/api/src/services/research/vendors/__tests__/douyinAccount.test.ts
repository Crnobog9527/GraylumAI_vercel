/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PUBLISH-MONITOR PR-4: Douyin account routes. Bodies are hand-built from TikHub's public OpenAPI description of
// /douyin/app/v3/handler_user_profile and /douyin/app/v3/fetch_user_post_videos — NOT recorded responses (none exist
// yet; RT-7 and the pre-release staging check replace them). No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { parseProfileLink } from '../../tools/accountLinks';
import { buildTikhubRequest, callTikhub } from '../tikhub';
import { FIXED_NOW, jsonFetch, type RecordedCall } from './fetchDoubles';

const SEC = 'MS4wLjABAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFG_-';
const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });

describe('Douyin account routes', () => {
  it("sends only a well-formed sec_user_id and caps the page size at TikHub's documented 20", () => {
    expect(buildTikhubRequest({ platform: 'douyin', kind: 'account_profile', account: '123456' })).toEqual({ reason: 'INVALID_ACCOUNT' });
    expect(buildTikhubRequest({ platform: 'douyin', kind: 'account_profile', account: `${SEC}/x` })).toEqual({ reason: 'INVALID_ACCOUNT' });
    const profile = buildTikhubRequest({ platform: 'douyin', kind: 'account_profile', account: SEC });
    expect(profile).toEqual({ request: expect.objectContaining({ method: 'GET',
      url: `https://api.tikhub.io/api/v1/douyin/app/v3/handler_user_profile?sec_user_id=${SEC}` }) });
    const posts = buildTikhubRequest({ platform: 'douyin', kind: 'account_posts', account: SEC, limit: 500 });
    expect('request' in posts && new URL(posts.request.url).searchParams.get('count')).toBe('20');
    const dflt = buildTikhubRequest({ platform: 'douyin', kind: 'account_posts', account: SEC });
    expect('request' in dflt && new URL(dflt.request.url).searchParams.get('count')).toBe('20');
  });

  it('normalizes a profile and a post page; an empty aweme_list is "no results", not a failure', async () => {
    const calls: RecordedCall[] = [];
    const profile = await callTikhub({ platform: 'douyin', kind: 'account_profile', account: SEC }, deps(jsonFetch(200, {
      code: 200, data: { user: { uid: '1', sec_uid: SEC, nickname: '露营老王', unique_id: 'laowang', follower_count: 52_000,
        following_count: 12, aweme_count: 80, total_favorited: 900_000 } } }, calls)));
    expect(profile).toMatchObject({ outcome: 'ok', items: [{ fields: { followers: 52_000, postsCount: 80, name: '露营老王' } }] });
    const posts = await callTikhub({ platform: 'douyin', kind: 'account_posts', account: SEC }, deps(jsonFetch(200, {
      code: 200, data: { aweme_list: [{ aweme_id: '7400000000000000001', desc: '新视频', create_time: 1_760_000_000,
        author: { nickname: '露营老王', unique_id: 'laowang' },
        statistics: { play_count: 1200, digg_count: 30, comment_count: 7, share_count: 3 } }], has_more: 1, max_cursor: 1 } })));
    expect(posts).toMatchObject({ outcome: 'ok', items: [{ url: 'https://www.douyin.com/video/7400000000000000001',
      fields: { views: 1200, likes: 30 } }] });
    const empty = await callTikhub({ platform: 'douyin', kind: 'account_posts', account: SEC },
      deps(jsonFetch(200, { code: 200, data: { aweme_list: [] } })));
    expect(empty).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS' });
  });
});

describe('Xiaohongshu and Douyin profile links', () => {
  it('accepts full profile links only', () => {
    expect(parseProfileLink('https://www.xiaohongshu.com/user/profile/61b46d790000000010008153?xsec_token=x'))
      .toEqual({ platform: 'xiaohongshu', account: '61b46d790000000010008153' });
    expect(parseProfileLink(`https://www.douyin.com/user/${SEC}?from_tab_name=main`)).toEqual({ platform: 'douyin', account: SEC });
    expect(parseProfileLink(`https://www.iesdouyin.com/share/user/${SEC}`)).toEqual({ platform: 'douyin', account: SEC });
    for (const bad of ['https://www.xiaohongshu.com/explore/61b46d790000000010008153', 'https://xhslink.com/a/AbCd',
      'https://v.douyin.com/iRNBho6/', 'https://www.douyin.com/video/7400000000000000001',
      'https://www.xiaohongshu.com/user/profile/NOT-HEX']) {
      expect(parseProfileLink(bad)).toBeNull();
    }
  });
});
