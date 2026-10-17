/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../bill2/service';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { estimateReview } from './reviewEstimate';
import { readReviewSkill, resolveReviewSkill } from './reviewPrompts';
import { readFusionSettings } from './settings';

/**
 * The admission checks and estimate of a review start (settings, Skill, the staging window, sizes). Shared by the
 * estimate the page shows before the user agrees and by start itself, so both compute the same maximum.
 */
export async function planReview(input: { admin: SupabaseClient; actorId: string; env: Record<string, string | undefined>;
  draftId: string; sourceVersionId: string }) {
  const { admin, actorId } = input;
  const settings = await readFusionSettings(admin);
  if (!settings.review.enabled) throw new Error('FUSION_REVIEW_DISABLED');
  if (!settings.review.skillId || !settings.review.summaryModelId || !settings.review.maxBudgetUsd) throw new Error('FUSION_REVIEW_INCOMPLETE');
  const skill = await resolveReviewSkill(admin, settings.review.skillId);
  const text = await readReviewSkill(admin, skill);
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, input.env);
  const sizes = await admin.rpc('fusion_review_preview', { p_actor_id: actorId, p_draft_id: input.draftId,
    p_source_version_id: input.sourceVersionId });
  if (sizes.error) throw new Error('FUSION_REVIEW_STALE');
  const preview = z.object({ reportSentBytes: z.number(), materialsSentBytes: z.number(), fieldCount: z.number() }).passthrough()
    .parse(sizes.data);
  // Instructions travel as one escaped string in the body; the host-written format rules add at most a few KB.
  const sent = (value: string) => Buffer.byteLength(JSON.stringify(value)) + 4096;
  const estimate = estimateReview({ quotes: window.callPolicies,
    creditsPerUsd: window.creditsPerUsd, reviewers: settings.review.reviewerModelIds,
    summary: settings.review.summaryModelId, maxRounds: settings.review.maxRounds, maxBudgetUsd: settings.review.maxBudgetUsd,
    opinionTokens: settings.review.opinionOutputTokens, summaryTokens: settings.review.summaryOutputTokens, fieldCount: preview.fieldCount,
    snapshotBytes: preview.reportSentBytes + preview.materialsSentBytes,
    instructionBytes: { reviewer: sent(`${text.reviewer}\n\n${text.rubric}`), summary: sent(`${text.summary}\n\n${text.rubric}`) } });
  return { settings, skill, text, ...estimate };
}
