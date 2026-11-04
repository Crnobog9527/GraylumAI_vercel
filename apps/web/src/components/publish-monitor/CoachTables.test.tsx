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
    vs_own_median: { retain_3s: 0.8, complete_rate: 0.5 }, stuck_layer: 'hook',
    layer_results: [{ layer: 'hook', name: '开头留人', status: 'fail', line: { bounce_2s: { max: 0.5 }, retain_3s: { min: 0.45 }, avg_watch_seconds: { min: 5 } } }] },
  { post_id: 'old', platform: 'tiktok', captured_on: '2026-11-01', opening_text: '  你可能一直做错了这一步', rates: { views: 300 }, stuck_layer: null,
    layer_results: [] }],
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
    for (const words of ['本周最好的作品', '本周最差的作品', '单条诊断', '五分钟上手', '6 秒', '28 秒', '21.4%', '11%', '第 4 秒', '开头留人', '2 秒跳出率 62%（参考线 ≤50%）', '3 秒留存 31%（参考线 ≥45%，自己中位数的 0.80 倍）', '点赞 12', '平均观看 6 秒（参考线 ≥5 秒）', '完播率 11%（无参考线，自己中位数的 0.50 倍）', '开头：你可能一直做错了这一步', '11/01', '诊断参考线来源：行业经验值（第三方），非平台官方',
      '上周实验完成情况', '开头先给结论', '还看不出', '符合条件的作品不到 3 条', '2 条', '1.12 倍', '再观察一期',
      '进行中：每周多发一条（10/27–11/09）', '10/26 结论：标题带数字 · 有效']) expect(text).toContain(words);
    for (const code of ['samples_lt_3', 'inconclusive', 'extended', 'worked', 'hook<', 'made_up', 'bounce_2s']) expect(html).not.toContain(code);
  });

  it('says the source of the diagnosis lines, or that there is none; every judged layer\'s line is shown, not only the stuck one', () => {
    const noHandbook = { ...pack, diagnostics: { posts: [{ post_id: 'n1', platform: 'tiktok', captured_on: '2026-11-02', video_seconds: 28,
      rates: { like_rate: 0.04, share_rate: 0.002, complete_rate: 0.1 }, vs_own_median: { like_rate: 1.2 }, stuck_layer: 'complete',
      layer_results: [{ layer: 'hook', name: '开头留人', status: 'pass', line: { like_rate: { min: 0.03 } } },
        { layer: 'complete', name: '完播', status: 'fail', line: { complete_rate: { min: 0.25 } } }] }], handbook: [] } };
    const text = renderToStaticMarkup(<CoachTables coach={coachTable(noHandbook)} />).replace(/<[^>]*>/g, '');
    // Lines were used but the pack names no handbook: the source is not recorded.
    expect(text).toContain('诊断参考线来源：手册参考线（来源未记录）');
    // The stuck layer's line, another layer's line, a metric without one, and the own-median comparison.
    for (const words of ['完播率 10%（参考线 ≥25%）', '点赞率 4%（参考线 ≥3%，自己中位数的 1.20 倍）', '分享率 0.2%（无参考线）']) expect(text).toContain(words);
    expect(renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />).replace(/<[^>]*>/g, ''))
      .toContain('诊断参考线来源：行业经验值（第三方），非平台官方');
    // A draft handbook (or too few views) judges nothing: its source is not claimed, and a count never says 无参考线.
    const draft = { ...pack, diagnostics: { posts: [{ post_id: 'n1', platform: 'tiktok', rates: { likes: 12, like_rate: 0.04 }, stuck_layer: null,
      layer_results: [{ layer: 'hook', name: '开头留人', status: 'unknown', line: null }] }],
    handbook: [{ platform: 'tiktok', calibration: 'draft', source: '行业经验值（第三方），非平台官方' }] } };
    const draftText = renderToStaticMarkup(<CoachTables coach={coachTable(draft)} />).replace(/<[^>]*>/g, '');
    expect(draftText).toContain('本期没有手册参考线');
    expect(draftText).not.toContain('行业经验值');
    expect(draftText).toContain('点赞 12；');
    expect(draftText).toContain('点赞率 4%（无参考线）');
    // A confirmed handbook without a source: its lines are used, the page says the source is not recorded (and never "no handbook line").
    const unsourced = { ...pack, diagnostics: { posts: [{ post_id: 'n1', platform: 'tiktok', rates: { like_rate: 0.04 }, stuck_layer: null,
      layer_results: [{ layer: 'hook', name: '开头留人', status: 'pass', line: { like_rate: { min: 0.03 } } }] }],
    handbook: [{ platform: 'tiktok', calibration: 'owner_confirmed', source: null }] } };
    const unsourcedText = renderToStaticMarkup(<CoachTables coach={coachTable(unsourced)} />).replace(/<[^>]*>/g, '');
    expect(unsourcedText).toContain('诊断参考线来源：手册参考线（来源未记录）');
    expect(unsourcedText).not.toContain('本期没有手册参考线');
    expect(unsourcedText).toContain('点赞率 4%（参考线 ≥3%）');
    // Two platforms: only the one whose lines were used speaks; a draft handbook that judged nothing does not name its source.
    const mixed = { ...pack, diagnostics: { posts: [
      { post_id: 'n1', platform: 'tiktok', rates: { like_rate: 0.04 }, stuck_layer: null,
        layer_results: [{ layer: 'hook', name: 'A', line: { like_rate: { min: 0.03 } } }] },
      { post_id: 'n2', platform: 'instagram', rates: { like_rate: 0.04 }, stuck_layer: null, layer_results: [{ layer: 'hook', name: 'A', line: null }] }],
    handbook: [{ platform: 'tiktok', calibration: 'owner_confirmed', source: null },
      { platform: 'instagram', calibration: 'draft', source: '草稿手册来源' }] } };
    const mixedText = renderToStaticMarkup(<CoachTables coach={coachTable(mixed)} />).replace(/<[^>]*>/g, '');
    expect(mixedText).toContain('诊断参考线来源：手册参考线（来源未记录）');
    expect(mixedText).not.toContain('草稿手册来源');
    // One platform with a source and one without: both are said.
    const both2 = { ...mixed, diagnostics: { ...mixed.diagnostics, handbook: [{ platform: 'tiktok', source: '甲来源' }, { platform: 'instagram', source: null }],
      posts: mixed.diagnostics.posts.map(p => ({ ...p, layer_results: [{ layer: 'hook', name: 'A', line: { like_rate: { min: 0.03 } } }] })) } };
    expect(renderToStaticMarkup(<CoachTables coach={coachTable(both2)} />).replace(/<[^>]*>/g, '')).toContain('诊断参考线来源：甲来源；另有手册参考线（来源未记录）');
    // Two layers with the same metric: the stuck layer's line is shown.
    const both = { ...pack, diagnostics: { posts: [{ post_id: 'n1', platform: 'tiktok', rates: { like_rate: 0.04 }, stuck_layer: 'b',
      layer_results: [{ layer: 'a', name: 'A', line: { like_rate: { min: 0.03 } } }, { layer: 'b', name: 'B', line: { like_rate: { min: 0.05 } } }] }],
    handbook: [] } };
    expect(renderToStaticMarkup(<CoachTables coach={coachTable(both)} />).replace(/<[^>]*>/g, '')).toContain('点赞率 4%（参考线 ≥5%）');
  });

  it('each table slides sideways in its own box, and the title and summary line do not scroll with it', () => {
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />);
    const tables = html.match(/<table /g)?.length ?? 0;
    expect(tables).toBeGreaterThanOrEqual(6);
    // One scroll box per table, wrapped directly around it; nothing above them scrolls.
    expect(html.match(/<div class="overflow-x-auto"><table /g)?.length).toBe(tables);
    expect(html.match(/overflow-x-auto/g)?.length).toBe(tables);
    expect(html).not.toMatch(/<caption/);
    expect(html).toMatch(/<p class="text-xs font-medium">按平台的趋势<\/p><div class="overflow-x-auto"><table /);
  });

  it('experiments with data are said in words: result, reason, sample, ratio, next step; running and concluded too, no state codes', () => {
    const experiments = { ...pack, ledger: {
      to_review: [
        { id: 'a', hypothesis: '甲', result: { verdict: 'worked', reason: null, samples: 5, vs_baseline: 1.6, next_status: 'concluded' } },
        { id: 'b', hypothesis: '乙', result: { verdict: 'failed', reason: null, samples: 4, vs_baseline: 0.5, next_status: 'concluded' } },
        { id: 'c', hypothesis: '丙', result: { verdict: 'inconclusive', reason: 'within_noise', samples: 3, vs_baseline: 1.05, next_status: 'extended' } },
        { id: 'd', hypothesis: '丁', result: { verdict: 'inconclusive', reason: 'platform_shift', samples: 6, vs_baseline: null, next_status: 'extended' } },
        { id: 'e', hypothesis: '戊', result: { verdict: 'not_run', reason: null, samples: 0, vs_baseline: null, next_status: 'concluded' } },
        { id: 'f', hypothesis: '己', result: { verdict: 'inconclusive', reason: 'low_volume', samples: 2, vs_baseline: 0.9, next_status: 'extended' } },
        { id: 'g', hypothesis: '庚', result: { verdict: 'inconclusive', reason: 'mixed_platforms', samples: 7, vs_baseline: null, next_status: 'concluded' } }],
      running: [{ id: 'r', hypothesis: '辛', period: { start: '2026-11-03', end: '2026-11-09' }, settling: true }],
      recent_concluded: [{ id: 'x', hypothesis: '壬', verdict: 'failed', concluded_on: '2026-10-26' }] } };
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(experiments)} />);
    const text = html.replace(/<[^>]*>/g, '');
    for (const words of ['有效', '没有效果', '还看不出', '没有执行', '差别在正常波动之内', '这段时间平台整体流量变了', '这段时间发得太少', '混了几个平台的作品',
      '5 条', '0 条', '1.60 倍', '0.50 倍', '再观察一期', '结束', '进行中：辛（11/03–11/09，等最后几条作品满 7 天）', '10/26 结论：壬 · 没有效果'])
      expect(text).toContain(words);
    for (const code of ['worked', 'failed', 'inconclusive', 'not_run', 'within_noise', 'platform_shift', 'low_volume', 'mixed_platforms', 'extended', 'concluded',
      'null', 'NaN', 'undefined']) expect(html).not.toContain(code);
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
