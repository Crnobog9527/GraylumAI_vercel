/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { coachTable, CoachTables, EMPTY_COACH, pillarLabel } from './CoachTables';

const pack = {
  kind: 'review_pack', version: 2,
  period: { start: '2026-10-27', end: '2026-11-02', prev_start: '2026-10-20', prev_end: '2026-10-26' },
  strategy: { pillars: [{ key: 'p1', name: '读书笔记', definition: '读书笔记' }, { key: 'p3', name: '城市探店', definition: '城市探店' }] },
  scoreboard: [
    { pillar: 'p1', platform: 'tiktok', weeks: 8, samples: 4, views_median: 1200, er_median: 0.0563, vs_platform_median: 1.1 },
    { pillar: 'untagged', platform: 'tiktok', weeks: 8, samples: 21, views_median: 1222, vs_platform_median: 1 },
    { pillar: 'p9', platform: 'x', weeks: 8, samples: 2, views_median: null, vs_platform_median: null },
  ],
  this_period: { published: 10, published_previous: 8,
    settled_posts: [{ post_id: 'a', platform: 'xiaohongshu', title: '【城市探店】 x', day7: { views: 900, er: 0.0825, vs_platform_median: 0.58 } },
      { post_id: 'b', platform: 'x', title: null, day7: { views: null } },
      { post_id: 'c', platform: 'tiktok', title: '我花三个月才想明白的事', day7: { views: 1626, er: 0.0529, vs_platform_median: 1.4 } }],
    best: ['c', 'gone'], worst: ['a', 'c'],
    too_new: [{ post_id: 'n1', platform: 'tiktok', title: '五分钟上手', note: '太新，下周再看' }],
    day7_views_median_vs_prev: { tiktok: { current: 1216.5, previous: 1352.5, samples: [2, 4] }, x: { current: 633, previous: null, samples: [3, 0] } } },
  stage: { day7_views_trend: { tiktok: { change: 0.03, previous_4w_median: 1335, recent_4w_median: 1369, samples: [11, 16] }, x: { change: -0.17,
    previous_4w_median: 795, recent_4w_median: 663, samples: [10, 11] } },
    // The shape stageSection() makes: `{ date, value }` or null.
    followers: [{ platform: 'tiktok', now: { date: '2026-11-03', value: 5200 }, weeks4_ago: { date: '2026-10-06', value: 5000 }, weeks8_ago: null }] },
  diagnostics: { posts: [{ post_id: 'n1', platform: 'tiktok', captured_on: '2026-11-02', video_seconds: 28, drop_second: 4,
    rates: { avg_watch_seconds: 6, avg_watch_pct: 0.2143, complete_rate: 0.11, bounce_2s: 0.62, retain_3s: 0.31, likes: 12, made_up: 3 },
    vs_own_median: { retain_3s: 0.8 }, stuck_layer: 'hook',
    layer_results: [{ layer: 'hook', name: '开头留人', status: 'fail', line: { bounce_2s: { max: 0.5 }, retain_3s: { min: 0.45 } } }] }],
    handbook: [{ platform: 'tiktok', calibration: 'owner_confirmed', version: 'v1', source: '行业经验值（第三方），非平台官方' }] },
  ledger: {
    to_review: [{ id: 'e1', hypothesis: '开头先给结论', result: { verdict: 'inconclusive', reason: 'samples_lt_3', samples: 2, vs_baseline: 1.12,
      next_status: 'extended' } }],
    running: [{ id: 'e2', hypothesis: '每周多发一条', period: { start: '2026-10-27', end: '2026-11-09' }, settling: false }],
    recent_concluded: [{ id: 'e3', hypothesis: '标题带数字', verdict: 'worked', concluded_on: '2026-10-26' }],
  },
};

describe('the brand review tables', () => {
  it('show a pillar by its name and everything without one as 未分类, never an internal code', () => {
    const names = new Map([['p1', '读书笔记']]);
    expect([pillarLabel('p1', names), pillarLabel('untagged', names), pillarLabel('p9', names)]).toEqual(['读书笔记', '未分类', '未分类']);
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />);
    expect(html).toContain('读书笔记');
    expect(html).toContain('未分类');
    for (const code of ['untagged', 'p1<', 'p9', '>p3']) expect(html).not.toContain(code);
  });

  it('carry the platform numbers the written part quotes: this period against the last, four weeks against four, followers', () => {
    const coach = coachTable(pack);
    expect(coach.trends).toEqual([
      { platform: 'tiktok', current: 1216.5, previous: 1352.5, recent4w: 1369, previous4w: 1335, change: 0.03, followersNow: 5200, followers4w: 5000,
        followers8w: null, samplesCurrent: 2, samplesPrevious: 4 },
      { platform: 'x', current: 633, previous: null, recent4w: 663, previous4w: 795, change: -0.17, followersNow: null, followers4w: null,
        followers8w: null, samplesCurrent: 3, samplesPrevious: 0 }]);
    const html = renderToStaticMarkup(<CoachTables coach={coach} />);
    expect(html).toContain('按平台的趋势');
    expect(html).toContain('+3%');
    expect(html).toContain('-17%');
    expect(html).toContain('5200 / 5000 / —');
    expect(html).toContain('样本（本期 / 上期）');
    expect(html).toContain('2 / 4');
  });

  it('carry the period line, engagement rates and the scoreboard window the written part quotes', () => {
    const text = renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />).replace(/<[^>]*>/g, '');
    expect(text).toContain('本期 10/27–11/02 · 本期发布 10 条 · 上期发布 8 条 · 满 7 天 3 条 · 太新暂不评判 1 条');
    expect(text).toContain('8.25%');
    expect(text).toContain('5.29%');
    expect(text).toContain('5.63%');
    expect(text).toContain('内容方向成绩单（近 8 周，满 7 天的作品）');
  });

  it('show the best and worst posts, single-post diagnoses and the experiments in words, never codes', () => {
    const coach = coachTable(pack);
    // An id the pack no longer lists (trimmed) drops out instead of showing an empty row.
    expect(coach.extras.best.map(p => p.postId)).toEqual(['c']);
    // With three ranked posts the middle one is in both lists in the pack; it is shown once.
    expect(coach.extras.worst.map(p => p.postId)).toEqual(['a']);
    const html = renderToStaticMarkup(<CoachTables coach={coach} />);
    const text = html.replace(/<[^>]*>/g, '');
    for (const words of ['本周最好的作品', '本周最差的作品', '单条诊断', '五分钟上手', '6 秒', '28 秒', '21.4%', '11%', '第 4 秒', '开头留人', '2 秒跳出率 62%（参考线 ≤50%）', '3 秒留存 31%（参考线 ≥45%，自己中位数的 0.80 倍）', '点赞 12', '诊断参考线来源：行业经验值（第三方），非平台官方',
      '上周实验完成情况', '开头先给结论', '还看不出', '符合条件的作品不到 3 条', '2 条', '1.12 倍', '再观察一期',
      '进行中：每周多发一条（10/27–11/09）', '10/26 结论：标题带数字 · 有效']) expect(text).toContain(words);
    for (const code of ['samples_lt_3', 'inconclusive', 'extended', 'worked', 'hook<', 'made_up', 'bounce_2s']) expect(html).not.toContain(code);
  });

  it('a basics-only pack (period but no this_period) shows no post counts at all, never counts of 0', () => {
    const basics = { kind: 'review_pack', version: 2, mode: 'basics_only', period: { start: '2026-10-27', end: '2026-11-02' } };
    expect(coachTable(basics).extras.summary).toBeNull();
    const trimmed = coachTable({ ...pack, trimmed_rows: 2 });
    expect(renderToStaticMarkup(<CoachTables coach={trimmed} />)).toContain('只列出复盘时看到的部分');
  });

  it('leave out the extra blocks when the pack has none of them', () => {
    const bare = { kind: 'review_pack', version: 2, this_period: { settled_posts: [] } };
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(bare)} />);
    for (const words of ['本期小结', '本周最好', '单条诊断', '上周实验']) expect(html).not.toContain(words);
  });

  it('show missing numbers as — and never as 0, NaN or null', () => {
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />);
    expect(html).toContain('—');
    for (const bad of ['NaN', 'null', 'undefined', '>0<', '0.00']) expect(html).not.toContain(bad);
  });

  it('read nothing from a pack of another shape', () => {
    expect(coachTable({ kind: 'review_pack', version: 1 })).toBe(EMPTY_COACH);
    expect(coachTable(null)).toBe(EMPTY_COACH);
    expect(renderToStaticMarkup(<CoachTables coach={coachTable({})} />)).not.toContain('table');
  });
});
