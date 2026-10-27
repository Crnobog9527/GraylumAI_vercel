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
  'profile_visit_rate'] as const;
const LOWER_IS_BETTER = new Set(['bounce_2s']);
const NOT_FRACTION = new Set(['avg_watch_seconds']);

const line = z.object({ max: z.number().optional(), min: z.number().optional() }).strict()
  .refine(l => l.max !== undefined || l.min !== undefined);
const layer = z.object({ layer: z.string().regex(/^[a-z0-9_]{1,24}$/), name: z.string().max(40), keys: z.array(z.enum(RATE_KEYS)).min(1),
  /** true for the foundation (hook, early retention, mid retention, completion); false for engagement and follow. */
  basics: z.boolean(), pass: z.record(z.string(), line),
  by_duration: z.partialRecord(z.enum(['<=15s', '16-60s', '>60s']), z.record(z.string(), line)).optional() });
export const handbookSchema = z.object({ platform: z.string(), version: z.string(),
  calibration: z.enum(['owner_confirmed', 'draft']), labels: z.record(z.string(), z.enum(RATE_KEYS)),
  funnel: z.array(layer).min(1) }).passthrough();
export type Handbook = z.infer<typeof handbookSchema>;
type Line = z.infer<typeof line>;

export type LayerResult = { layer: string; name: string; status: 'pass' | 'fail' | 'unknown';
  value: Record<string, number>; line: Record<string, Line> | null; line_status: 'handbook' | 'own_median' | 'none' };
export type PostDiagnosis = { post_id: string; diagnostic_id: string; platform: string; captured_on: string;
  rates: Record<string, number>; derived: string[]; opening_text: string | null; video_seconds: number | null;
  drop_second: number | null; stuck_layer: string | null; layer_results: LayerResult[]; inconsistent: string[];
  vs_own_median: Record<string, number> };

const bucket = (seconds: number | null): '<=15s' | '16-60s' | '>60s' | null =>
  seconds === null ? null : seconds <= 15 ? '<=15s' : seconds <= 60 ? '16-60s' : '>60s';
const ok = (value: number, l: Line) => (l.max === undefined || value <= l.max) && (l.min === undefined || value >= l.min);

/** Rates as confirmed, plus what code can derive (watch percentage from seconds); never invents a missing rate. */
export function withDerived(d: Pick<Diagnostic, 'rates' | 'videoSeconds'>) {
  const rates = { ...d.rates }, derived: string[] = [];
  if (rates.avg_watch_pct === undefined && rates.avg_watch_seconds !== undefined && d.videoSeconds) {
    rates.avg_watch_pct = round(Math.min(1, rates.avg_watch_seconds / d.videoSeconds), 4);
    derived.push('avg_watch_pct');
  }
  return { rates, derived };
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
  const own = history.filter(h => h.id !== d.id && h.platform === d.platform).slice(0, 10).map(h => withDerived(h).rates);
  const vsOwn: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    const mid = median(own.map(r => r[key]).filter((v): v is number => v !== undefined));
    if (mid && own.length >= 3) vsOwn[key] = round(value / mid, 2);
  }
  const calibrated = handbook?.calibration === 'owner_confirmed';
  const results: LayerResult[] = (handbook?.funnel ?? []).map(l => {
    const value = Object.fromEntries(l.keys.filter(k => rates[k] !== undefined).map(k => [k, rates[k]!]));
    if (!Object.keys(value).length) return { layer: l.layer, name: l.name, status: 'unknown', value, line: null, line_status: 'none' };
    if (!calibrated) {
      return { layer: l.layer, name: l.name, status: 'unknown', value, line: null,
        line_status: Object.keys(value).some(k => k in vsOwn) ? 'own_median' : 'none' };
    }
    const length = bucket(d.videoSeconds);
    const lines = { ...l.pass, ...(length ? l.by_duration?.[length] ?? {} : {}) };
    const judged = Object.entries(value).filter(([k]) => lines[k]);
    if (!judged.length) return { layer: l.layer, name: l.name, status: 'unknown', value, line: null, line_status: 'none' };
    return { layer: l.layer, name: l.name, status: judged.every(([k, v]) => ok(v, lines[k]!)) ? 'pass' : 'fail', value,
      line: Object.fromEntries(judged.map(([k]) => [k, lines[k]!])), line_status: 'handbook' };
  });
  return { post_id: d.postId, diagnostic_id: d.id, platform: d.platform, captured_on: d.capturedOn, rates, derived,
    opening_text: d.openingText, video_seconds: d.videoSeconds, drop_second: d.dropSecond ?? null,
    stuck_layer: results.find(r => r.status === 'fail')?.layer ?? null, layer_results: results,
    inconsistent: inconsistencies(rates), vs_own_median: vsOwn };
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
