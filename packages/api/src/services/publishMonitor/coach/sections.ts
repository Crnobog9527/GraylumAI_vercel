/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** REVIEW-COACH RC-2: the review pack's data sections, all computed by code from the pack rows. */
import type { Fact, PackRows } from './rows';
import { platformShift } from './scoreboard';
import { DAY_MS, SCORE_WEEKS, day7Metric, isoDay, median, round, utcDay } from './stats';

export type Period = { start: number; end: number; prevStart: number; prevEnd: number };
const views = (facts: Fact[]) => facts.map(f => day7Metric(f, 'views')).filter((v): v is number => v !== null);
const between = (iso: string, from: number, to: number) => utcDay(iso) >= from && utcDay(iso) <= to;
const text = (value: string | null, max: number) => value === null ? null : Array.from(value).slice(0, max).join('');

/** The period is the last full `days` days before today (UTC); the previous period is the same length just before it. */
export function periodOf(now: number, days: number): Period {
  const end = Math.floor(now / DAY_MS) - 1;
  return { start: end - days + 1, end, prevStart: end - 2 * days + 1, prevEnd: end - days };
}

/**
 * Posts whose day 7 fell inside the period (they were published 7 days earlier), each compared with its own pillar's
 * and platform's 8-week median before it. Posts published inside the period are too new to judge and only counted.
 */
export function thisPeriod(rows: PackRows, period: Period) {
  const facts = rows.facts;
  const settled = facts.filter(f => f.day7 && between(f.postedAt, period.start - 7, period.end - 7));
  const prior = (f: Fact, pillarOnly: boolean) => views(facts.filter(x => x.platform === f.platform && x.postId !== f.postId
    && (!pillarOnly || x.pillarKey === f.pillarKey) && utcDay(x.postedAt) < utcDay(f.postedAt)
    && utcDay(x.postedAt) >= utcDay(f.postedAt) - SCORE_WEEKS * 7));
  const posts = settled.map(f => {
    const v = day7Metric(f, 'views'), pillar = median(prior(f, true)), platform = median(prior(f, false));
    const er = day7Metric(f, 'engagement_rate');
    return { post_id: f.postId, platform: f.platform, posted_at: f.postedAt.slice(0, 10), title: text(f.title, 80),
      pillar: f.pillarKey, pillar_source: f.pillarSource, format_tags: f.formatTags,
      day7: { status: 'available', views: v, er: er === null ? null : round(er, 4), on: f.day7On,
        vs_pillar_median: v !== null && pillar ? round(v / pillar, 2) : null,
        vs_platform_median: v !== null && platform ? round(v / platform, 2) : null } };
  }).sort((a, b) => b.posted_at.localeCompare(a.posted_at));
  const ranked = posts.filter(p => p.day7.vs_platform_median !== null)
    .toSorted((a, b) => b.day7.vs_platform_median! - a.day7.vs_platform_median! || a.post_id.localeCompare(b.post_id));
  const recent = rows.recent.filter(p => between(p.postedAt, period.start, period.end));
  const prevSettled = facts.filter(f => f.day7 && between(f.postedAt, period.prevStart - 7, period.prevEnd - 7));
  const vsPrev: Record<string, { current: number | null; previous: number | null; samples: [number, number] }> = {};
  for (const platform of new Set([...settled, ...prevSettled].map(f => f.platform))) {
    const now = views(settled.filter(f => f.platform === platform)), before = views(prevSettled.filter(f => f.platform === platform));
    vsPrev[platform] = { current: median(now), previous: median(before), samples: [now.length, before.length] };
  }
  const byPillar: Record<string, number> = {};
  for (const p of recent) byPillar[p.pillarKey ?? 'untagged'] = (byPillar[p.pillarKey ?? 'untagged'] ?? 0) + 1;
  return {
    published: recent.length,
    published_previous: rows.recent.filter(p => between(p.postedAt, period.prevStart, period.prevEnd)).length
      + facts.filter(f => between(f.postedAt, period.prevStart, period.prevEnd)).length,
    too_new: recent.map(p => ({ post_id: p.postId, platform: p.platform, posted_at: p.postedAt.slice(0, 10),
      title: text(p.title, 80), note: '太新，下周再看' })),
    by_pillar: byPillar, settled_posts: posts,
    best: ranked.slice(0, 2).map(p => p.post_id),
    worst: ranked.length > 2 ? ranked.slice(-2).reverse().map(p => p.post_id) : [],
    day7_views_median_vs_prev: vsPrev,
    platform_shift: [...new Set(facts.map(f => f.platform))].map(p => platformShift(facts, p, period.start - 7, period.end - 7))
      .filter(s => s.detected),
  };
}

/** Follower points (TikHub profiles only) sampled now, 4 and 8 weeks ago; Post for Me platforms say "not provided". */
export function stageSection(rows: PackRows, now: number) {
  const today = Math.floor(now / DAY_MS);
  const at = (points: Array<{ date: string; value: number }>, daysAgo: number) =>
    points.filter(p => utcDay(p.date) <= today - daysAgo).at(-1) ?? null;
  const last8 = rows.facts.filter(f => utcDay(f.postedAt) >= today - 56);
  const recentV = views(rows.facts.filter(f => utcDay(f.postedAt) >= today - 35)), olderV = views(rows.facts
    .filter(f => utcDay(f.postedAt) >= today - 63 && utcDay(f.postedAt) < today - 35));
  const a = median(recentV), b = median(olderV);
  return {
    accounts: rows.accounts.map(x => ({ platform: x.platform, stage: x.stage })),
    followers: rows.followers.map(f => ({ platform: f.platform, now: at(f.points, 0), weeks4_ago: at(f.points, 28),
      weeks8_ago: at(f.points, 56) })),
    posts_8w: last8.length + rows.recent.filter(p => utcDay(p.postedAt) >= today - 56).length,
    day7_views_trend: a !== null && b ? { recent_4w_median: Math.round(a), previous_4w_median: Math.round(b),
      change: round(a / b - 1, 2), samples: [recentV.length, olderV.length] } : null,
  };
}

/** What the data cannot say. Every entry is something the review must name instead of guessing. */
export function gaps(rows: PackRows) {
  const out: Array<{ platform: string | null; missing: string[]; note: string }> = [];
  if (!rows.profile?.strategyVersionId || !rows.strategy) out.push({ platform: null, missing: ['strategy'], note: '还没有确认的定位报告' });
  if (!rows.profile?.pillars.length) out.push({ platform: null, missing: ['pillars'], note: '还没有内容支柱' });
  const withFollowers = new Set(rows.followers.filter(f => f.points.length).map(f => f.platform));
  for (const platform of new Set(rows.accounts.map(a => a.platform))) {
    const own = rows.facts.filter(f => f.platform === platform);
    const missing = own.length ? [...new Set(own.flatMap(f => f.missing))].filter(k => !['day7', 'day30'].includes(k)
      && own.filter(f => f.missing.includes(k)).length * 2 >= own.length).sort() : [];
    if (!withFollowers.has(platform)) missing.unshift('followers');
    if (!own.length) missing.push('posts');
    if (missing.length) out.push({ platform, missing, note: !own.length ? '数据积累中' : '平台不提供' });
  }
  return out;
}

export function mixActual(rows: PackRows, now: number, days: number) {
  const since = Math.floor(now / DAY_MS) - days;
  const keys = [...rows.facts.filter(f => utcDay(f.postedAt) >= since).map(f => f.pillarKey),
    ...rows.recent.filter(p => utcDay(p.postedAt) >= since).map(p => p.pillarKey)].map(k => k ?? 'untagged');
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).map(([k, n]) => [k, round(n / keys.length, 2)]));
}

export const dayLabel = isoDay;
