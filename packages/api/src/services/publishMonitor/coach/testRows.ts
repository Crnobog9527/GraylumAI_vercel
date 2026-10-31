/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2 test fixture: the simulated dataset as publish_monitor_review_pack_rows would return it after the
 * settle batch, with posts already tagged to their pillars. Tests only; no production code imports it.
 */
import { createHash } from 'node:crypto';
import { freezeBaseline } from './ledger';
import type { Experiment, Fact, PackRows } from './rows';
import type { SimAccount, SimDataset } from './simulatedDataset';
import { DAY_MS, utcDay } from './stats';

/** Stable UUID-shaped ids from dataset keys, so ids are equal across runs. */
export const simId = (key: string) => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function packRowsFor(data: SimDataset, account: SimAccount, options: { now?: number; untagged?: number } = {}): PackRows {
  const now = options.now ?? Date.parse(data.asOf + 'T00:00:00Z');
  const connectedDay = new Map(account.connections.map(c => [c.platform, utcDay(c.connectedOn)]));
  const loadable = account.posts.filter(p => p.visibility !== 'not_imported');
  const settled = loadable.filter(p => Date.parse(p.postedAt) <= now - 7 * DAY_MS);
  const facts: Fact[] = settled.map((p, i) => {
    const truth = account.settled.find(s => s.postKey === p.key)!;
    const late = utcDay(p.postedAt) + 9 < connectedDay.get(p.platform)!;
    const day7 = late ? null : truth.day7, day30 = late || p.postedDaysAgo < 30 ? null : truth.day30;
    const tagged = i >= (options.untagged ?? 0);
    return { postId: simId(p.key), platform: p.platform, postedAt: p.postedAt, title: p.title, url: null,
      pillarKey: tagged ? p.pillarKey : null, pillarSource: tagged ? 'model' : null, formatTags: p.formatTags,
      basis: day30 ? 'day30' : day7 ? 'day7' : truth.cumulativeAtImport ? 'cumulative_at_import' : null,
      day7, day7On: day7 ? new Date(utcDay(p.postedAt) * DAY_MS + 7 * DAY_MS).toISOString().slice(0, 10) : null,
      day30, day30On: day30 ? new Date(utcDay(p.postedAt) * DAY_MS + 30 * DAY_MS).toISOString().slice(0, 10) : null,
      importCumulative: late ? truth.cumulativeAtImport?.metrics ?? null : null,
      importOn: late ? truth.cumulativeAtImport?.on ?? null : null,
      missing: [...(late ? ['day7'] : []), ...(account.snapshots.find(s => s.postKey === p.key)?.missingFields ?? [])] };
  });
  const experiments: Experiment[] = account.experiments.map(e => {
    const match = { pillar_key: e.match.pillarKey, ...(e.match.platform ? { platform: e.match.platform } : {}),
      ...(e.match.formatTags ? { format_tags: e.match.formatTags } : {}) };
    return { id: simId(e.id), proposed_in: simId(e.id + ':run'), kind: e.kind, status: 'running', hypothesis: e.hypothesis,
      action: e.action, metric: e.metric, layer: null, target_mult: e.targetMult, target_line: null, match,
      baseline: freezeBaseline(match, e.metric, facts, e.proposedOn), evidence: { post_ids: [] },
      period_start: e.periodStart, period_end: e.periodEnd, verdict: null, verdict_detail: null, verdict_in: null,
      extended_once: false, user_decision: null, decided_at: null, created_at: e.proposedOn, updated_at: e.proposedOn };
  });
  return {
    profile: { strategyVersionId: simId(account.key + ':strategy'), pillars: account.pillars, pillarsSource: 'user',
      pillarMixTarget: null, strategyCheckedAt: null },
    strategy: { summary: account.label, content: { pillars: account.pillars.map(p => p.name) } },
    accounts: account.connections.map(c => ({ projectId: simId(account.key + c.platform), platform: c.platform, stage: 'starting' })),
    followers: account.connections.filter(c => c.followersProvided).map(c => ({ connectionId: simId(account.key + c.platform + 'c'),
      platform: c.platform, source: c.source, points: account.snapshots.filter(s => !s.postKey && s.platform === c.platform)
        .map(s => ({ date: s.capturedOn, value: s.metrics.followers! })) })),
    facts,
    recent: loadable.filter(p => Date.parse(p.postedAt) > now - 7 * DAY_MS && p.postedDaysAgo <= 14)
      .map(p => ({ postId: simId(p.key), platform: p.platform, postedAt: p.postedAt, title: p.title, pillarKey: null })),
    experiments,
    diagnostics: account.diagnostics.map(d => ({ id: simId(d.postKey + d.capturedOn), postId: simId(d.postKey),
      platform: d.platform, source: d.source, rates: d.rates, openingText: d.openingText, videoSeconds: d.videoSeconds,
      capturedOn: d.capturedOn, reviewRunId: null, dropSecond: d.dropSecond })).toSorted((a, b) => b.capturedOn.localeCompare(a.capturedOn)),
  };
}
