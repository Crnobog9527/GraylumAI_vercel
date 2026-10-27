/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: the model's structured output (```coach_json block after the prose, Skill v2 section 11) checked
 * against the pack it read. A suggestion without evidence from that pack, or outside what this cadence may decide, is
 * dropped item by item; the prose is kept. The model never re-runs for a rejected item.
 */
import { z } from 'zod';
import { isRateMetric } from './funnel';

const DAY7_METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'followers_gained', 'engagement_rate'];
const STAGES = ['starting', 'growing', 'mature'];
const short = (max: number) => z.string().trim().min(1).max(max);
const evidence = z.object({ post_ids: z.array(z.string()).max(10).default([]), metrics: z.array(z.string()).max(10).default([]) });
const experiment = z.object({
  kind: z.enum(['tactic', 'basics', 'pillar_mix']), layer: z.string().nullable().default(null),
  hypothesis: short(300), action: short(300), metric: z.string(),
  target: z.object({ mult: z.number().optional(), max: z.number().optional(), min: z.number().optional() }),
  match: z.object({ pillar_key: z.string(), platform: z.string().optional(), format_tags: z.array(short(24)).max(4).optional() }),
  evidence,
});
const outputSchema = z.object({
  version: z.literal(2), mode: z.enum(['basics_only', 'full']),
  diagnoses: z.array(z.unknown()).default([]), verdict_notes: z.array(z.unknown()).default([]),
  experiments: z.array(z.unknown()).default([]), tags: z.array(z.unknown()).default([]),
  pillar_mix_proposal: z.unknown().nullable().default(null), strategy_proposal: z.unknown().nullable().default(null),
  stage_suggestion: z.string().nullable().default(null),
});
export type CoachExperiment = z.infer<typeof experiment>;

/** The pieces of a pack the checks need (the pack itself is untyped JSON once built). */
type PackView = { mode: string; cadence: string; limits: { experiments_max: number; experiment_kinds: string[];
  strategy_proposal: boolean; pillar_mix_proposal: boolean }; strategy: { pillars: Array<{ key: string }> };
  diagnostics: { posts: Array<{ post_id: string; stuck_layer: string | null; rates: Record<string, number> }> };
  ledger: { to_review: Array<{ id: string; result?: { matched_posts: string[] } }> };
  scoreboard?: Array<{ pillar: string; platform: string }>; history_scoreboard?: Array<{ pillar: string; platform: string }>;
  stage: { followers: Array<{ platform: string }> };
  this_period?: { settled_posts: Array<{ post_id: string }>; too_new: Array<{ post_id: string }> };
  untagged_posts?: Array<{ post_id: string }> };

export type Rejection = { path: string; reason: string };
export type CheckedOutput = { body: string; parsed: boolean; mode_mismatch: boolean; rejected: Rejection[];
  diagnoses: Array<{ post_id: string; stuck_layer: string | null; problem_span: string; rewrite: string[] }>;
  verdict_notes: Array<{ experiment_id: string; note: string }>; experiments: CoachExperiment[];
  tags: Array<{ post_id: string; pillar_key: string }>;
  pillar_mix_proposal: { target: Record<string, number>; evidence: z.infer<typeof evidence> } | null;
  strategy_proposal: { summary: string; evidence: z.infer<typeof evidence> } | null; stage_suggestion: string | null };

const BLOCK = /```coach_json\s*\n([\s\S]*?)\n```\s*$/;

/** The references a model may cite: every post and every number row present in this pack. */
function refs(p: PackView) {
  const posts = new Set([...(p.this_period?.settled_posts ?? []), ...(p.this_period?.too_new ?? []), ...(p.untagged_posts ?? []),
    ...p.diagnostics.posts].map(x => x.post_id).concat(p.ledger.to_review.flatMap(e => e.result?.matched_posts ?? [])));
  const metrics = new Set([...(p.scoreboard ?? []).map(r => `scoreboard:${r.pillar}:${r.platform}`),
    ...(p.history_scoreboard ?? []).map(r => `history:${r.pillar}:${r.platform}`),
    ...p.stage.followers.map(f => `stage:followers:${f.platform}`),
    ...p.diagnostics.posts.flatMap(d => Object.keys(d.rates).map(k => `diagnostics:${d.post_id}:${k}`)),
    ...p.ledger.to_review.map(e => `ledger:${e.id}`), 'stage:posts_8w', 'stage:day7_views_trend']);
  return { posts, metrics };
}

export function checkOutput(text: string, pack: PackView): CheckedOutput {
  const match = BLOCK.exec(text);
  const out: CheckedOutput = { body: (match ? text.slice(0, match.index) : text).trimEnd(), parsed: false, mode_mismatch: false,
    rejected: [], diagnoses: [], verdict_notes: [], experiments: [], tags: [], pillar_mix_proposal: null,
    strategy_proposal: null, stage_suggestion: null };
  if (!match) return { ...out, rejected: [{ path: '', reason: 'no_block' }] };
  let raw: unknown;
  try { raw = JSON.parse(match[1]!); } catch { return { ...out, rejected: [{ path: '', reason: 'json' }] }; }
  const top = outputSchema.safeParse(raw);
  if (!top.success) return { ...out, rejected: [{ path: '', reason: 'shape' }] };
  const o = top.data, reject = (path: string, reason: string) => { out.rejected.push({ path, reason }); };
  out.parsed = true;
  out.mode_mismatch = o.mode !== pack.mode;
  const { posts, metrics } = refs(pack);
  const pillars = new Set(pack.strategy.pillars.map(x => x.key));
  const cited = (e: z.infer<typeof evidence>) => (e.post_ids.length || e.metrics.length)
    && e.post_ids.every(id => posts.has(id)) && e.metrics.every(m => metrics.has(m));
  const diagnosed = new Map(pack.diagnostics.posts.map(d => [d.post_id, d]));
  o.diagnoses.forEach((item, i) => {
    const d = z.object({ post_id: z.string(), stuck_layer: z.string().nullable(), problem_span: short(200),
      rewrite: z.array(short(200)).min(1).max(2) }).safeParse(item);
    if (!d.success) return reject(`diagnoses.${i}`, 'shape');
    const code = diagnosed.get(d.data.post_id);
    if (!code) return reject(`diagnoses.${i}`, 'post_not_diagnosed');
    if (code.stuck_layer !== d.data.stuck_layer) return reject(`diagnoses.${i}`, 'stuck_layer_changed');
    out.diagnoses.push(d.data);
  });
  const reviewable = new Set(pack.ledger.to_review.map(e => e.id));
  o.verdict_notes.forEach((item, i) => {
    const v = z.object({ experiment_id: z.string(), note: short(300) }).safeParse(item);
    if (!v.success || !reviewable.has(v.data.experiment_id)) return reject(`verdict_notes.${i}`, 'not_reviewed');
    out.verdict_notes.push(v.data);
  });
  const usedPillars = new Set<string>();
  o.experiments.forEach((item, i) => {
    const e = experiment.safeParse(item), path = `experiments.${i}`;
    if (!e.success) return reject(path, 'shape');
    const x = e.data, rate = isRateMetric(x.metric);
    if (out.experiments.length >= pack.limits.experiments_max) return reject(path, 'too_many');
    if (!pack.limits.experiment_kinds.includes(x.kind)) return reject(path, 'kind_not_allowed');
    if (!pillars.has(x.match.pillar_key)) return reject(path, 'unknown_pillar');
    // One long-run experiment per pillar per period (tech plan v1); basics experiments are about the opening, not the pillar.
    if (x.kind !== 'basics' && usedPillars.has(x.match.pillar_key)) return reject(path, 'pillar_repeated');
    if (!cited(x.evidence)) return reject(path, 'no_evidence');
    if (x.kind === 'basics' ? !rate || !x.layer || (x.target.max === undefined && x.target.min === undefined)
      : rate || !DAY7_METRICS.includes(x.metric) || x.target.mult === undefined || x.target.mult < 1.1 || x.target.mult > 5)
      return reject(path, 'metric_or_target');
    usedPillars.add(x.match.pillar_key);
    out.experiments.push(x);
  });
  o.tags.forEach((item, i) => {
    const t = z.object({ post_id: z.string(), pillar_key: z.string() }).safeParse(item);
    const untagged = new Set((pack.untagged_posts ?? []).map(p => p.post_id));
    if (!t.success || !untagged.has(t.data.post_id) || !pillars.has(t.data.pillar_key)) return reject(`tags.${i}`, 'not_taggable');
    out.tags.push(t.data);
  });
  if (o.pillar_mix_proposal !== null) {
    const m = z.object({ target: z.record(z.string(), z.number().min(0).max(1)), evidence }).safeParse(o.pillar_mix_proposal);
    const sum = m.success ? Object.values(m.data.target).reduce((a, b) => a + b, 0) : 0;
    if (!pack.limits.pillar_mix_proposal) reject('pillar_mix_proposal', 'not_this_cadence');
    else if (!m.success || Object.keys(m.data.target).some(k => !pillars.has(k)) || Math.abs(sum - 1) > 0.02 || !cited(m.data.evidence))
      reject('pillar_mix_proposal', 'invalid');
    else out.pillar_mix_proposal = m.data;
  }
  if (o.strategy_proposal !== null) {
    const s = z.object({ summary: short(300), evidence }).safeParse(o.strategy_proposal);
    if (!pack.limits.strategy_proposal) reject('strategy_proposal', 'not_this_cadence');
    else if (!s.success || !cited(s.data.evidence)) reject('strategy_proposal', 'invalid');
    else out.strategy_proposal = s.data;
  }
  if (o.stage_suggestion !== null) {
    if (pack.cadence !== 'quarterly' || !STAGES.includes(o.stage_suggestion)) reject('stage_suggestion', 'not_this_cadence');
    else out.stage_suggestion = o.stage_suggestion;
  }
  return out;
}
