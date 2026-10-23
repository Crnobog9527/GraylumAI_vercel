/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-6: YouTube benchmark routes checked against REAL TikHub responses recorded on 2026-10-23
// (get_general_search_v2, get_channel_videos, get_video_info_v2; about 0.005 USD). The fixtures keep the real structure,
// labels and dates but replace every name, id and link. The detail route returned no channel_follower_count, only the
// rounded subscriber label: Owner 2026-10-23 "YouTube 对标按约数保守判断，同意 A". No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { classifyAccount } from '../../benchmark/classify';
import { accountMetrics, type EvidenceItem } from '../../benchmark/metrics';
import { approximateRange, approximateSubscribers } from '../approxCount';
import { callTikhub } from '../tikhub';
import { FIXED_NOW, jsonFetch } from './fetchDoubles';
import samples from './fixtures/youtubeSamples.json';

const CHANNEL = 'UC' + 'a'.repeat(22);
const deps = { apiKey: 'test-key', now: FIXED_NOW, timeoutMs: 50 };
const growth = { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' };

describe('YouTube subscriber labels', () => {
  it('reads the rounded label as a number with exact decimal arithmetic, and nothing else', () => {
    expect(approximateSubscribers('1.88万位订阅者')).toBe(18_800);
    expect(approximateSubscribers('28.6万位订阅者')).toBe(286_000);
    expect(approximateSubscribers('15.1M subscribers')).toBe(15_100_000);
    expect(approximateSubscribers('18.8K subscribers')).toBe(18_800);
    expect(approximateSubscribers('1.11亿')).toBe(111_000_000);
    expect(approximateSubscribers('523 subscribers')).toBe(523);
    for (const label of ['', '1.2', 'about 2M', '1,234 subscribers', '1.2.3万', 12_000, null]) {
      expect(approximateSubscribers(label)).toBeUndefined();
    }
  });

  it('spans every exact count a three-figure label may stand for (rounded or cut)', () => {
    expect(approximateRange(18_800)).toEqual({ low: 18_750, highExclusive: 18_900 });
    expect(approximateRange(200_000)).toEqual({ low: 199_500, highExclusive: 201_000 });
    expect(approximateRange(523)).toEqual({ low: 523, highExclusive: 524 });
  });
});

describe('YouTube benchmark routes on real response shapes', () => {
  it('finds channel ids in keyword search results to look up as authors', async () => {
    const result = await callTikhub({ platform: 'youtube', kind: 'keyword_posts', keyword: 'hardanger embroidery' },
      { ...deps, fetchImpl: jsonFetch(200, samples.keywordSearch) });
    expect(result.outcome).toBe('ok');
    expect(result.items.map(item => item.fields.authorId)).toEqual(['UC' + 'c'.repeat(22), 'UC' + 'b'.repeat(22), 'UC' + 'c'.repeat(22)]);
    expect(result.items[0]!.fields.views).toBe(123_276);
    expect(result.items[0]!.missing).toContain('publishedAt');
  });

  it('reads the channel list newest first with relative times kept missing', async () => {
    const result = await callTikhub({ platform: 'youtube', kind: 'account_posts', account: CHANNEL },
      { ...deps, fetchImpl: jsonFetch(200, samples.channelVideos) });
    expect(result.items.map(item => item.fields.id)).toEqual(['vid00000000', 'vid00000001', 'vid00000002']);
    for (const item of result.items) expect(item.missing).toContain('publishedAt');
    // "1.4K views" is rounded and stays missing; "711 views" is an exact count.
    expect(result.items.map(item => item.fields.views)).toEqual([undefined, undefined, 711]);
  });

  it('takes the absolute date and the rounded subscriber label from the video detail', async () => {
    const result = await callTikhub({ platform: 'youtube', kind: 'post_detail', postId: 'vid00000000' },
      { ...deps, fetchImpl: jsonFetch(200, samples.videoInfo) });
    expect(result.outcome).toBe('ok');
    expect(result.items[0]!.fields).toMatchObject({ id: 'vid00000000', authorId: CHANNEL, followers: 18_800, followersApprox: true,
      publishedAt: '2026-09-04T09:00:02.000Z' });
  });
});

describe('approximate followers in benchmark classification', () => {
  const now = new Date('2026-09-20T00:00:00.000Z');
  const item = (ref: string, fields: EvidenceItem['fields']): EvidenceItem => ({ ref, fields, missing: [] });
  const posts = Array.from({ length: 20 }, (_, i) => item(`p#${i + 1}`, { id: `v${i}`, title: 'video' }));
  const classify = (followers: number, approximate: boolean) => {
    const detail = item('d#1', { id: 'v0', publishedAt: '2026-09-04T09:00:02.000Z', followers,
      ...(approximate ? { followersApprox: true } : {}) });
    const metrics = accountMetrics({ profile: detail, followersItem: detail, posts }, now);
    return { metrics, classification: classifyAccount(metrics, growth, now) };
  };

  it('marks the followers metric approximate and qualifies a label well inside the range', () => {
    const { metrics, classification } = classify(18_800, true);
    expect(metrics.followers).toEqual({ value: 18_800, refs: ['d#1'], approximate: true });
    expect(metrics.lastPublishedAt.value).toBe('2026-09-04T09:00:02.000Z');
    expect(classification).toMatchObject({ qualified: true, excluded: null });
  });

  it('never qualifies a label whose possible counts straddle a threshold', () => {
    expect(classify(200_000, true).classification).toEqual({ category: null, qualified: false, excluded: 'FOLLOWERS_MISSING' });
    expect(classify(10_000, true).classification).toEqual({ category: null, qualified: false, excluded: 'FOLLOWERS_MISSING' });
    expect(classify(199_000, true).classification.qualified).toBe(true);
    expect(classify(286_000, true).classification).toEqual({ category: 'head_reference', qualified: false, excluded: null });
    expect(classify(9_990, true).classification.excluded).toBe('FOLLOWERS_BELOW_MIN');
  });

  it('keeps exact counts on the exact thresholds', () => {
    expect(classify(200_000, false).classification.qualified).toBe(true);
    expect(classify(10_000, false).classification.qualified).toBe(true);
    expect(classify(200_001, false).classification.category).toBe('head_reference');
  });
});
