/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatMetric, platformName } from './labels';

/**
 * The rest of the brand review's numbers, so every number the written part quotes can be found on the page (Codex check of #1697,
 * item 4): the period line, the best and worst posts, single-post diagnoses and the experiment ledger. Read from the stored pack only
 * (`review_pack` version 2); codes are never shown, and a missing number is "—", never 0.
 */
export type CoachSummary = { start: string; end: string; published: number | null; publishedPrevious: number | null; settled: number;
  tooNew: number;
  /** The pack was cut to fit: the listed post counts are what the review saw, not every post. */
  trimmed: boolean };
export type CoachPick = { postId: string; title: string; platform: string; views: number | null; relative: number | null; er: number | null };
export type CoachDiagnosis = { postId: string; title: string; platform: string; capturedOn: string | null; avgWatchSeconds: number | null;
  videoSeconds: number | null; avgWatchPct: number | null; completeRate: number | null; dropSecond: number | null; stuck: string | null;
  /** Every other rate or count of the capture, in words, with the stuck layer's reference line and the own-median ratio when known. */
  metrics: string[] };
export type CoachReviewed = { id: string; hypothesis: string; verdict: string; reason: string | null; samples: number | null;
  vsBaseline: number | null; next: string | null };
export type CoachRunning = { id: string; hypothesis: string; start: string | null; end: string | null; settling: boolean };
export type CoachConcluded = { id: string; hypothesis: string; verdict: string | null; on: string | null };
export type CoachExtrasData = { summary: CoachSummary | null; best: CoachPick[]; worst: CoachPick[]; diagnoses: CoachDiagnosis[];
  /** Where the diagnosis lines come from (handbook source), said as is: the written part quotes it. */
  sources: string[];
  reviewed: CoachReviewed[]; running: CoachRunning[]; concluded: CoachConcluded[] };

export const EMPTY_EXTRAS: CoachExtrasData = { summary: null, best: [], worst: [], diagnoses: [], sources: [], reviewed: [], running: [], concluded: [] };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

export const VERDICT_TEXT: Record<string, string> = { worked: '有效', failed: '没有效果', inconclusive: '还看不出', not_run: '没有执行' };
export const REASON_TEXT: Record<string, string> = {
  platform_shift: '这段时间平台整体流量变了，不能算成实验的效果',
  samples_lt_3: '符合条件的作品不到 3 条',
  low_volume: '这段时间发得太少',
  within_noise: '差别在正常波动之内',
  mixed_platforms: '混了几个平台的作品，不能一起比',
};
const NEXT_TEXT: Record<string, string> = { extended: '再观察一期', concluded: '结束' };
/** The diagnosis keys (funnel.ts RATE_KEYS and COUNT_KEYS) in words; a key not listed here is not shown rather than shown as a code. */
const METRIC_TEXT: Record<string, string> = { impressions_ctr: '曝光点击率', bounce_2s: '2 秒跳出率', retain_3s: '3 秒留存', retain_5s: '5 秒留存',
  retain_30s: '30 秒留存', like_rate: '点赞率', comment_rate: '评论率', save_rate: '收藏率', share_rate: '分享率', follow_rate: '关注率',
  profile_visit_rate: '主页访问率', engage_rate: '互动率', views: '播放', likes: '点赞', comments: '评论', saves: '收藏', shares: '分享',
  followers_gained: '涨粉', profile_visits: '主页访问' };
const COUNTS = new Set(['views', 'likes', 'comments', 'saves', 'shares', 'followers_gained', 'profile_visits']);
/** Shown in their own columns. */
const OWN_COLUMNS = new Set(['avg_watch_seconds', 'avg_watch_pct', 'complete_rate']);
const asPct = (n: number) => `${Number((n * 100).toFixed(1))}%`;

function metricsOf(d: Record<string, unknown>, stuck: Record<string, unknown> | undefined): string[] {
  const rates = rec(d.rates), lines = rec(stuck?.line), own = rec(d.vs_own_median);
  return Object.entries(rates).flatMap(([key, value]) => {
    const label = METRIC_TEXT[key];
    if (OWN_COLUMNS.has(key) || !label || typeof value !== 'number' || !Number.isFinite(value)) return [];
    const show = (n: number) => (COUNTS.has(key) ? String(n) : asPct(n));
    const line = rec(lines[key]), min = num(line.min), max = num(line.max);
    const ref = [max !== null ? `≤${show(max)}` : null, min !== null ? `≥${show(min)}` : null].filter(Boolean).join('、');
    const ratio = num(own[key]);
    const notes = [ref ? `参考线 ${ref}` : null, ratio !== null ? `自己中位数的 ${ratio.toFixed(2)} 倍` : null].filter(Boolean);
    return [`${label} ${show(value)}${notes.length ? `（${notes.join('，')}）` : ''}`];
  });
}

/** Reads the extras from a version-2 pack; best / worst are ids into `this_period.settled_posts`, so a trimmed post drops out. */
export function coachExtras(pack: Record<string, unknown>): CoachExtrasData {
  const period = rec(pack.period), tp = rec(pack.this_period);
  const settled = list(tp.settled_posts);
  const titles = new Map<string, string>();
  for (const p of [...settled, ...list(tp.too_new), ...list(pack.untagged_posts)]) {
    if (typeof p.post_id === 'string' && typeof p.title === 'string' && p.title) titles.set(p.post_id, p.title);
  }
  const start = str(period.start), end = str(period.end);
  // A basics-only pack has a period but no this_period: no counts at all then, rather than counts of 0.
  const hasPeriod = !!pack.this_period && typeof pack.this_period === 'object';
  const summary = start && end && hasPeriod ? { start, end, published: num(tp.published), publishedPrevious: num(tp.published_previous),
    settled: settled.length, tooNew: list(tp.too_new).length, trimmed: (num(pack.trimmed_rows) ?? 0) > 0 } : null;
  const byId = new Map(settled.flatMap(p => (typeof p.post_id === 'string' ? [[p.post_id, p] as const] : [])));
  const pick = (ids: unknown): CoachPick[] => (Array.isArray(ids) ? ids : []).flatMap(id => {
    const p = typeof id === 'string' ? byId.get(id) : undefined;
    if (!p || typeof p.platform !== 'string') return [];
    const day7 = rec(p.day7);
    return [{ postId: id as string, title: titles.get(id as string) ?? '', platform: p.platform, views: num(day7.views),
      relative: num(day7.vs_platform_median), er: num(day7.er) }];
  });
  const diagnoses = list(rec(pack.diagnostics).posts).flatMap(d => {
    if (typeof d.post_id !== 'string' || typeof d.platform !== 'string') return [];
    const rates = rec(d.rates);
    const stuck = list(d.layer_results).find(l => l.layer === d.stuck_layer);
    return [{ postId: d.post_id, title: titles.get(d.post_id) ?? '', platform: d.platform, capturedOn: str(d.captured_on),
      avgWatchSeconds: num(rates.avg_watch_seconds), videoSeconds: num(d.video_seconds), avgWatchPct: num(rates.avg_watch_pct),
      completeRate: num(rates.complete_rate), dropSecond: num(d.drop_second), stuck: stuck ? str(stuck.name) : null,
      metrics: metricsOf(d, stuck) }];
  });
  const sources = [...new Set(list(rec(pack.diagnostics).handbook).flatMap(h => (typeof h.source === 'string' && h.source ? [h.source] : [])))];
  const ledger = rec(pack.ledger);
  const reviewed = list(ledger.to_review).flatMap(e => {
    const r = rec(e.result);
    return typeof e.id === 'string' && typeof r.verdict === 'string' ? [{ id: e.id, hypothesis: str(e.hypothesis) ?? '', verdict: r.verdict,
      reason: str(r.reason), samples: num(r.samples), vsBaseline: num(r.vs_baseline), next: str(r.next_status) }] : [];
  });
  const running = list(ledger.running).flatMap(e => (typeof e.id === 'string' ? [{ id: e.id, hypothesis: str(e.hypothesis) ?? '',
    start: str(rec(e.period).start), end: str(rec(e.period).end), settling: e.settling === true }] : []));
  const concluded = list(ledger.recent_concluded).flatMap(e => (typeof e.id === 'string' ? [{ id: e.id,
    hypothesis: str(e.hypothesis) ?? '', verdict: str(e.verdict), on: str(e.concluded_on) }] : []));
  // With exactly three ranked posts the middle one is in both lists; it is shown once, among the best.
  const best = pick(tp.best), shownBest = new Set(best.map(p => p.postId));
  return { summary, best, worst: pick(tp.worst).filter(p => !shownBest.has(p.postId)), diagnoses, sources, reviewed, running, concluded };
}

/** "10/27" for 2026-10-27; anything else is shown as it is. */
export const shortDay = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : iso ?? '—');
const dash = (v: number | null, f: (n: number) => string) => (v === null ? '—' : f(v));
/** Engagement rate as the written part quotes it: two decimals (5.29%). */
export const erText = (v: number | null) => dash(v, n => `${(n * 100).toFixed(2)}%`);
const pct = (v: number | null) => dash(v, asPct);
const seconds = (v: number | null) => dash(v, n => `${Number(n.toFixed(1))} 秒`);
const times = (v: number | null) => dash(v, n => `${n.toFixed(2)} 倍`);
const th = 'pr-3 font-medium';
const cell = 'py-1 pr-3';
const row = { borderColor: 'var(--border-primary)' };
const muted = { color: 'var(--text-secondary)' };

export function CoachSummaryLine({ summary }: { summary: CoachSummary }) {
  const n = (v: number | null) => (v === null ? '—' : String(v));
  return (
    <p className="text-xs" style={muted} aria-label="本期小结">
      本期 {shortDay(summary.start)}–{shortDay(summary.end)} · 本期发布 {n(summary.published)} 条 · 上期发布 {n(summary.publishedPrevious)} 条
      {' '}· 满 7 天 {summary.settled} 条 · 太新暂不评判 {summary.tooNew} 条{summary.trimmed ? '（作品较多，下面只列出复盘时看到的部分）' : ''}
    </p>
  );
}

function PickTable({ label, picks }: { label: string; picks: CoachPick[] }) {
  return (
    <table className="w-full min-w-[520px] text-left text-xs" aria-label={label}>
      <caption className="pb-1 text-left font-medium">{label}</caption>
      <thead><tr><th className={th}>作品</th><th className={th}>平台</th><th className={th}>第 7 天浏览</th><th className={th}>相对该平台中位数</th>
        <th className={th}>互动率</th></tr></thead>
      <tbody>{picks.map(p => (
        <tr key={p.postId} className="border-t align-top" style={row}>
          <td className={`max-w-[200px] ${cell}`}>{p.title || '（没有标题）'}</td><td className={cell}>{platformName(p.platform)}</td>
          <td className={cell}>{dash(p.views, v => formatMetric('views', v))}</td><td className={cell}>{times(p.relative)}</td>
          <td className={cell}>{erText(p.er)}</td></tr>))}</tbody>
    </table>
  );
}

export function CoachExtras({ extras }: { extras: CoachExtrasData }) {
  const { best, worst, diagnoses, sources, reviewed, running, concluded } = extras;
  const experiments = reviewed.length + running.length + concluded.length > 0;
  return (
    <>
      {best.length > 0 && <PickTable label="本周最好的作品" picks={best} />}
      {worst.length > 0 && <PickTable label="本周最差的作品" picks={worst} />}
      {diagnoses.length > 0 && (
        <table className="w-full min-w-[880px] text-left text-xs" aria-label="单条诊断">
          <caption className="pb-1 text-left font-medium">单条诊断</caption>
          <thead><tr><th className={th}>作品</th><th className={th}>平台</th><th className={th}>平均观看</th><th className={th}>视频时长</th>
            <th className={th}>平均观看比例</th><th className={th}>完播率</th><th className={th}>流失</th><th className={th}>卡在</th>
            <th className={th}>其他指标</th></tr></thead>
          <tbody>{diagnoses.map(d => (
            <tr key={d.postId} className="border-t align-top" style={row}>
              <td className={`max-w-[200px] ${cell}`}>{d.title || '—'}</td><td className={cell}>{platformName(d.platform)}</td>
              <td className={cell}>{seconds(d.avgWatchSeconds)}</td><td className={cell}>{seconds(d.videoSeconds)}</td>
              <td className={cell}>{pct(d.avgWatchPct)}</td><td className={cell}>{pct(d.completeRate)}</td>
              <td className={cell}>{dash(d.dropSecond, v => `第 ${v} 秒`)}</td><td className={cell}>{d.stuck ?? '—'}</td>
              <td className={`max-w-[280px] ${cell}`}>{d.metrics.length ? d.metrics.join('；') : '—'}</td></tr>))}</tbody>
        </table>
      )}
      {diagnoses.length > 0 && sources.length > 0 && <p className="text-xs" style={muted}>诊断参考线来源：{sources.join('；')}</p>}
      {experiments && (
        <section className="space-y-2 text-xs" aria-label="上周实验完成情况">
          <h4 className="font-medium">上周实验完成情况</h4>
          {reviewed.length > 0 && (
            <table className="w-full min-w-[600px] text-left" aria-label="这次复盘的实验">
              <thead><tr><th className={th}>实验</th><th className={th}>结果</th><th className={th}>原因</th><th className={th}>样本</th>
                <th className={th}>相对基线</th><th className={th}>下一步</th></tr></thead>
              <tbody>{reviewed.map(e => (
                <tr key={e.id} className="border-t align-top" style={row}>
                  <td className={`max-w-[220px] ${cell}`}>{e.hypothesis || '—'}</td><td className={cell}>{VERDICT_TEXT[e.verdict] ?? '—'}</td>
                  <td className={cell}>{e.reason ? REASON_TEXT[e.reason] ?? '—' : '—'}</td>
                  <td className={cell}>{dash(e.samples, v => `${v} 条`)}</td><td className={cell}>{times(e.vsBaseline)}</td>
                  <td className={cell}>{e.next ? NEXT_TEXT[e.next] ?? '—' : '—'}</td></tr>))}</tbody>
            </table>
          )}
          {running.length > 0 && (
            <ul className="space-y-0.5" aria-label="还在进行的实验">
              {running.map(e => (
                <li key={e.id}>进行中：{e.hypothesis || '—'}（{shortDay(e.start)}–{shortDay(e.end)}
                  {e.settling ? '，等最后几条作品满 7 天' : ''}）</li>))}
            </ul>
          )}
          {concluded.length > 0 && (
            <ul className="space-y-0.5" style={muted} aria-label="最近的实验结论">
              {concluded.map(e => (
                <li key={e.id}>{shortDay(e.on)} 结论：{e.hypothesis || '—'} · {e.verdict ? VERDICT_TEXT[e.verdict] ?? '—' : '—'}</li>))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
