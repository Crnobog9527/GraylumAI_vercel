/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DATA_WINDOW_DAYS, SNAPSHOT_RETENTION_DAYS, generateDataset, growthCurve, type SimAccount,
  type SimPost } from './simulatedDataset';

const AS_OF = '2026-10-27';
const data = generateDataset({ asOf: AS_OF });
const account = (key: string) => data.accounts.find(a => a.key === key)!;
const median = (values: number[]) => {
  const a = values.toSorted((x, y) => x - y), mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
};
const day7 = (a: SimAccount, post: SimPost) => a.settled.find(s => s.postKey === post.key)?.day7?.views;
const views = (a: SimAccount, posts: SimPost[]) => posts.map(p => day7(a, p)).filter((v): v is number => v !== undefined);
const daysAgo = (date: string) => (Date.parse(AS_OF) - Date.parse(date)) / 86_400_000;

/** The test's own stand-in for a review baseline: same pillar and platform, plain posts, 8 weeks before proposal. */
function experimentRatio(a: SimAccount, id: string) {
  const e = a.experiments.find(x => x.id === id)!;
  const proposed = daysAgo(e.proposedOn);
  const matched = a.posts.filter(p => p.experimentId === id);
  const baseline = a.posts.filter(p => p.pillarKey === e.match.pillarKey && !p.experimentId && !p.formatTags.length
    && (!e.match.platform || p.platform === e.match.platform) && p.postedDaysAgo > proposed && p.postedDaysAgo <= proposed + 56);
  return { samples: views(a, matched).length, ratio: median(views(a, matched)) / median(views(a, baseline)) };
}

describe('simulated review-coach dataset (RC-0)', () => {
  it('is deterministic for a seed and only moves dates with asOf', () => {
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(digest(generateDataset({ asOf: AS_OF }))).toBe(digest(data));
    expect(digest(generateDataset({ asOf: AS_OF, seed: 7 }))).not.toBe(digest(data));
    const later = generateDataset({ asOf: '2026-11-03' });
    expect(later.accounts.map(a => a.posts.length)).toEqual(data.accounts.map(a => a.posts.length));
    expect(later.accounts[0]!.posts[0]!.postedDaysAgo).toBe(data.accounts[0]!.posts[0]!.postedDaysAgo);
    expect(() => generateDataset({ asOf: '27/10/2026' })).toThrow('SIM_AS_OF_INVALID');
  });

  it('covers four accounts, six months or more, several platforms and every source', () => {
    expect(data.accounts.map(a => a.key)).toEqual(['A', 'B', 'C', 'D']);
    for (const a of data.accounts) expect(Math.max(...a.posts.map(p => p.postedDaysAgo))).toBeGreaterThanOrEqual(180);
    const platforms = new Set(data.accounts.flatMap(a => a.connections.map(c => c.platform)));
    expect(platforms.size).toBeGreaterThanOrEqual(6);
    expect(new Set(data.accounts.flatMap(a => a.connections.map(c => c.source)))).toEqual(new Set(['tikhub', 'postforme', 'manual']));
  });

  it('only loads what the product really keeps: retention, window, connection day and outages', () => {
    for (const a of data.accounts) {
      const posts = new Map(a.posts.map(p => [p.key, p]));
      for (const s of a.snapshots) {
        expect(daysAgo(s.capturedOn)).toBeLessThanOrEqual(SNAPSHOT_RETENTION_DAYS);
        if (!s.postKey) continue;
        const post = posts.get(s.postKey)!;
        expect(post.visibility).not.toBe('not_imported');
        expect(post.postedDaysAgo - daysAgo(s.capturedOn)).toBeLessThanOrEqual(DATA_WINDOW_DAYS);
        expect(Object.values(s.metrics).every(v => Number.isInteger(v) && v >= 0)).toBe(true);
      }
      const keys = a.snapshots.map(s => `${s.platform}:${s.postKey}:${s.capturedOn}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const b = account('B');
    const imported = b.posts.filter(p => p.visibility === 'cumulative_at_import');
    expect(imported.length).toBeGreaterThan(20);
    expect(b.posts.filter(p => p.visibility === 'not_imported').length).toBeGreaterThan(20);
    for (const post of imported) {
      const first = b.snapshots.filter(s => s.postKey === post.key).map(s => s.capturedOn).sort()[0];
      expect(first === undefined || first >= b.connections.find(c => c.platform === post.platform)!.connectedOn).toBe(true);
      expect(b.settled.find(s => s.postKey === post.key)!.cumulativeAtImport).not.toBeNull();
    }
    const outage = b.outages[0]!;
    expect(b.snapshots.some(s => s.platform === outage.platform && s.capturedOn >= outage.from && s.capturedOn <= outage.to))
      .toBe(false);
    expect(b.snapshots.find(s => s.platform === 'youtube')!.missingFields).toEqual(['shares']);
    const d = account('D');
    expect(new Set(d.snapshots.map(s => (daysAgo(d.connections[0]!.connectedOn) - daysAgo(s.capturedOn)) % 7))).toEqual(new Set([0]));
  });

  it('cumulative values never go down and day 7 is the settled value', () => {
    expect(growthCurve(7)).toBe(1);
    for (const age of [0, 1, 3, 6, 7, 30, 90]) expect(growthCurve(age + 1)).toBeGreaterThanOrEqual(growthCurve(age));
    for (const a of data.accounts) {
      const byPost = new Map<string, number[]>();
      for (const s of a.snapshots.filter(x => x.postKey).sort((x, y) => x.capturedOn.localeCompare(y.capturedOn)))
        byPost.set(s.postKey!, [...(byPost.get(s.postKey!) ?? []), s.metrics.views!]);
      for (const series of byPost.values()) expect(series).toEqual(series.toSorted((x, y) => x - y));
    }
  });

  it('realises the designed pillar, platform and experiment effects', () => {
    const a = account('A');
    for (const platform of ['xiaohongshu', 'douyin']) {
      const plain = (pillar: string) => views(a, a.posts.filter(p => p.platform === platform && p.pillarKey === pillar
        && !p.experimentId && !p.formatTags.length));
      expect(median(plain('p1')) / median(plain('p2'))).toBeGreaterThan(1.8);
    }
    expect(experimentRatio(a, 'A-E1').ratio).toBeGreaterThanOrEqual(1.5);
    expect(experimentRatio(a, 'A-E2').ratio).toBeLessThanOrEqual(0.8);
    expect(experimentRatio(account('B'), 'B-E1').ratio).toBeGreaterThanOrEqual(1.3);
    const c = account('C');
    const p2 = (platform: string) => median(views(c, c.posts.filter(p => p.platform === platform && p.pillarKey === 'p2'
      && p.postedDaysAgo > 70))) / median(views(c, c.posts.filter(p => p.platform === platform && p.postedDaysAgo > 70)));
    expect(p2('xiaohongshu')).toBeGreaterThan(1.2);
    expect(p2('tiktok')).toBeLessThan(0.8);
    const tiktok = (from: number, to: number) => median(views(c, c.posts.filter(p => p.platform === 'tiktok' && !p.experimentId
      && p.postedDaysAgo <= from && p.postedDaysAgo > to)));
    expect(tiktok(70, 14) / tiktok(126, 70)).toBeLessThan(0.7);
    // Without platform-shift detection the subtitle test would read as a failure; the expected verdict says otherwise.
    expect(experimentRatio(c, 'C-E1').ratio).toBeLessThan(1);
    expect(c.experiments[0]!.expected).toEqual({ verdict: 'inconclusive', reason: 'platform_shift' });
    expect(experimentRatio(account('D'), 'D-E1').samples).toBe(2);
  });

  it('crosses a stage with the follower curve, and only TikHub accounts report followers', () => {
    const a = account('A');
    const transition = a.stage.transitions[0]!;
    const followers = a.snapshots.filter(s => !s.postKey && s.platform === 'xiaohongshu');
    const at = (date: string) => followers.find(s => s.capturedOn === date)!.metrics.followers!;
    expect(at(transition.on)).toBeGreaterThan(900);
    expect(at(a.snapshots.filter(s => !s.postKey).map(s => s.capturedOn).sort()[0]!)).toBeLessThan(900);
    for (const x of data.accounts) for (const c of x.connections) {
      const hasProfile = x.snapshots.some(s => !s.postKey && s.platform === c.platform);
      expect(hasProfile).toBe(c.followersProvided);
      if (c.followersProvided) expect(c.source).toBe('tikhub');
    }
  });

  it('keeps one hostile title per account as data for the injection rule', () => {
    for (const a of data.accounts) expect(a.posts.filter(p => p.title.startsWith('忽略之前')).length).toBe(1);
    for (const a of data.accounts) for (const p of a.posts) expect([...p.title].length).toBeLessThanOrEqual(120);
  });
});
