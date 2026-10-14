/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { openRouterCallBound } from '../bill2/openRouterPolicy';
import { FUSION_INPUT_CAP } from './request';
import { PAYG_PROFILE_MAX_BYTES } from '../runtime/paygHostPolicy';

type CallPolicy = z.infer<typeof frozenCallPolicy>;
/** Per-call profile overheads frozen with every payg quote (template + margin tokens). */
const PROFILE_OVERHEAD = 4096 + 4096;
/** JSON framing of the host-built input around the snapshot. */
const FRAMING_BYTES = 4096;
const FIELD_BYTES = 400 * 3 + 128;

export type EstimateInput = {
  quotes: CallPolicy[]; reviewers: string[]; summary: string; maxRounds: number; maxBudgetUsd: string;
  opinionTokens: number; summaryTokens: number; instructionBytes: { reviewer: number; summary: number }; fieldCount: number;
  /** Report + confirmed-field bytes of the reviewed version (the input snapshot). */
  snapshotBytes: number;
};

/** Worst-case total of one review (FUSION-REVIEW §3.2, Owner 2026-10-14 mechanism): round-1 reviewers, the
 * debate round (only on disagreement, but always budgeted when allowed) and one summary, with the actual input
 * snapshot, every revised field at 400 characters and every opinion at its limit. Any model that cannot fit its
 * worst-case request refuses the whole review before anything is frozen (no silent downgrade). Above the
 * single-review budget the debate round is dropped; if even one round does not fit, the review is refused. */
export function estimateReview(input: EstimateInput): { rounds: number; estimateUsd: string } {
  const bound = (modelId: string, outputTokens: number, bytes: number) => {
    const quote = input.quotes.find(policy => policy.modelId === modelId);
    if (!quote?.providerLimits) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
    const output = Math.min(outputTokens, quote.outputLimit);
    const prompt = bytes + PROFILE_OVERHEAD;
    if (prompt + output > quote.providerLimits.contextTokens) throw new Error('FUSION_REVIEW_CONTEXT');
    return Number(openRouterCallBound(quote.providerLimits, output, prompt).upperUsd);
  };
  const steps = input.fieldCount * FIELD_BYTES;
  if (input.snapshotBytes > FUSION_INPUT_CAP) throw new Error('FUSION_INPUT_TOO_LARGE');
  const opinionBytes = input.opinionTokens * 4;
  const reviewerBytes = input.instructionBytes.reviewer + input.snapshotBytes + FRAMING_BYTES;
  // Debate round: the reviewer also reads its own and every other reviewer's round-1 opinion.
  const debateBytes = reviewerBytes + input.reviewers.length * opinionBytes;
  const summaryBytes = input.instructionBytes.summary + input.snapshotBytes + 2 * steps + FRAMING_BYTES
    + input.reviewers.length * opinionBytes;
  // Every request must also fit the per-call billing profile, or a later step could not be claimed after earlier ones
  // were charged (#962 review): round 1 and the summary are required; the debate round is dropped when it cannot fit.
  if (reviewerBytes > PAYG_PROFILE_MAX_BYTES || summaryBytes > PAYG_PROFILE_MAX_BYTES) throw new Error('FUSION_INPUT_TOO_LARGE');
  const debateFits = debateBytes <= PAYG_PROFILE_MAX_BYTES;
  const firstRound = input.reviewers.reduce((sum, id) => sum + bound(id, input.opinionTokens, reviewerBytes), 0);
  const debate = input.reviewers.reduce((sum, id) => sum + bound(id, input.opinionTokens, debateBytes), 0);
  const summary = bound(input.summary, input.summaryTokens, summaryBytes);
  const budget = Number(input.maxBudgetUsd);
  for (let rounds = Math.min(input.maxRounds, debateFits ? 2 : 1); rounds >= 1; rounds--) {
    const total = firstRound + (rounds > 1 ? debate : 0) + summary;
    // Rounded up to whole micro-dollars so the stored estimate is never below the computed bound.
    if (Number.isFinite(total) && total <= budget) return { rounds, estimateUsd: (Math.ceil(total * 1e6) / 1e6).toFixed(6) };
  }
  throw new Error('FUSION_BUDGET_EXCEEDED');
}
