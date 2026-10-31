/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: the experiment ledger's verdicts, decided by code (tech plan v1 section 5, v2 for rate metrics).
 * The model may explain a verdict, never change it. Baselines are frozen when an experiment is proposed.
 */
import { isRateMetric } from './funnel';
import type { Diagnostic, Experiment, Fact } from './rows';
import { platformShift } from './scoreboard';
import { DAY_MS, DEFAULT_TARGET_MULT, FAILED_AT_OR_BELOW, LOW_VOLUME_PER_WEEK, MIN_SAMPLES, day7Metric, median, round,
  utcDay } from './stats';

export type Match = Experiment['match'];
export type Verdict = 'worked' | 'failed' | 'inconclusive' | 'not_run';
export type Conclusion = { verdict: Verdict; reason: string | null; lean: 'positive' | 'negative' | null;
  matched_posts: string[]; samples: number; median: number | null; vs_baseline: number | null;
  next_status: 'concluded' | 'extended' };

export function matches(match: Match, fact: Pick<Fact, 'pillarKey' | 'platform' | 'formatTags'>) {
  return fact.pillarKey === match.pillar_key && (!match.platform || match.platform === fact.platform)
    && (match.format_tags ?? []).every(tag => fact.formatTags.includes(tag));
}

/** Median of the same pillar (and platform) over the 8 weeks before proposal, without posts already doing the change. */
export function freezeBaseline(match: Match, metric: string, facts: Fact[], proposedOn: string) {
  const end = utcDay(proposedOn), start = end - 56;
  const tags = match.format_tags ?? [];
  const values = facts.filter(f => f.pillarKey === match.pillar_key && (!match.platform || f.platform === match.platform)
    && !(tags.length && tags.every(t => f.formatTags.includes(t))) && utcDay(f.postedAt) >= start && utcDay(f.postedAt) < end)
    .map(f => day7Metric(f, metric)).filter((v): v is number => v !== null);
  const mid = median(values);
  return mid === null ? null : { metric, median: round(mid, 4), samples: values.length, window_weeks: 8, basis: 'day7' };
}

const inPeriod = (iso: string, e: Pick<Experiment, 'period_start' | 'period_end'>) =>
  utcDay(iso) >= utcDay(e.period_start) && utcDay(iso) <= utcDay(e.period_end);

/** Posts per week on the experiment's platform(s) over the 8 weeks up to the period end. */
function weeklyRate(e: Experiment, facts: Fact[]) {
  const end = utcDay(e.period_end) + 1;
  return facts.filter(f => (!e.match.platform || f.platform === e.match.platform)
    && utcDay(f.postedAt) >= end - 56 && utcDay(f.postedAt) < end).length / 8;
}

function decide(e: Experiment, matched: string[], values: number[], extra: { shift: boolean; lowVolume: boolean;
  meets: (value: number) => boolean | null; ratio: number | null }): Conclusion {
  const mid = median(values);
  const base = { matched_posts: matched, samples: values.length, median: mid === null ? null : round(mid, 4),
    vs_baseline: extra.ratio === null ? null : round(extra.ratio, 2), lean: null as Conclusion['lean'] };
  const finish = (verdict: Verdict, reason: string | null, lean: Conclusion['lean'] = null): Conclusion => ({ ...base, verdict,
    reason, lean, next_status: verdict === 'inconclusive' && !e.extended_once && matched.length > 0 ? 'extended' : 'concluded' });
  if (extra.shift) return finish('inconclusive', 'platform_shift');
  if (!matched.length) return finish('not_run', null);
  const meets = mid === null ? null : extra.meets(mid);
  const lean = meets === true ? 'positive' : extra.ratio !== null && extra.ratio <= FAILED_AT_OR_BELOW ? 'negative' : null;
  if (values.length < MIN_SAMPLES) {
    if (extra.lowVolume && values.length >= 2) return finish('inconclusive', 'low_volume', lean);
    return finish('inconclusive', 'samples_lt_3');
  }
  if (meets) return finish('worked', null);
  if (extra.ratio !== null && extra.ratio <= FAILED_AT_OR_BELOW) return finish('failed', null);
  if (meets === false && e.target_line) return finish('failed', null);
  return finish('inconclusive', 'within_noise');
}

/** Day-7 experiments (views, engagement_rate, ...) are settled on facts; rate experiments on confirmed diagnostics. */
export function conclude(e: Experiment, facts: Fact[], diagnostics: Diagnostic[]): Conclusion {
  const matchedFacts = facts.filter(f => matches(e.match, f) && inPeriod(f.postedAt, e));
  const platforms = e.match.platform ? [e.match.platform] : [...new Set(matchedFacts.map(f => f.platform))];
  const treated = new Set(matchedFacts.map(f => f.postId));
  const shift = platforms.some(p => platformShift(facts, p, utcDay(e.period_start), utcDay(e.period_end), treated).detected);
  const lowVolume = weeklyRate(e, facts) < LOW_VOLUME_PER_WEEK;
  const line = e.target_line;
  const meetsLine = (value: number) => line ? (line.max === undefined || value <= line.max)
    && (line.min === undefined || value >= line.min) : null;
  const isRate = e.layer !== null || isRateMetric(e.metric);
  if (isRate) {
    const byPost = new Map(facts.map(f => [f.postId, f]));
    const rows = diagnostics.filter(d => inPeriod(d.capturedOn + 'T00:00:00Z', e) && e.metric in d.rates
      && (() => { const f = byPost.get(d.postId); return !f || matches(e.match, f); })());
    const baseline = e.baseline?.median ?? null;
    const values = rows.map(d => d.rates[e.metric]!);
    const mid = median(values);
    const ratio = mid !== null && baseline ? mid / baseline : null;
    // Rates are judged against their handbook line; no line means only a lean, never a verdict by ratio.
    return decide(e, rows.map(d => d.postId), values, { shift: false, lowVolume, meets: v => meetsLine(v) ?? false,
      ratio: line ? null : ratio });
  }
  const values = matchedFacts.map(f => day7Metric(f, e.metric)).filter((v): v is number => v !== null);
  const mid = median(values);
  const baseline = e.baseline?.median ?? null;
  const ratio = mid !== null && baseline ? mid / baseline : null;
  const target = e.target_mult ?? DEFAULT_TARGET_MULT;
  return decide(e, matchedFacts.map(f => f.postId), values, { shift, lowVolume,
    meets: () => (line ? meetsLine(mid!) : ratio === null ? null : ratio >= target), ratio });
}

/** Ledger rows for the pack: what to review now, what still runs, and the latest concluded. */
export function ledgerView(experiments: Experiment[], facts: Fact[], diagnostics: Diagnostic[], now: number) {
  const today = Math.floor(now / DAY_MS);
  const open = experiments.filter(e => ['proposed', 'running', 'extended'].includes(e.status) && e.user_decision !== 'declined');
  const brief = (e: Experiment) => ({ id: e.id, kind: e.kind, hypothesis: e.hypothesis, action: e.action, metric: e.metric,
    layer: e.layer, target_mult: e.target_mult, target_line: e.target_line, match: e.match, baseline: e.baseline,
    period: { start: e.period_start, end: e.period_end } });
  return {
    to_review: open.filter(e => utcDay(e.period_end) < today).map(e => ({ ...brief(e), result: conclude(e, facts, diagnostics) })),
    running: open.filter(e => utcDay(e.period_end) >= today).map(brief),
    recent_concluded: experiments.filter(e => e.status === 'concluded').slice(0, 6)
      .map(e => ({ id: e.id, verdict: e.verdict, hypothesis: e.hypothesis, concluded_on: e.updated_at.slice(0, 10) })),
  };
}
