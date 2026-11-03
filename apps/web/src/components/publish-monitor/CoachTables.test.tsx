/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { coachTable, CoachTables, pillarLabel } from './CoachTables';

const pack = {
  kind: 'review_pack', version: 2,
  strategy: { pillars: [{ key: 'p1', name: '读书笔记', definition: '读书笔记' }, { key: 'p3', name: '城市探店', definition: '城市探店' }] },
  scoreboard: [
    { pillar: 'p1', platform: 'tiktok', samples: 4, views_median: 1200, vs_platform_median: 1.1 },
    { pillar: 'untagged', platform: 'tiktok', samples: 21, views_median: 1222, vs_platform_median: 1 },
    { pillar: 'p9', platform: 'x', samples: 2, views_median: null, vs_platform_median: null },
  ],
  this_period: { settled_posts: [{ post_id: 'a', platform: 'xiaohongshu', title: '【城市探店】 x', day7: { views: 900, vs_platform_median: 0.58 } },
    { post_id: 'b', platform: 'x', title: null, day7: { views: null } }],
    day7_views_median_vs_prev: { tiktok: { current: 1216.5, previous: 1352.5, samples: [2, 4] }, x: { current: 633, previous: null, samples: [3, 0] } } },
  stage: { day7_views_trend: { tiktok: { change: 0.03, previous_4w_median: 1335, recent_4w_median: 1369, samples: [11, 16] }, x: { change: -0.17,
    previous_4w_median: 795, recent_4w_median: 663, samples: [10, 11] } },
    followers: [{ platform: 'tiktok', now: 5200, weeks4_ago: 5000, weeks8_ago: null }] },
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
      { platform: 'tiktok', current: 1216.5, previous: 1352.5, recent4w: 1369, previous4w: 1335, change: 0.03, followersNow: 5200, followers4w: 5000, followers8w: null },
      { platform: 'x', current: 633, previous: null, recent4w: 663, previous4w: 795, change: -0.17, followersNow: null, followers4w: null, followers8w: null }]);
    const html = renderToStaticMarkup(<CoachTables coach={coach} />);
    expect(html).toContain('按平台的趋势');
    expect(html).toContain('+3%');
    expect(html).toContain('-17%');
    expect(html).toContain('5200 / 5000 / —');
  });

  it('show missing numbers as — and never as 0, NaN or null', () => {
    const html = renderToStaticMarkup(<CoachTables coach={coachTable(pack)} />);
    expect(html).toContain('—');
    for (const bad of ['NaN', 'null', 'undefined', '>0<', '0.00']) expect(html).not.toContain(bad);
  });

  it('read nothing from a pack of another shape', () => {
    expect(coachTable({ kind: 'review_pack', version: 1 })).toEqual({ posts: [], scores: [], trends: [] });
    expect(coachTable(null)).toEqual({ posts: [], scores: [], trends: [] });
    expect(renderToStaticMarkup(<CoachTables coach={coachTable({})} />)).not.toContain('table');
  });
});
