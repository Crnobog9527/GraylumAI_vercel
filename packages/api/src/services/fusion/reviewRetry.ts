/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readFusionSettings } from './settings';

/**
 * One retry of a summary the host check refused (Owner 2026-10-20): the platform bears its cost, the user's fixed price
 * is neither held again nor charged twice (the call settles inside the fixed-price group like every review call), and it
 * only happens while the frozen estimate plus one more summary call stays within the single-review budget line.
 * Only revision_invalid is retried: a provider refusal or a lost answer is not a bad revision.
 */
export function summaryRetryAllowed(input: {
  /** Judged summary calls of the current round, all attempts. */
  summaryVerdicts: Array<string | null>;
  /** Frozen at start: the whole review's dollar estimate and the summary call's dollar bound. */
  estimateUsd: string; summaryCapUsd: string | undefined;
  /** The administrators' single-review budget line, read now (null: unreadable, no retry). */
  maxBudgetUsd: string | null;
}): boolean {
  const refused = input.summaryVerdicts.filter(verdict => verdict === 'revision_invalid').length;
  if (refused !== 1 || input.summaryVerdicts.some(verdict => verdict === 'usable' || verdict === 'unjudged_saved')) return false;
  const total = Number(input.estimateUsd) + Number(input.summaryCapUsd);
  const budget = Number(input.maxBudgetUsd);
  return input.summaryCapUsd !== undefined && input.maxBudgetUsd !== null && Number.isFinite(total) && Number.isFinite(budget)
    && total <= budget;
}

/** The same decision with the budget line read now; an unreadable setting means no retry. */
export async function mayRetrySummary(admin: SupabaseClient, cfg: { estimateUsd: string; summary: string;
  callCaps?: Partial<Record<string, Record<string, { usd: string }>>> }, summaryVerdicts: Array<string | null>): Promise<boolean> {
  const maxBudgetUsd = await readFusionSettings(admin).then(settings => settings.review.maxBudgetUsd, () => null);
  return summaryRetryAllowed({ summaryVerdicts, estimateUsd: cfg.estimateUsd, summaryCapUsd: cfg.callCaps?.summary?.[cfg.summary]?.usd,
    maxBudgetUsd });
}
