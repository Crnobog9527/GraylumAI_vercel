/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { estimateReview } from './reviewEstimate';

const quote = (modelId: string) => ({ modelId, outputLimit: 32768, multiplier: '3', providerLimits: { providerSlug: 'x', contextTokens: 1_000_000,
  promptUsdPerMillion: '0.1', completionUsdPerMillion: '0.1', requestUsd: '0' } });
const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'];
const base = { quotes: [...ids, 's'].map(quote) as never, reviewers: ids, summary: 's', maxRounds: 2, maxBudgetUsd: '100', creditsPerUsd: '100',
  summaryTokens: 16384, instructionBytes: { reviewer: 8000, summary: 8000 }, fieldCount: 14, snapshotBytes: 30_000 };

describe('review estimate', () => {
  it('keeps every request within the per-call billing byte cap: drops the debate round, or refuses before anything is charged', () => {
    expect(estimateReview({ ...base, opinionTokens: 4096 }).rounds).toBe(2);
    // Three 12k-token opinions make the debate request too large: one round only.
    expect(estimateReview({ ...base, opinionTokens: 12_000, snapshotBytes: 5_000, fieldCount: 0,
      instructionBytes: { reviewer: 60_000, summary: 1_000 } }).rounds).toBe(1);
    // A summary that cannot fit the cap: refused at start, before round 1 is charged.
    expect(() => estimateReview({ ...base, opinionTokens: 32768 })).toThrow('FUSION_INPUT_TOO_LARGE');
    // With one round allowed, an oversized debate payload is never bounded (no context refusal for an unused round).
    const small = [...ids, 's'].map(id => ({ ...quote(id), providerLimits: { ...quote(id).providerLimits, contextTokens: 120_000 } }));
    expect(estimateReview({ ...base, quotes: small as never, maxRounds: 1, opinionTokens: 4000, summaryTokens: 4096, fieldCount: 0,
      instructionBytes: { reviewer: 60_000, summary: 1_000 } }).rounds).toBe(1);
  });

  it('returns the maximum credits as admission holds them: each call rounded up on its own, then summed', () => {
    const one = { ...base, reviewers: [ids[0]!], maxRounds: 1, opinionTokens: 4096, summaryTokens: 4096, fieldCount: 0, snapshotBytes: 1_000 };
    const result = estimateReview(one);
    // Two calls of about 1.4 credits each: each hold rounds up to 2, so the maximum is 4, not the 3 the summed dollars give.
    expect(Math.ceil(Number(result.estimateUsd) * 100 * 3)).toBe(3);
    expect(result.estimateCredits).toBe(4);
    expect(() => estimateReview({ ...one, quotes: [ids[0]!, 's'].map(id => ({ ...quote(id), multiplier: undefined })) as never }))
      .toThrow('FUSION_MODEL_ADMISSION_REQUIRED');
  });
});
