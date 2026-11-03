/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatMetric, platformName } from './labels';

/**
 * The brand review's numbers, read from the stored pack only (`review_pack` version 2): the posts whose day 7 fell in the period, the
 * pillar scoreboard, and the per-platform trend (this period against the last, the last four weeks against the four before, followers).
 * The written part never carries a table of its own, and every number it quotes is one of these (the coach's instructions say so).
 */
export type CoachPost = { postId: string; title: string; platform: string; views: number | null; relative: number | null };
export type CoachScore = { pillar: string; platform: string; samples: number; views: number | null; relative: number | null };
export type CoachTrend = { platform: string; current: number | null; previous: number | null; recent4w: number | null; previous4w: number | null;
  change: number | null; followersNow: number | null; followers4w: number | null; followers8w: number | null };
export type CoachTable = { posts: CoachPost[]; scores: CoachScore[]; trends: CoachTrend[] };

export const EMPTY_COACH: CoachTable = { posts: [], scores: [], trends: [] };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A follower snapshot is `{ date, value }` (or null: the platform does not provide it); only the value is shown. */
const snapshot = (v: unknown) => num(rec(v).value);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

/** Internal codes are never shown: a pillar is its name from the brand's pillars, and anything without one is "未分类". */
export function pillarLabel(key: string, names: ReadonlyMap<string, string>): string {
  return names.get(key) ?? '未分类';
}

export function coachTable(tables: unknown): CoachTable {
  const t = rec(tables);
  if (t.kind !== 'review_pack' || t.version !== 2) return EMPTY_COACH;
  const names = new Map(list(rec(t.strategy).pillars).flatMap(p =>
    (typeof p.key === 'string' && typeof p.name === 'string' ? [[p.key, p.name] as const] : [])));
  const posts = list(rec(t.this_period).settled_posts).flatMap(p => {
    const day7 = rec(p.day7);
    return typeof p.post_id === 'string' && typeof p.platform === 'string'
      ? [{ postId: p.post_id, title: typeof p.title === 'string' ? p.title : '', platform: p.platform, views: num(day7.views),
        relative: num(day7.vs_platform_median) }] : [];
  });
  const scores = list(t.scoreboard).flatMap(r => typeof r.pillar === 'string' && typeof r.platform === 'string' && typeof r.samples === 'number'
    ? [{ pillar: pillarLabel(r.pillar, names), platform: r.platform, samples: r.samples, views: num(r.views_median),
      relative: num(r.vs_platform_median) }] : []);
  const vsPrev = rec(rec(t.this_period).day7_views_median_vs_prev), trend = rec(rec(t.stage).day7_views_trend);
  const followers = new Map(list(rec(t.stage).followers).flatMap(f => (typeof f.platform === 'string' ? [[f.platform, f] as const] : [])));
  const platforms = [...new Set([...Object.keys(vsPrev), ...Object.keys(trend), ...followers.keys()])].sort();
  const trends = platforms.map(platform => {
    const [a, b, f] = [rec(vsPrev[platform]), rec(trend[platform]), rec(followers.get(platform))];
    return { platform, current: num(a.current), previous: num(a.previous), recent4w: num(b.recent_4w_median), previous4w: num(b.previous_4w_median),
      change: num(b.change), followersNow: snapshot(f.now), followers4w: snapshot(f.weeks4_ago), followers8w: snapshot(f.weeks8_ago) };
  });
  return { posts, scores, trends };
}

const relative = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)} 倍`);
const views = (v: number | null) => (v === null ? '—' : formatMetric('views', v));
const count = (v: number | null) => (v === null ? '—' : String(v));
const percent = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
const th = 'pr-3 font-medium';
const row = { borderColor: 'var(--border-primary)' };

export function CoachTables({ coach }: { coach: CoachTable }) {
  return (
    <div className="space-y-3 overflow-x-auto">
      {coach.posts.length > 0 && (
        <table className="w-full min-w-[480px] text-left text-xs" aria-label="本期满 7 天的作品">
          <thead><tr><th className={th}>作品</th><th className={th}>平台</th><th className={th}>第 7 天浏览</th><th className={th}>相对该平台中位数</th></tr></thead>
          <tbody>{coach.posts.map(p => (
            <tr key={p.postId} className="border-t align-top" style={row}>
              <td className="max-w-[200px] py-1 pr-3">{p.title || '（没有标题）'}</td><td className="py-1 pr-3">{platformName(p.platform)}</td>
              <td className="py-1 pr-3">{views(p.views)}</td><td className="py-1 pr-3">{relative(p.relative)}</td></tr>))}</tbody>
        </table>
      )}
      {coach.scores.length > 0 && (
        <table className="w-full min-w-[480px] text-left text-xs" aria-label="内容方向成绩单">
          <thead><tr><th className={th}>内容方向</th><th className={th}>平台</th><th className={th}>作品数</th><th className={th}>浏览中位数</th>
            <th className={th}>相对该平台中位数</th></tr></thead>
          <tbody>{coach.scores.map(r => (
            <tr key={`${r.pillar}:${r.platform}`} className="border-t" style={row}>
              <td className="py-1 pr-3">{r.pillar}</td><td className="py-1 pr-3">{platformName(r.platform)}</td><td className="py-1 pr-3">{r.samples}</td>
              <td className="py-1 pr-3">{views(r.views)}</td><td className="py-1 pr-3">{relative(r.relative)}</td></tr>))}</tbody>
        </table>
      )}
      {coach.trends.length > 0 && (
        <table className="w-full min-w-[640px] text-left text-xs" aria-label="按平台的趋势">
          <thead><tr><th className={th}>平台</th><th className={th}>本期第 7 天浏览中位数</th><th className={th}>上期</th><th className={th}>近 4 周</th>
            <th className={th}>前 4 周</th><th className={th}>变化</th><th className={th}>粉丝（现在 / 4 周前 / 8 周前）</th></tr></thead>
          <tbody>{coach.trends.map(r => (
            <tr key={r.platform} className="border-t" style={row}>
              <td className="py-1 pr-3">{platformName(r.platform)}</td>
              <td className="py-1 pr-3">{views(r.current)}</td><td className="py-1 pr-3">{views(r.previous)}</td>
              <td className="py-1 pr-3">{views(r.recent4w)}</td><td className="py-1 pr-3">{views(r.previous4w)}</td>
              <td className="py-1 pr-3">{percent(r.change)}</td>
              <td className="py-1 pr-3">{count(r.followersNow)} / {count(r.followers4w)} / {count(r.followers8w)}</td></tr>))}</tbody>
        </table>
      )}
    </div>
  );
}
