/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { handbookSchema } from './funnel';
import { checkOutput } from './output';
import { buildPack } from './pack';
import { packRowsSchema } from './rows';
import { generateDataset } from './simulatedDataset';
import { packRowsFor, simId } from './testRows';

/** The pack is plain JSON once built; tests read it as such. */
const loose = (pack: object) => JSON.parse(JSON.stringify(pack));
const NOW = Date.parse('2026-10-27T00:00:00Z');
const data = generateDataset({ asOf: '2026-10-27' });
const rowsC = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'C')!, { untagged: 60 }));
const full = loose(buildPack({ rows: { ...rowsC, diagnostics: [] }, cadence: 'weekly', businessId: simId('C'), now: NOW,
  handbooks: new Map() }));
const handbook = handbookSchema.parse({ platform: 'douyin', version: 't', calibration: 'owner_confirmed', labels: {},
  funnel: [{ layer: 'hook', name: '开头', keys: ['bounce_2s'], basics: true, pass: { bounce_2s: { max: 0.5 } } }] });
const rowsA = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'A')!));
const basics = loose(buildPack({ rows: rowsA, cadence: 'weekly', businessId: simId('A'), now: NOW,
  handbooks: new Map([['douyin', handbook]]) }));
const post = full.this_period.settled_posts[0].post_id as string;
const good = { kind: 'tactic', layer: null, hypothesis: '城市探店在小红书更强', action: '下两周小红书探店 2 条', metric: 'views',
  target: { mult: 1.3 }, match: { pillar_key: 'p3', platform: 'xiaohongshu' }, evidence: { post_ids: [post], metrics: [] } };
const block = (o: unknown) => `正文第一段。\n\n\`\`\`coach_json\n${JSON.stringify(o)}\n\`\`\``;
const out = (o: Record<string, unknown>, pack: typeof full = full) => checkOutput(block({ version: 2, mode: pack.mode, ...o }), pack);

describe('coach_json checks (RC-2)', () => {
  it('keeps the prose, strips the block and accepts a cited, measurable experiment', () => {
    const r = out({ experiments: [good] });
    expect(r.body).toBe('正文第一段。');
    expect(r).toMatchObject({ parsed: true, mode_mismatch: false, rejected: [] });
    expect(r.experiments).toHaveLength(1);
  });

  it('a missing or broken block keeps the prose and records nothing', () => {
    expect(checkOutput('只有正文', full)).toMatchObject({ body: '只有正文', parsed: false, rejected: [{ reason: 'no_block' }] });
    expect(checkOutput('正文\n```coach_json\n{oops\n```', full).rejected).toEqual([{ path: '', reason: 'json' }]);
    expect(checkOutput(block({ version: 1 }), full).rejected).toEqual([{ path: '', reason: 'shape' }]);
  });

  it.each([
    ['no evidence', { ...good, evidence: { post_ids: [], metrics: [] } }, 'no_evidence'],
    ['a post that is not in the pack', { ...good, evidence: { post_ids: [simId('nope')], metrics: [] } }, 'no_evidence'],
    ['a metric reference that is not in the pack', { ...good, evidence: { post_ids: [], metrics: ['scoreboard:p9:x'] } }, 'no_evidence'],
    ['an unknown pillar', { ...good, match: { pillar_key: 'p9' } }, 'unknown_pillar'],
    ['a target that cannot be measured', { ...good, target: {} }, 'metric_or_target'],
    ['a rate metric in a day-7 experiment', { ...good, metric: 'bounce_2s' }, 'metric_or_target'],
    ['a kind this cadence may not propose', { ...good, kind: 'pillar_mix' }, 'kind_not_allowed'],
  ])('rejects an experiment with %s', (_name, experiment, reason) => {
    const r = out({ experiments: [experiment] });
    expect(r.experiments).toEqual([]);
    expect(r.rejected).toEqual([{ path: 'experiments.0', reason }]);
  });

  it('caps experiments, one per pillar, and drops proposals this cadence may not make', () => {
    const other = { ...good, match: { pillar_key: 'p1' } }, third = { ...good, match: { pillar_key: 'p2' } };
    const r = out({ experiments: [good, { ...good }, other, third, { ...good, match: { pillar_key: 'p1', platform: 'x' } }],
      strategy_proposal: { summary: '换赛道', evidence: { post_ids: [post] } }, stage_suggestion: 'growing',
      pillar_mix_proposal: { target: { p1: 1 }, evidence: { post_ids: [post] } } });
    expect(r.experiments.map(e => e.match.pillar_key)).toEqual(['p3', 'p1', 'p2']);
    expect(r.rejected.map(x => `${x.path}:${x.reason}`)).toEqual(['experiments.1:pillar_repeated', 'experiments.4:too_many',
      'pillar_mix_proposal:not_this_cadence', 'strategy_proposal:not_this_cadence', 'stage_suggestion:not_this_cadence']);
  });

  it('only tags untagged posts with known pillars and only annotates reviewed experiments', () => {
    const untagged = full.untagged_posts[0].post_id;
    const r = out({ tags: [{ post_id: untagged, pillar_key: 'p2' }, { post_id: untagged, pillar_key: 'p9' }, { post_id: post, pillar_key: 'p1' }],
      verdict_notes: [{ experiment_id: full.ledger.to_review[0].id, note: '平台整体限流，这期不算' }, { experiment_id: simId('x'), note: 'x' }] });
    expect(r.tags).toEqual([{ post_id: untagged, pillar_key: 'p2' }]);
    expect(r.verdict_notes).toHaveLength(1);
    expect(r.rejected.map(x => x.path)).toEqual(['verdict_notes.1', 'tags.1', 'tags.2']);
  });

  it('basics only: basics experiments with a layer and a rate line; the stuck layer cannot be changed', () => {
    expect(basics.mode).toBe('basics_only');
    const diagnosed = basics.diagnostics.posts[0];
    const basicsExperiment = { kind: 'basics', layer: 'hook', hypothesis: '开头是自我介绍，2 秒就走', action: '下 2 条开头用场景+数字',
      metric: 'bounce_2s', target: { max: 0.5 }, match: { pillar_key: 'p1' },
      evidence: { post_ids: [diagnosed.post_id], metrics: [`diagnostics:${diagnosed.post_id}:bounce_2s`] } };
    const r = out({ experiments: [basicsExperiment, basicsExperiment, basicsExperiment, good],
      diagnoses: [{ post_id: diagnosed.post_id, stuck_layer: 'hook', problem_span: '大家好，我是小林', rewrite: ['改写一'] },
        { post_id: diagnosed.post_id, stuck_layer: 'complete', problem_span: 'x', rewrite: ['y'] }] }, basics);
    expect(r.experiments).toHaveLength(2);
    expect(r.diagnoses).toHaveLength(1);
    expect(r.rejected.map(x => `${x.path}:${x.reason}`)).toEqual(['diagnoses.1:stuck_layer_changed', 'experiments.2:too_many',
      'experiments.3:too_many']);
    expect(checkOutput(block({ version: 2, mode: 'full' }), basics).mode_mismatch).toBe(true);
  });
});
