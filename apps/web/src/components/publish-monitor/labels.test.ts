/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { brandsFromLibrary } from './brands';
import { connectRoute, dataErrorMessage, errorCode, formatDay, metricCell, metricColumns, platformName } from './labels';
import { reviewTable, reviewTitle } from './ReviewPanel';

describe('metric cells (plan §9 item 2: a missing field is never 0)', () => {
  const snapshot = { metrics: { likes: 0, views: 1200, completion_rate: 41.5 }, missingFields: ['views_unique', 'shares'] };
  it('shows real zeros, the platform gap and an unread value differently', () => {
    expect(metricCell('likes', snapshot)).toBe('0');
    expect(metricCell('shares', snapshot)).toBe('平台不提供');
    expect(metricCell('comments', snapshot)).toBe('未取到');
    expect(metricCell('views', null)).toBe('未取到');
    expect(metricCell('completion_rate', snapshot)).toBe('41.5%');
  });
  it('builds columns only from fields the snapshots name, known ones first', () => {
    expect(metricColumns([snapshot, null])).toEqual(['views', 'likes', 'shares', 'completion_rate', 'views_unique']);
    expect(metricColumns([null])).toEqual([]);
  });
});

describe('connect routes', () => {
  it('sends the nine overseas platforms to Post for Me, Xiaohongshu and Douyin to a profile link, the rest nowhere', () => {
    for (const p of ['x', 'youtube', 'tiktok', 'instagram', 'facebook', 'threads', 'linkedin', 'pinterest', 'bluesky']) {
      expect(connectRoute(p)).toBe('postforme');
    }
    expect(connectRoute('xiaohongshu')).toBe('profile_link');
    expect(connectRoute('douyin')).toBe('profile_link');
    expect(connectRoute('小红书')).toBe('unsupported');
    expect(platformName('douyin')).toBe('抖音');
  });
});

describe('errors', () => {
  it('maps server codes and rate limits to fixed text, never the raw message', () => {
    expect(errorCode({ message: '请求过于频繁，请在 3600 秒后重试', data: { code: 'TOO_MANY_REQUESTS' } })).toBe('rate_limited');
    expect(dataErrorMessage(errorCode({ message: 'PUBLISH_MONITOR_DISABLED' }))).toBe('作品数据和复盘还没有开放。');
    expect(dataErrorMessage('SOMETHING_INTERNAL')).toBe('暂时读不到，请稍后重试。');
  });
});

describe('library brands', () => {
  it('keeps only accounts with an id and platform, and never throws on odd data', () => {
    expect(brandsFromLibrary(null)).toEqual([]);
    const brands = brandsFromLibrary({ businesses: [{ businessId: 'b', name: '', accounts: [
      { projectId: 'p', platform: 'x', account: 'main', items: [{ workItemId: 'w', title: '' }] }, { projectId: '', platform: 'x' }] }] });
    expect(brands).toEqual([{ businessId: 'b', name: '未命名品牌', accounts: [{ projectId: 'p', platform: 'x', label: 'main',
      businessId: 'b', businessName: '未命名品牌', items: [{ workItemId: 'w', title: '未命名内容' }] }] }]);
  });
});

describe('review title', () => {
  it('names the brand and the rhythm of a coach review; a plain weekly review reads as before', () => {
    expect(reviewTitle({ periodStart: '2026-11-03' })).toBe('2026-11-03 这一周');
    expect(reviewTitle({ periodStart: '2026-11-03', cadence: 'weekly', businessName: null })).toBe('2026-11-03 这一周');
    expect(reviewTitle({ periodStart: '2026-11-03', cadence: 'monthly', businessName: '复盘测试品牌' })).toBe('复盘测试品牌 · 2026-11-03 月度复盘');
    expect(reviewTitle({ periodStart: '2026-11-03', cadence: 'quarterly', businessName: 'B' })).toBe('B · 2026-11-03 季度体检');
    expect(reviewTitle({ periodStart: '2026-11-03', cadence: 'something-new' })).toBe('2026-11-03 这一周');
  });
});

describe('stored review table', () => {
  it('reads rows and weeks it recognises and ignores anything else', () => {
    expect(reviewTable(null)).toEqual({ rows: [], weeks: [], coach: { posts: [], scores: [], trends: [] } });
    expect(reviewTable({ rows: [{ postId: 'a', ageDays: 1, status: 'too_new', comparisons: {} }, { nope: 1 }],
      weekly: [{ start: '2026-10-01', end: '2026-10-08', published: 2, matched_posts: 0, status: 'data_accumulating' }, 'x'] }))
      .toEqual({ rows: [{ postId: 'a', ageDays: 1, status: 'too_new', comparisons: {} }],
        weeks: [{ start: '2026-10-01', end: '2026-10-08', published: 2, matched_posts: 0, status: 'data_accumulating' }],
        coach: { posts: [], scores: [], trends: [] } });
  });
  it('reads the brand review pack\'s settled posts and scoreboard, and nothing from a pack of another shape', () => {
    const pack = { kind: 'review_pack', version: 2, scoreboard: [{ pillar: 'tips', platform: 'tiktok', samples: 4, views_median: 1200,
      er_median: 0.05, vs_platform_median: 1.5 }, { nope: 1 }], this_period: { settled_posts: [{ post_id: 'p1', platform: 'tiktok', title: 'T',
      day7: { status: 'available', views: 900, vs_platform_median: null } }, { post_id: 2 }] } };
    expect(reviewTable(pack).coach).toEqual({ posts: [{ postId: 'p1', title: 'T', platform: 'tiktok', views: 900, relative: null }],
      scores: [{ pillar: '未分类', platform: 'tiktok', samples: 4, views: 1200, relative: 1.5 }], trends: [] });
    expect(reviewTable({ ...pack, version: 1 }).coach).toEqual({ posts: [], scores: [], trends: [] });
  });
});

describe('calendar days', () => {
  it('shows a date-only value as it is in any time zone, and an unreadable one as 未提供', () => {
    const zone = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = tz;
        expect(formatDay('2026-10-18')).toBe('2026-10-18');
      }
    } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
    expect(formatDay(null)).toBe('未提供');
    expect(formatDay('not a date')).toBe('未提供');
  });
});
