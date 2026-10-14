/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { accountMetrics, type EvidenceItem } from '../metrics';
import { aggregateAuthors, classifyAccount, qualifiedCount, selectCandidates, type ScoredAccount } from '../classify';

const now = new Date('2026-10-14T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
const growth = { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' };
const item = (ref: string, fields: EvidenceItem['fields'], missing: string[] = []): EvidenceItem => ({ ref, fields, missing });
const profile = (followers?: number) => item('e1#1', followers === undefined ? {} : { followers }, followers === undefined ? ['followers'] : []);
const posts = (n: number, f: (i: number) => EvidenceItem['fields']) => Array.from({ length: n }, (_, i) => item(`e2#${i + 1}`, f(i)));

describe('benchmark metrics', () => {
  it('computes medians, engagement, frequency and recency from evidence with refs', () => {
    const m = accountMetrics({ profile: profile(50_000), posts: posts(30, i => ({
      publishedAt: daysAgo(i * 2), views: 1000 + i * 100, likes: 50, comments: 10, shares: 0 })) }, now);
    expect(m.followers).toEqual({ value: 50_000, refs: ['e1#1'] });
    expect(m.postsAnalyzed).toBe(30);
    expect(m.medianViews.value).toBe(2450);
    // Median of each post's own rate (60 / views), not total interactions over median views.
    expect(m.engagementRate.value).toBeCloseTo((60 / 2400 + 60 / 2500) / 2, 9);
    expect(m.postsPerWeek.value).toBeCloseTo((16 * 7) / 30, 6);
    expect(m.postsPerWeek.refs).toHaveLength(30);
    expect(m.lastPublishedAt.value).toBe(daysAgo(0));
    expect(m.wholeHistory).toBe(false);
    expect(m.missing).toEqual([]);
  });

  it('keeps missing data missing instead of zero (e.g. Xiaohongshu has no views)', () => {
    const m = accountMetrics({ profile: profile(undefined), posts: posts(5, i => ({ publishedAt: daysAgo(i), likes: 3 })) }, now);
    expect(m.followers.value).toBeNull();
    expect(m.medianViews).toEqual({ value: null, refs: [] });
    expect(m.engagementRate.value).toBeNull();
    expect(m.missing).toEqual(['followers', 'medianViews', 'engagementRate', 'postsPerWeek']);
    expect(m.wholeHistory).toBe(false);
  });

  it('leaves engagement unknown when a counter is missing (e.g. Bilibili has no likes or shares)', () => {
    const m = accountMetrics({ profile: profile(20_000), posts: posts(5, i => ({ publishedAt: daysAgo(i), views: 100, comments: 3 })) }, now);
    expect(m.engagementRate).toEqual({ value: null, refs: [] });
    expect(accountMetrics({ profile: profile(20_000), posts: [], complete: true }, now).wholeHistory).toBe(true);
  });

  it('uses only the newest 30 posts and ignores future-dated or undated posts for recency', () => {
    const m = accountMetrics({ profile: profile(20_000), posts: [
      ...posts(35, i => ({ publishedAt: daysAgo(40 + i), views: 10 })),
      item('bad#1', { publishedAt: '2099-01-01T00:00:00Z', views: 10 }),
      item('nodate#1', { views: 10 }),
    ] }, now);
    expect(m.postsAnalyzed).toBe(30);
    expect(m.lastPublishedAt.value).toBe(daysAgo(40));
    expect(m.postsPerWeek).toMatchObject({ value: 0 });
    expect(m.postsPerWeek.refs).toHaveLength(30);
  });

  it('keeps the frequency unknown when a short page may continue, unless the list is complete', () => {
    const short = posts(20, i => ({ publishedAt: daysAgo(i), views: 5 }));
    expect(accountMetrics({ profile: profile(20_000), posts: short }, now).postsPerWeek.value).toBeNull();
    expect(accountMetrics({ profile: profile(20_000), posts: short, complete: true }, now).postsPerWeek.value).toBeCloseTo((20 * 7) / 30, 6);
  });

  it('keeps the frequency unknown when a full page is entirely inside the window', () => {
    const m = accountMetrics({ profile: profile(20_000), posts: posts(30, i => ({ publishedAt: daysAgo(i * 0.5), views: 5 })) }, now);
    expect(m.postsPerWeek).toEqual({ value: null, refs: [] });
  });

  it('reports no frequency when some analyzed posts are undated (never counts them as zero)', () => {
    const m = accountMetrics({ profile: profile(20_000), posts: [item('p#1', { publishedAt: daysAgo(1), views: 5 }),
      ...posts(10, () => ({ views: 5 }))] }, now);
    expect(m.postsPerWeek).toEqual({ value: null, refs: [] });
    expect(m.missing).toContain('postsPerWeek');
    expect(m.lastPublishedAt.value).toBe(daysAgo(1));
  });

  it('uses the YouTube post detail time for recency when the list has only relative times', () => {
    const m = accountMetrics({ profile: profile(undefined), followersItem: item('d#1', { followers: 30_000, publishedAt: daysAgo(3) }),
      posts: posts(30, () => ({ views: 900 })) }, now);
    expect(m.lastPublishedAt).toEqual({ value: daysAgo(3), refs: ['d#1'] });
    expect(classifyAccount(m, growth, now)).toEqual({ category: 'imitable', qualified: true, excluded: null });
  });

  it('takes followers from a separate item when the platform needs one (Bilibili relation, YouTube detail)', () => {
    const m = accountMetrics({ profile: profile(undefined), followersItem: item('e3#1', { followers: 12_345 }), posts: [] }, now);
    expect(m.followers).toEqual({ value: 12_345, refs: ['e3#1'] });
  });
});

describe('benchmark classification', () => {
  const metrics = (followers: number | undefined, lastDays: number | null, extra: Partial<{ views: number; count: number }> = {}) =>
    accountMetrics({ profile: profile(followers), posts: lastDays === null ? posts(extra.count ?? 25, () => ({ views: 1 }))
      // 30 posts = a full page, so the fetched posts are not the whole history unless a test says so.
      : posts(extra.count ?? 30, i => ({ publishedAt: daysAgo(lastDays + i), views: extra.views ?? 100 })) }, now);

  it('applies the fixed product thresholds', () => {
    expect(classifyAccount(metrics(undefined, 1), growth, now)).toMatchObject({ qualified: false, excluded: 'FOLLOWERS_MISSING' });
    expect(classifyAccount(metrics(9_999, 1), growth, now)).toMatchObject({ qualified: false, excluded: 'FOLLOWERS_BELOW_MIN' });
    expect(classifyAccount(metrics(200_001, 1), growth, now)).toEqual({ category: 'head_reference', qualified: false, excluded: null });
    expect(classifyAccount(metrics(10_000, 31), growth, now)).toMatchObject({ qualified: false, excluded: 'INACTIVE_30_DAYS' });
    expect(classifyAccount(metrics(10_000, null), growth, now)).toMatchObject({ qualified: false, excluded: 'NO_PUBLISH_TIME' });
    expect(classifyAccount(metrics(200_000, 30), { ...growth, maxFirstPostAgeDays: 1 }, now))
      .toEqual({ category: 'imitable', qualified: true, excluded: null });
  });

  it('marks fast rising by the earliest obtainable post within N days or views ≥ followers × K', () => {
    const shortN = { ...growth, maxFirstPostAgeDays: 20 };
    expect(classifyAccount(metrics(20_000, 1, { count: 10 }), shortN, now).category).toBe('fast_rising');
    expect(classifyAccount(metrics(20_000, 1), { ...growth, maxFirstPostAgeDays: 30 }, now).category).toBe('fast_rising');
    expect(classifyAccount(metrics(20_000, 1), { ...growth, maxFirstPostAgeDays: 29 }, now).category).toBe('imitable');
    expect(classifyAccount(metrics(20_000, 1, { views: 20_000 }), shortN, now).category).toBe('fast_rising');
    const old = { ...growth, maxFirstPostAgeDays: 1 };
    expect(classifyAccount(metrics(20_000, 1, { views: 19_999 }), old, now).category).toBe('imitable');
    expect(classifyAccount(metrics(20_000, 1, { views: 20_000 }), { ...old, minViewsToFollowers: 'x' }, now).category).toBe('imitable');
  });

  it('selects 8–12 qualified candidates, never head references', () => {
    const scored = (n: number, followers: number): ScoredAccount[] => Array.from({ length: n }, (_, i) => {
      const m = metrics(followers, 1, { views: 100 + i });
      return { key: `tiktok:a${followers}-${i}`, metrics: m, classification: classifyAccount(m, growth, now) };
    });
    const few = selectCandidates([...scored(7, 50_000), ...scored(3, 500_000)]);
    expect(few).toMatchObject({ enough: false });
    expect(few.headReferences).toHaveLength(3);
    const many = selectCandidates(scored(15, 50_000));
    expect(many.enough).toBe(true);
    expect(many.selectable).toHaveLength(12);
    expect(many.selectable[0]!.metrics.medianViews.value).toBe(114);
    expect(qualifiedCount([...scored(2, 50_000), ...scored(2, 50_000)])).toBe(2);
    // The same 4 accounts found twice are still 4 candidates: not enough for a card.
    const twice = selectCandidates([...scored(4, 50_000), ...scored(4, 50_000)]);
    expect(twice).toMatchObject({ enough: false });
    expect(twice.selectable).toHaveLength(4);
  });
});

describe('author aggregation', () => {
  it('groups keyword posts by author and ranks by appearances then interactions', () => {
    const list = aggregateAuthors([
      item('k#1', { authorId: 'a', author: 'A', likes: 5 }), item('k#2', { authorId: 'b', likes: 100 }),
      item('k#3', { authorId: 'a', likes: 1, comments: 1 }), item('k#4', { likes: 999 }),
    ], 10);
    expect(list).toEqual([
      { authorId: 'a', author: 'A', appearances: 2, interactions: 7, refs: ['k#1', 'k#3'] },
      { authorId: 'b', author: null, appearances: 1, interactions: 100, refs: ['k#2'] },
    ]);
    expect(aggregateAuthors([item('k#1', { authorId: 'a' })], 0)).toEqual([]);
  });
});
