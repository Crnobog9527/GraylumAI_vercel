/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: the single-post funnel diagnosis (tech plan v2 section 4). Code finds the first stuck layer against
 * the platform handbook; the model only explains it and rewrites the sentence. A draft handbook never says "fails":
 * it only compares with the user's own recent posts.
 */
import { z } from 'zod';
import type { Diagnostic } from './rows';
import { median, round } from './stats';

/** Normalized back-office rate keys (tech plan v2 section 2.2). Fractions are 0..1; *_seconds are seconds. */
export const RATE_KEYS = ['impressions_ctr', 'bounce_2s', 'retain_3s', 'retain_5s', 'retain_30s', 'avg_watch_seconds',
  'avg_watch_pct', 'complete_rate', 'like_rate', 'comment_rate', 'save_rate', 'share_rate', 'follow_rate',
  'profile_visit_rate', 'engage_rate'] as const;
/** Counts a back office gives instead of rates (TikTok gives every engagement as a count): code turns them into rates per view. */
export const COUNT_KEYS = ['views', 'likes', 'comments', 'saves', 'shares', 'followers_gained', 'profile_visits'] as const;
const PER_VIEW: Record<string, string> = { likes: 'like_rate', comments: 'comment_rate', saves: 'save_rate', shares: 'share_rate',
  followers_gained: 'follow_rate', profile_visits: 'profile_visit_rate' };
/** The engagement total (Owner 2026-11-04): likes + comments + saves + shares per view, only when all four are known. */
const ENGAGE_PARTS = ['like_rate', 'comment_rate', 'save_rate', 'share_rate'];
const LOWER_IS_BETTER = new Set(['bounce_2s']);
const NOT_FRACTION = new Set<string>(['avg_watch_seconds', ...COUNT_KEYS]);
/** The own "excellent" line (Owner 2026-11-04): the top 20% of the user's own last 10 posts; fewer than 5 is too few to rank. */
const EXCELLENT_MIN_SAMPLES = 5;

const line = z.object({ max: z.number().optional(), min: z.number().optional() }).strict()
  .refine(l => l.max !== undefined || l.min !== undefined);
const layer = z.object({ layer: z.string().regex(/^[a-z0-9_]{1,24}$/), name: z.string().max(40), keys: z.array(z.enum(RATE_KEYS)).min(1),
  /** true for the foundation (hook, early retention, mid retention, completion); false for engagement and follow. */
  basics: z.boolean(), pass: z.record(z.string(), line),
  /** Per video length; null removes the layer's line for that length (no line there: compared with the user's own posts only). */
  by_duration: z.partialRecord(z.enum(['<=15s', '16-60s', '>60s']), z.record(z.string(), line.nullable())).optional(),
  /** Reference lines of single keys inside a layer: a key outside its line is named as the weak one, never judged on its own. */
  low: z.record(z.string(), line).optional() });
export const handbookSchema = z.object({ platform: z.string(), version: z.string(),
  calibration: z.enum(['owner_confirmed', 'draft']), labels: z.record(z.string(), z.enum([...RATE_KEYS, ...COUNT_KEYS])),
  /** Where the lines come from, said as is to the user (e.g. third-party industry experience, not the platform's own standard). */
  source: z.string().max(80).optional(),
  /** Below this many views a post is not diagnosed: its rates are too noisy to judge. */
  min_views: z.number().int().positive().optional(),
  funnel: z.array(layer).min(1) }).passthrough();
export type Handbook = z.infer<typeof handbookSchema>;
type Line = z.infer<typeof line>;

export type LayerResult = { layer: string; name: string; status: 'pass' | 'fail' | 'unknown';
  value: Record<string, number>; line: Record<string, Line> | null; line_status: 'handbook' | 'own_median' | 'none';
  /** Keys of this layer outside their reference line (handbook `low`), present only when there is one. */
  low_keys?: string[] };
export type PostDiagnosis = { post_id: string; diagnostic_id: string; platform: string; captured_on: string;
  rates: Record<string, number>; derived: string[]; opening_text: string | null; video_seconds: number | null;
  drop_second: number | null; stuck_layer: string | null; layer_results: LayerResult[]; inconsistent: string[];
  vs_own_median: Record<string, number>;
  /** Keys at or beyond the top 20% of the user's own last 10 posts on this platform (the own excellent line). */
  own_excellent: string[];
  /** Views below the handbook's min_views: nothing is judged. */
  too_few_views?: true };

const bucket = (seconds: number | null): '<=15s' | '16-60s' | '>60s' | null =>
  seconds === null ? null : seconds <= 15 ? '<=15s' : seconds <= 60 ? '16-60s' : '>60s';
const ok = (value: number, l: Line) => (l.max === undefined || value <= l.max) && (l.min === undefined || value >= l.min);

/**
 * Rates as confirmed, plus what code can derive: rates per view from counts, the engagement total from its four parts, the watch
 * percentage from seconds. Never invents a missing rate, and a rate the back office gave is never replaced by a derived one.
 */
export function withDerived(d: Pick<Diagnostic, 'rates' | 'videoSeconds'>) {
  const rates = { ...d.rates }, derived: string[] = [];
  const set = (key: string, value: number) => { rates[key] = round(value, 4); derived.push(key); };
  const views = rates.views;
  if (views !== undefined && views > 0) {
    for (const [count, rate] of Object.entries(PER_VIEW))
      if (rates[rate] === undefined && rates[count] !== undefined) set(rate, rates[count]! / views);
  }
  if (rates.engage_rate === undefined && ENGAGE_PARTS.every(k => rates[k] !== undefined))
    set('engage_rate', ENGAGE_PARTS.reduce((sum, k) => sum + rates[k]!, 0));
  if (rates.avg_watch_pct === undefined && rates.avg_watch_seconds !== undefined && d.videoSeconds)
    set('avg_watch_pct', Math.min(1, rates.avg_watch_seconds / d.videoSeconds));
  return { rates, derived };
}

/** Whether `value` reaches the top 20% of `own` (direction-aware), or null when there are too few posts to rank. */
function excellent(key: string, value: number, own: number[]): boolean | null {
  if (own.length < EXCELLENT_MIN_SAMPLES) return null;
  // The line is the worst of the best 20% (2 of 10): reaching it puts the post among the user's top fifth.
  const sorted = own.toSorted((a, b) => a - b), top = Math.ceil(sorted.length * 0.2);
  return LOWER_IS_BETTER.has(key) ? value <= sorted[top - 1]! : value >= sorted[sorted.length - top]!;
}

function inconsistencies(rates: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(rates))
    if (!NOT_FRACTION.has(key) && (value < 0 || value > 1)) out.push(`${key}_out_of_range`);
  const { retain_3s: r3, retain_5s: r5, complete_rate: done, bounce_2s: bounce } = rates;
  if (r3 !== undefined && r5 !== undefined && r3 < r5) out.push('retain_3s_below_retain_5s');
  if (r5 !== undefined && done !== undefined && done > r5) out.push('complete_rate_above_retain_5s');
  if (bounce !== undefined && r3 !== undefined && bounce + r3 > 1.05) out.push('bounce_2s_plus_retain_3s_above_1');
  return out;
}

/** history: the user's other confirmed diagnostics on this platform, newest first (the last 10 are used). */
export function diagnosePost(d: Diagnostic, handbook: Handbook | null, history: Diagnostic[]): PostDiagnosis {
  const { rates, derived } = withDerived(d);
  // One entry per other post (its newest capture, history being newest first): repeated captures of one post are not ten posts.
  const others = [...new Map(history.filter(h => h.postId !== d.postId && h.platform === d.platform).reverse().map(h => [h.postId, h] as const))
    .values()].reverse();
  const own = others.slice(0, 10).map(h => withDerived(h).rates);
  const vsOwn: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    const mid = median(own.map(r => r[key]).filter((v): v is number => v !== undefined));
    if (mid && own.length >= 3) vsOwn[key] = round(value / mid, 2);
  }
  const counts: readonly string[] = COUNT_KEYS;
  const tooFew = handbook?.min_views !== undefined && rates.views !== undefined && rates.views < handbook.min_views;
  // Too few views: nothing is judged, not even against the user's own posts.
  const ownExcellent = tooFew ? [] : Object.entries(rates).filter(([key, value]) => !counts.includes(key)
    && excellent(key, value, own.map(r => r[key]).filter((v): v is number => v !== undefined)) === true).map(([key]) => key);
  const calibrated = handbook?.calibration === 'owner_confirmed' && !tooFew;
  const ownLine = (value: Record<string, number>) => Object.keys(value).some(k => k in vsOwn) ? 'own_median' as const : 'none' as const;
  const results: LayerResult[] = (handbook?.funnel ?? []).map(l => {
    const value = Object.fromEntries(l.keys.filter(k => rates[k] !== undefined).map(k => [k, rates[k]!]));
    if (!Object.keys(value).length) return { layer: l.layer, name: l.name, status: 'unknown', value, line: null, line_status: 'none' };
    if (!calibrated) return { layer: l.layer, name: l.name, status: 'unknown', value, line: null, line_status: ownLine(value) };
    const length = bucket(d.videoSeconds);
    const merged = { ...l.pass, ...(length ? l.by_duration?.[length] ?? {} : {}) };
    const lines = Object.fromEntries(Object.entries(merged).filter((e): e is [string, Line] => e[1] !== null));
    const lowKeys = l.low ? Object.entries(value).filter(([k, v]) => l.low![k] && !ok(v, l.low![k]!)).map(([k]) => k) : undefined;
    const extra = lowKeys ? { low_keys: lowKeys } : {};
    const judged = Object.entries(value).filter(([k]) => lines[k]);
    if (!judged.length) return { layer: l.layer, name: l.name, status: 'unknown', value, line: null, line_status: ownLine(value), ...extra };
    return { layer: l.layer, name: l.name, status: judged.every(([k, v]) => ok(v, lines[k]!)) ? 'pass' : 'fail', value,
      line: Object.fromEntries(judged.map(([k]) => [k, lines[k]!])), line_status: 'handbook', ...extra };
  });
  return { post_id: d.postId, diagnostic_id: d.id, platform: d.platform, captured_on: d.capturedOn, rates, derived,
    opening_text: d.openingText, video_seconds: d.videoSeconds, drop_second: d.dropSecond ?? null,
    stuck_layer: results.find(r => r.status === 'fail')?.layer ?? null, layer_results: results,
    inconsistent: inconsistencies(rates), vs_own_median: vsOwn, own_excellent: ownExcellent, ...(tooFew ? { too_few_views: true as const } : {}) };
}

/**
 * Basics pass when most diagnosed posts (2 of 3, 2 of 2, or the only one) have no failing foundation layer. Null when no
 * post could be judged against a confirmed handbook line: the review then runs in full mode and says the rates are missing.
 */
export function basicsPass(posts: PostDiagnosis[], handbooks: Map<string, Handbook>): boolean | null {
  const judged = posts.map(p => {
    const basics = new Set((handbooks.get(p.platform)?.funnel ?? []).filter(l => l.basics).map(l => l.layer));
    const results = p.layer_results.filter(r => basics.has(r.layer) && r.status !== 'unknown');
    return results.length ? results.every(r => r.status === 'pass') : null;
  }).filter((v): v is boolean => v !== null);
  if (!judged.length) return null;
  return judged.filter(Boolean).length * 2 > judged.length;
}

export const isRateMetric = (metric: string) => (RATE_KEYS as readonly string[]).includes(metric);
export const lowerIsBetter = (metric: string) => LOWER_IS_BETTER.has(metric);
