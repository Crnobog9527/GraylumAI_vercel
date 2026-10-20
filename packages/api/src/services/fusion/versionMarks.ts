/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Report version marks (Owner 2026-10-20: "经过评审团评审过的报告版本在资料库里要加一个醒目的标识，和普通报告做区分；
 * 用户编辑修订评审过后的报告产生的新版本则显示衍伸标识，普通报告没标识"). All decided by code from rows that already exist; no model.
 *
 * - reviewed: the version was the source of a completed review (whether or not any revision was adopted), or it is the
 *   version an adoption produced. A failed, stopped or unfinished review does not count.
 * - derived: a version made by editing (R14, `source: review_revision`) that is not an adoption's result, traced through
 *   its source versions to a reviewed one. The trace is bounded and never loops.
 * - nothing for any other version.
 */
export const TRACE_LIMIT = 50;
export type VersionMark = { mark: 'reviewed' | 'derived'; reviewId: string | null; draftId: string | null; reviewedAt: string | null;
  adoptedCount: number;
  /** Derived only: the reviewed version it traces back to. */
  derivedFrom: string | null };
export type VersionRow = { id: string; source: string | null; from: string | null };
export type ReviewRow = { id: string; draft_id: string; source_version_id: string; state: string; ended_at: string | null;
  adoption: { state?: string; versionId?: string | null; adopted?: unknown; at?: string } | null };

const count = (adoption: ReviewRow['adoption']) =>
  adoption?.state === 'recorded' && Array.isArray(adoption.adopted) ? adoption.adopted.length : 0;

export function computeVersionMarks(versions: VersionRow[], reviews: ReviewRow[]): Record<string, VersionMark> {
  const reviewedAs = new Map<string, VersionMark>();
  // Newest first: the latest completed review of a version is the one shown.
  for (const review of reviews) {
    if (review.state === 'completed' && !reviewedAs.has(review.source_version_id)) {
      reviewedAs.set(review.source_version_id, { mark: 'reviewed', reviewId: review.id, draftId: review.draft_id, reviewedAt: review.ended_at,
        adoptedCount: count(review.adoption), derivedFrom: null });
    }
  }
  const producedBy = new Map<string, VersionMark>();
  for (const review of reviews) {
    const made = review.adoption?.versionId;
    if (review.adoption?.state === 'recorded' && typeof made === 'string' && !producedBy.has(made)) {
      producedBy.set(made, { mark: 'reviewed', reviewId: review.id, draftId: review.draft_id, reviewedAt: review.adoption.at ?? review.ended_at,
        adoptedCount: count(review.adoption), derivedFrom: null });
    }
  }
  const reviewed = (id: string) => reviewedAs.get(id) ?? producedBy.get(id) ?? null;
  const byId = new Map(versions.map(version => [version.id, version]));
  const marks: Record<string, VersionMark> = {};
  for (const version of versions) {
    const own = reviewed(version.id);
    if (own) { marks[version.id] = own; continue; }
    if (version.source !== 'review_revision') continue;
    // An edit: follow its source versions up to a reviewed one, bounded and without revisiting a version.
    const seen = new Set<string>([version.id]);
    let current = version.from;
    for (let depth = 0; current && depth < TRACE_LIMIT && !seen.has(current); depth++) {
      seen.add(current);
      if (reviewed(current)) {
        marks[version.id] = { mark: 'derived', reviewId: null, draftId: null, reviewedAt: null, adoptedCount: 0, derivedFrom: current };
        break;
      }
      const next = byId.get(current);
      current = next && next.source === 'review_revision' ? next.from : null;
    }
  }
  return marks;
}

export class VersionMarksDenied extends Error { constructor() { super('FUSION_VERSION_MARKS_DENIED'); } }

/**
 * Marks of every version of the given analyses' projects, plus the extra version ids the page shows (an account's history also
 * lists versions of its inherited root and earlier draft projects). Another user's analysis (or an unknown one) is refused, never
 * empty. Reviews are only the caller's own, so an extra id of someone else's version can never come back marked.
 */
export async function loadVersionMarks(admin: SupabaseClient, actorId: string, draftIds: string[], versionIds: string[] = []):
  Promise<Record<string, VersionMark>> {
  const ids = [...new Set(draftIds)];
  const drafts = await admin.from('opc_drafts').select('draft_id,project_id,actor_id').in('draft_id', ids);
  if (drafts.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
  const own = (drafts.data ?? []) as Array<{ draft_id: string; project_id: string; actor_id: string }>;
  if (own.length !== ids.length || own.some(draft => draft.actor_id !== actorId)) throw new VersionMarksDenied();
  const projects = [...new Set(own.map(draft => draft.project_id))];
  const columns = 'id,source:report->generatedReport->>source,from:report->generatedReport->>sourceVersionId' as const;
  const extra = [...new Set(versionIds)];
  const [versions, shown, reviews] = await Promise.all([
    admin.from('artifact_versions').select(columns).in('project_id', projects).is('erased_at', null).limit(1000),
    extra.length ? admin.from('artifact_versions').select(columns).in('id', extra).is('erased_at', null).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    admin.from('fusion_reviews').select('id,draft_id,source_version_id,state,ended_at,adoption').eq('actor_id', actorId)
      .order('created_at', { ascending: false }).limit(1000),
  ]);
  if (versions.error || shown.error || reviews.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
  const all = new Map([...(versions.data ?? []), ...(shown.data ?? [])].map(row => [(row as { id: string }).id, row]));
  return computeVersionMarks([...all.values()] as unknown as VersionRow[], (reviews.data ?? []) as unknown as ReviewRow[]);
}
