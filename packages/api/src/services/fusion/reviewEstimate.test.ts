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
    // A reviewer request so large that adding the three opinions to it overflows: one round only.
    expect(estimateReview({ ...base, opinionTokens: 4096, snapshotBytes: 5_000, fieldCount: 0,
      instructionBytes: { reviewer: 140_000, summary: 1_000 } }).rounds).toBe(1);
    // A summary that cannot fit the cap: refused at start, before round 1 is charged.
    expect(() => estimateReview({ ...base, opinionTokens: 8192, snapshotBytes: 190_000 })).toThrow('FUSION_INPUT_TOO_LARGE');
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

  it('raising the opinion cap to 8192 raises only the reviewers\' own bounds: the summary hold, its bytes and the minimum balance stay', () => {
    // The staging models' real price rows (price per million tokens; a cache write priced above the listed prompt is what the bound uses).
    const real = (modelId: string, prompt: string, write: string, completion: string) => ({ ...quote(modelId), multiplier: '3',
      providerLimits: { providerSlug: 'x', contextTokens: 1_000_000, promptUsdPerMillion: prompt, cacheWriteUsdPerMillion: write,
        completionUsdPerMillion: completion, requestUsd: '0' } });
    const quotes = [real(ids[0]!, '2', '2.5', '10'), real(ids[1]!, '4', '5', '15'), real(ids[2]!, '2', '2.1875', '10'), real('s', '4', '5', '20')];
    const staging = { ...base, quotes: quotes as never, maxRounds: 1, maxBudgetUsd: '5', creditsPerUsd: '100', summaryTokens: 32768,
      instructionBytes: { reviewer: 9_000, summary: 9_000 }, fieldCount: 14, snapshotBytes: 40_000 };
    const before = estimateReview({ ...staging, opinionTokens: 4096 });
    const after = estimateReview({ ...staging, opinionTokens: 8192 });
    // The summary request is priced for the same bytes, so its hold is the same.
    expect(after.requestBytes.summary).toBe(before.requestBytes.summary);
    expect(after.callCaps.summary).toEqual(before.callCaps.summary);
    expect(after.requestBytes.review).toBe(before.requestBytes.review);
    // Each reviewer gains exactly 4096 more output tokens at its own completion price (the GPT row is 15, not 10).
    const gain = (id: string) => Number(after.callCaps.review[id]!.usd) - Number(before.callCaps.review[id]!.usd);
    expect(gain(ids[0]!)).toBeCloseTo(4096 * 10 / 1e6, 6);
    expect(gain(ids[1]!)).toBeCloseTo(4096 * 15 / 1e6, 6);
    expect(gain(ids[2]!)).toBeCloseTo(4096 * 10 / 1e6, 6);
    // The hold a start freezes is the larger of the reviewers' sum and the summary: still the summary's.
    const sum = (caps: Record<string, { credits: number }>) => Object.values(caps).reduce((total, cap) => total + cap.credits, 0);
    expect(sum(after.callCaps.review)).toBeLessThan(after.callCaps.summary[Object.keys(after.callCaps.summary)[0]!]!.credits);
    // Every call at its bound stays within the fixed price (1500) and the single-review budget.
    expect(sum(after.callCaps.review) + sum(after.callCaps.summary)).toBeLessThan(1500);
    expect(Number(after.estimateUsd)).toBeLessThan(5);
  });
});
