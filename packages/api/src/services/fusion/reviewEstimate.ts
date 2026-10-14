/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { openRouterCallBound } from '../bill2/openRouterPolicy';
import { FUSION_INPUT_CAP } from './request';

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

/** Worst-case total of one review (FUSION-REVIEW §3.2): rounds × (Σ reviewer upper bounds + summary upper bound),
 * with the actual input snapshot (report at most the larger of itself and the summary output, §2.2), every
 * revised field at 400 characters and every opinion at its limit. Any model that
 * cannot fit its worst-case request refuses the whole review before anything is frozen (no silent downgrade).
 * Above the single-review budget the rounds are reduced; not even one round fits → refused. */
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
  // From round 2 the report is the previous revision, at most the summary's output (4 bytes per token).
  const report = Math.max(input.snapshotBytes, input.summaryTokens * 4 + input.snapshotBytes);
  const reviewerBytes = input.instructionBytes.reviewer + report + steps + FRAMING_BYTES;
  const summaryBytes = input.instructionBytes.summary + report + 2 * steps + FRAMING_BYTES
    + input.reviewers.length * input.opinionTokens * 4;
  const round = input.reviewers.reduce((sum, id) => sum + bound(id, input.opinionTokens, reviewerBytes), 0)
    + bound(input.summary, input.summaryTokens, summaryBytes);
  const rounds = Math.min(input.maxRounds, Math.floor(Number(input.maxBudgetUsd) / round));
  if (!Number.isFinite(round) || rounds < 1) throw new Error('FUSION_BUDGET_EXCEEDED');
  // Rounded up to whole micro-dollars so the stored estimate is never below the computed bound.
  return { rounds, estimateUsd: (Math.ceil(rounds * round * 1e6) / 1e6).toFixed(6) };
}
