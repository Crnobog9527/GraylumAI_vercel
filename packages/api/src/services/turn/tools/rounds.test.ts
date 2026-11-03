/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { fallbackEligible, researchRounds } from './rounds';

// Round 13 (staging draft 8c296a0c): TikHub answered HTTP 402 to every Xiaohongshu call. The keyword round still returned web results
// (one counted round), the pasted-link check returned nothing (not counted), and no benchmark qualified: no fallback card is due.
describe('research rounds and the fallback B condition (Owner 10-20, 10-27)', () => {
  it('counts a delivered keyword round once; a link check only when it completed; failed ones never', () => {
    const rounds = researchRounds();
    rounds.discovery('delivered'); rounds.discovery('no_data'); rounds.discovery('unknown'); rounds.discovery('not_sent');
    rounds.linkCheck('check-1', 'no_data'); rounds.linkCheck('check-2', 'unknown');
    expect(rounds.value()).toEqual({ keywordSearches: 1, linkChecks: 0 });
    rounds.linkCheck('check-3', 'delivered'); rounds.linkCheck('check-3', 'delivered');
    expect(rounds.value()).toEqual({ keywordSearches: 1, linkChecks: 1 });
  });
  it('needs one qualified benchmark AND two counted rounds: neither alone is enough', () => {
    const r = (keywordSearches: number, linkChecks: number) => ({ keywordSearches, linkChecks });
    expect(fallbackEligible({ qualified: 0, rounds: r(1, 0) })).toBe(false); // round 13
    expect(fallbackEligible({ qualified: 0, rounds: r(2, 1) })).toBe(false); // many rounds, nothing qualified
    expect(fallbackEligible({ qualified: 1, rounds: r(1, 0) })).toBe(false);
    expect(fallbackEligible({ qualified: 1, rounds: r(1, 1) })).toBe(true);  // a link check counts as a round
    expect(fallbackEligible({ qualified: 2, rounds: r(2, 0) })).toBe(true);
  });
});
