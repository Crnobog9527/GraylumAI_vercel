/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { aggregateCredits } from '../bill2/decimal';
import { openRouterCallBound } from '../bill2/openRouterPolicy';
import { FUSION_INPUT_CAP } from './request';
import { PAYG_PROFILE_MAX_BYTES } from '../runtime/paygHostPolicy';

type CallPolicy = z.infer<typeof frozenCallPolicy>;
/** Per-call profile overheads frozen with every payg quote (template + margin tokens). */
const PROFILE_OVERHEAD = 4096 + 4096;
/** JSON framing of the input, the response format and the request fields around the snapshot (as fusionRequestBytes
 * counts them, including its fields allowance). */
const FRAMING_BYTES = 16384;
/** One declared field in the summary input: up to 400 characters, escaped twice (input string inside the body). */
const FIELD_BYTES = 400 * 3 * 2 + 256;

export type EstimateInput = {
  quotes: CallPolicy[]; reviewers: string[]; summary: string; maxRounds: number; maxBudgetUsd: string;
  /** The test window's rate: with each model's frozen multiplier it converts every call bound to credits as admission does. */
  creditsPerUsd: string;
  opinionTokens: number; summaryTokens: number; instructionBytes: { reviewer: number; summary: number }; fieldCount: number;
  /** Report + confirmed-field bytes of the reviewed version as sent (after the request's JSON escaping). */
  snapshotBytes: number;
};

/** Worst-case total of one review (FUSION-REVIEW §3.2, Owner 2026-10-14 mechanism): round-1 reviewers, the
 * debate round (only on disagreement, but always budgeted when allowed) and one summary, with the actual input
 * snapshot, every revised field at 400 characters and every opinion at its limit. Any model that cannot fit its
 * worst-case request refuses the whole review before anything is frozen (no silent downgrade). Above the
 * single-review budget the debate round is dropped; if even one round does not fit, the review is refused. */
/** Rounded up to whole micro-dollars, so a stored bound is never below the computed one. */
const micro = (usd: number) => (Math.ceil(usd * 1e6) / 1e6).toFixed(6);
export type PhaseBytes = { review: number; debate: number; summary: number };
export function estimateReview(input: EstimateInput): { rounds: number; estimateUsd: string;
  /** "最多消耗 X 积分" shown before the user agrees (§3.2): every call's credit hold, each rounded up on its own. */
  estimateCredits: number;
  /** The credit holds each phase's group may freeze (a later claim above it is refused, so the shown maximum holds). */
  phaseCredits: PhaseBytes;
  /** The provider cost bound of each phase's group, in dollars (decimal strings): a later claim above it is refused, so
   * the review never exceeds the single-review budget it was admitted under (#962 review). */
  phaseUsd: { review: string; debate: string; summary: string };
  /** The serialized size each phase's request may reach: the prices above assume it, and claims enforce it. */
  requestBytes: PhaseBytes } {
  const bound = (modelId: string, outputTokens: number, bytes: number) => {
    const quote = input.quotes.find(policy => policy.modelId === modelId);
    if (!quote?.providerLimits) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
    const output = Math.min(outputTokens, quote.outputLimit);
    const prompt = bytes + PROFILE_OVERHEAD;
    if (prompt + output > quote.providerLimits.contextTokens) throw new Error('FUSION_REVIEW_CONTEXT');
    if (quote.multiplier === undefined) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
    const { upperUsd } = openRouterCallBound(quote.providerLimits, output, prompt);
    // Holds are per run (one call each), so each call's credits round up separately, exactly as admission freezes them.
    return { usd: Number(upperUsd), credits: aggregateCredits([upperUsd], input.creditsPerUsd, quote.multiplier) };
  };
  const add = (parts: Array<{ usd: number; credits: number }>) =>
    parts.reduce((sum, part) => ({ usd: sum.usd + part.usd, credits: sum.credits + part.credits }), { usd: 0, credits: 0 });
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
  const firstRound = add(input.reviewers.map(id => bound(id, input.opinionTokens, reviewerBytes)));
  // Only bound the debate when a second round is possible; an unused debate payload must not refuse a one-round plan.
  const debate = input.maxRounds >= 2 && debateFits
    ? add(input.reviewers.map(id => bound(id, input.opinionTokens, debateBytes))) : add([]);
  const summary = bound(input.summary, input.summaryTokens, summaryBytes);
  const budget = Number(input.maxBudgetUsd);
  for (let rounds = Math.min(input.maxRounds, debateFits ? 2 : 1); rounds >= 1; rounds--) {
    const total = add([firstRound, rounds > 1 ? debate : add([]), summary]);
    // Rounded up to whole micro-dollars so the stored estimate is never below the computed bound.
    if (Number.isFinite(total.usd) && total.usd <= budget) return { rounds, estimateUsd: micro(total.usd),
      estimateCredits: total.credits,
      phaseCredits: { review: firstRound.credits, debate: rounds > 1 ? debate.credits : 0, summary: summary.credits },
      phaseUsd: { review: micro(firstRound.usd), debate: micro(rounds > 1 ? debate.usd : 0), summary: micro(summary.usd) },
      requestBytes: { review: reviewerBytes, debate: rounds > 1 ? debateBytes : 0, summary: summaryBytes } };
  }
  throw new Error('FUSION_BUDGET_EXCEEDED');
}
