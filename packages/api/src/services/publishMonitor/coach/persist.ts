/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-3b: what a delivered brand review leaves in the ledger. Verdicts are not sent: the database applies the ones the code
 * computed into the pack the model read (pack.review.ledger.to_review); this adds the model's short note per verdict, the new
 * experiments (baseline frozen by code from the facts, period = the next period after the review's) and the pillar tags of untagged posts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { tagFromTitles } from './autotag';
import { freezeBaseline } from './ledger';
import type { CheckedOutput } from './output';
import { COACH_READ_WEEKS, readPackRows } from './rows';
import { isoDay, utcDay } from './stats';

type SavedPack = { review?: unknown; auto_tags?: Array<{ post_id: string; pillar_key: string }> };
/** The save function takes at most this many tags in all. */
const MAX_TAGS = 40;
type ReviewMeta = { as_of: string; cadence: string; period: { end: string } };

export async function saveCoachLedger(db: Pick<SupabaseClient, 'rpc'>, claim: { id: string; token: string; actorId: string },
  businessId: string, pack: SavedPack, output: CheckedOutput) {
  // A review whose structured block is missing or broken still saves: the verdicts come from the pack the code made, and the tags the
  // code took from titles are the code's own. Only what the model proposed is dropped.
  const checked: CheckedOutput = output.parsed ? output : { ...output, experiments: [], verdict_notes: [], tags: [] };
  const review = pack.review as ReviewMeta;
  // The next period has the length of this one (28 days for a monthly or quarterly review, 7 otherwise).
  const length = review.cadence === 'monthly' || review.cadence === 'quarterly' ? 28 : 7;
  const start = utcDay(review.period.end) + 1;
  // The baseline is frozen on the same facts the pack was made from: the pillars the code took from titles count here too, or an
  // experiment proposed on them would freeze an empty baseline (the tags are only written after the experiments).
  const read = checked.experiments.length ? await readPackRows(db, claim.actorId, businessId, COACH_READ_WEEKS) : null;
  const facts = read ? tagFromTitles(read.facts, read.profile?.pillars ?? []).items : [];
  const experiments = checked.experiments.map(e => ({
    kind: e.kind, layer: e.layer, hypothesis: e.hypothesis, action: e.action, metric: e.metric,
    // Only the target that fits the kind is stored: a line settles basics, a multiple settles the rest.
    target_mult: e.kind === 'basics' ? null : e.target.mult ?? null,
    target_line: e.kind === 'basics' && (e.target.max !== undefined || e.target.min !== undefined)
      ? { ...(e.target.max !== undefined ? { max: e.target.max } : {}), ...(e.target.min !== undefined ? { min: e.target.min } : {}) } : null,
    match: e.match, baseline: freezeBaseline(e.match, e.metric, facts, review.as_of), evidence: e.evidence,
    period_start: isoDay(start), period_end: isoDay(start + length - 1),
  }));
  // The model's tags first, then the ones the code took from titles, up to what one save takes; a post tagged twice keeps the model's.
  const modelTagged = new Set(checked.tags.map(tag => tag.post_id));
  const tags = [...checked.tags, ...(pack.auto_tags ?? []).filter(tag => !modelTagged.has(tag.post_id))].slice(0, MAX_TAGS);
  const saved = await db.rpc('publish_monitor_review_save_coach', { p_id: claim.id, p_token: claim.token,
    p_payload: { experiments, verdict_notes: checked.verdict_notes, tags } });
  if (saved.error) throw new Error('PUBLISH_MONITOR_COACH_LEDGER_SAVE_FAILED');
  return (saved.data as { saved?: boolean } | null)?.saved === true;
}
