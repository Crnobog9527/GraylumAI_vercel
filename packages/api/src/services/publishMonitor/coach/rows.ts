/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: the rows publish_monitor_review_pack_rows returns (migration 0407), parsed strictly enough that a
 * changed database shape fails loudly instead of quietly feeding the model wrong numbers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metrics = z.record(z.string(), z.number());

export const factSchema = z.object({
  postId: uuid, platform: z.string(), postedAt: z.string(), title: z.string().nullable(), url: z.string().nullable(),
  pillarKey: z.string().nullable(), pillarSource: z.enum(['item', 'model', 'user']).nullable(), formatTags: z.array(z.string()),
  basis: z.enum(['day7', 'day30', 'cumulative_at_import']).nullable(),
  day7: metrics.nullable(), day7On: day.nullable(), day30: metrics.nullable(), day30On: day.nullable(),
  importCumulative: metrics.nullable(), importOn: day.nullable(), missing: z.array(z.string()),
});
export type Fact = z.infer<typeof factSchema>;

export const experimentSchema = z.object({
  id: uuid, proposed_in: uuid, kind: z.enum(['tactic', 'basics', 'pillar_mix', 'strategy']),
  status: z.enum(['proposed', 'running', 'declined', 'concluded', 'extended']),
  hypothesis: z.string(), action: z.string(), metric: z.string(), layer: z.string().nullable(),
  target_mult: z.union([z.number(), z.string()]).nullable().transform(v => (v === null ? null : Number(v))),
  target_line: z.object({ max: z.number().optional(), min: z.number().optional() }).nullable(),
  match: z.object({ pillar_key: z.string(), platform: z.string().optional(), format_tags: z.array(z.string()).optional() }),
  baseline: z.object({ metric: z.string(), median: z.number(), samples: z.number(), window_weeks: z.number(),
    basis: z.string() }).nullable(),
  evidence: z.record(z.string(), z.unknown()),
  period_start: day, period_end: day,
  verdict: z.enum(['worked', 'failed', 'inconclusive', 'not_run']).nullable(),
  verdict_detail: z.record(z.string(), z.unknown()).nullable(), verdict_in: uuid.nullable(), extended_once: z.boolean(),
  user_decision: z.enum(['accepted', 'declined']).nullable(), decided_at: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
});
export type Experiment = z.infer<typeof experimentSchema>;

export const diagnosticSchema = z.object({
  id: uuid, postId: uuid, platform: z.string(), source: z.enum(['screenshot', 'manual']), rates: metrics,
  openingText: z.string().nullable(), videoSeconds: z.number().int().nullable(), capturedOn: day,
  reviewRunId: uuid.nullable(), dropSecond: z.number().int().nullable(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const pillarSchema = z.object({ key: z.string(), name: z.string(), definition: z.string() });
export type Pillar = z.infer<typeof pillarSchema>;

export const packRowsSchema = z.object({
  profile: z.object({ strategyVersionId: uuid.nullable(), pillars: z.array(pillarSchema),
    pillarsSource: z.enum(['extracted', 'user']).nullable(), pillarMixTarget: z.record(z.string(), z.number()).nullable(),
    strategyCheckedAt: z.string().nullable() }).nullable(),
  strategy: z.record(z.string(), z.unknown()).nullable(),
  accounts: z.array(z.object({ projectId: uuid, platform: z.string(), stage: z.string() })),
  followers: z.array(z.object({ connectionId: uuid, platform: z.string(), source: z.string(),
    points: z.array(z.object({ date: day, value: z.number() })) })),
  facts: z.array(factSchema),
  /** Own posts of the last 14 days not settled yet (too new to judge; counted and listed only). */
  recent: z.array(z.object({ postId: uuid, platform: z.string(), postedAt: z.string(), title: z.string().nullable(),
    pillarKey: z.string().nullable() })),
  experiments: z.array(experimentSchema),
  diagnostics: z.array(diagnosticSchema),
});
export type PackRows = z.infer<typeof packRowsSchema>;

/** One round trip; never refreshes a provider and never reads beyond the owner's brand. */
export async function readPackRows(db: Pick<SupabaseClient, 'rpc'>, actor: string, businessId: string, weeks: number) {
  const result = await db.rpc('publish_monitor_review_pack_rows', { a: uuid.parse(actor), p_business_id: uuid.parse(businessId),
    p_weeks: weeks });
  if (result.error) throw new Error('PUBLISH_MONITOR_REVIEW_PACK_UNAVAILABLE');
  return packRowsSchema.parse(result.data);
}
