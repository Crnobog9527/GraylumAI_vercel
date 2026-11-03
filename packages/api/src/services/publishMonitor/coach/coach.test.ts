/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { basicsPass, diagnosePost, handbookSchema, type Handbook } from './funnel';
import { conclude, freezeBaseline, ledgerView } from './ledger';
import { stageSection } from './sections';
import { buildPack, packBytes, type Cadence } from './pack';
import { packRowsSchema } from './rows';
import { historyScoreboard, platformShift, scoreboard } from './scoreboard';
import { generateDataset } from './simulatedDataset';
import { REVIEW_PACK_RESERVE, day7Metric, utcDay } from './stats';
import { packRowsFor, simId } from './testRows';

const AS_OF = '2026-10-27';
/** The pack is plain JSON once built; tests read it as such. */
const loose = (pack: object) => JSON.parse(JSON.stringify(pack));
const NOW = Date.parse(AS_OF + 'T00:00:00Z');
const data = generateDataset({ asOf: AS_OF });
const account = (key: string) => data.accounts.find(a => a.key === key)!;
const rows = (key: string) => packRowsSchema.parse(packRowsFor(data, account(key)));
const verdict = (key: string, id: string) => {
  const r = rows(key);
  return conclude(r.experiments.find(e => e.id === simId(id))!, r.facts, r.diagnostics);
};

/** Placeholder numbers for tests only; the real handbook lines live in the private Skill package (Owner interview pending). */
const TEST_HANDBOOK: Handbook = handbookSchema.parse({
  platform: 'douyin', version: 'test', calibration: 'owner_confirmed',
  labels: { '2秒跳出率': 'bounce_2s', '3秒完播率': 'retain_3s', '5秒完播率': 'retain_5s', '完播率': 'complete_rate' },
  funnel: [
    { layer: 'hook', name: '前 2–3 秒停留', keys: ['bounce_2s', 'retain_3s'], basics: true,
      pass: { bounce_2s: { max: 0.5 }, retain_3s: { min: 0.45 } } },
    { layer: 'retain5', name: '5 秒留存', keys: ['retain_5s'], basics: true, pass: { retain_5s: { min: 0.3 } } },
    { layer: 'complete', name: '完播', keys: ['complete_rate'], basics: true, pass: { complete_rate: { min: 0.15 } },
      by_duration: { '>60s': { complete_rate: { min: 0.08 } } } },
    { layer: 'engage', name: '互动', keys: ['like_rate', 'save_rate'], basics: false, pass: { like_rate: { min: 0.04 } } },
  ],
});
const handbooks = new Map([['douyin', TEST_HANDBOOK]]);

describe('scorecards (RC-2, simulated accounts)', () => {
  it('A: the strong pillar scores about twice the weak one on both platforms, against its own platform', () => {
    const board = scoreboard(rows('A').facts, NOW, 26);
    for (const platform of ['xiaohongshu', 'douyin']) {
      const p1 = board.find(r => r.pillar === 'p1' && r.platform === platform)!, p2 = board.find(r => r.pillar === 'p2' && r.platform === platform)!;
      expect(p1.views_median! / p2.views_median!).toBeGreaterThan(1.8);
      expect(p1.vs_platform_median).toBeGreaterThan(1);
      expect(p2.vs_platform_median).toBeLessThan(1);
    }
  });

  it('B: history imported after day 7 is its own scorecard, never mixed with day-7 rows', () => {
    const r = rows('B');
    const history = historyScoreboard(r.facts);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(h => h.basis === 'cumulative_at_import')).toBe(true);
    const youtube = history.filter(h => h.platform === 'youtube');
    expect(youtube.toSorted((a, b) => b.views_median! - a.views_median!)[0]!.pillar).toBe('p3');
    const day7Posts = new Set(r.facts.filter(f => f.day7).map(f => f.postId));
    expect(r.facts.filter(f => f.basis === 'cumulative_at_import').some(f => day7Posts.has(f.postId))).toBe(false);
  });

  it('B: an imported post that later gets its day-30 snapshot stays in the history scorecard', () => {
    const r = rows('B');
    const before = historyScoreboard(r.facts);
    const settled = r.facts.map(f => f.basis === 'cumulative_at_import' && !f.day7
      ? { ...f, basis: 'day30' as const, day30: { views: 999999 }, day30On: '2026-10-20' } : f);
    expect(settled.some(f => f.basis === 'day30' && f.importCumulative)).toBe(true);
    expect(historyScoreboard(settled)).toEqual(before);
  });

  it('A: samples count every settled post, views_samples only those with a view count', () => {
    const r = rows('A');
    const pick = r.facts.filter(f => f.day7 && f.platform === 'douyin' && (f.pillarKey ?? 'untagged') === 'p1'
      && utcDay(f.postedAt) >= Math.floor(NOW / 86_400_000) - 26 * 7).slice(0, 3);
    expect(pick).toHaveLength(3);
    const only = new Set(pick.map(f => f.postId));
    const facts = r.facts.filter(f => !f.day7 || f.platform !== 'douyin' || (f.pillarKey ?? 'untagged') !== 'p1' || only.has(f.postId))
      .map((f, i) => only.has(f.postId) && f.postId !== pick[0]!.postId ? { ...f, day7: { likes: 5 + i } } : f);
    const row = scoreboard(facts, NOW, 26).find(x => x.pillar === 'p1' && x.platform === 'douyin')!;
    expect(row).toMatchObject({ samples: 3, views_samples: 1 });
  });

  it('C: a pillar strong on one platform and weak on another stays per platform; the TikTok shift is detected', () => {
    const board = scoreboard(rows('C').facts, NOW - 70 * 86_400_000, 16);
    expect(board.find(r => r.pillar === 'p2' && r.platform === 'xiaohongshu')!.vs_platform_median).toBeGreaterThan(1.2);
    expect(board.find(r => r.pillar === 'p2' && r.platform === 'tiktok')!.vs_platform_median).toBeLessThan(0.8);
    const start = utcDay(account('C').experiments[0]!.periodStart);
    expect(platformShift(rows('C').facts, 'tiktok', start, start + 13)).toMatchObject({ detected: true, direction: 'down' });
    expect(platformShift(rows('C').facts, 'xiaohongshu', start, start + 13).detected).toBe(false);
  });
});

describe('experiment ledger (RC-2): verdicts by code match the designed outcomes', () => {
  it.each([['A', 'A-E1'], ['A', 'A-E2'], ['B', 'B-E1'], ['C', 'C-E1'], ['D', 'D-E1']])('%s %s', (key, id) => {
    const expected = account(key).experiments.find(e => e.id === id)!.expected;
    const result = verdict(key, id);
    expect({ verdict: result.verdict, reason: result.reason ?? undefined }).toEqual(expected);
  });

  it('an inconclusive first period is extended once; nothing matched is not_run', () => {
    expect(verdict('D', 'D-E1').next_status).toBe('extended');
    const r = rows('A');
    const e = { ...r.experiments[0]!, match: { pillar_key: 'p3', format_tags: ['不存在的形式'] } };
    expect(conclude(e, r.facts, r.diagnostics)).toMatchObject({ verdict: 'not_run', next_status: 'concluded' });
    expect(conclude({ ...r.experiments[1]!, extended_once: true, baseline: null }, r.facts, r.diagnostics).next_status).toBe('concluded');
  });

  // A diagnostic counts only through a known fact of the same brand: these are the facts of the posts the diagnostics describe.
  const factFor = (d: { postId: string; platform: string; capturedOn: string }, over: object = {}) => ({ postId: d.postId, platform: d.platform,
    postedAt: d.capturedOn + 'T00:00:00Z', title: null, url: null, pillarKey: 'p1', pillarSource: 'user' as const, formatTags: [],
    basis: 'day7' as const, day7: { views: 100 }, day7On: d.capturedOn, day30: null, day30On: null, importCumulative: null,
    importOn: null, missing: [], ...over });
  const basics = () => {
    const r = rows('A');
    const fresh = r.diagnostics.filter(d => d.capturedOn === r.diagnostics[0]!.capturedOn);
    const e = { ...r.experiments[0]!, kind: 'basics' as const, metric: 'bounce_2s', layer: 'hook', target_line: { max: 0.5 },
      target_mult: null, match: { pillar_key: 'p1' }, period_start: fresh[0]!.capturedOn, period_end: fresh[0]!.capturedOn };
    return { r, fresh, e, facts: fresh.map(d => factFor(d)) };
  };

  it('a basics experiment is settled on confirmed rates against its handbook line', () => {
    const { e, fresh, facts } = basics();
    const result = conclude(e, facts, fresh);
    expect(result.samples).toBe(3);
    expect(result.verdict).toBe('failed');
    expect(conclude({ ...e, target_line: { max: 0.65 } }, facts, fresh).verdict).toBe('worked');
  });

  it('a diagnostic whose post is not a matching fact is never a sample (another platform, another pillar, not settled)', () => {
    const { e, fresh, facts } = basics();
    expect(conclude(e, [], fresh)).toMatchObject({ samples: 0, verdict: 'not_run' });
    const other = { ...e, match: { pillar_key: 'p1', platform: fresh[0]!.platform } };
    expect(conclude(other, facts.map(f => ({ ...f, platform: 'tiktok' })), fresh).samples).toBe(0);
    expect(conclude(e, facts.map(f => ({ ...f, pillarKey: 'p2' })), fresh).samples).toBe(0);
  });

  it('a rate without a handbook line gives a lean in the metric direction, never a verdict by ratio', () => {
    const { e, fresh, facts } = basics();
    const noLine = { ...e, target_line: null, baseline: { metric: 'bounce_2s', median: 0.5, samples: 5, window_weeks: 8, basis: 'diag' } };
    const low = fresh.map(d => ({ ...d, rates: { ...d.rates, bounce_2s: 0.1 } }));
    // The bounce rate fell from 0.5 to 0.1: that is an improvement, not a failure.
    expect(conclude(noLine, facts, low)).toMatchObject({ verdict: 'inconclusive', reason: 'within_noise', lean: 'positive' });
    const high = fresh.map(d => ({ ...d, rates: { ...d.rates, bounce_2s: 0.95 } }));
    expect(conclude(noLine, facts, high)).toMatchObject({ verdict: 'inconclusive', lean: 'negative' });
    const retain = { ...noLine, metric: 'retain_3s', baseline: { metric: 'retain_3s', median: 0.5, samples: 5, window_weeks: 8, basis: 'diag' } };
    const drop = fresh.map(d => ({ ...d, rates: { ...d.rates, retain_3s: 0.1 } }));
    expect(conclude(retain, facts, drop)).toMatchObject({ verdict: 'inconclusive', lean: 'negative' });
  });

  it('a rate sample is a post published in the experiment period, whenever its numbers were captured', () => {
    const { e, fresh } = basics();
    const inside = fresh.map(d => factFor(d));
    // The posts are older than the period: their numbers captured inside it do not make them participants.
    const old = fresh.map(d => factFor(d, { postedAt: '2020-01-01T00:00:00Z' }));
    expect(conclude(e, old, fresh)).toMatchObject({ samples: 0, verdict: 'not_run' });
    // Numbers uploaded after the period for posts inside it still count.
    const late = fresh.map(d => ({ ...d, capturedOn: '2099-01-01' }));
    expect(conclude(e, inside, late).samples).toBe(3);
  });

  it('published posts without a captured rate are thin data (extended), not "not run"', () => {
    const { e, fresh, facts } = basics();
    const result = conclude(e, facts, []);
    expect(fresh.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ samples: 0, verdict: 'inconclusive', reason: 'samples_lt_3', next_status: 'extended' });
    expect(conclude({ ...e, extended_once: true }, facts, [])).toMatchObject({ verdict: 'inconclusive', next_status: 'concluded' });
  });

  it('a real day-7 value is not hidden by a missing field of another observation', () => {
    const { facts } = basics();
    const fact = { ...facts[0]!, day7: { views: 1000 }, missing: ['views'] };
    expect(day7Metric(fact, 'views')).toBe(1000);
    expect(day7Metric({ ...fact, day7: {} }, 'views')).toBeNull();
  });

  it('a derived rate (watch percentage from seconds and video length) settles like a confirmed one', () => {
    const { e, fresh, facts } = basics();
    const derived = fresh.map(d => ({ ...d, videoSeconds: 40, rates: { avg_watch_seconds: 20 } }));
    const result = conclude({ ...e, metric: 'avg_watch_pct', layer: 'retention', target_line: { min: 0.4 } }, facts, derived);
    expect(result).toMatchObject({ samples: 3, verdict: 'worked' });
  });

  it('platforms are never mixed in one baseline or verdict', () => {
    const { e, fresh } = basics();
    const post = (id: string, platform: string, daysAgo: number, views: number) => ({ ...factFor(fresh[0]!, { postId: simId(id), platform,
      postedAt: new Date(NOW - daysAgo * 86400000).toISOString(), day7: { views } }) });
    const noPlatform = { ...e, metric: 'views', layer: null, kind: 'tactic' as const, target_line: null, target_mult: 1.3, match: { pillar_key: 'p1' },
      baseline: { metric: 'views', median: 5000, samples: 6, window_weeks: 8, basis: 'day7' },
      period_start: new Date(NOW - 10 * 86400000).toISOString().slice(0, 10), period_end: new Date(NOW - 1 * 86400000).toISOString().slice(0, 10) };
    // 100 views on one platform and 10000 on the other, each stable; only the share of posts per platform changes.
    const facts = [post('a1', 'douyin', 5, 100), post('a2', 'douyin', 4, 100), post('b1', 'xiaohongshu', 3, 10000)];
    expect(conclude(noPlatform, facts, [])).toMatchObject({ verdict: 'inconclusive', reason: 'mixed_platforms' });
    const baselineFacts = [post('c1', 'douyin', 30, 100), post('c2', 'xiaohongshu', 31, 10000)];
    expect(freezeBaseline({ pillar_key: 'p1' }, 'views', baselineFacts, new Date(NOW).toISOString().slice(0, 10))).toBeNull();
    expect(freezeBaseline({ pillar_key: 'p1', platform: 'douyin' }, 'views', baselineFacts, new Date(NOW).toISOString().slice(0, 10)))
      .toMatchObject({ median: 100, samples: 1 });
  });

  it('several captures of one post are one sample, not several', () => {
    const { e, fresh, facts } = basics();
    const first = fresh[0]!;
    const repeated = [0, 1, 2].map(i => ({ ...first, id: first.id.slice(0, -1) + String(i), capturedOn: `2026-10-0${i + 1}`,
      rates: { ...first.rates, bounce_2s: 0.1 } }));
    const result = conclude(e, [facts[0]!], repeated);
    expect(result.samples).toBe(1);
    expect(result.matched_posts).toEqual([first.postId]);
    expect(result.verdict).not.toBe('worked');
  });

  it('an experiment is reviewed only after its last post could have settled; until then it is listed as settling', () => {
    const { r, e } = basics();
    const end = '2026-10-24';
    const waiting = { ...e, status: 'running' as const, user_decision: null, period_end: end, period_start: '2026-10-17' };
    const early = ledgerView([waiting], [], [], Date.parse('2026-10-27T00:00:00Z'));
    expect(early.to_review).toHaveLength(0);
    expect(early.running[0]).toMatchObject({ id: waiting.id, settling: true });
    const later = ledgerView([waiting], [], [], Date.parse('2026-11-01T00:00:00Z'));
    expect(later.to_review.map(x => x.id)).toEqual([waiting.id]);
    expect(r.experiments.length).toBeGreaterThan(0);
  });
});

describe('funnel diagnosis (RC-2)', () => {
  it('finds the first stuck layer, compares with the user own history and flags inconsistent numbers', () => {
    const r = rows('A');
    const fresh = r.diagnostics.slice(0, 3);
    const results = fresh.map(d => diagnosePost(d, TEST_HANDBOOK, r.diagnostics));
    expect(results.map(x => x.stuck_layer)).toEqual(['hook', 'hook', null]);
    expect(results[0]!.drop_second).toBe(2);
    expect(Object.keys(results[0]!.vs_own_median)).toContain('bounce_2s');
    expect(basicsPass(results, handbooks)).toBe(false);
    expect(basicsPass(results.slice(1), handbooks)).toBe(false);
    expect(basicsPass([results[2]!], handbooks)).toBe(true);
    const odd = diagnosePost({ ...fresh[2]!, rates: { retain_3s: 0.3, retain_5s: 0.4, complete_rate: 1.2 } }, TEST_HANDBOOK, []);
    expect(odd.inconsistent).toEqual(['complete_rate_out_of_range', 'retain_3s_below_retain_5s', 'complete_rate_above_retain_5s']);
  });

  it('a draft handbook or a platform without one never says a layer fails', () => {
    const r = rows('A');
    const draft = { ...TEST_HANDBOOK, calibration: 'draft' as const };
    const result = diagnosePost(r.diagnostics[0]!, draft, r.diagnostics);
    expect(result.stuck_layer).toBeNull();
    expect(result.layer_results[0]).toMatchObject({ status: 'unknown', line_status: 'own_median' });
    expect(basicsPass([result], new Map([['douyin', draft]]))).toBeNull();
    const tiktok = rows('C').diagnostics[0]!;
    expect(diagnosePost(tiktok, null, []).layer_results).toEqual([]);
    expect(diagnosePost({ ...tiktok, rates: { avg_watch_seconds: 7 } }, null, []).rates.avg_watch_pct).toBe(0.25);
  });
});

describe('review pack (RC-2)', () => {
  const cadences: Cadence[] = ['weekly', 'monthly', 'quarterly', 'chat'];
  it.each(data.accounts.map(a => a.key))('account %s fits the reserve in every cadence and keeps the protected sections', key => {
    for (const cadence of cadences) {
      const pack = loose(buildPack({ rows: rows(key), cadence, businessId: simId(key), now: NOW, handbooks }));
      expect(packBytes(pack)).toBeLessThanOrEqual(REVIEW_PACK_RESERVE);
      for (const section of ['strategy', 'stage', 'diagnostics', 'ledger', 'gaps', 'rules']) expect(pack).toHaveProperty(section);
    }
  });

  it('A with two of three posts stuck at the hook is basics only: no long-run sections, basics experiments only', () => {
    const pack = loose(buildPack({ rows: rows('A'), cadence: 'weekly', businessId: simId('A'), now: NOW, handbooks }));
    expect(pack.mode).toBe('basics_only');
    expect(pack.diagnostics.basics_pass).toBe(false);
    expect(pack.diagnostics.stuck_summary).toEqual({ hook: 2 });
    for (const section of ['scoreboard', 'history_scoreboard', 'this_period', 'untagged_posts', 'monthly']) expect(pack).not.toHaveProperty(section);
    expect(pack.limits).toMatchObject({ experiments_max: 2, experiment_kinds: ['basics'], strategy_proposal: false });
  });

  it('without diagnostics the pack is full, offers candidates and names the gaps instead of inventing numbers', () => {
    const r = { ...rows('B'), diagnostics: [] };
    const pack = loose(buildPack({ rows: r, cadence: 'monthly', businessId: simId('B'), now: NOW, handbooks }));
    // The count and the pillar mix cover every post of the 28 days (settled and too new), not only the too-new ones.
    const posted = r.facts.filter(f => utcDay(f.postedAt) > utcDay(AS_OF + 'T00:00:00Z') - 28).length
      + r.recent.filter(p => utcDay(p.postedAt) > utcDay(AS_OF + 'T00:00:00Z') - 28).length;
    expect(pack.this_period.published).toBe(posted);
    expect(Object.values(pack.this_period.by_pillar as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(posted);
    expect(pack.this_period.published).toBeGreaterThan(pack.this_period.too_new.length);
    expect(pack.mode).toBe('full');
    expect(pack.diagnostics).toMatchObject({ requested: false, basics_pass: null });
    expect(pack.diagnostics.candidates.length).toBeGreaterThan(0);
    expect(pack.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ platform: 'youtube', note: '平台不提供',
      missing: expect.arrayContaining(['followers', 'shares']) })]));
    expect(pack.monthly.pillar_mix_actual_4w).toBeDefined();
    expect(pack.limits).toMatchObject({ experiments_max: 3, pillar_mix_proposal: true, strategy_proposal: false });
    expect(pack.this_period.too_new.every((p: { note: string }) => p.note === '太新，下周再看')).toBe(true);
  });

  it('untagged posts are offered for tagging (bounded) and reviewed experiments carry their code verdict', () => {
    const r = packRowsSchema.parse(packRowsFor(data, account('C'), { untagged: 60 }));
    const pack = loose(buildPack({ rows: { ...r, diagnostics: [] }, cadence: 'weekly', businessId: simId('C'), now: NOW, handbooks }));
    expect(pack.untagged_posts.length).toBeGreaterThan(0);
    expect(pack.untagged_posts.length).toBeLessThanOrEqual(40);
    expect(pack.ledger.to_review[0].result).toMatchObject({ verdict: 'inconclusive', reason: 'platform_shift' });
  });

  it('a quarterly pack checks the strategy fit; a missing strategy is a gap, not a guess', () => {
    const r = { ...rows('D'), strategy: null, diagnostics: [] };
    const pack = loose(buildPack({ rows: r, cadence: 'quarterly', businessId: simId('D'), now: NOW, handbooks }));
    expect(pack.quarterly.strategy_fit).toBeDefined();
    expect(pack.strategy.missing).toBe(true);
    expect(pack.gaps[0]).toMatchObject({ missing: ['strategy'] });
    expect(pack.limits.strategy_proposal).toBe(true);
  });
});

describe('funnel diagnoses (RC-2 picks)', () => {
  it('three different posts are diagnosed, the newest capture of each: repeated captures of one post do not crowd out the others', () => {
    const r = rows('A');
    const base = r.diagnostics[0]!;
    const mk = (n: number, postKey: string, capturedOn: string) => ({ ...base, id: simId(`d${n}`), postId: simId(postKey), capturedOn, reviewRunId: null });
    const ds = [mk(1, 'p-bad', '2026-10-26'), mk(2, 'p-bad', '2026-10-25'), mk(3, 'p-bad', '2026-10-24'), mk(4, 'p-ok1', '2026-10-23'), mk(5, 'p-ok2', '2026-10-22')];
    const pack = loose(buildPack({ rows: { ...r, diagnostics: ds }, cadence: 'weekly', businessId: simId('A'), now: NOW, handbooks }));
    expect(pack.diagnostics.posts.map((p: { post_id: string }) => p.post_id)).toEqual([simId('p-bad'), simId('p-ok1'), simId('p-ok2')]);
  });
});

describe('strategy proposals (RC-2)', () => {
  it('a quarterly pack that only covers the basics does not open the strategy proposal', () => {
    const r = rows('A');
    const full = loose(buildPack({ rows: { ...r, diagnostics: [] }, cadence: 'quarterly', businessId: simId('A'), now: NOW, handbooks }));
    expect(full.limits.strategy_proposal).toBe(true);
    const failing = r.diagnostics.slice(0, 3).map(d => ({ ...d, platform: 'douyin', rates: { bounce_2s: 0.95, retain_3s: 0.1 }, reviewRunId: null,
      capturedOn: AS_OF }));
    const basicsOnly = loose(buildPack({ rows: { ...r, diagnostics: failing }, cadence: 'quarterly', businessId: simId('A'), now: NOW, handbooks }));
    expect(basicsOnly.mode).toBe('basics_only');
    expect(basicsOnly.limits.strategy_proposal).toBe(false);
  });
});

describe('post counts (RC-2)', () => {
  it('a post that is both a settled fact and a too-new row counts once in every count', () => {
    const r = rows('A');
    const f = r.facts.find(x => utcDay(x.postedAt) > utcDay(AS_OF + 'T00:00:00Z') - 20)!;
    expect(f).toBeDefined();
    const twin = { postId: f.postId, platform: f.platform, postedAt: f.postedAt, title: null, pillarKey: f.pillarKey };
    const once = loose(buildPack({ rows: { ...r, diagnostics: [] }, cadence: 'monthly', businessId: simId('A'), now: NOW, handbooks }));
    const twice = loose(buildPack({ rows: { ...r, recent: [...r.recent, twin], diagnostics: [] }, cadence: 'monthly', businessId: simId('A'), now: NOW, handbooks }));
    expect(twice.this_period.published).toBe(once.this_period.published);
    expect(twice.this_period.published_previous).toBe(once.this_period.published_previous);
    expect(twice.stage.posts_8w).toBe(once.stage.posts_8w);
    expect(twice.monthly.pillar_mix_actual_4w).toEqual(once.monthly.pillar_mix_actual_4w);
  });
});

describe('stage trend (RC-2)', () => {
  it('the day-7 views trend is per platform: a shift in which platform is used is not a performance change', () => {
    const base = rows('A');
    const make = (platform: string, daysAgo: number, views: number, n: number) => Array.from({ length: n }, (_, i) => ({
      postId: simId(`${platform}-${daysAgo}-${i}`), platform, postedAt: new Date(NOW - daysAgo * 86400000).toISOString(), title: null, url: null,
      pillarKey: null, pillarSource: null, formatTags: [], basis: 'day7' as const, day7: { views }, day7On: AS_OF, day30: null, day30On: null,
      importCumulative: null, importOn: null, missing: [] }));
    // Two platforms keep 100 and 10000 views; recently the user posts mostly on the big one.
    const facts = [...make('douyin', 50, 100, 4), ...make('douyin', 10, 100, 1), ...make('xiaohongshu', 50, 10000, 1), ...make('xiaohongshu', 10, 10000, 4)];
    const trend = loose(stageSection({ ...base, facts, recent: [] }, NOW)).day7_views_trend as Record<string, { change: number }>;
    expect(Object.keys(trend).sort()).toEqual(['douyin', 'xiaohongshu']);
    expect(trend.douyin!.change).toBe(0);
    expect(trend.xiaohongshu!.change).toBe(0);
    expect(loose(stageSection({ ...base, facts: [], recent: [] }, NOW)).day7_views_trend).toBeNull();
  });
});
