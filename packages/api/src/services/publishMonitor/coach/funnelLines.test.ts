/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { diagnosePost, handbookSchema, withDerived, type Handbook } from './funnel';
import type { Diagnostic } from './rows';

/** Placeholder numbers for tests only; the real handbook lines live in the private Skill package. */
const HANDBOOK: Handbook = handbookSchema.parse({
  platform: 'douyin', version: 'test', calibration: 'owner_confirmed', source: 'test source', min_views: 100,
  labels: { '2s跳出率': 'bounce_2s', '均播时长': 'avg_watch_seconds', Likes: 'likes', 'Video views': 'views' },
  funnel: [
    { layer: 'hook', name: '开头', keys: ['bounce_2s'], basics: true, pass: { bounce_2s: { max: 0.4 } } },
    { layer: 'complete', name: '完播', keys: ['complete_rate'], basics: true, pass: { complete_rate: { min: 0.25 } },
      by_duration: { '>60s': { complete_rate: null } } },
    { layer: 'engage', name: '互动', keys: ['engage_rate', 'like_rate', 'comment_rate', 'save_rate', 'share_rate'], basics: false,
      pass: { engage_rate: { min: 0.03 } },
      low: { like_rate: { min: 0.01 }, comment_rate: { min: 0.001 }, save_rate: { min: 0.005 }, share_rate: { min: 0.001 } } },
  ],
});
let n = 0;
const post = (rates: Record<string, number>, videoSeconds: number | null = 30): Diagnostic => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, postId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  platform: 'douyin', source: 'screenshot', rates, openingText: null, videoSeconds, capturedOn: '2026-11-04', reviewRunId: null, dropSecond: null });
const layer = (d: ReturnType<typeof diagnosePost>, name: string) => d.layer_results.find(r => r.layer === name)!;

describe('derived rates (Owner 2026-11-04)', () => {
  it('counts become rates per view; a rate the back office gave is kept as given', () => {
    const { rates, derived } = withDerived({ rates: { views: 1000, likes: 50, comments: 2, saves: 8, shares: 3, like_rate: 0.06 }, videoSeconds: null });
    expect(rates).toMatchObject({ like_rate: 0.06, comment_rate: 0.002, save_rate: 0.008, share_rate: 0.003 });
    expect(derived).not.toContain('like_rate');
  });

  it('the engagement total is the four parts added, only when all four are known (missing is not zero)', () => {
    expect(withDerived({ rates: { like_rate: 0.02, comment_rate: 0.002, save_rate: 0.005, share_rate: 0.003 }, videoSeconds: null }).rates.engage_rate)
      .toBe(0.03);
    expect(withDerived({ rates: { like_rate: 0.02, comment_rate: 0.002, share_rate: 0.003 }, videoSeconds: null }).rates.engage_rate).toBeUndefined();
  });

  it('counts are not checked as fractions', () => {
    expect(diagnosePost(post({ views: 5000, likes: 200, bounce_2s: 0.3 }), HANDBOOK, []).inconsistent).toEqual([]);
  });
});

describe('handbook lines', () => {
  it('a length band can remove a line: past 60 seconds completion is compared with the user\'s own posts only', () => {
    const short = diagnosePost(post({ complete_rate: 0.1 }, 45), HANDBOOK, []);
    expect(layer(short, 'complete')).toMatchObject({ status: 'fail', line_status: 'handbook' });
    const long = diagnosePost(post({ complete_rate: 0.1 }, 120), HANDBOOK, []);
    expect(layer(long, 'complete')).toMatchObject({ status: 'unknown', line: null });
    expect(long.stuck_layer).toBeNull();
  });

  it('the engagement layer is judged on the total; a weak part is named, never failed on its own', () => {
    const d = diagnosePost(post({ views: 1000, likes: 30, comments: 0, saves: 2, shares: 3 }), HANDBOOK, []);
    expect(layer(d, 'engage')).toMatchObject({ status: 'pass', line: { engage_rate: { min: 0.03 } } });
    expect(layer(d, 'engage').low_keys).toEqual(['comment_rate', 'save_rate']);
    const low = diagnosePost(post({ like_rate: 0.01, comment_rate: 0.001, save_rate: 0.005, share_rate: 0.001 }), HANDBOOK, []);
    expect(layer(low, 'engage').status).toBe('fail');
  });

  it('too few views: nothing is judged against a line', () => {
    const d = diagnosePost(post({ views: 40, bounce_2s: 0.9 }), HANDBOOK, []);
    expect(d.too_few_views).toBe(true);
    expect(layer(d, 'hook').status).toBe('unknown');
    expect(d.stuck_layer).toBeNull();
    expect(diagnosePost(post({ views: 400, bounce_2s: 0.9 }), HANDBOOK, []).stuck_layer).toBe('hook');
  });

  it('labels may name counts as well as rates; an unknown key is refused', () => {
    expect(HANDBOOK.labels.Likes).toBe('likes');
    expect(() => handbookSchema.parse({ ...HANDBOOK, labels: { x: 'not_a_key' } })).toThrow();
  });
});

describe('the own excellent line (top 20% of the last 10)', () => {
  const history = [0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.3, 0.35, 0.4].map(v => post({ complete_rate: v, bounce_2s: 1 - v - 0.1 }));

  it('a value at or beyond the 80th percentile of the user\'s own posts is excellent, direction-aware', () => {
    const top = diagnosePost(post({ complete_rate: 0.36, bounce_2s: 0.2 }), HANDBOOK, history);
    expect(top.own_excellent.sort()).toEqual(['bounce_2s', 'complete_rate']);
    const middle = diagnosePost(post({ complete_rate: 0.22, bounce_2s: 0.6 }), HANDBOOK, history);
    expect(middle.own_excellent).toEqual([]);
  });

  it('repeated captures of one post count once, and the post\'s own other captures are not its history', () => {
    const repeated = [0.1, 0.12, 0.15, 0.18, 0.2].map(v => ({ ...post({ complete_rate: v }), postId: '20000000-0000-4000-8000-000000000001' }));
    expect(diagnosePost(post({ complete_rate: 0.9 }), HANDBOOK, repeated).own_excellent).toEqual([]);
    const current = post({ complete_rate: 0.5 });
    const self = history.slice(0, 5).map(h => ({ ...h, postId: current.postId }));
    expect(diagnosePost(current, HANDBOOK, [...self, ...history.slice(5, 9)]).own_excellent).toEqual([]);
  });

  it('the ten posts are the ten newest posts, each by its newest capture, even when a recent post also has an older capture', () => {
    const recentNew = { ...post({ complete_rate: 0.9 }), postId: '30000000-0000-4000-8000-000000000001' };
    const recentOld = { ...post({ complete_rate: 0.1 }), postId: recentNew.postId };
    const rest = [0.8, ...Array(9).fill(0.1)].map(v => post({ complete_rate: v }));
    const newestFirst = [recentNew, ...rest, recentOld];
    // The ten newest posts are A (0.9) and the first nine of the rest (0.8 and eight 0.1s): 0.5 is below the top fifth (>= 0.8).
    expect(diagnosePost(post({ complete_rate: 0.5 }), HANDBOOK, newestFirst).own_excellent).toEqual([]);
  });

  it('too few views: no excellent mark either', () => {
    expect(diagnosePost(post({ views: 10, complete_rate: 0.9 }), HANDBOOK, history).own_excellent).toEqual([]);
  });

  it('fewer than five own posts: no excellent line', () => {
    expect(diagnosePost(post({ complete_rate: 0.9 }), HANDBOOK, history.slice(0, 4)).own_excellent).toEqual([]);
  });
});
