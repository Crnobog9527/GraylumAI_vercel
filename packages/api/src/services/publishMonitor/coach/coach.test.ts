/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { basicsPass, diagnosePost, handbookSchema, type Handbook } from './funnel';
import { conclude } from './ledger';
import { buildPack, packBytes, type Cadence } from './pack';
import { packRowsSchema } from './rows';
import { historyScoreboard, platformShift, scoreboard } from './scoreboard';
import { generateDataset } from './simulatedDataset';
import { REVIEW_PACK_RESERVE, utcDay } from './stats';
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

  it('a basics experiment is settled on confirmed rates against its handbook line', () => {
    const r = rows('A');
    const fresh = r.diagnostics.filter(d => d.capturedOn === r.diagnostics[0]!.capturedOn);
    const e = { ...r.experiments[0]!, kind: 'basics' as const, metric: 'bounce_2s', layer: 'hook', target_line: { max: 0.5 },
      target_mult: null, match: { pillar_key: 'p1' }, period_start: fresh[0]!.capturedOn, period_end: fresh[0]!.capturedOn };
    const facts = r.facts.map(f => fresh.some(d => d.postId === f.postId) ? { ...f, pillarKey: 'p1' } : f);
    const result = conclude(e, facts, fresh);
    expect(result.samples).toBe(3);
    expect(result.verdict).toBe('failed');
    expect(conclude({ ...e, target_line: { max: 0.65 } }, facts, fresh).verdict).toBe('worked');
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
