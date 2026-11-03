/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-3b: what a delivered brand review leaves in the ledger. Verdicts are not sent: the database applies the ones the code
 * computed into the pack the model read (pack.review.ledger.to_review); this adds the model's short note per verdict, the new
 * experiments (baseline frozen by code from the facts, period = the next period after the review's) and the pillar tags of untagged posts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { freezeBaseline } from './ledger';
import type { CheckedOutput } from './output';
import { COACH_READ_WEEKS, readPackRows } from './rows';
import { isoDay, utcDay } from './stats';

type SavedPack = { review?: unknown };
type ReviewMeta = { as_of: string; cadence: string; period: { end: string } };

export async function saveCoachLedger(db: Pick<SupabaseClient, 'rpc'>, claim: { id: string; token: string; actorId: string },
  businessId: string, pack: SavedPack, checked: CheckedOutput) {
  if (!checked.parsed) return false;
  const review = pack.review as ReviewMeta;
  // The next period has the length of this one (28 days for a monthly or quarterly review, 7 otherwise).
  const length = review.cadence === 'monthly' || review.cadence === 'quarterly' ? 28 : 7;
  const start = utcDay(review.period.end) + 1;
  const facts = checked.experiments.length ? (await readPackRows(db, claim.actorId, businessId, COACH_READ_WEEKS)).facts : [];
  const experiments = checked.experiments.map(e => ({
    kind: e.kind, layer: e.layer, hypothesis: e.hypothesis, action: e.action, metric: e.metric,
    target_mult: e.target.mult ?? null, target_line: e.target.max !== undefined || e.target.min !== undefined
      ? { ...(e.target.max !== undefined ? { max: e.target.max } : {}), ...(e.target.min !== undefined ? { min: e.target.min } : {}) } : null,
    match: e.match, baseline: freezeBaseline(e.match, e.metric, facts, review.as_of), evidence: e.evidence,
    period_start: isoDay(start), period_end: isoDay(start + length - 1),
  }));
  const saved = await db.rpc('publish_monitor_review_save_coach', { p_id: claim.id, p_token: claim.token,
    p_payload: { experiments, verdict_notes: checked.verdict_notes, tags: checked.tags } });
  if (saved.error) throw new Error('PUBLISH_MONITOR_COACH_LEDGER_SAVE_FAILED');
  return (saved.data as { saved?: boolean } | null)?.saved === true;
}
