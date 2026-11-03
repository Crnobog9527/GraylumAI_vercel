/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { fallbackEligible } from './rounds';

// Round 13 (staging draft 8c296a0c): one search round and no qualified benchmark. The database counts the rounds (research_benchmark_rounds)
// and applies the same condition as this one in turn_mentor_context.
describe('the fallback B condition (Owner 10-20, 10-27)', () => {
  it('needs one qualified benchmark AND two rounds: neither alone is enough', () => {
    const r = (keywordSearches: number, linkChecks: number) => ({ keywordSearches, linkChecks });
    expect(fallbackEligible({ qualified: 0, rounds: r(1, 0) })).toBe(false); // round 13
    expect(fallbackEligible({ qualified: 0, rounds: r(2, 1) })).toBe(false); // many rounds, nothing qualified
    expect(fallbackEligible({ qualified: 1, rounds: r(1, 0) })).toBe(false);
    expect(fallbackEligible({ qualified: 1, rounds: r(1, 1) })).toBe(true);  // a link check counts as a round
    expect(fallbackEligible({ qualified: 2, rounds: r(2, 0) })).toBe(true);
  });
});
